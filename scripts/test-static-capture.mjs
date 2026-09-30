import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startStaticServer } from '../src/services/preview.js';
import { imageSize } from '../src/lib/image-size.js';

// Exercises the two paths a public repo cannot be relied upon to produce:
// serving a static entry point off disk, and screenshotting it. A blank capture
// is the failure that would otherwise ship unnoticed, so it is asserted by
// counting distinct colours rather than by file size.
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { margin:0; font-family:system-ui,sans-serif; background:#0d1117; color:#e6edf3; }
  header { padding:22px 28px; background:#161b22; border-bottom:1px solid #30363d; font-weight:700; font-size:20px; }
  main { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; padding:24px 28px; }
  .card { height:150px; border-radius:10px; display:flex; align-items:center; justify-content:center; font-size:15px; font-weight:600; }
</style></head>
<body>
  <header>Fixture Application</header>
  <main>
    <div class="card" style="background:#1f6feb">Requests 1,284</div>
    <div class="card" style="background:#238636">Healthy</div>
    <div class="card" style="background:#9e6a03">Queue 42</div>
  </main>
</body></html>`;

const dir = await mkdtemp(join(tmpdir(), 'gitphoto-fixture-'));
await mkdir(join(dir, 'assets'), { recursive: true });
const entry = join(dir, 'index.html');
await writeFile(entry, PAGE, 'utf8');
await writeFile(join(dir, 'assets', 'nested.txt'), 'sibling asset', 'utf8');

const server = await startStaticServer(entry);
let failures = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failures += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${detail}`);
};

try {
  // A crafted path must not read outside the served document root. A browser
  // would normalise `..` away before sending, so the request is issued raw,
  // which is what an actual attacker or a misconfigured client would do.
  const raw = await new Promise((resolveRequest) => {
    const request = http.get(
      { host: '127.0.0.1', port: server.port, path: '/../../../../../../etc/passwd' },
      (response) => {
        let body = '';
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => resolveRequest({ status: response.statusCode, body }));
      },
    );
    request.on('error', (error) => resolveRequest({ status: 0, body: error.message }));
  });
  check(
    'path traversal cannot read outside the document root',
    !raw.body.includes('root:') && raw.body === PAGE,
    `status=${raw.status} served the entry document instead of a filesystem read`,
  );

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1180, height: 850 } });

  // A deep link must fall through to the entry document, not 404, because SPAs
  // own their own routing.
  const deep = await page.goto(`${server.url}/dashboard/settings`, { waitUntil: 'load' });
  check('deep link falls back to the entry page', deep.status() === 200, `status=${deep.status()}`);

  await page.goto(server.url, { waitUntil: 'load' });
  const shot = await page.screenshot({ type: 'png' });
  const size = imageSize(shot);
  check('capture matches the requested viewport', size?.width === 1180 && size?.height === 850, JSON.stringify(size));
  check('capture is not a flat fill', shot.length > 8000, `${(shot.length / 1024).toFixed(1)} kB`);

  // Distinct-colour count is the real "is anything actually rendered" signal.
  const dataUri = `data:image/png;base64,${shot.toString('base64')}`;
  const colours = await page.evaluate(async (uri) => {
    const img = new Image();
    img.src = uri;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const seen = new Set();
    for (let i = 0; i < data.length; i += 4 * 37) {
      seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    }
    return seen.size;
  }, dataUri);
  check('capture contains varied content', colours > 8, `${colours} distinct colours sampled`);

  await browser.close();
} finally {
  await server.stop();
  await rm(dir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? 'all static-capture checks passed' : `${failures} check(s) failed`}\n`);
process.exit(failures === 0 ? 0 : 1);
