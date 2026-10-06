// Import closure of LCU's Node entry points: every quoted relative `./x.mjs|cjs|js` reached from the given files,
// resolved against the files themselves. Shared by the archive
// closure test (tests/node/bundle_closure.test.mjs) and scripts that need to know which files a platform needs.
import fs from 'node:fs';
import path from 'node:path';

// Any quoted relative file specifier: `from './x.mjs'`, `import('./x.mjs')`, `require('./x.mjs')` and the
// injectable loaders (`internals.load('./setup.mjs')`).
const SPECIFIER = /['"](\.{1,2}\/[^'"\s]+\.(?:mjs|cjs|js))['"]/g;

/** Returns { files: sorted absolute paths that exist, missing: absolute paths imported but absent }. */
export function closure(entries, root = process.cwd()) {
  const seen = new Set();
  const missing = new Set();
  const stack = entries.map((entry) => path.resolve(root, entry));
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    if (!fs.existsSync(file)) {
      missing.add(file);
      continue;
    }
    seen.add(file);
    if (!/\.(mjs|cjs|js)$/.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(SPECIFIER)) stack.push(path.resolve(path.dirname(file), match[1]));
  }
  return { files: [...seen].sort(), missing: [...missing].sort() };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = closure(process.argv.slice(2));
  const root = process.cwd();
  for (const file of result.files) console.log(path.relative(root, file));
  for (const file of result.missing) console.log('MISSING', path.relative(root, file));
}
