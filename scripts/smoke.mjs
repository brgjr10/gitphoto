import { writeFile } from 'node:fs/promises';
import { generateCover, coverPath } from '../src/services/pipeline.js';
import { closeBrowser } from '../src/services/renderer.js';
import { ensureDataDirs } from '../src/config.js';
import { readFile } from 'node:fs/promises';

// Renders one repository outside the HTTP layer. Useful for checking layout
// changes without clicking through the UI:
//   node scripts/smoke.mjs deadvisionai/FactorApp dark
const ref = process.argv[2] ?? 'expressjs/express';
const theme = process.argv[3] ?? 'dark';
const force = process.argv.includes('--refresh');

await ensureDataDirs();

const started = Date.now();
const stem = `smoke-${ref.replace(/[^\w.-]/g, '-')}-${theme}`;
const result = await generateCover(ref, {
  options: { theme, refresh: force },
  origin: 'http://localhost:9780',
  htmlPath: `${stem}.html`,
  onProgress: (event) => console.log(`  [${event.stage}] ${event.detail ?? ''}`),
});

// A cache hit returns no buffer; the PNG is already on disk.
const buffer = result.buffer ?? (await readFile(coverPath(result.fileName)));
await writeFile(`${stem}.png`, buffer);

console.log(
  `\n${result.fullName} -> ${stem}.png\n` +
    `strategy=${result.strategy} label=${result.label ?? '-'} framework=${result.framework}\n` +
    `bytes=${result.bytes} duration=${result.durationMs}ms total=${Date.now() - started}ms\n` +
    `banner document: ${stem}.html  (node scripts/verify-layout.mjs ${stem}.html ${result.fullName})`,
);

if (process.argv.includes('--explain')) {
  console.log('\ncandidate preview strategies, highest confidence first:');
  for (const candidate of result.explain ?? []) {
    console.log(`  ${String(candidate.confidence).padStart(3)}  ${candidate.kind.padEnd(7)} ${candidate.label ?? ''}  ${candidate.target ?? ''}`);
  }
}

for (const attempt of result.attempts) {
  console.log(`  attempt ${attempt.kind}: ${attempt.ok ? 'ok' : `failed (${attempt.reason})`}`);
}

await closeBrowser();
process.exit(0);
