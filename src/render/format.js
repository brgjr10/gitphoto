// Short, bounded helpers shared by the banner templates. Everything that reaches
// the DOM goes through `escapeHtml` — repo names, descriptions, topics and code
// snippets are all attacker-controlled input rendered into a browser.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);

// Compacts a snippet to the lines that actually fit on the code card, and marks
// the cut so the last visible line never reads as a syntax error.
export const clampLines = (code, maxLines) => {
  const lines = String(code ?? '').split('\n');
  return lines.length <= maxLines ? lines.join('\n') : [...lines.slice(0, maxLines), '…'].join('\n');
};

/**
 * Shortens lines that would run past the code card. The card is ~578px of
 * monospace at 7.5px per character, so anything beyond the limit is cropped by
 * the viewport anyway — cutting it here keeps the line numbers, the comment
 * gutter and the visible text consistent with each other.
 */
export const clampColumns = (code, maxColumns) =>
  String(code ?? '')
    .split('\n')
    .map((line) => (line.length <= maxColumns ? line : `${line.slice(0, maxColumns - 1)}…`))
    .join('\n');

export const compactNumber = (value) => {
  const n = Number(value) || 0;
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 10 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)}k`;
  }
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
};

export const truncate = (value, max) => {
  const text = String(value ?? '').trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
};

// Deterministic 0..1 hash. Seeds the background glow so the same repo always
// produces the same cover, which matters for README diffs and cache reuse.
export const hashUnit = (value, salt = 0) => {
  let hash = 2166136261 ^ salt;
  for (let i = 0; i < String(value).length; i += 1) {
    hash ^= String(value).charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 100000) / 100000;
};

export const relativeTime = (iso) => {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  const units = [
    ['year', 31_536_000], ['month', 2_592_000], ['week', 604_800],
    ['day', 86_400], ['hour', 3600], ['minute', 60],
  ];
  for (const [name, span] of units) {
    if (seconds >= span) return `${Math.floor(seconds / span)} ${name}${Math.floor(seconds / span) === 1 ? '' : 's'} ago`;
  }
  return 'just now';
};

export const toRgba = (hex, alpha) => {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};
