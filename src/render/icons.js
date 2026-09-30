import { escapeHtml, toRgba } from './format.js';

const ICON_PATHS = {
  star: '<path d="M12 2.6l2.9 5.9 6.5.95-4.7 4.58 1.11 6.47L12 17.44 6.19 20.5l1.11-6.47L2.6 9.45l6.5-.95L12 2.6z"/>',
  fork: '<path d="M6 3.5a2 2 0 110 4 2 2 0 010-4zm12 0a2 2 0 110 4 2 2 0 010-4zM12 10.2a2 2 0 110 4 2 2 0 010-4zM6 7.5v1.2c0 1.6 1.9 2.6 4 3v1.9M18 7.5v1.2c0 1.6-1.9 2.6-4 3"/>',
  issue: '<path d="M12 3.2a8.8 8.8 0 100 17.6 8.8 8.8 0 000-17.6zm0 4.6v5.4m0 3.2v.2"/>',
  code: '<path d="M8.6 7.4L4 12l4.6 4.6M15.4 7.4L20 12l-4.6 4.6M13.4 5.2l-2.8 13.6"/>',
  image: '<path d="M3.6 5.4h16.8v13.2H3.6zM3.6 15l4.4-4.2 3.4 3.2 3.2-3 5.8 5.4M8.2 9.4a1.2 1.2 0 100-2.4 1.2 1.2 0 000 2.4z"/>',
  play: '<path d="M7 4.8l11 7.2-11 7.2z"/>',
  git: '<path d="M6 3.5a2 2 0 110 4 2 2 0 010-4zm0 8.5a2 2 0 110 4 2 2 0 010-4zm12-8.5a2 2 0 110 4 2 2 0 010-4zm0 4v1.2c0 2.2-2.4 3.4-4.6 4.1C11.7 13.2 10 14 10 16.2v.4"/>',
};

const FILLED = new Set(['star', 'play', 'git', 'fork']);

export const icon = (name, size = 16) => {
  const body = ICON_PATHS[name] ?? '';
  const fill = FILLED.has(name) ? 'currentColor' : 'none';
  return (
    `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}" ` +
    `stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ` +
    `aria-hidden="true">${body}</svg>`
  );
};

const KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'class',
  'import', 'export', 'from', 'default', 'async', 'await', 'new', 'this', 'typeof', 'instanceof',
  'try', 'catch', 'finally', 'throw', 'switch', 'case', 'break', 'continue', 'extends', 'super',
  'def', 'self', 'None', 'True', 'False', 'elif', 'lambda', 'print', 'import', 'from', 'pass',
  'public', 'private', 'protected', 'static', 'void', 'int', 'string', 'bool', 'float', 'double',
  'struct', 'fn', 'mut', 'impl', 'use', 'pub', 'package', 'type', 'interface', 'where', 'match',
  'null', 'undefined', 'true', 'false', 'end', 'then', 'in', 'of', 'not', 'and', 'or',
]);

// Two-tone highlighting keeps the code card legible at cover size. A full
// grammar would be a dependency and would still be wrong for most of the
// languages this service renders.
const TOKEN_RE = new RegExp(
  [
    '(\\/\\/[^\\n]*)',
    '(#[^\\n]*)',
    '("(?:\\\\.|[^"\\\\])*")',
    "('(?:\\\\.|[^'\\\\])*')",
    '(`(?:\\\\.|[^`\\\\])*`)',
    '(\\b\\d+(?:\\.\\d+)?\\b)',
    '([A-Za-z_$][\\w$]*)',
  ].join('|'),
  'g',
);

const tokenClass = (token, previous) => {
  if (token.startsWith('//') || token.startsWith('#')) return 'tok-comment';
  if (/^["'`]/.test(token)) return 'tok-string';
  if (/^\d/.test(token)) return 'tok-number';
  if (KEYWORDS.has(token)) return 'tok-keyword';
  if (/^[A-Z]/.test(token)) return 'tok-type';
  if (previous && /[.>]\s*$/.test(previous)) return 'tok-prop';
  return '';
};

export const highlight = (code) =>
  String(code ?? '')
    .split('\n')
    .map((line) => {
      let output = '';
      let lastIndex = 0;
      let previous = '';
      for (const match of line.matchAll(TOKEN_RE)) {
        const token = match[0];
        output += escapeHtml(line.slice(lastIndex, match.index));
        const cls = tokenClass(token, previous);
        output += cls ? `<span class="${cls}">${escapeHtml(token)}</span>` : escapeHtml(token);
        previous = token;
        lastIndex = match.index + token.length;
      }
      output += escapeHtml(line.slice(lastIndex));
      return `<span class="code-line">${output || ' '}</span>`;
    })
    .join('\n');

// A deterministic glow derived from the repo name. Cached renders have to match
// a fresh render byte for byte, so nothing here may depend on time or randomness.
export const backdrop = (seed, accents, alpha) => {
  const blob = (index, salt) => {
    const x = 12 + seed(index, salt) * 76;
    const y = 8 + seed(index, salt + 1) * 84;
    const size = 46 + seed(index, salt + 2) * 40;
    const color = accents[index % Math.max(1, accents.length)] ?? '#58a6ff';
    return `radial-gradient(circle at ${x.toFixed(1)}% ${y.toFixed(1)}%, ${toRgba(color, alpha)} 0%, ${toRgba(color, 0)} ${size}%)`;
  };
  return [blob(0, 7), blob(1, 31), blob(2, 59)].join(', ');
};
