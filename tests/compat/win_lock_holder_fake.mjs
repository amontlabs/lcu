// Stand-in for the Windows PowerShell lock holder (lcu/compat/lock.mjs windowsHolderScript), used by
// tests/compat/test_lock.py through lock._testing on any OS. It speaks the same protocol on the same
// stdio: status lines on stdout (a private file), lifetime on stdin.
//   argv[2] = mode: lock | deadlock | openfail | die-after-lock (exits 300 ms after LOCKED)
import { writeSync } from 'node:fs';

const mode = process.argv[2];
const say = (line) => writeSync(1, line + '\n');
if (mode === 'deadlock') {
  say('DEADLOCK');
  process.exit(4);
}
if (mode === 'openfail') {
  say('OPENFAIL -2147024891');
  process.exit(3);
}
say('LOCKED');
if (mode === 'die-after-lock') setTimeout(() => process.exit(9), 300); // lost while held
process.stdin.resume();
process.stdin.on('end', () => {
  say('RELEASED');
  process.exit(0);
});
