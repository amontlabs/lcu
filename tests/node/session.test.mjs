import assert from 'node:assert/strict';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { main } from '../../lcu/session.mjs';
import { discover } from '../../lcu/session.mjs';
import { override, temporary, write } from './fixtures.mjs';

function session(proc, pid, display = ':1') {
  write(join(proc, String(pid), 'comm'), 'xfce4-session\n');
  write(join(proc, String(pid), 'environ'),
    `DISPLAY=${display}\0DBUS_SESSION_BUS_ADDRESS=unix:path=/run/test\0TOKEN=never-copy\0`);
}

test('discovery copies only the GUI environment', (t) => {
  const proc = temporary(t);
  session(proc, 123);
  write(join(proc, 'self/comm'), 'xfce4-session\n');
  assert.deepEqual(discover(proc), { DISPLAY: ':1', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/test' });
});

test('an ambiguous desktop or another account’s desktop is refused', (t) => {
  const proc = temporary(t);
  session(proc, 123);
  assert.throws(() => discover(proc, process.getuid() + 1), /found 0/);
  session(proc, 124, ':2');
  assert.throws(() => discover(proc), /found 2/);
});

test('the launcher runs the command in the discovered session as the calling account only', (t) => {
  const calls = [];
  override(t, process, 'execve', (...args) => calls.push(args));
  assert.throws(() => main(['--user', `${userInfo().username}-other`, '--', 'true']), /selected desktop account/);
  assert.equal(calls.length, 0);
  t.mock.method(process.stderr, 'write', () => true);
  assert.equal(main(['--user', userInfo().username]), 2);
});
