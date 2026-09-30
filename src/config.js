import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Renders are the expensive part of this service, so the ceiling has to cover a
// cold `npm ci` on a large repo. Anything slower than this is a broken app, not
// a slow one, and the client is better served by a fallback than by a hang.
const num = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const dataDir = isAbsolute(process.env.DATA_DIR || '') ? process.env.DATA_DIR : join(ROOT, process.env.DATA_DIR || './data');

export const config = {
  publicDir: join(ROOT, 'public'),
  fontDir: join(ROOT, 'assets', 'fonts'),
  dataDir,
  cloneDir: join(dataDir, 'clones'),
  outputDir: join(dataDir, 'covers'),
  cacheDir: join(dataDir, 'cache'),

  port: num(process.env.PORT, 9780),
  githubToken: process.env.GITHUB_TOKEN || '',
  renderTimeoutMs: num(process.env.RENDER_TIMEOUT_MS, 90_000),
  cacheTtlMs: num(process.env.CACHE_TTL_MS, 6 * 60 * 60 * 1000),
  renderConcurrency: num(process.env.RENDER_CONCURRENCY, 2),
  allowInstalls: bool(process.env.ALLOW_INSTALLS, false),

  // Fixed output geometry. GitHub renders README images inline, so anything
  // narrower than this ends up soft on retina displays.
  bannerWidth: 1280,
  bannerHeight: 640,
};

export const hasBundledFonts = () => existsSync(join(config.fontDir, 'fonts.inline.css'));

export const ensureDataDirs = async () => {
  const { mkdir } = await import('node:fs/promises');
  await Promise.all([config.cloneDir, config.outputDir, config.cacheDir].map((dir) => mkdir(dir, { recursive: true })));
};
