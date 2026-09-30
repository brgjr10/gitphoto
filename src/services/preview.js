import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import net from 'node:net';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { createLogger } from '../lib/logger.js';
import { killTree, spawnTool } from './workspace.js';

const log = createLogger('preview');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.map': 'application/json', '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
};

/**
 * Serves one HTML entry point with the rest of the clone on the same origin.
 * The entry file can sit in a subdirectory, so the document root is derived from
 * it and every request is confined to that subtree.
 */
export const startStaticServer = (entryFile) =>
  new Promise((resolveServer, reject) => {
    const docRoot = dirname(entryFile);
    const entryName = entryFile.slice(docRoot.length + sep.length) || 'index.html';

    const server = createServer(async (req, res) => {
      const send = (status, body, headers = {}) => {
        res.writeHead(status, { 'cache-control': 'no-store', ...headers });
        res.end(body);
      };

      try {
        const url = new URL(req.url, 'http://localhost');
        const pathname = decodeURIComponent(url.pathname) || `/${entryName}`;

        // Resolve before serving: a crafted `..` must not escape the clone, and
        // only an already-normalised path can be compared against the root.
        const requested = resolve(join(docRoot, normalize(pathname)));
        if (requested !== docRoot && !requested.startsWith(docRoot + sep)) {
          return send(403, 'Forbidden');
        }

        let filePath = requested;
        try {
          const info = await stat(filePath);
          if (info.isDirectory()) filePath = join(filePath, 'index.html');
        } catch {
          // Single-page apps own their own routing, so an unknown path returns
          // the entry document instead of 404ing every deep link.
          filePath = entryFile;
        }

        const body = await readFile(filePath);
        send(200, body, { 'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream' });
      } catch (error) {
        send(500, String(error.message ?? error));
      }
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      log.debug(`Static server 127.0.0.1:${port} -> ${entryFile}`);
      resolveServer({
        url: `http://127.0.0.1:${port}`,
        port,
        stop: () => new Promise((done) => server.close(done)),
      });
    });
  });

const canConnect = ({ port, host = '127.0.0.1' }) =>
  new Promise((settle) => {
    const socket = net.connect({ port, host });
    const finish = (reachable) => {
      socket.removeAllListeners();
      socket.destroy();
      settle(reachable);
    };
    socket.setTimeout(2000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });

const waitForPort = async (port, { timeoutMs = 60_000 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect({ port })) return true;
    await new Promise((r) => setTimeout(r, 350));
  }
  return false;
};

// Dev servers announce their port in incompatible formats, and several pick a
// random one. The child's own output is the only reliable source.
const PORT_PATTERNS = [
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})/gi,
  /\blocal:\s*(?:https?:\/\/\S*)?:(\d{2,5})/gi,
  /\bport\s*[:=]\s*(\d{2,5})\b/gi,
];

const discoverPort = (hint, output) => {
  for (const pattern of PORT_PATTERNS) {
    for (const match of output.matchAll(pattern)) {
      const port = Number.parseInt(match[1], 10);
      if (port > 0 && port < 65536) return port;
    }
  }
  return Number.isInteger(hint) ? hint : null;
};

/**
 * Runs a package script and waits for its HTTP port to accept connections.
 * Returns `{ ready: false }` instead of throwing when the app never comes up, so
 * the caller can fall through to the next strategy rather than fail the render.
 */
export const startDevServer = async (dir, strategy, { budgetMs }) => {
  const [command, ...args] = strategy.command.split(/\s+/);
  const portHint = strategy.port ?? 3000;

  const child = spawnTool(command, args, {
    cwd: dir,
    env: {
      BROWSER: 'none', // Vite and friends must not try to open a real browser.
      PORT: String(portHint),
      HOST: '127.0.0.1',
      CI: '1',
      NODE_ENV: 'development',
    },
  });
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');

  let output = '';
  const collect = (chunk) => {
    output += chunk;
    if (output.length > 20_000) output = output.slice(-10_000);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  const exited = new Promise((done) => {
    child.once('exit', (code) => done(code));
    child.once('error', (error) => {
      collect(error.message);
      done(-1);
    });
  });

  const port = await discoverPort(portHint, output);
  if (port === null) {
    await killTree(child);
    await exited;
    return { ready: false, reason: 'no port announced', log: output.slice(-400) };
  }

  // Racing the exit event means a crashed dev server is detected immediately
  // instead of after the full port-probe timeout.
  const ready = await Promise.race([waitForPort(port, { timeoutMs: budgetMs }), exited.then(() => false)]);

  if (!ready) {
    await killTree(child);
    await exited;
    return { ready: false, reason: `port ${port} never opened`, log: output.slice(-400) };
  }

  log.info(`${strategy.command} ready on ${port}`);
  return {
    ready: true,
    url: `http://127.0.0.1:${port}`,
    log: output.slice(-400),
    // killTree, not kill: the dev server is a grandchild of this process and
    // would keep its port open after the render otherwise.
    stop: async () => {
      await killTree(child);
      await exited;
    },
  };
};
