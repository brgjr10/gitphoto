import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { config, ensureDataDirs } from '../config.js';
import { createCoverCache } from '../lib/cover-cache.js';
import { createLogger } from '../lib/logger.js';
import { createSemaphore } from '../lib/semaphore.js';
import { buildMarkdown } from '../lib/markdown.js';
import { getRepository, parseRepoRef } from './github.js';
import { renderCover } from './renderer.js';
import { cloneRepo, removeClone, sweepStaleClones, touchClone } from './workspace.js';

const log = createLogger('pipeline');

const cache = createCoverCache(config.cacheDir, config.cacheTtlMs);
const gate = createSemaphore(config.renderConcurrency);

const noop = () => {};

// Query strings and JSON bodies both arrive as strings, and a truthiness check
// on "false" is true. This is the only place options are coerced, so the HTTP
// layer passes its input through untouched.
const asBoolean = (value) =>
  value === true || ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());

export const normalizeOptions = (input = {}) => ({
  theme: input.theme === 'light' ? 'light' : 'dark',
  branch: typeof input.branch === 'string' && input.branch.trim() ? input.branch.trim().slice(0, 80) : null,
  refresh: asBoolean(input.refresh),
});

/**
 * Produces a cover PNG for a repository reference.
 *
 * The cache key folds in `pushed_at` rather than the head SHA: a single extra
 * API call per request buys nothing when the same field already tells us whether
 * the cached render is still current.
 */
export const generateCover = async (ref, { options = {}, origin = '', onProgress = noop, htmlPath = null } = {}) => {
  await ensureDataDirs();
  const { owner, repo } = parseRepoRef(ref);
  const settings = normalizeOptions(options);

  onProgress({ stage: 'meta', detail: 'Reading repository metadata' });
  const meta = await getRepository({ owner, repo });
  const branch = settings.branch ?? meta.defaultBranch;

  const key = cache.keyFor([meta.fullName, branch, settings.theme, meta.pushedAt ?? '0']);

  if (!settings.refresh) {
    const hit = await cache.get(key);
    if (hit) {
      log.debug(`cache hit ${meta.fullName}@${branch} (${settings.theme})`);
      onProgress({ stage: 'done', detail: 'Served from cache' });
      return { ...hit, cached: true, meta };
    }
  }

  onProgress({ stage: 'clone', detail: `Cloning ${meta.fullName}@${branch}` });

  return gate.run(async () => {
    const clone = await cloneRepo({ owner, repo, branch });

    try {
      await touchClone(clone.dir);
      const result = await renderCover({
        repo: { ...meta, defaultBranch: branch },
        dir: clone.dir,
        commit: { sha: clone.sha, subject: clone.subject, committedAt: clone.committedAt },
        theme: settings.theme,
        htmlPath,
        onProgress,
      });

      const fileName = `${key}.png`;
      await writeFile(coverPath(fileName), result.buffer);

      const payload = {
        fileName,
        bytes: result.buffer.length,
        width: config.bannerWidth,
        height: config.bannerHeight,
        theme: settings.theme,
        branch,
        strategy: result.strategy,
        label: result.label,
        source: result.source,
        framework: result.framework,
        explain: result.explain,
        attempts: result.attempts,
        durationMs: result.durationMs,
        fullName: meta.fullName,
        owner: meta.owner,
        name: meta.name,
        description: meta.description,
        url: meta.url,
        stars: meta.stars,
        primaryLanguage: meta.primaryLanguage,
        markdown: buildMarkdown({ origin, fileName, fullName: meta.fullName, description: meta.description }),
      };

      // The buffer is intentionally not cached: a few hundred kilobytes per
      // entry would dominate the cache dir. Consumers read it back from disk.
      await cache.set(key, payload);
      onProgress({ stage: 'done', detail: `Rendered via ${result.strategy}` });
      return { ...payload, buffer: result.buffer, cached: false, meta };
    } finally {
      await removeClone(clone.dir);
    }
  });
};

/** Absolute path for a cover filename. Filenames are content hashes, so this is total. */
export const coverPath = (fileName) => join(config.outputDir, basename(fileName));

let sweepTimer = null;

export const startBackgroundTasks = () => {
  if (sweepTimer) return;
  // Runs hourly. `unref` keeps the timer from holding the process open on exit.
  sweepTimer = setInterval(() => {
    sweepStaleClones().catch((error) => log.warn(`clone sweep failed: ${error.message}`));
  }, 60 * 60 * 1000);
  sweepTimer.unref();
};

export const stats = () => ({ active: gate.active, queued: gate.pending, limit: config.renderConcurrency });

// Shutdown drains through this instead of closing the browser mid-render, which
// would leave a half-written PNG in the covers directory.
export const waitForIdle = (timeoutMs) =>
  new Promise((resolvePromise) => {
    if (gate.active === 0 && gate.pending === 0) return resolvePromise(true);
    const deadline = Date.now() + timeoutMs;
    const poll = setInterval(() => {
      if (gate.active === 0 && gate.pending === 0) {
        clearInterval(poll);
        resolvePromise(true);
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        resolvePromise(false);
      }
    }, 100);
    poll.unref?.();
  });
