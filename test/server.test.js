import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { connect } from 'node:net';
import { dirname, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Importing the server must not bind a port or start the hourly sweep, which is
// why server.js only calls main() when it is the entrypoint.
const { app } = await import('../src/server.js');
const { closeBrowser } = await import('../src/services/renderer.js');
const { createServer } = await import('node:http');

let base;
let server;

before(async () => {
  server = createServer(app);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((done) => server.close(done));
  // The readiness probe leaves a real Chromium process behind.
  await closeBrowser();
});

/**
 * curl and fetch normalize `..` out of a path before it hits the wire, so the
 * traversal case has to be spoken raw over a socket to reach the route.
 */
const rawRequest = async (path, method = 'GET') =>
  new Promise((done, fail) => {
    const { port } = new URL(base);
    const socket = connect(Number(port), '127.0.0.1', () => {
      socket.write(`${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let raw = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      raw += chunk;
    });
    socket.on('error', fail);
    socket.on('end', () => done(raw));
  });

const statusOf = (raw) => Number(raw.split(' ')[1]);
const bodyOf = (raw) => raw.slice(raw.indexOf('\r\n\r\n') + 4);

describe('/covers traversal containment', () => {
  it('answers a traversal attempt with 404, not the SPA', async () => {
    const raw = await rawRequest('/covers/../../.env');
    assert.equal(statusOf(raw), 404);
  });

  it('answers a percent-encoded traversal with 404', async () => {
    const raw = await rawRequest('/covers/%2e%2e%2f%2e%2e%2f.env');
    assert.equal(statusOf(raw), 404);
  });

  it('answers an absolute-looking escape with 404', async () => {
    const raw = await rawRequest('/covers/..%5c..%5c.env');
    assert.equal(statusOf(raw), 404);
  });
});

describe('missing cover file', () => {
  it('returns 404 rather than a 500 with a stack trace', async () => {
    const res = await fetch(`${base}/covers/definitely-not-a-real-cover.png`);
    assert.equal(res.status, 404);
    const body = await res.text();
    assert.ok(!body.includes('ENOENT'), 'body must not name the filesystem error');
    assert.ok(!body.includes('at Object.'), 'body must not contain a stack frame');
    assert.ok(!body.includes('\\gitphoto\\'), 'body must not disclose an internal path');
  });
});

describe('response headers', () => {
  it('sets the hardening headers on every response', async () => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  });
});

describe('request body limit', () => {
  it('returns a JSON 413 instead of an HTML error page', async () => {
    const res = await fetch(`${base}/api/cover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo: 'a'.repeat(20 * 1024) }),
    });
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: 'Request body too large (max 16kb)' });
  });
});

describe('readiness probe', () => {
  it('reports readiness separately from liveness', async () => {
    const ready = await fetch(`${base}/api/ready`);
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.ok(ready.status === 200 || ready.status === 503);
    assert.equal(typeof (await ready.json()).ok, 'boolean');
  });
});

describe('GitHub URL shortcut', () => {
  it('redirects /owner/repo to the web UI with the form pre-filled', async () => {
    const res = await fetch(`${base}/brgjr10/pit-tv`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/?repo=brgjr10%2Fpit-tv');
  });

  it('redirects /owner/repo/tree/branch with the branch filled in', async () => {
    const res = await fetch(`${base}/brgjr10/pit-tv/tree/main`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/?repo=brgjr10%2Fpit-tv&branch=main');
  });

  it('answers a segment with an invalid character with 404', async () => {
    const res = await fetch(`${base}/brgjr%2F10/pit-tv`, { redirect: 'manual' });
    assert.equal(res.status, 404);
  });

  it('answers a branch containing `..` with 404', async () => {
    const raw = await rawRequest('/brgjr10/pit-tv/tree/feat..urel');
    assert.equal(statusOf(raw), 404);
  });

  it('answers a traversal attempt with 404, not the SPA', async () => {
    const raw = await rawRequest('/brgjr10/pit-tv/tree/..%2f..%2f.env');
    assert.equal(statusOf(raw), 404);
  });

  it('leaves API routes alone', async () => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
  });
});

describe('secret hygiene (GITPHOTO-001 regression)', () => {
  // A PAT body, in either the classic or the fine-grained form.
  const TOKEN_PATTERN = '(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})';

  it('has no GitHub token pattern in any tracked file', () => {
    let stdout = '';
    let failed = false;
    try {
      stdout = execFileSync('git', ['grep', '-IlE', TOKEN_PATTERN], { cwd: ROOT, encoding: 'utf8' });
    } catch (error) {
      // git grep exits 1 for "no match", which is the pass case.
      if (error.status !== 1) throw error;
      failed = true;
    }
    assert.ok(failed || stdout.trim() === '', `token pattern found in tracked files: ${stdout.trim()}`);
  });

  it('keeps .env ignored and .env.example without a value', () => {
    const ignored = execFileSync('git', ['check-ignore', '.env'], { cwd: ROOT, encoding: 'utf8' }).trim();
    assert.match(ignored, /\.env$/);
    const example = execFileSync('git', ['show', 'HEAD:.env.example'], { cwd: ROOT, encoding: 'utf8' });
    assert.match(example, /^GITHUB_TOKEN=\s*$/m);
  });
});