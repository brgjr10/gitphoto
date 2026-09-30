import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';
import { config } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { buildBannerHtml } from '../render/banner.js';
import { imageSize } from '../lib/image-size.js';
import { waitForImages } from '../lib/page-wait.js';
import { detectPreview } from './detect.js';
import { installDependencies } from './install.js';
import { startDevServer, startStaticServer } from './preview.js';

const log = createLogger('render');

// A README screenshot is often a multi-megabyte PNG. Inlining it as a data URI
// keeps the banner document self-contained, but not without a ceiling.
const MAX_INLINE_BYTES = 8 * 1024 * 1024;

// The app is captured at roughly 2x the frame it lands in, so downscaling to
// 1280x600 produces a sharper banner than capturing at final size would.
const APP_SHOT = { width: 1180, height: 850 };

const browser = { instance: null, launching: null };

const getBrowser = async () => {
  if (browser.instance?.isConnected()) return browser.instance;
  if (browser.launching) return browser.launching;

  browser.launching = chromium
    .launch({
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none', '--force-color-profile=srgb'],
    })
    .then((instance) => {
      // A crashed browser is replaced rather than surfaced: the next render
      // should not fail because an unrelated page segfaulted.
      instance.on('disconnected', () => {
        browser.instance = null;
        log.warn('Chromium disconnected, will relaunch on next render');
      });
      browser.instance = instance;
      return instance;
    })
    .finally(() => {
      browser.launching = null;
    });

  return browser.launching;
};

export const closeBrowser = async () => {
  const instance = browser.instance;
  browser.instance = null;
  if (instance) await instance.close().catch(() => {});
};

const newPage = async (browser, viewport) => {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    // Deterministic output: a random agent changes how some sites respond, and
    // the desktop UA keeps framework feature detection on the modern path.
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  // Third-party assets (analytics, fonts, chat widgets) are noise on a cover and
  // a common source of the long tail that blows the render budget.
  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    const url = route.request().url();
    if (type === 'media' || /googletagmanager|google-analytics|doubleclick|hotjar|segment\.io|intercom|sentry\.io/.test(url)) {
      return route.abort();
    }
    return route.continue();
  });
  return { context, page };
};

const fetchImageDataUri = async (url) => {
  if (url.startsWith('data:')) return { dataUri: url, size: null };
  const response = await fetch(url, {
    signal: AbortSignal.timeout(20_000),
    headers: { 'user-agent': 'gitphoto', accept: 'image/*' },
  });
  if (!response.ok) throw new Error(`image fetch returned ${response.status}`);

  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_INLINE_BYTES) throw new Error('image is too large to inline');

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_INLINE_BYTES) throw new Error('image is too large to inline');
  if (!response.headers.get('content-type')?.startsWith('image/') && !imageSize(buffer)) {
    throw new Error('response was not an image');
  }

  return {
    dataUri: `data:${response.headers.get('content-type') ?? 'image/png'};base64,${buffer.toString('base64')}`,
    size: imageSize(buffer),
  };
};

const settle = async (page, ms) => {
  if (ms > 0) await page.waitForTimeout(ms);
  await waitForImages(page);
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
};

/** Screenshots a running app: navigate, wait for it to settle, capture. */
const captureSite = async (url, { timeoutMs, settleMs = 1200 }) => {
  const engine = await getBrowser();
  const { context, page } = await newPage(engine, APP_SHOT);
  try {
    await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
    // networkidle is the best signal that a SPA has mounted, but a polling
    // backend means it may never fire, so it is best-effort with a hard cap.
    await page.waitForLoadState('networkidle', { timeout: Math.min(8000, timeoutMs) }).catch(() => {});
    await settle(page, settleMs);

    const buffer = await page.screenshot({ type: 'png' });
    if (buffer.length < 1500) throw new Error('capture came back empty');
    return buffer;
  } finally {
    await context.close().catch(() => {});
  }
};

/** Screenshots the composed banner document itself. */
const captureBanner = async (html) => {
  const engine = await getBrowser();
  const { context, page } = await newPage(engine, { width: config.bannerWidth, height: config.bannerHeight });
  try {
    await page.setContent(html, { waitUntil: 'load' });
    await page.waitForFunction(() => document.fonts.status === 'loaded', null, { timeout: 8000 }).catch(() => {});
    await waitForImages(page);
    return await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: config.bannerWidth, height: config.bannerHeight } });
  } finally {
    await context.close().catch(() => {});
  }
};

const realize = async (strategy, { dir, repo, deadline, onProgress }) => {
  const remaining = () => Math.max(3000, deadline - Date.now());

  if (strategy.kind === 'image') {
    onProgress({ stage: 'preview', detail: 'Fetching README screenshot' });
    const { dataUri, size } = await fetchImageDataUri(strategy.url);
    // A tall screenshot cropped to `top` keeps the app's header and primary UI.
    // A wide one (banner, diagram) must be contained or it loses both edges.
    const contain = size ? size.width / size.height > 1.5 : false;
    return { kind: 'image', dataUri, contain, label: strategy.label, source: strategy.url };
  }

  if (strategy.kind === 'static') {
    onProgress({ stage: 'preview', detail: `Serving ${strategy.rel}` });
    const server = await startStaticServer(strategy.file);
    try {
      const buffer = await captureSite(server.url, { timeoutMs: remaining(), settleMs: 1400 });
      return { kind: 'site', dataUri: `data:image/png;base64,${buffer.toString('base64')}`, label: strategy.label, address: `${repo.fullName}/${strategy.rel}` };
    } finally {
      await server.stop();
    }
  }

  if (strategy.kind === 'server') {
    onProgress({ stage: 'preview', detail: 'Installing dependencies' });
    const install = await installDependencies(dir, { budgetMs: Math.min(remaining(), 180_000) });
    if (!install.ok) throw new Error(`install failed: ${install.log}`);

    onProgress({
      stage: 'preview',
      detail: install.cached ? 'Reusing node_modules' : `Starting ${strategy.command}`,
    });
    const server = await startDevServer(dir, strategy, { budgetMs: Math.min(remaining(), 60_000) });
    if (!server.ready) throw new Error(`dev server did not start (${server.reason})${server.log ? `: ${server.log}` : ''}`);
    try {
      const buffer = await captureSite(server.url, { timeoutMs: remaining(), settleMs: 1800 });
      return { kind: 'site', dataUri: `data:image/png;base64,${buffer.toString('base64')}`, label: strategy.label, address: server.url };
    } finally {
      await server.stop();
    }
  }

  if (strategy.kind === 'code') {
    onProgress({ stage: 'preview', detail: 'Reading source' });
    return { kind: 'code', rel: strategy.rel, code: strategy.code, label: strategy.label };
  }

  throw new Error(`unknown strategy: ${strategy.kind}`);
};

const inlineAvatar = async (avatarUrl) => {
  try {
    const { dataUri } = await fetchImageDataUri(avatarUrl);
    return dataUri;
  } catch (error) {
    // A missing avatar must not sink the render; the frame falls back to a
    // neutral initial block.
    log.debug(`avatar unavailable: ${error.message}`);
    return null;
  }
};

/**
 * Renders a 1280x600 cover PNG for a cloned repository.
 * Walks the detected strategies in confidence order and stops at the first one
 * that produces a usable image, so a broken dev server costs a fallback rather
 * than a failed request.
 */
export const renderCover = async ({ repo, dir, commit, onProgress = () => {}, htmlPath = null, theme = 'dark' }) => {
  const started = Date.now();
  const deadline = started + config.renderTimeoutMs;

  onProgress({ stage: 'detect', detail: 'Inspecting repository' });
  const { strategies, framework, explain, logo } = await detectPreview(dir, repo);

  let chosen = null;
  const attempts = [];

  for (const strategy of strategies) {
    if (chosen) break;
    if (strategy.requiresInstall && !config.allowInstalls) {
      attempts.push({ kind: strategy.kind, ok: false, reason: 'installs disabled (ALLOW_INSTALLS=false)' });
      continue;
    }
    if (Date.now() >= deadline) {
      attempts.push({ kind: strategy.kind, ok: false, reason: 'render budget exhausted' });
      break;
    }

    try {
      chosen = await realize(strategy, { dir, repo, deadline, onProgress });
      attempts.push({ kind: strategy.kind, ok: true });
    } catch (error) {
      const reason = String(error.message ?? error).slice(0, 160);
      log.warn(`strategy ${strategy.kind} failed: ${reason}`);
      attempts.push({ kind: strategy.kind, ok: false, reason });
    }
  }

  if (!chosen) {
    chosen = { kind: 'none', reason: 'Nothing renderable was found in this repository' };
  }

  onProgress({ stage: 'compose', detail: 'Composing cover' });
  const enrichedRepo = { ...repo, avatarDataUri: await inlineAvatar(repo.avatarUrl) };
  const logoDataUri = logo ? (await fetchImageDataUri(logo.url)).dataUri : null;
  const html = await buildBannerHtml({ repo: enrichedRepo, preview: chosen, commit, theme, logo: logoDataUri ? { dataUri: logoDataUri, alt: logo.alt } : null });
  // Keeping the intermediate document is the only way to inspect a layout
  // change without reverse-engineering it from the flattened PNG.
  if (htmlPath) await writeFile(htmlPath, html, 'utf8');
  const buffer = await captureBanner(html);

  log.info(
    `Rendered ${repo.fullName} via ${chosen.kind} in ${Date.now() - started}ms (${(buffer.length / 1024).toFixed(0)} kB)`,
  );

  return {
    buffer,
    strategy: chosen.kind,
    label: chosen.label ?? null,
    source: chosen.source ?? chosen.address ?? chosen.rel ?? null,
    framework,
    explain,
    attempts,
    durationMs: Date.now() - started,
  };
};
