import { readFile, readdir, stat } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import { imageSize } from '../lib/image-size.js';
import { createLogger } from '../lib/logger.js';
import { LOCKFILES } from './install.js';

const log = createLogger('detect');

const exists = (path) => access(path).then(() => true, () => false);

// Ordered by how reliably each strategy produces a screenshot worth putting on a
// cover. Cheap and near-certain strategies come first so the common case never
// pays for an install.
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'vendor', 'dist', 'build', 'out', 'coverage', '.next',
  '.nuxt', '.svelte-kit', '.venv', 'venv', 'target', 'bin', 'obj', '__pycache__',
  'test', 'tests', 'spec', 'docs', 'examples', 'fixtures', 'public/assets',
]);

const readJson = async (path) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
};

const walk = async (dir, { depth = 0, maxDepth = 3, limit = 4000 } = {}, acc = []) => {
  if (depth > maxDepth || acc.length >= limit) return acc;
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }

  for (const entry of entries) {
    if (acc.length >= limit) break;
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      await walk(full, { depth: depth + 1, maxDepth, limit }, acc);
    } else if (entry.isFile()) {
      acc.push(full);
    }
  }
  return acc;
};

const relativePosix = (dir, file) => relative(dir, file).split(sep).join('/');

// GitHub rewrites relative image links to raw.githubusercontent.com, so this
// mirrors that resolution rather than guessing.
const resolveReadmeImage = (src, repoFullName, branch) => {
  if (/^(https?:)?\/\//i.test(src) || src.startsWith('data:')) return src;
  const clean = src.replace(/^\.\//, '').split('#')[0].split('?')[0];
  if (clean.startsWith('/')) {
    return `https://raw.githubusercontent.com/${repoFullName}/${branch}${clean}`;
  }
  return `https://raw.githubusercontent.com/${repoFullName}/${branch}/${clean}`;
};

// README screenshots are the most honest "preview of the app" a repo usually has,
// and they cost one HTTP request instead of a build.
const readmeScreenshot = async (files, meta) => {
  const readme = files.find((file) => {
    const name = basename(file).toLowerCase();
    return name === 'readme.md' || name === 'readme.markdown' || name === 'readme.rst';
  });
  if (!readme) return null;

  let markdown;
  try {
    markdown = await readFile(readme, 'utf8');
  } catch {
    return null;
  }

  const references = [];
  for (const match of markdown.matchAll(/!\[([^\]]*)\]\(([^)\s]+)/g)) references.push({ alt: match[1], src: match[2] });
  for (const match of markdown.matchAll(/<img[^>]+alt=["']([^"']*)["'][^>]+src=["']([^"']+)["']/gi)) references.push({ alt: match[1], src: match[2] });
  for (const match of markdown.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]+alt=["']([^"']*)["']/gi)) references.push({ alt: match[2], src: match[1] });
  if (!references.length) return null;

  // Shallow clones skip nothing, but badges and logos live at the top of most
  // READMEs and are exactly the thing a cover should not show. A logo is not a
  // preview of anything, so branding is rejected outright rather than ranked
  // low enough to win by default.
  const REJECT = /(^|[-_./])(logo|logos|icon|icons|avatar|wordmark|favicon|clearspace|glyph)([-_./]|$)/i;
  const BANNER_NAMES = /^(banner|header|hero|masthead|cover|wide)\b/i;
  const CAMO_HOST = /camo\.githubusercontent\.com/i;

  const rank = (ref) => {
    const src = ref.src;
    const alt = (ref.alt ?? '').toLowerCase();
    const file = basename(src.split('?')[0].split('#')[0]);
    const lower = file.toLowerCase();

    // GitHub's camo proxy almost always serves logos/badges, not screenshots
    if (CAMO_HOST.test(src)) return null;
    if (/badge|shields\.io|img\.shields|travis|codecov|coveralls|opencollective|ko-fi|buymeacoffee|sponsor|funding|discord|twitter|discordapp/.test(lower)) return null;
    if (REJECT.test(lower)) return null;
    // A vector asset is nearly always a wordmark or a diagram, not a screenshot.
    if (extname(lower) === '.svg') return 9;
    if (/(screenshot|preview|demo|showcase|gui|ui|app|home|dashboard|hero)/i.test(lower)) return 0;
    if (BANNER_NAMES.test(lower)) return 3;
    if (/(docs|screenshots?|images?|assets|media)\//i.test(src)) return 2;
    return 5;
  };

  const scored = references
    .map((ref) => ({ ...ref, score: rank(ref) }))
    .filter((candidate) => candidate.score !== null)
    .sort((a, b) => a.score - b.score);

  for (const candidate of scored.slice(0, 8)) {
    const url = resolveReadmeImage(candidate.src, meta.fullName, meta.defaultBranch);
    const probe = await probeImage(url);
    // A cover photo needs enough pixels to read. Anything smaller is a badge, a
    // wordmark or a stray icon, whatever the README called it.
    if (probe.ok && probe.width >= MIN_PREVIEW_WIDTH && probe.height >= MIN_PREVIEW_HEIGHT) {
      return { url, from: 'readme', label: 'README screenshot' };
    }
  }
  return null;
};

// Logo detection: finds images in README where alt text exactly matches repo name
const readmeLogo = async (files, meta) => {
  const readme = files.find((file) => {
    const name = basename(file).toLowerCase();
    return name === 'readme.md' || name === 'readme.markdown' || name === 'readme.rst';
  });
  if (!readme) return null;

  let markdown;
  try {
    markdown = await readFile(readme, 'utf8');
  } catch {
    return null;
  }

  const references = [];
  for (const match of markdown.matchAll(/!\[([^\]]*)\]\(([^)\s]+)/g)) references.push({ alt: match[1], src: match[2] });
  for (const match of markdown.matchAll(/<img[^>]+alt=["']([^"']*)["'][^>]+src=["']([^"']+)["']/gi)) references.push({ alt: match[1], src: match[2] });
  for (const match of markdown.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]+alt=["']([^"']*)["']/gi)) references.push({ alt: match[2], src: match[1] });

  const repoNameLower = meta.name.toLowerCase();
  const NOT_LOGO = /screenshot|banner|preview|demo|dashboard|hero|image|photo|capture|readme|screen|ui|app|home/i;
  for (const ref of references) {
    const alt = (ref.alt ?? '').toLowerCase().trim();
    if (!alt) continue;
    if (NOT_LOGO.test(alt)) continue;
    // Only exact match (after normalizing separators) - no partial matches
    const altNormalized = alt.replace(/[-_.]/g, '');
    const repoNameNormalized = repoNameLower.replace(/[-_.]/g, '');
    if (altNormalized === repoNameNormalized) {
      const url = resolveReadmeImage(ref.src, meta.fullName, meta.defaultBranch);
      const probe = await probeImage(url);
      if (probe.ok && probe.width >= 100 && probe.height >= 100) {
        return { url, alt: ref.alt, label: 'README logo' };
      }
    }
  }
  return null;
};

// Badge services are rejected by name because it costs nothing, then the
// dimension floor catches every other generator (badgen, nodei.co, custom CI).
const BADGE_HOSTS = /badgen\.net|badge\.fury|shields\.io|nodei\.co|travis-ci|circleci\.com|coveralls\.io|appveyor|codacy|sonarcloud|opencollective|ko-fi|buymeacoffee/i;

// A real screenshot, banner or demo image clears both floors comfortably; a CI
// badge is typically under 200x60. The width floor catches a tall icon, the
// height floor catches the wide version.
const MIN_PREVIEW_WIDTH = 300;
const MIN_PREVIEW_HEIGHT = 100;

/**
 * Fetches the leading bytes of a candidate and reports what it is. A partial
 * read is enough: PNG, JPEG, GIF and WebP all carry their dimensions in the
 * first few kilobytes, so probing a multi-megabyte screenshot costs 256 kB.
 */
const probeImage = async (url) => {
  if (url.startsWith('data:')) return { ok: true, width: 4096, height: 4096 };
  if (BADGE_HOSTS.test(url)) return { ok: false, reason: 'badge service' };

  try {
    const response = await fetch(url, {
      headers: { range: 'bytes=0-262143', 'user-agent': 'gitphoto', accept: 'image/*' },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok && response.status !== 206) return { ok: false, reason: `status ${response.status}` };
    if (!response.headers.get('content-type')?.startsWith('image/')) return { ok: false, reason: 'not an image' };

    const size = imageSize(Buffer.from(await response.arrayBuffer()));
    return size ? { ok: true, ...size } : { ok: false, reason: 'unrecognised image format' };
  } catch (error) {
    return { ok: false, reason: String(error.message ?? error) };
  }
};

const STATIC_ROOTS = ['', 'public', 'dist', 'build', 'out', 'www', 'site', 'docs'];

// Template syntax that requires a backend to render. A static server would just
// serve the raw source, so these files are rejected as preview candidates.
const TEMPLATE_RE = /\{\{|\{%|<%=|<\?php/;

const isTemplateFile = async (file) => {
  try {
    const handle = await access(file).then(() => readFile(file, 'utf8').then((content) => content.slice(0, 4096)).catch(() => '')).catch(() => '');
    return TEMPLATE_RE.test(handle);
  } catch {
    return false;
  }
};

// A prebuilt entry point needs no toolchain, so it can be served straight off
// disk. This is the difference between a 2 second and a 2 minute render.
const staticEntry = async (dir, files) => {
  for (const root of STATIC_ROOTS) {
    const base = root ? join(dir, root) : dir;
    for (const name of ['index.html', 'index.htm']) {
      const candidate = join(base, name);
      try {
        const info = await stat(candidate);
        if (info.isFile()) {
          if (await isTemplateFile(candidate)) continue;
          return { file: candidate, rel: relativePosix(dir, candidate) };
        }
      } catch {
        // Keep looking: a missing index.html is the normal case, not an error.
      }
    }
  }

  // No index at a known root, so look for any shallow HTML page that looks like
  // an app shell rather than a documentation file.
  const pages = files.filter((file) => extname(file).toLowerCase() === '.html');
  const ranked = pages
    .map((file) => {
      const rel = relativePosix(dir, file);
      const lower = rel.toLowerCase();
      let score = 5;
      if (lower.endsWith('index.html')) score = 0;
      if (/(^|\/)(app|main|home|dashboard|playground|demo|site|page)\.html$/.test(lower)) score = 1;
      if (/readme|changelog|license|contributing|doc/.test(lower)) score = 9;
      return { file, rel, score };
    });
  const filtered = [];
  for (const candidate of ranked) {
    if (!(await isTemplateFile(candidate.file))) filtered.push(candidate);
  }
  const sorted = filtered.sort((a, b) => a.score - b.score);

  return sorted.length && sorted[0].score < 9 ? { file: sorted[0].file, rel: sorted[0].rel } : null;
};

// Framework knowledge is deliberately small and explicit. Guessing wrong here
// starts a dev server that never becomes ready, so only well-known signals count.
const detectFramework = (pkg) => {
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const has = (name) => name in deps;
  const scriptHas = (name) => typeof pkg?.scripts?.[name] === 'string';

  if (has('next')) return { id: 'next', dev: scriptHas('dev') ? 'npm run dev' : null, port: 3000 };
  if (has('nuxt')) return { id: 'nuxt', dev: scriptHas('dev') ? 'npm run dev' : null, port: 3000 };
  if (has('vite') || has('@vitejs/plugin-react') || has('@sveltejs/kit')) {
    return { id: 'vite', dev: scriptHas('dev') ? 'npm run dev' : null, port: 5173 };
  }
  if (has('@angular/cli')) return { id: 'angular', dev: 'npm start', port: 4200 };
  if (has('gatsby')) return { id: 'gatsby', dev: scriptHas('develop') ? 'npm run develop' : null, port: 8000 };
  if (has('astro')) return { id: 'astro', dev: scriptHas('dev') ? 'npm run dev' : null, port: 4321 };
  if (has('svelte')) return { id: 'svelte', dev: scriptHas('start') ? 'npm start' : null, port: 5000 };
  if (has('express') || has('fastify') || has('koa') || has('hapi')) {
    return { id: 'node-server', dev: scriptHas('start') ? 'npm start' : scriptHas('dev') ? 'npm run dev' : null, port: 3000 };
  }
  if (has('react-scripts')) return { id: 'cra', dev: scriptHas('start') ? 'npm start' : null, port: 3000 };
  return { id: 'unknown', dev: null, port: null };
};

const hasLockfile = async (dir) => {
  // LOCKFILES is owned by the install module; keeping one list here is what
  // stops a package manager being detectable but not installable.
  for (const name of LOCKFILES) {
    if (await exists(join(dir, name))) return name;
  }
  return null;
};

const primarySourceFile = async (dir, files, language) => {
  const extensions = {
    JavaScript: ['.jsx', '.mjs', '.js'],
    TypeScript: ['.tsx', '.ts'],
    Python: ['.py'],
    Go: ['.go'],
    Rust: ['.rs'],
    Ruby: ['.rb'],
  }[language] ?? ['.js', '.ts', '.py', '.mjs', '.jsx', '.tsx', '.go', '.rs', '.rb', '.c', '.cpp'];

  const preferred = ['src/index', 'src/main', 'src/app', 'index', 'main', 'app', 'server', 'src/index'];
  const candidates = files.filter((file) => {
    const ext = extname(file).toLowerCase();
    if (!extensions.includes(ext)) return false;
    const rel = relativePosix(dir, file).toLowerCase();
    if (rel.includes('test') || rel.includes('spec')) return false;
    return true;
  });

  const byPreference = [...candidates].sort((a, b) => {
    const score = (file) => {
      const rel = relativePosix(dir, file).toLowerCase().replace(/\.[^.]+$/, '');
      const index = preferred.findIndex((prefix) => rel === prefix || rel.endsWith(`/${prefix}`));
      return index === -1 ? preferred.length : index;
    };
    return score(a) - score(b);
  });

  return byPreference[0] ?? null;
};

const isBannerLine = (line) => /^\s*(\/\/|#|\/\*|\*|<!--|===|---)/.test(line);

const readSnippet = async (dir, file, maxLines = 26) => {
  if (!file) return { rel: '', code: '' };
  try {
    const raw = await readFile(file, 'utf8');
    const lines = raw.split('\n').filter((line) => line.trim().length > 0);
    // License headers and shebangs open most source files. On a 26 line cover
    // they eat a third of the space, so the snippet starts at real code.
    const firstContent = lines.findIndex((line) => !isBannerLine(line));
    const start = firstContent === -1 ? 0 : Math.min(firstContent, 6);
    return { rel: relativePosix(dir, file), code: lines.slice(start, start + maxLines).join('\n') };
  } catch {
    return { rel: '', code: '' };
  }
};

/**
 * Decides how to show a repository as a picture.
 * Returns a ranked list of strategies; the renderer walks it until one yields an
 * image. Everything downstream keys off `kind`.
 */
export const detectPreview = async (dir, meta) => {
  const files = await walk(dir);
  const pkg = await readJson(join(dir, 'package.json'));
  const framework = detectFramework(pkg);
  const lockfile = await hasLockfile(dir);
  const strategies = [];

  // Logo detection happens separately from preview strategies.
  // A logo replaces the repo name in the cover but should NOT become the preview image.
  const logo = await readmeLogo(files, meta).catch(() => null);

  const screenshot = await readmeScreenshot(files, meta).catch(() => null);
  if (screenshot) strategies.push({ kind: 'image', ...screenshot, confidence: 90 });

  const html = await staticEntry(dir, files);
  if (html) {
    strategies.push({
      kind: 'static',
      file: html.file,
      rel: html.rel,
      label: framework.id === 'unknown' ? 'Static page' : `${framework.id} build`,
      confidence: 70,
    });
  }

  if (pkg && framework.dev && lockfile) {
    strategies.push({
      kind: 'server',
      command: framework.dev,
      port: framework.port,
      rel: 'package.json',
      label: `${framework.id} dev server`,
      requiresInstall: true,
      confidence: 50,
    });
  } else if (pkg && framework.dev) {
    strategies.push({
      kind: 'server',
      command: framework.dev,
      port: framework.port,
      rel: 'package.json',
      label: `${framework.id} dev server`,
      requiresInstall: true,
      confidence: 40,
    });
  }

  const source = await primarySourceFile(dir, files, meta.primaryLanguage);
  const snippet = await readSnippet(dir, source);
  if (snippet.code) {
    strategies.push({
      kind: 'code',
      rel: snippet.rel,
      code: snippet.code,
      label: meta.primaryLanguage === 'Unknown' ? 'Source' : meta.primaryLanguage,
      confidence: 10,
    });
  }

  log.debug(`detect ${meta.fullName}: ${strategies.map((s) => s.kind).join(' > ') || 'none'}`, {
    framework: framework.id,
    files: files.length,
  });

  return {
    strategies,
    framework: framework.id,
    logo,
    // A flat summary for the smoke script and for tuning the ranking, which is
    // otherwise only observable by reading generated HTML by hand.
    explain: strategies.map((s) => ({
      kind: s.kind,
      label: s.label ?? null,
      confidence: s.confidence,
      target: s.url ?? s.rel ?? s.command ?? null,
    })),
  };
};

