import assert from 'node:assert/strict';
import { test } from 'node:test';

import { run } from '../../lcu/capture.mjs';

test('output larger than a pipe buffer survives a child that exits right after printing', () => {
  const script = "process.stdout.write('x'.repeat(200000)); process.stderr.write('done'); process.exit(3)";
  const result = run(process.execPath, ['-e', script]);
  assert.deepEqual([result.status, result.stdout.length, result.stderr], [3, 200000, 'done']);
});
