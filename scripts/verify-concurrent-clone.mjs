import { readdir } from 'node:fs/promises';
// Relative, so the script resolves against the repo layout on the host and at
// /app in the container, where the old absolute form only worked.
import { cloneRepo } from '../src/services/workspace.js';
import { config } from '../src/config.js';

// The failing scenario: two renders of the same repo in flight at once, which
// renderConcurrency=2 explicitly permits. Both used to resolve to one path.
const target = { owner: 'openclaw', repo: 'openclaw', branch: 'main' };

const started = Date.now();
const results = await Promise.allSettled([cloneRepo(target), cloneRepo(target)]);

results.forEach((result, index) => {
  if (result.status === 'fulfilled') {
    console.log(`clone${index}: OK dir=${result.value.dir.split('/').pop()} sha=${result.value.sha.slice(0, 8)}`);
  } else {
    console.log(`clone${index}: FAILED ${result.reason.message}`);
  }
});

const failures = results.filter((r) => r.status === 'rejected').length;
console.log(`\n${results.length - failures}/${results.length} succeeded in ${Date.now() - started}ms`);

// Confirm the two clones used distinct directories, which is the actual fix.
const dirs = results.filter((r) => r.status === 'fulfilled').map((r) => r.value.dir);
console.log(`distinct dirs: ${new Set(dirs).size}/${dirs.length}`);
console.log(`leftover clone dirs: ${(await readdir(config.cloneDir)).length}`);

process.exit(failures === 0 && new Set(dirs).size === dirs.length ? 0 : 1);
