import assert from 'node:assert/strict';
import { test } from 'node:test';

import { batchCommand, run } from '../../lcu/capture.mjs';

test('output larger than a pipe buffer survives a child that exits right after printing', () => {
  const script = "process.stdout.write('x'.repeat(200000)); process.stderr.write('done'); process.exit(3)";
  const result = run(process.execPath, ['-e', script]);
  assert.deepEqual([result.status, result.stdout.length, result.stderr], [3, 200000, 'done']);
});

test('on Windows an npm .cmd or .bat shim runs through cmd.exe with every part quoted', () => {
  const options = { cwd: 'C:\\work', timeout: 5 };
  assert.deepEqual(batchCommand('C:\\npm\\codex.CMD', ['mcp', 'list', 'a b', 'C:\\dir\\'], options, 'win32'), ['cmd.exe',
    ['/d', '/s', '/c', '""C:\\npm\\codex.CMD" "mcp" "list" "a b" "C:\\dir\\\\""'],
    { ...options, windowsVerbatimArguments: true }]);
  assert.equal(batchCommand('C:\\npm\\pi.bat', [], {}, 'win32')[0], 'cmd.exe');
  for (const bad of ['50%', 'say "hi"', 'two\nlines']) {
    assert.throws(() => batchCommand('C:\\npm\\omp.cmd', ['config', bad], {}, 'win32'), /safely to the batch file/);
  }
  assert.deepEqual(batchCommand('C:\\app\\codex.exe', ['x'], options, 'win32'), ['C:\\app\\codex.exe', ['x'], options]);
  assert.deepEqual(batchCommand('/usr/bin/codex.cmd', ['%'], options, 'linux'), ['/usr/bin/codex.cmd', ['%'], options]);
});
