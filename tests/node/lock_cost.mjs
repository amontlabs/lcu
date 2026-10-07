// Prints how long LCU's lock takes to acquire and release on this machine (Windows: a PowerShell holder per lock).
// Not a test (no .test.mjs suffix); run by .github/workflows/windows-node.yml before the suite, on an idle runner.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquireSync } from '../../lcu/compat/lock.mjs';

const file = join(mkdtempSync(join(tmpdir(), 'lcu-lockcost-')), 'x.lock');
for (let i = 0; i < 5; i += 1) {
  const started = Date.now();
  const lock = acquireSync(file);
  const acquired = Date.now() - started;
  lock.release();
  console.log(`lock ${i}: acquired in ${acquired} ms, released after ${Date.now() - started} ms`);
}
