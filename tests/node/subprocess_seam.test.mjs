// Shared subprocess seam (compat/subprocess.mjs run, compat/runas.mjs runProcess) vs CPython's subprocess.run:
// round-2 F7 (a cwd that cannot be entered is blamed, not argv[0]) and F8 (timeout 0 expires at once).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { runProcess } from '../../lcu/compat/runas.mjs';
import { run } from '../../lcu/compat/subprocess.mjs';
import { python312 } from './runtime_support.mjs';

const PYTHON = python312();
const TRUE = ['/usr/bin/true'];
const outcome = (fn) => { try { fn(); return 'returned'; } catch (e) { return `${e.name}: ${e.message}`; } };

describe('subprocess seam vs CPython', { skip: !PYTHON && 'needs python3.12' }, () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'lcu-seam-')));
  const cases = { missing: join(base, 'missing'), notdir: join(base, 'notdir'), blocked: join(base, 'blocked') };
  writeFileSync(cases.notdir, 'x');
  mkdirSync(cases.blocked);
  chmodSync(cases.blocked, 0);
  const python = (code, args) => spawnSync(PYTHON, ['-c', code, ...args], { encoding: 'utf8' }).stdout.trim();

  it('cwd failures name the cwd, as Python does', (t) => {
    if (process.getuid?.() === 0) t.diagnostic('root: the denied-cwd case cannot fail, only missing/notdir are compared');
    for (const [name, cwd] of Object.entries(cases)) {
      if (name === 'blocked' && process.getuid?.() === 0) continue;
      const expected = python(`import subprocess, sys
try: subprocess.run(['/usr/bin/true'], cwd=sys.argv[1])
except Exception as e: print(type(e).__name__ + ': ' + str(e))`, [cwd]);
      assert.equal(outcome(() => run(TRUE, { cwd })), expected, name);
      assert.equal(outcome(() => runProcess(TRUE, { cwd })), expected, `${name} (runProcess)`);
    }
  });

  it('timeout 0 expires immediately (spawnSync would wait without limit)', () => {
    const expected = python(`import subprocess, time
t = time.time()
try: subprocess.run(['/bin/sleep', '0.3'], timeout=0)
except subprocess.TimeoutExpired as e: print('TimeoutExpired')
print(round(time.time() - t, 1))`, []).split('\n');
    for (const call of [() => run(['/bin/sleep', '0.3'], { timeout: 0 }), () => runProcess(['/bin/sleep', '0.3'], { timeout: 0 })]) {
      const start = performance.now();
      const result = outcome(call);
      assert.match(result, /^TimeoutExpired: /);
      assert.equal(expected[0], 'TimeoutExpired');
      assert.ok(performance.now() - start < 250, 'did not wait for the child');
    }
  });

  it('cleanup', () => { chmodSync(cases.blocked, 0o700); rmSync(base, { recursive: true, force: true }); });
});
