import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { createLogger } from '../lib/logger.js';
import { runCommand } from './workspace.js';

const log = createLogger('install');

// Install ordering follows the lockfile. `npm ci` is deterministic and much
// faster when a lockfile exists; the other managers have no equivalent flag.
// LOCKFILES is the single list both this module and the strategy detector read,
// so a new package manager cannot be half-supported.
export const LOCKFILES = ['pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'yarn.lock', 'package-lock.json'];

const INSTALL_COMMANDS = {
  'pnpm-lock.yaml': ['pnpm', ['install', '--prefer-offline']],
  'bun.lock': ['bun', ['install', '--frozen-lockfile']],
  'bun.lockb': ['bun', ['install', '--frozen-lockfile']],
  'yarn.lock': ['yarn', ['install', '--frozen-lockfile', '--non-interactive']],
  'package-lock.json': ['npm', ['ci', '--no-audit', '--no-fund']],
};

const DEFAULT_INSTALL = ['npm', ['install', '--no-audit', '--no-fund']];

const markerExists = async (dir, name) => {
  try {
    await stat(join(dir, name));
    return true;
  } catch {
    return false;
  }
};

/**
 * Installs a repo's node dependencies. Only reached when ALLOW_INSTALLS is on,
 * because installs execute third-party lifecycle scripts and dominate render time.
 * Returns `{ ok, log }` and never throws.
 */
export const installDependencies = async (dir, { budgetMs }) => {
  if (await markerExists(dir, 'node_modules')) {
    log.debug('node_modules present, skipping install');
    return { ok: true, cached: true };
  }

  const present = await Promise.all(LOCKFILES.map((name) => markerExists(dir, name)));
  const lock = LOCKFILES.find((name, index) => present[index]);
  const [command, args] = lock ? INSTALL_COMMANDS[lock] : DEFAULT_INSTALL;

  const started = Date.now();
  const result = await runCommand(command, args, {
    cwd: dir,
    timeoutMs: budgetMs,
    env: { npm_config_yes: 'true', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1', CYPRESS_INSTALL_BINARY: '0' },
  });

  const ok = result.code === 0;
  const detail = result.stderr.trim().split('\n').slice(-6).join(' | ');
  log.info(`${command} ${args.join(' ')} -> ${result.code} in ${Date.now() - started}ms`);
  return { ok, log: ok ? 'already installed' : detail || 'non-zero exit' };
};
