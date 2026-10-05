import express from 'express';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, ensureDataDirs, hasBundledFonts } from './config.js';
import { createLogger } from './lib/logger.js';
import { themes } from './render/styles.js';
import { coverPath, generateCover, startBackgroundTasks, stats, waitForIdle } from './services/pipeline.js';
import { closeBrowser, probeBrowser } from './services/renderer.js';

const log = createLogger('server');

const app = express();
app.disable('x-powered-by');

// No helmet dependency: the frontend is same-origin only (no inline script, no
// inline style, no third-party origin), so a single strict policy covers it.
// `data:` stays allowed for img-src because the favicon is an inline SVG data URI.
app.use((req, res, next) => {
  res.set({
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'content-security-policy': [
      "default-src 'self'",
      "img-src 'self' data:",
      "style-src 'self'",
      "script-src 'self'",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ].join('; '),
  });
  next();
});

app.use(express.json({ limit: '16kb' }));

// Renders clone, install, and drive a browser, so an open endpoint is a way to
// spend the host's memory and the GitHub rate limit. Fixed window per IP; the
// limit is env-tunable and 0 disables it for trusted networks.
const RATE_LIMIT = Number.parseInt(process.env.RATE_LIMIT_PER_MIN ?? '', 10) || 30;
const hits = new Map();

const rateLimit = (req, res, next) => {
  if (RATE_LIMIT <= 0) return next();
  const now = Date.now();
  const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  const window = hits.get(key);
  if (!window || now > window.resetAt) {
    hits.set(key, { count: 1, resetAt: now + 60_000 });
  } else if (window.count >= RATE_LIMIT) {
    res.set('retry-after', String(Math.ceil((window.resetAt - now) / 1000)));
    return res.status(429).json({ error: 'Too many requests, slow down' });
  } else {
    window.count += 1;
  }
  // Every key expires on its own next window; without this the map grows for the
  // life of the process.
  if (hits.size > 4096) hits.clear();
  return next();
};

const coversRoot = resolve(config.outputDir);

/**
 * A cover request must resolve inside the covers directory. `..` is not a
 * traversal here — express.static already refuses to serve it — but letting it
 * fall through to the SPA answered `/covers/../.env` with 200 index.html, which
 * hid the attempt from anyone reading the logs.
 */
const escapesCovers = (urlPath) => {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return true;
  }
  const target = resolve(coversRoot, `.${sep}${decoded}`);
  const rel = relative(coversRoot, target);
  return rel.startsWith('..') || isAbsolute(rel);
};

const coversStatic = express.static(coversRoot, {
  immutable: true,
  maxAge: '30d',
  fallthrough: false,
  setHeaders: (res) => res.setHeader('x-content-type-options', 'nosniff'),
});

// Covers are immutable for the life of their cache entry, and the filenames are
// content hashes, so they can be cached hard.
app.use('/covers', (req, res, next) => {
  if (escapesCovers(req.path)) return res.status(404).type('text/plain').send('Not found');
  return coversStatic(req, res, (error) => {
    if (!error) return next();
    // A cover that is not on disk is a normal miss, not a server fault. Any
    // other failure is logged in full here and answered generically, so an
    // internal path never reaches the client.
    if (error.status === 404 || error.code === 'ENOENT') return res.status(404).type('text/plain').send('Not found');
    log.error(`GET ${req.originalUrl} failed: ${error.stack ?? error.message}`);
    return res.status(500).type('text/plain').send('Internal server error');
  });
});

app.use(express.static(config.publicDir, { extensions: ['html'], maxAge: '0s', mustRevalidate: true }));

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

// Liveness only: this returns the moment the process is listening, which is what
// a restart decision needs. Readiness is /api/ready, because a container that
// accepts traffic before Chromium can launch fails the first render.
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

app.get('/api/ready', async (req, res) => {
  try {
    const browser = await probeBrowser();
    res.json({
      ok: true,
      browser,
      fonts: hasBundledFonts() ? 'bundled' : 'system',
      render: stats(),
    });
  } catch (error) {
    log.warn(`readiness probe failed: ${error.message}`);
    res.status(503).json({ ok: false, error: 'Browser is not available yet' });
  }
});

app.post('/api/cover', rateLimit, async (req, res) => {
  try {
    const result = await generateCover(req.body?.repo, {
      options: req.body,
      origin: requestOrigin(req),
    });
    // Same reasoning as the stream: the PNG is addressable at /covers, so the
    // response carries metadata only.
    const { buffer, ...payload } = result;
    res.json({ ...payload, image: `/covers/${result.fileName}` });
  } catch (error) {
    log.warn(`POST /api/cover failed: ${error.message}`);
    failWith(res, error);
  }
});

// Direct PNG access. `/api/cover.png?repo=owner/name` is the only URL a README
// needs, so this is the primary interface and the web UI is a client of it.
app.get('/api/cover.png', rateLimit, async (req, res) => {
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
app.get('/api/stream', rateLimit, async (req, res) => {
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
    // The buffer is dropped deliberately. JSON.stringify expands a Buffer into a
    // byte array, which turned a 486 kB cover into a 1.75 MB event, and every
    // stream client fetches the PNG from /covers anyway. The direct PNG endpoint
    // still uses it to skip a disk read.
    const { buffer, ...payload } = result;
    send('result', { ...payload, image: `/covers/${result.fileName}` });
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

// GitHub URL shortcut. Swapping the host on a github.com URL —
// https://github.com/brgjr10/pit-tv → https://gitphoto.com/brgjr10/pit-tv —
// lands on the web UI with the form pre-filled and rendering started. The
// optional /tree/branch segment mirrors GitHub's own branch URLs.
// `..` is rejected outright: a branch like `../../etc` would otherwise pass
// the character class and the redirect would carry it to the client.
const isValidRepoSegment = (segment) => /^[\w.-]+$/.test(segment) && !segment.includes('..');
app.get(['/:owner/:repo', '/:owner/:repo/tree/:branch'], (req, res) => {
  const { owner, repo, branch } = req.params;
  if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo)) {
    return res.status(404).type('text/plain').send('Not found');
  }
  // A malformed branch is rejected rather than silently dropped: the caller
  // asked for that branch, and answering 200 with a different one would hide
  // the mistake.
  if (branch && !isValidRepoSegment(branch)) {
    return res.status(404).type('text/plain').send('Not found');
  }
  const params = new URLSearchParams({ repo: `${owner}/${repo}` });
  if (branch) params.set('branch', branch);
  return res.redirect(302, `/?${params.toString()}`);
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(join(config.publicDir, 'index.html'));
});

// Body-parser errors arrive here before any route ran, and the default handler
// renders them as an HTML page with a stack trace attached.
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error.type === 'entity.too.large' || error.status === 413) {
    return res.status(413).json({ error: 'Request body too large (max 16kb)' });
  }
  if (error.type === 'entity.parse.failed' || error.status === 400) {
    return res.status(400).json({ error: 'Request body is not valid JSON' });
  }
  log.error(`${req.method} ${req.originalUrl} failed: ${error.stack ?? error.message}`);
  return res.status(error.status && error.status < 500 ? error.status : 500).json({ error: 'Internal server error' });
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
    // In-flight renders hold a page and write the cache on the way out, so
    // closing Chromium out from under them truncates the write. The backstop
    // timer still applies; draining only shortens the common case.
    const drained = await waitForIdle(8_000);
    if (!drained) log.warn('shutting down with renders still in flight');
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

  // Anonymous is a supported mode, so this is a diagnostic rather than a fatal
  // error: the token is optional, but without one GitHub answers 60 requests an
  // hour per IP and the render fails with a rate-limit error that looks like a
  // clone bug. Never log the value.
  if (!config.githubToken) {
    log.warn(
      'GITHUB_TOKEN is not set — falling back to anonymous GitHub API access ' +
        '(60 requests/hour per IP). Set GITHUB_TOKEN in the environment, or copy ' +
        '.env.example to .env and fill it in, to lift the limit and reach private repos. ' +
        'Do not commit that file.',
    );
  }
};

// Imported by the test suite, which needs the app without a listening socket or
// the background sweep timer.
export { app, server };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    log.error(`failed to start: ${error.stack ?? error.message}`);
    process.exit(1);
  });
}
