import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config, hasBundledFonts } from '../config.js';
import { backdrop, highlight, icon } from './icons.js';
import { clampColumns, clampLines, compactNumber, escapeHtml, hashUnit, relativeTime, truncate } from './format.js';
import { getPalette, styles } from './styles.js';

// The code card's viewport is 648px wide with 70px of gutter and padding. At
// 12.5px JetBrains Mono the advance is 7.5px, so 76 columns is the widest a line
// can be before it stops being fully readable.
const MAX_CODE_COLUMNS = 76;

// Bundled Inter renders identically everywhere. When the fetch script has not
// run, the stack still resolves to a humanist sans on every host we support.
const FALLBACK_FAMILY = {
  sans: `"Inter", "Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, "Helvetica Neue", Arial, sans-serif`,
  mono: `"JetBrains Mono", "Cascadia Mono", "SF Mono", Consolas, "Liberation Mono", monospace`,
};

const nameSize = (name) => {
  if (name.length <= 18) return 44;
  if (name.length <= 26) return 38;
  if (name.length <= 34) return 32;
  return 27;
};

const KIND_ICON = { image: 'image', site: 'play', code: 'code' };

const languageBar = (languages) => {
  if (!languages.length) return '';
  // A single language renders as a full-width solid bar, which reads better
  // than a 100% segment and still matches GitHub's own presentation.
  const segments = languages
    .map((lang) => `<span style="width:${(lang.share * 100).toFixed(2)}%;background:${lang.color}"></span>`)
    .join('');
  return `<div class="langbar">${segments}</div>`;
};

const languageLegend = (languages) => {
  if (!languages.length) return '';
  const items = languages
    .slice(0, 3)
    .map((lang) => `<span><i style="background:${lang.color}"></i>${escapeHtml(lang.name)}<em>${Math.round(lang.share * 100)}%</em></span>`)
    .join('');
  return `<div class="langlegend">${items}</div>`;
};

const topics = (list) =>
  list.length
    ? `<div class="topics">${list
        .slice(0, 4)
        .map((topic) => `<span class="topic">#${escapeHtml(truncate(topic, 22))}</span>`)
        .join('')}</div>`
    : '';

const stats = (repo) => {
  const items = [
    `<span class="stat">${icon('star', 15)}<span>${compactNumber(repo.stars)}</span></span>`,
    `<span class="stat">${icon('fork', 15)}<span>${compactNumber(repo.forks)}</span></span>`,
  ];
  if (repo.license) {
    items.push(`<span class="stat stat--muted"><span>${escapeHtml(repo.license)}</span></span>`);
  } else if (repo.openIssues) {
    items.push(`<span class="stat stat--muted">${icon('issue', 15)}<span>${compactNumber(repo.openIssues)}</span></span>`);
  }
  return `<div class="stats">${items.join('')}</div>`;
};

const commitLine = (commit) => {
  if (!commit?.subject) return '';
  const age = relativeTime(commit.committedAt);
  const sha = escapeHtml((commit.sha ?? '').slice(0, 7));
  return `<div class="commit">${icon('git', 13)}<span class="commit__sha">${sha}</span><span class="commit__text">${escapeHtml(
    truncate(commit.subject, 34),
  )}</span>${age ? `<span>· ${escapeHtml(age)}</span>` : ''}</div>`;
};

const chromeUrl = (repo, preview) => {
  if (preview.kind === 'site' && preview.address) return preview.address;
  return `github.com/${repo.owner}/${repo.name}`;
};

const previewBody = (preview) => {
  if (preview.kind === 'image' || preview.kind === 'site') {
    const fit = preview.contain ? 'viewport--contain' : '';
    return `<div class="viewport ${fit}" data-preview="bitmap"><img src="${preview.dataUri}" alt=""></div>`;
  }

  if (preview.kind === 'code') {
    const body = clampColumns(clampLines(preview.code, 24), MAX_CODE_COLUMNS);
    return (
      `<div class="viewport" data-preview="code"><div class="code">` +
      `<div class="code__bar">${icon('code', 13)}<b>${escapeHtml(preview.rel ?? 'source')}</b>` +
      `<em>${escapeHtml(preview.label ?? '')}</em></div>` +
      `<div class="code__body">${highlight(body)}</div></div></div>`
    );
  }

  return (
    `<div class="viewport viewport--empty" data-preview="none">${icon('image', 20)}` +
    `<span>${escapeHtml(preview.reason ?? 'No previewable content in this repository')}</span></div>`
  );
};

const previewKindLabel = (preview) => {
  if (preview.kind === 'image') return 'README screenshot';
  if (preview.kind === 'site') return preview.label ?? 'Live app';
  if (preview.kind === 'code') return 'Source';
  return 'No preview';
};

/**
 * Builds the full cover document. The renderer screenshots this at
 * 1280x600 @ 1x, so every dimension here is fixed at author time.
 */
export const buildBannerHtml = async ({ repo, preview, commit, theme = 'dark', logo = null }) => {
  const palette = getPalette(theme);
  const useBundled = hasBundledFonts();
  const fontFace = useBundled ? await readFile(join(config.fontDir, 'fonts.inline.css'), 'utf8') : '';
  const fontFamily = useBundled
    ? { sans: `'Inter', ${FALLBACK_FAMILY.sans}`, mono: `'JetBrains Mono', ${FALLBACK_FAMILY.mono}` }
    : FALLBACK_FAMILY;

  const accents = repo.languages.length
    ? repo.languages.map((lang) => lang.color)
    : [palette.blue, palette.green];
  const seed = (index, salt) => hashUnit(repo.fullName, salt + index * 977);

  // A blocked or missing avatar would leave a hollow circle, so the first
  // letter of the owner stands in instead.
  const avatar = repo.avatarDataUri
    ? `<img class="avatar" src="${repo.avatarDataUri}" alt="">`
    : `<div class="avatar avatar--letter">${escapeHtml((repo.owner[0] ?? '?').toUpperCase())}</div>`;

  // Use logo from README if detected, otherwise show repo name
  const hasLogo = logo && logo.dataUri;
  const logoHtml = hasLogo
    ? `<img class="logo" src="${logo.dataUri}" alt="${escapeHtml(logo.alt ?? repo.name)}">`
    : '';
  const nameHtml = hasLogo
    ? ''
    : `<h1 class="name" style="font-size:${nameSize(repo.name)}px">${escapeHtml(repo.name)}</h1>`;

  const identity = `<div class="identity">
    ${avatar}
    <div>
      <div class="identity__owner">${escapeHtml(repo.owner)}</div>
      <div class="identity__repo">${escapeHtml(repo.defaultBranch)}</div>
    </div>
  </div>`;

  const meta = `<div class="meta">
    ${identity}
    ${logoHtml}
    ${nameHtml}
    <p class="description">${escapeHtml(truncate(repo.description || 'No description provided.', 168))}</p>
    ${topics(repo.topics)}
    <div class="spacer"></div>
    ${stats(repo)}
    ${languageBar(repo.languages)}
    ${languageLegend(repo.languages)}
    ${commitLine(commit)}
  </div>`;

  // Evaluated once: the chrome splits the same value into host and path.
  const address = chromeUrl(repo, preview);

const stage = `<div class="stage">
    <div class="frame">
      <div class="chrome">
        <div class="dots"><i></i><i></i></div>
        <div class="url">${icon(preview.kind === 'site' ? 'play' : 'image', 12)}<b>${escapeHtml(
          address.split('/')[0],
        )}</b><span>${escapeHtml(address.replace(/^[^/]+/, '') || '/')}</span></div>
      </div>
      ${previewBody(preview)}
      <div class="kind">${icon(KIND_ICON[preview.kind] ?? 'image', 12)}<span>${escapeHtml(
        previewKindLabel(preview),
      )}</span></div>
    </div>
    <div class="attribution"><i></i><span>gitphoto</span></div>
  </div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>${styles({ fontFace, fontFamily, palette })}</style>
</head>
<body>
  <div class="cover">
    <div class="cover__glow" style="background:${backdrop(seed, accents, palette.glowAlpha)}"></div>
    <div class="cover__grid"></div>
    <div class="cover__vignette"></div>
    <div class="cover__inner">${meta}${stage}</div>
  </div>
</body>
</html>`;
};
