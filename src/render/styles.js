// The cover is a fixed 1280x640 box rendered at deviceScaleFactor 1, so every
// value here is a literal. No percentages of unknown parents, no media queries.
// The canvas size lives in config so the renderer, the layout audit and the
// service all measure the same document.
import { config } from '../config.js';

export const styles = ({ fontFace, fontFamily, palette }) => `
${fontFace}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg: ${palette.bg};
  --card: ${palette.card};
  --border: ${palette.border};
  --text: ${palette.text};
  --muted: ${palette.muted};
  --dim: ${palette.dim};
  --blue: ${palette.blue};
  --green: ${palette.green};
  --surface-raised: ${palette.surfaceRaised};
  --surface-sunken: ${palette.surfaceSunken};
  --code-text: ${palette.codeText};
  --code-gutter: ${palette.codeGutter};
  --code-comment: ${palette.codeComment};
  --code-string: ${palette.codeString};
  --code-number: ${palette.codeNumber};
  --code-keyword: ${palette.codeKeyword};
  --code-type: ${palette.codeType};
  --code-prop: ${palette.codeProp};
  --veil-1: ${palette.veil[0]};
  --veil-2: ${palette.veil[1]};
  --veil-3: ${palette.veil[2]};
  --veil-4: ${palette.veil[3]};
  --veil-edge: ${palette.veilEdge};
  --grid: ${palette.grid};
}

html, body {
  width: ${palette.width}px;
  height: ${palette.height}px;
  overflow: hidden;
  background: var(--bg);
}

body {
  font-family: ${fontFamily.sans};
  color: var(--text);
  -webkit-font-smoothing: antialiased;
  text-rendering: geometricPrecision;
}

.cover {
  position: relative;
  width: ${palette.width}px;
  height: ${palette.height}px;
  overflow: hidden;
  isolation: isolate;
  background: var(--bg);
}

/* Layer order matters: glow, then grid, then a vignette that keeps the text
   column legible over the brightest part of the backdrop. */
.cover__glow {
  position: absolute;
  inset: 0;
  z-index: 0;
}
.cover__grid {
  position: absolute;
  inset: 0;
  z-index: 1;
  background-image:
    linear-gradient(to right, var(--grid) 1px, transparent 1px),
    linear-gradient(to bottom, var(--grid) 1px, transparent 1px);
  background-size: 56px 56px;
  mask-image: radial-gradient(ellipse 78% 82% at 42% 34%, #000 20%, transparent 78%);
  -webkit-mask-image: radial-gradient(ellipse 78% 82% at 42% 34%, #000 20%, transparent 78%);
}
.cover__vignette {
  position: absolute;
  inset: 0;
  z-index: 2;
  background:
    linear-gradient(94deg, var(--veil-1) 0%, var(--veil-2) 34%, var(--veil-3) 62%, var(--veil-4) 100%),
    radial-gradient(ellipse 120% 96% at 50% 50%, transparent 40%, var(--veil-edge) 100%);
}

.cover__inner {
  position: relative;
  z-index: 3;
  display: flex;
  gap: 46px;
  align-items: stretch;
  height: 100%;
  padding: 54px 58px;
}

/* ---------- text column ---------- */

.meta {
  display: flex;
  flex-direction: column;
  width: 468px;
  flex: 0 0 468px;
  min-width: 0;
}

.identity {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 18px;
}
.avatar {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: var(--card);
  object-fit: cover;
  flex: 0 0 44px;
}
.avatar--letter {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  font-weight: 700;
  color: var(--blue);
  background: rgba(88,166,255,0.12);
}
.identity__owner {
  font-size: 14px;
  font-weight: 500;
  color: var(--muted);
  letter-spacing: 0.01em;
  line-height: 1.3;
}
.identity__repo {
  font-size: 13px;
  font-weight: 500;
  color: var(--dim);
  line-height: 1.3;
}

.name {
  font-size: 44px;
  font-weight: 800;
  line-height: 1.06;
  letter-spacing: -0.028em;
  word-break: break-word;
  margin-bottom: 14px;
}

.logo {
  display: block;
  max-width: 100%;
  max-height: 80px;
  width: auto;
  height: auto;
  object-fit: contain;
  margin-bottom: 14px;
  border-radius: 8px;
}

.description {
  font-size: 16.5px;
  font-weight: 400;
  line-height: 1.52;
  color: var(--muted);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin-bottom: 16px;
}

.topics {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 18px;
}
.topic {
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--blue);
  background: rgba(88,166,255,0.1);
  border: 1px solid rgba(88,166,255,0.24);
  border-radius: 999px;
  padding: 3.5px 9px;
}

.spacer { flex: 1 1 auto; min-height: 8px; }

.stats {
  display: flex;
  align-items: center;
  gap: 18px;
  margin-bottom: 14px;
}
.stat {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14.5px;
  font-weight: 600;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
.stat .ico { color: var(--muted); }
.stat--muted { color: var(--muted); font-weight: 500; }

.langbar {
  display: flex;
  height: 7px;
  width: 100%;
  border-radius: 999px;
  overflow: hidden;
  background: var(--card);
  margin-bottom: 12px;
}
.langbar span { display: block; height: 100%; }

.langlegend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  font-size: 12px;
  font-weight: 500;
  color: var(--muted);
  margin-bottom: 18px;
}
.langlegend i {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 2px;
  margin-right: 6px;
}
.langlegend em { font-style: normal; color: var(--dim); margin-left: 5px; }

.commit {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--dim);
  border-top: 1px solid var(--border);
  padding-top: 13px;
  white-space: nowrap;
  overflow: hidden;
}
.commit__text { overflow: hidden; text-overflow: ellipsis; }
.commit__sha {
  font-family: ${fontFamily.mono};
  font-size: 11px;
  color: var(--blue);
  background: rgba(88,166,255,0.1);
  border-radius: 4px;
  padding: 1.5px 5px;
  flex: 0 0 auto;
}

/* ---------- preview frame ---------- */

.stage {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.frame {
  position: relative;
  flex: 0 0 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 14px;
  overflow: hidden;
  box-shadow:
    0 24px 60px -18px rgba(0,0,0,0.72),
    0 2px 0 0 rgba(255,255,255,0.04) inset;
}

.chrome {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 42px;
  flex: 0 0 42px;
  padding: 0 14px;
  background: var(--surface-raised);
  border-bottom: 1px solid var(--border);
}
.dots { display: flex; gap: 6px; flex: 0 0 auto; }
.dots i { width: 10px; height: 10px; border-radius: 50%; display: block; }
.dots i:nth-child(1) { background: #f85149; }
.dots i:nth-child(2) { background: #d29922; }
.dots i:nth-child(3) { background: #3fb950; }

.url {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  height: 24px;
  padding: 0 10px;
  border-radius: 6px;
  background: var(--bg);
  border: 1px solid var(--border);
  font-family: ${fontFamily.mono};
  font-size: 11.5px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
}
.url b { color: var(--dim); font-weight: 500; flex: 0 0 auto; }
.url span { overflow: hidden; text-overflow: ellipsis; }

.viewport {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  background: var(--surface-sunken);
  overflow: hidden;
}
.viewport img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: top center;
  display: block;
}
.viewport--contain img { object-fit: contain; }

/* A failed image leaves the viewport empty. This keeps the cover looking
   deliberate instead of showing a broken graphic. */
.viewport--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--dim);
  font-size: 14px;
  gap: 9px;
}

.kind {
  position: absolute;
  left: 12px;
  bottom: 12px;
  z-index: 4;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border-radius: 999px;
  background: rgba(13,17,23,0.82);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid var(--border);
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--muted);
}
.kind .ico { color: var(--green); }

.attribution {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 7px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--dim);
  flex: 0 0 auto;
}
.attribution i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--blue);
  display: block;
  box-shadow: 0 0 8px var(--blue);
}

/* ---------- code card ---------- */

.code {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--surface-sunken);
}
.code__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  flex: 0 0 34px;
  padding: 0 14px;
  border-bottom: 1px solid var(--border);
  font-family: ${fontFamily.mono};
  font-size: 11.5px;
  color: var(--dim);
  background: var(--card);
}
.code__bar .ico { color: var(--blue); flex: 0 0 auto; }
.code__bar b { color: var(--muted); font-weight: 500; }
.code__bar em { font-style: normal; margin-left: auto; }

.code__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  padding: 14px 0;
  font-family: ${fontFamily.mono};
  font-size: 12.5px;
  line-height: 1.62;
  color: var(--code-text);
  counter-reset: ln;
}
.code-line {
  display: block;
  padding: 0 18px 0 52px;
  position: relative;
  white-space: pre;
  overflow: hidden;
  text-overflow: ellipsis;
}
.code-line::before {
  counter-increment: ln;
  content: counter(ln);
  position: absolute;
  left: 0;
  width: 34px;
  text-align: right;
  color: var(--code-gutter);
  user-select: none;
}
.tok-comment { color: var(--code-comment); font-style: italic; }
.tok-string  { color: var(--code-string); }
.tok-number  { color: var(--code-number); }
.tok-keyword { color: var(--code-keyword); font-weight: 600; }
.tok-type    { color: var(--code-type); }
.tok-prop    { color: var(--code-prop); }

.placeholder {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  text-align: center;
  padding: 0 40px;
  color: var(--dim);
}
.placeholder h3 {
  font-size: 17px;
  font-weight: 600;
  color: var(--muted);
  letter-spacing: -0.01em;
}
.placeholder p { font-size: 13.5px; line-height: 1.5; max-width: 320px; }
.placeholder .ico { color: var(--border); }
`;

// Token colours follow the same syntax scheme in both themes, so a code card
// does not change character when the user switches.
const TOKEN_COLORS = {
  dark: {
    codeText: '#c9d1d9', gutter: '#484f58', comment: '#6e7681',
    string: '#a5d6ff', number: '#79c0ff', keyword: '#ff7b72', type: '#ffa657', prop: '#d2a8ff',
  },
  light: {
    codeText: '#24292f', gutter: '#8c959f', comment: '#6e7781',
    string: '#0a3069', number: '#0550ae', keyword: '#cf222e', type: '#953800', prop: '#8250df',
  },
};

const THEMES = {
  dark: {
    bg: '#0d1117',
    card: '#161b22',
    border: '#30363d',
    text: '#e6edf3',
    muted: '#8b949e',
    dim: '#6e7681',
    blue: '#58a6ff',
    green: '#3fb950',
    surfaceRaised: '#10161d',
    surfaceSunken: '#0b0f14',
    veil: ['rgba(13,17,23,0.96)', 'rgba(13,17,23,0.86)', 'rgba(13,17,23,0.42)', 'rgba(13,17,23,0.72)'],
    veilEdge: 'rgba(13,17,23,0.9)',
    grid: 'rgba(139,148,158,0.055)',
    glowAlpha: 0.26,
    ...TOKEN_COLORS.dark,
  },
  light: {
    bg: '#ffffff',
    card: '#f6f8fa',
    border: '#d0d7de',
    text: '#1f2328',
    muted: '#59636e',
    dim: '#818b98',
    blue: '#0969da',
    green: '#1a7f37',
    surfaceRaised: '#eef1f4',
    surfaceSunken: '#f6f8fa',
    veil: ['rgba(255,255,255,0.97)', 'rgba(255,255,255,0.9)', 'rgba(255,255,255,0.55)', 'rgba(255,255,255,0.78)'],
    veilEdge: 'rgba(255,255,255,0.92)',
    grid: 'rgba(31,35,40,0.05)',
    glowAlpha: 0.16,
    ...TOKEN_COLORS.light,
  },
};

// Geometry is the one thing the renderer, the audit and the HTTP layer must all
// agree on, so it comes from config rather than being restated per template.
const withGeometry = (theme) => ({ width: config.bannerWidth, height: config.bannerHeight, ...THEMES[theme] });

export const getPalette = (theme = 'dark') => withGeometry(theme in THEMES ? theme : 'dark');

export const themes = Object.keys(THEMES);
