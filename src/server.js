import express from 'express';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { config, ensureDataDirs, hasBundledFonts } from './config.js';
import { createLogger } from './lib/logger.js';
import { themes } from './render/styles.js';
import { coverPath, generateCover, startBackgroundTasks, stats } from './services/pipeline.js';
import { closeBrowser } from './services/renderer.js';

const log = createLogger('server');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

// Covers are immutable for the life of their cache entry, and the filenames are
// content hashes, so they can be cached hard.
app.use(
  '/covers',
  express.static(config.outputDir, {
    immutable: true,
    maxAge: '30d',
    fallthrough: false,
    setHeaders: (res) => res.setHeader('x-content-type-options', 'nosniff'),
  }),
);

app.use(express.static(config.publicDir, { extensions: ['html'], maxAge: '1h' }));

// The banner is served from `/covers`, but the service may be reached through a
// reverse proxy, so an explicit forwarded-host beats req.headers.host.
const requestOrigin = (req) => {
  const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? `localhost:${config.port}`;
  const proto = req.headers['x-forwarded-proto'] ?? req.protocol;
  return `${String(host).split(',')[0].trim()}`.includes('://') ? String(host).split(',')[0].trim() : `${proto}://${host}`;
};

// Query values are handed to the pipeline as-is; normalizeOptions is the single
// place that coerces them, so one route cannot disagree with another about what
// `refresh=false` means.
const failWith = (res, error) => res.status(statusFor(error)).json({ error: error.message });

// 400 for something the caller can fix, 404 when the repository does not exist,
// 502 for everything else, which in practice means GitHub or the clone failed.
const statusFor = (error) => {
  if (error.status === 404) return 404;
  if (/could not read a repository|is required|required/i.test(error.message)) return 400;
  return 502;
};

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    version: '1.0.0',
    themes,
    fonts: hasBundledFonts() ? 'bundled' : 'system',
    auth: config.githubToken ? 'token' : 'anonymous',
    installs: config.allowInstalls,
    render: stats(),
  });
});

app.post('/api/cover', async (req, res) => {
  try {
    const result = await generateCover(req.body?.repo, {
      options: req.body,
      origin: requestOrigin(req),
    });
    res.json({ ...result, image: `/covers/${result.fileName}` });
  } catch (error) {
    log.warn(`POST /api/cover failed: ${error.message}`);
    failWith(res, error);
  }
});

// Direct PNG access. `/api/cover.png?repo=owner/name` is the only URL a README
// needs, so this is the primary interface and the web UI is a client of it.
app.get('/api/cover.png', async (req, res) => {
  try {
    const result = await generateCover(req.query.repo, {
      options: req.query,
      origin: requestOrigin(req),
    });

    // A cache hit carries no buffer; the PNG is already on disk.
    const buffer = result.buffer ?? (await readFile(coverPath(result.fileName)));

    res.setHeader('content-type', 'image/png');
    res.setHeader('x-gitphoto-strategy', result.strategy);
    res.setHeader('x-gitphoto-cached', String(result.cached));
    res.setHeader('cache-control', 'public, max-age=3600');
    if (req.query.download) {
      res.setHeader('content-disposition', `attachment; filename="${result.fileName}"`);
    }
    res.end(buffer);
  } catch (error) {
    log.warn(`GET /api/cover.png failed: ${error.message}`);
    if (!res.headersSent) res.status(statusFor(error)).type('text/plain').send(error.message);
  }
});

/**
 * Server-sent progress. Renders take tens of seconds, and a spinner with no
 * stage names is indistinguishable from a hang.
 */
app.get('/api/stream', async (req, res) => {
  res.set({
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders?.();

  let closed = false;
  const send = (event, data) => {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  req.on('close', () => {
    closed = true;
  });

  // Proxies drop idle event streams; a comment frame keeps the pipe warm.
  const heartbeat = setInterval(() => !closed && res.write(': keepalive\n\n'), 15_000);

  try {
    const result = await generateCover(req.query.repo, {
      options: req.query,
      origin: requestOrigin(req),
      onProgress: (progress) => send('progress', progress),
    });
    send('result', { ...result, image: `/covers/${result.fileName}` });
  } catch (error) {
    send('error', { error: error.message });
  } finally {
    clearInterval(heartbeat);
    if (!closed) res.end();
  }
});

app.get('/api/config', (req, res) => {
  res.json({
    themes,
    width: config.bannerWidth,
    height: config.bannerHeight,
    installs: config.allowInstalls,
    renderTimeoutMs: config.renderTimeoutMs,
  });
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(join(config.publicDir, 'index.html'));
});

const server = createServer(app);

let hardExitTimer = null;

const shutdown = async (signal) => {
  log.info(`${signal} received, shutting down`);
  // Armed here, not at startup: a timer that is merely unref'd still fires while
  // the process is alive, so arming one on boot would kill a healthy server.
  // Chromium refuses to close cleanly if a page is mid-navigation, so this is
  // the backstop that keeps a restart from hanging forever.
  hardExitTimer = setTimeout(() => process.exit(1), 10_000);
  hardExitTimer.unref();
  try {
    server.close();
    await closeBrowser();
  } catch (error) {
    log.warn(`shutdown encountered an error: ${error.message}`);
  } finally {
    clearTimeout(hardExitTimer);
  }
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => log.error('unhandled rejection', String(reason?.message ?? reason)));

const main = async () => {
  await ensureDataDirs();
  startBackgroundTasks();
  server.listen(config.port, () => {
    log.info(`gitphoto listening on http://0.0.0.0:${config.port}`);
    log.info(
      `github auth: ${config.githubToken ? 'token' : 'anonymous (60 req/hr)'} · ` +
        `installs: ${config.allowInstalls ? 'enabled' : 'disabled'} · ` +
        `fonts: ${hasBundledFonts() ? 'bundled' : 'system fallback'}`,
    );
  });
};

main().catch((error) => {
  log.error(`failed to start: ${error.stack ?? error.message}`);
  process.exit(1);
});
