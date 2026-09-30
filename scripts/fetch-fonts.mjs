// Downloads the two webfonts the banner depends on and writes a self-hosted
// stylesheet. The rendered PNG must look identical on every machine, so the
// fonts are vendored rather than resolved from the host's font stack.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FONT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts');

// Only `latin` is kept. It covers every glyph the banner can emit, and the extra
// subsets roughly triple the payload for characters that never appear here.
// `family` must match the name the banner's CSS asks for; `stem` only names the
// file on disk. They cannot be the same identifier, because "jetbrains-mono" is
// not a match for "JetBrains Mono" and the browser would silently fall back.
const FAMILIES = [
  { css: 'Inter:wght@100..900', family: 'Inter', stem: 'inter' },
  { css: 'JetBrains+Mono:wght@100..800', family: 'JetBrains Mono', stem: 'jetbrains-mono' },
];

// Google's CSS is keyed off a desktop UA string; without it we get TTF instead
// of woff2 and Chromium refuses the woff2 @font-face source.
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const parseFaces = (css) => {
  const faces = [];
  const blocks = css.split(/\/\*\s*([\w-]+)\s*\*\//).slice(1);
  for (let i = 0; i < blocks.length; i += 2) {
    const subset = blocks[i];
    const body = blocks[i + 1] ?? '';
    const url = body.match(/url\((https:\/\/[^)]+\.woff2)\)/)?.[1];
    if (subset === 'latin' && url) {
      faces.push({ url, weight: body.match(/font-weight:\s*([^;]+);/)?.[1]?.trim() ?? '400' });
    }
  }
  return faces;
};

const main = async () => {
  await mkdir(FONT_DIR, { recursive: true });
  const pathRules = [];
  const inlineRules = [];

  for (const family of FAMILIES) {
    const cssUrl = `https://fonts.googleapis.com/css2?family=${family.css}&display=swap`;
    const css = await (await fetch(cssUrl, { headers: { 'User-Agent': DESKTOP_UA } })).text();
    const faces = parseFaces(css);
    if (faces.length === 0) throw new Error(`No latin subset found for ${family.css}`);

    for (const face of faces) {
      const fileName = `${family.stem}-${face.weight.replace(/\s+/g, '_')}.woff2`;
      const bytes = Buffer.from(await (await fetch(face.url)).arrayBuffer());
      await writeFile(join(FONT_DIR, fileName), bytes);

      const shared =
        `font-family:'${family.family}';font-style:normal;` +
        `font-weight:${face.weight};font-display:block;`;

      // The renderer injects CSS into a document with no base URL, so relative
      // font paths cannot resolve. It reads the inline variant; the web UI uses
      // the path variant so the fonts stay cacheable across requests.
      pathRules.push(`@font-face{${shared}src:url('./${fileName}') format('woff2');}`);
      inlineRules.push(
        `@font-face{${shared}src:url(data:font/woff2;base64,${bytes.toString('base64')}) format('woff2');}`,
      );
      console.log(`${fileName}  ${(bytes.length / 1024).toFixed(1)} kB`);
    }
  }

  await writeFile(join(FONT_DIR, 'fonts.css'), `${pathRules.join('\n')}\n`);
  await writeFile(join(FONT_DIR, 'fonts.inline.css'), `${inlineRules.join('\n')}\n`);
  console.log('Wrote assets/fonts/fonts.css and fonts.inline.css');
};

main().catch((error) => {
  console.error(`Font fetch failed: ${error.message}`);
  console.error('The banner falls back to the system font stack, so this is not fatal.');
  process.exit(1);
});
