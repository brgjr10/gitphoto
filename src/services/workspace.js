import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('workspace');

// On Windows the package managers are .cmd shims, which spawn cannot resolve on
// its own, and `shell: true` is deprecated for argument arrays. Routing through
// ComSpec explicitly avoids both. Arguments are quoted rather than joined
// blindly so a path with spaces cannot split into two arguments.
const NEEDS_QUOTING = /[\s"&|<>^%!]/;

const wrapForPlatform = (command, args) => {
  if (process.platform !== 'win32') return { file: command, args };
  const line = [command, ...args]
    .map((arg) => (NEEDS_QUOTING.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg))
    .join(' ');
  return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', line] };
};

/**
 * Starts a child process and captures its output. Shared by the clone and
 * install paths so neither has to know about Windows shims.
 */
export const spawnTool = (command, args, { cwd, env, stdio } = {}) => {
  const { file, args: resolved } = wrapForPlatform(command, args);
  return spawn(file, resolved, {
    cwd,
    env: { ...process.env, ...env },
    windowsHide: true,
    // Detached on POSIX puts the child in its own process group, which is what
    // makes killTree able to take down a dev server's whole tree.
    detached: process.platform !== 'win32',
    stdio: stdio ?? ['ignore', 'pipe', 'pipe'],
  });
};

/**
 * Kills a child and everything it started.
 *
 * Signalling the process directly leaves grandchildren alive: `npm run dev` puts
 * the actual server in a grandchild, which would keep holding the port after the
 * render finished. POSIX signals the process group; Windows has no group signal,
 * so taskkill /T is used instead.
 */
export const killTree = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === 'win32') {
    await new Promise((done) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      killer.once('exit', done);
      killer.once('error', done);
    });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
};

const run = (command, args, { cwd, timeoutMs = 120_000, env } = {}) =>
  new Promise((resolve) => {
    const child = spawnTool(command, args, { cwd, env: { GIT_TERMINAL_PROMPT: '0', ...env } });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: error.message });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });

// A clone is removed when its render finishes, but a crash or a killed process
// leaves the directory behind, and an unattended service should not grow
// without bound. Anything untouched for a full TTL is swept.
const IDLE_SWEEP_MS = 60 * 60 * 1000;

export const sweepStaleClones = async () => {
  const { readdir } = await import('node:fs/promises');
  let entries = [];
  try {
    entries = await readdir(config.cloneDir, { withFileTypes: true });
  } catch {
    return 0;
  }

  const now = Date.now();
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(config.cloneDir, entry.name);
    try {
      const info = await stat(path);
      if (now - info.mtimeMs < IDLE_SWEEP_MS) continue;
      await rm(path, { recursive: true, force: true });
      removed += 1;
    } catch {
      // A clone being actively written is expected to disappear mid-sweep.
    }
  }
  if (removed > 0) log.info(`Swept ${removed} stale clone(s)`);
  return removed;
};

export const cloneRepo = async ({ owner, repo, branch }) => {
  // The directory must be unique per call, not per repo. Nothing ever reuses a
  // clone (each call starts from scratch and the pipeline deletes it afterwards),
  // so a stable name bought nothing while letting two concurrent renders of the
  // same repo share one path. The loser's `rm -rf` then deleted the winner's
  // in-flight pack, which git reports as "fetch-pack: invalid index-pack output".
  const dir = join(config.cloneDir, `${owner}__${repo}__${randomBytes(4).toString('hex')}`);
  await mkdir(config.cloneDir, { recursive: true });

  const auth = process.env.GITHUB_TOKEN
    ? `https://x-access-token:${process.env.GITHUB_TOKEN}@github.com`
    : 'https://github.com';

  const started = Date.now();
  const result = await run('git', [
    'clone',
    '--depth', '1',
    '--single-branch',
    '--no-tags',
    '--config', 'core.symlinks=false',
    // Submodules double the clone time and are almost never what a cover shows.
    '--recurse-submodules=no',
    '--branch', branch,
    `${auth}/${owner}/${repo}.git`,
    dir,
  ], { timeoutMs: 120_000 });

  if (result.code !== 0) {
    await rm(dir, { recursive: true, force: true });
    const reason = result.timedOut ? 'timed out' : result.stderr.trim().split('\n').pop() || 'unknown error';
    throw new Error(`git clone failed: ${reason}`);
  }

  const { stdout: sha } = await run('git', ['rev-parse', 'HEAD'], { cwd: dir, timeoutMs: 10_000 });
  const { stdout: subject } = await run('git', ['log', '-1', '--pretty=%s'], { cwd: dir, timeoutMs: 10_000 });
  const { stdout: date } = await run('git', ['log', '-1', '--pretty=%cI'], { cwd: dir, timeoutMs: 10_000 });

  log.info(`Cloned ${owner}/${repo}@${branch} in ${Date.now() - started}ms`);
  return { dir, sha: sha.trim(), subject: subject.trim(), committedAt: date.trim() };
};

// Touching the directory updates mtimeMs, which is what sweepStaleClones reads.
export const touchClone = async (dir) => {
  const { utimes } = await import('node:fs/promises');
  const now = new Date();
  await utimes(dir, now, now).catch(() => {});
};

export const removeClone = async (dir) => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
};

export { run as runCommand };
