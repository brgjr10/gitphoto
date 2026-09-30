import { chromium } from 'playwright';
import { config } from '../src/config.js';
import { waitForImages } from '../src/lib/page-wait.js';
import { pathToFileURL } from 'node:url';

/**
 * Geometry audit for the banner document.
 *
 * Layout regressions in a screenshot are invisible in code review and the only
 * way to catch them without eyes on the PNG is to assert the invariants. Run
 * with a rendered banner path: node scripts/verify-layout.mjs <banner.html> [label]
 */
const file = process.argv[2];
const label = process.argv[3] ?? 'banner';
if (!file) {
  console.error('usage: node scripts/verify-layout.mjs <banner.html> [label]');
  process.exit(1);
}

// Injected into the page so the overflow thresholds cannot drift from config.
const EDGE = { right: config.bannerWidth, bottom: config.bannerHeight };

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: config.bannerWidth, height: config.bannerHeight } });
await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
await page.waitForFunction(() => document.fonts.status === 'loaded', null, { timeout: 8000 }).catch(() => {});
await waitForImages(page);

const report = await page.evaluate((EDGE) => {
  const box = (selector) => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return {
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.width), h: Math.round(rect.height),
    };
  };
  const styles = (selector, prop) => {
    const node = document.querySelector(selector);
    return node ? getComputedStyle(node)[prop] : null;
  };
  const lineCount = (selector) => {
    const node = document.querySelector(selector);
    if (!node) return 0;
    const lh = Number.parseFloat(getComputedStyle(node).lineHeight) || 1;
    return Math.round(node.getBoundingClientRect().height / lh);
  };
  const images = [...document.images].map((img) => ({
    src: img.className || 'img',
    loaded: img.complete && img.naturalWidth > 0,
    natural: `${img.naturalWidth}x${img.naturalHeight}`,
  }));

  return {
    cover: box('.cover'),
    meta: box('.meta'),
    stage: box('.stage'),
    frame: box('.frame'),
    viewport: box('.viewport'),
    name: { ...box('.name'), fontSize: styles('.name', 'fontSize'), clipped: (() => {
      const n = document.querySelector('.name');
      return n ? n.scrollWidth > n.clientWidth + 1 : false;
    })() },
    descriptionLines: lineCount('.description'),
    descriptionText: document.querySelector('.description')?.textContent ?? '',
    commit: box('.commit'),
    langbar: box('.langbar'),
    previewKind: document.querySelector('.viewport')?.dataset.preview ?? null,
    bodyOverflow: {
      scrollW: document.documentElement.scrollWidth,
      scrollH: document.documentElement.scrollHeight,
    },
    images,
    fontInUse: styles('.name', 'fontFamily'),
    // document.fonts.check() returns true for unknown families, so the loaded
    // face list is the only trustworthy signal that the webfont actually applied.
    loadedFaces: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => `${f.family}@${f.weight}`),
    // Any element past an edge is an overflow, which the screenshot would crop.
    // The scan covers the whole document, not just .cover, so a stray injected
    // node or a default margin is caught rather than assumed away.
    widest: [...document.querySelectorAll('body, body *')]
      .map((n) => ({ tag: `${n.tagName}.${n.className}`, right: Math.round(n.getBoundingClientRect().right) }))
      .filter((n) => n.right > EDGE.right)
      .slice(0, 5),
    // Any element taller than the canvas is a vertical overflow.
    tallest: [...document.querySelectorAll('body, body *')]
      .map((n) => ({ tag: `${n.tagName}.${n.className}`, bottom: Math.round(n.getBoundingClientRect().bottom) }))
      .sort((a, b) => b.bottom - a.bottom)
      .slice(0, 5),
  };
}, EDGE);

// Compared without punctuation or case: a family name is only "active" if the
// loaded face list carries it, and the check must not be defeated by a rename
// of the @font-face identifier.
const hasLoadedFace = (name) => {
  const target = name.toLowerCase().replace(/[^a-z]/g, '');
  return report.loadedFaces.some((face) => face.toLowerCase().replace(/[^a-z]/g, '').startsWith(target));
};

const checks = [
  [
    `cover is exactly ${config.bannerWidth}x${config.bannerHeight}`,
    report.cover?.w === config.bannerWidth && report.cover?.h === config.bannerHeight,
    JSON.stringify(report.cover),
  ],
  ['no horizontal scroll', report.bodyOverflow.scrollW <= config.bannerWidth, `scrollW=${report.bodyOverflow.scrollW}`],
  [
    'no vertical scroll',
    report.bodyOverflow.scrollH <= config.bannerHeight,
    `scrollH=${report.bodyOverflow.scrollH} tallest=${JSON.stringify(report.tallest[0])}`,
  ],
  ['no element past the right edge', report.widest.length === 0, JSON.stringify(report.widest)],
  ['meta column keeps its width', report.meta?.w === 468, JSON.stringify(report.meta)],
  ['frame fills the stage', report.frame?.h > 300, JSON.stringify(report.frame)],
  ['preview viewport has height', report.viewport?.h > 200, JSON.stringify(report.viewport)],
  ['repo name is not clipped', report.name?.clipped === false, `fontSize=${report.name?.fontSize}`],
  ['description is clamped to 3 lines', report.descriptionLines <= 3, `${report.descriptionLines} lines`],
  ['preview body is present', report.previewKind !== null, String(report.previewKind)],
  ['all images decoded', report.images.every((i) => i.loaded), JSON.stringify(report.images)],
  ['bundled Inter is active', hasLoadedFace('inter'), String(report.fontInUse)],
  ['bundled JetBrains Mono is active', hasLoadedFace('jetbrainsmono'), report.loadedFaces.join(', ')],
];

let failed = 0;
console.log(`\nlayout audit: ${label}\n${'-'.repeat(72)}`);
for (const [name, pass, detail] of checks) {
  if (!pass) failed += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(38)} ${detail}`);
}
console.log(`${'-'.repeat(72)}\n${checks.length - failed}/${checks.length} passed\n`);

await browser.close();
process.exit(failed === 0 ? 0 : 1);
