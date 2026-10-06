"""lcu/compat/lock.mjs interoperating with Python's fcntl.flock."""
import base64
import fcntl
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

import os as _os
import sys as _sys

_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from support import COMPAT, NODE, SYSTOOL_URL, NodeTestCase, in_disposable_linux, own_session_popen, send

LOCK_URL = (COMPAT / 'lock.mjs').as_uri()

PY_HOLD = '''
import fcntl, os, sys, time
fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
fcntl.flock(fd, fcntl.LOCK_EX)
print('HELD', flush=True)
sys.stdin.readline()          # hold until told to release
print('RELEASING', flush=True)
os.close(fd)
'''

PY_TRY = '''
import fcntl, os, sys
fd = os.open(sys.argv[1], os.O_RDWR)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    print('FREE')
except BlockingIOError:
    print('BUSY')
'''

PY_WAIT = '''
import fcntl, os, sys, time
fd = os.open(sys.argv[1], os.O_RDWR)
print('WAITING', flush=True)
fcntl.flock(fd, fcntl.LOCK_EX)
print('GOT %f' % time.time(), flush=True)
'''


def py_try(path):
    return subprocess.run([sys.executable, '-c', PY_TRY, str(path)], capture_output=True, text=True,
                          check=True).stdout.strip()


def node_script(body):
    return ("import * as lock from " + json.dumps(LOCK_URL) + ";\n"
            "import * as pyerr from " + json.dumps((COMPAT / 'pyerr.mjs').as_uri()) + ";\n" + body)


def spawn_node(body, *args, **kwargs):
    return subprocess.Popen([NODE, '--input-type=module', '-e', node_script(body), *map(str, args)],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, **kwargs)


class LockInteropTests(NodeTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'x.lock'
        self.procs = []
        self.addCleanup(self.cleanup)

    def cleanup(self):
        for proc in self.procs:
            if proc.poll() is None:
                send(proc, signal.SIGKILL)
            proc.wait()
            for stream in (proc.stdin, proc.stdout, proc.stderr):
                if stream:
                    stream.close()

    def popen(self, *argv, **kwargs):
        proc = own_session_popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, **kwargs)
        self.procs.append(proc)
        return proc

    def python_holder(self):
        proc = self.popen(sys.executable, '-c', PY_HOLD, str(self.path))
        self.assertEqual(proc.stdout.readline().strip(), 'HELD')
        return proc

    def node_holder(self, hold_marker='HELD'):
        proc = self.popen(NODE, '--input-type=module', '-e', node_script(f'''
const l = await lock.acquire(process.argv[1]);
console.log({json.dumps(hold_marker)});
process.stdin.on('data', () => {{ l.release(); console.log('RELEASED'); process.exit(0); }});
'''), str(self.path))
        self.assertEqual(proc.stdout.readline().strip(), hold_marker)
        return proc

    def test_python_holds_node_waits(self):
        holder = self.python_holder()
        waiter = self.popen(NODE, '--input-type=module', '-e', node_script('''
console.log('WAITING');
const t = Date.now();
const l = await lock.acquire(process.argv[1]);
console.log('GOT ' + (Date.now() - t));
l.release();
'''), str(self.path))
        self.assertEqual(waiter.stdout.readline().strip(), 'WAITING')
        time.sleep(1.0)
        self.assertIsNone(waiter.poll(), 'node must still be waiting while Python holds the lock')
        released = time.time()
        holder.stdin.write('\n')
        holder.stdin.flush()
        line = waiter.stdout.readline().strip()
        self.assertTrue(line.startswith('GOT'), line)
        self.assertGreaterEqual(time.time() - released, 0)
        self.assertGreaterEqual(int(line.split()[1]), 900)
        self.assertEqual(waiter.wait(timeout=10), 0)

    def test_python_holds_node_sync_waits(self):
        holder = self.python_holder()
        waiter = self.popen(NODE, '--input-type=module', '-e', node_script('''
console.log('WAITING');
const t = Date.now();
const l = lock.acquireSync(process.argv[1]);
console.log('GOT ' + (Date.now() - t));
l.release();
'''), str(self.path))
        self.assertEqual(waiter.stdout.readline().strip(), 'WAITING')
        time.sleep(1.0)
        self.assertIsNone(waiter.poll())
        holder.stdin.write('\n')
        holder.stdin.flush()
        line = waiter.stdout.readline().strip()
        self.assertGreaterEqual(int(line.split()[1]), 900, line)
        self.assertEqual(waiter.wait(timeout=10), 0)

    def test_node_holds_python_waits(self):
        holder = self.node_holder()
        self.assertEqual(py_try(self.path), 'BUSY')
        waiter = self.popen(sys.executable, '-c', PY_WAIT, str(self.path))
        self.assertEqual(waiter.stdout.readline().strip(), 'WAITING')
        time.sleep(0.8)
        self.assertIsNone(waiter.poll(), 'python must still be waiting while node holds the lock')
        released = time.time()
        holder.stdin.write('x\n')
        holder.stdin.flush()
        self.assertEqual(holder.stdout.readline().strip(), 'RELEASED')
        line = waiter.stdout.readline().split()
        self.assertEqual(line[0], 'GOT')
        self.assertGreaterEqual(float(line[1]), released - 0.05)
        self.assertEqual(waiter.wait(timeout=10), 0)

    def test_node_sync_holds_python_try(self):
        holder = self.popen(NODE, '--input-type=module', '-e', node_script('''
const l = lock.acquireSync(process.argv[1]);
console.log('HELD');
process.stdin.on('data', () => { l.release(); console.log('RELEASED'); process.exit(0); });
'''), str(self.path))
        self.assertEqual(holder.stdout.readline().strip(), 'HELD')
        self.assertEqual(py_try(self.path), 'BUSY')
        holder.stdin.write('x\n')
        holder.stdin.flush()
        self.assertEqual(holder.stdout.readline().strip(), 'RELEASED')
        self.assertEqual(py_try(self.path), 'FREE')

    def test_killed_node_releases(self):
        holder = self.node_holder()
        self.assertEqual(py_try(self.path), 'BUSY')
        send(holder, signal.SIGKILL)
        holder.wait()
        self.assertEqual(py_try(self.path), 'FREE')

    def test_exit_without_release_frees_lock(self):
        done = subprocess.run([NODE, '--input-type=module', '-e', node_script('''
await lock.acquire(process.argv[1]);
console.log('HELD then exiting');
'''), str(self.path)], capture_output=True, text=True, timeout=30)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(py_try(self.path), 'FREE')

    def test_node_holder_survives_no_stray_processes(self):
        before = subprocess.run(['ps', '-axo', 'command'], capture_output=True, text=True).stdout
        holder = self.node_holder()
        during = subprocess.run(['ps', '-axo', 'command'], capture_output=True, text=True).stdout
        new = [line for line in during.splitlines() if ('flock' in line or 'lockf' in line)
               and line not in before and str(self.path) not in line and 'ps -ax' not in line]
        self.assertEqual(new, [], 'no helper process may remain while the lock is held')
        send(holder, signal.SIGKILL)

    def test_timeout(self):
        holder = self.python_holder()
        run = subprocess.run([NODE, '--input-type=module', '-e', node_script('''
const out = [];
for (const timeout of [0, 1]) {
  const t = Date.now();
  try { (await lock.acquire(process.argv[1], { timeout })).release(); out.push('got'); }
  catch (e) { out.push(e.name + ' ' + (Date.now() - t >= timeout * 1000 ? 'waited' : 'early')); }
  try { lock.acquireSync(process.argv[1], { timeout }).release(); out.push('got'); }
  catch (e) { out.push(e.name + ' ' + (Date.now() - t >= timeout * 1000 ? 'waited' : 'early')); }
}
console.log(out.join(','));
'''), str(self.path)], capture_output=True, text=True, timeout=60)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(run.stdout.strip(),
                         'LockTimeoutError waited,LockTimeoutError waited,LockTimeoutError waited,LockTimeoutError waited')
        self.assertEqual(py_try(self.path), 'BUSY', 'failed attempts must not disturb the holder')
        holder.stdin.write('\n')
        holder.stdin.flush()
        holder.wait(timeout=10)
        run = subprocess.run([NODE, '--input-type=module', '-e', node_script(
            "(await lock.acquire(process.argv[1], { timeout: 2 })).release(); console.log('ok');"), str(self.path)],
            capture_output=True, text=True, timeout=30)
        self.assertEqual(run.stdout.strip(), 'ok', run.stderr)

    def test_file_is_opened_like_python(self):
        # created 0600 (umask-independent), contents untouched, nothing else left behind
        old = os.umask(0)
        try:
            subprocess.run([NODE, '--input-type=module', '-e', node_script(
                "await lock.withLock(process.argv[1], () => 0);"), str(self.path)], check=True)
        finally:
            os.umask(old)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.path.read_bytes(), b'')
        self.assertEqual(sorted(p.name for p in self.path.parent.iterdir()), ['x.lock'])
        # an existing file keeps its mode and content
        self.path.write_text('keep')
        self.path.chmod(0o640)
        subprocess.run([NODE, '--input-type=module', '-e', node_script(
            "lock.withLockSync(process.argv[1], () => 0);"), str(self.path)], check=True)
        self.assertEqual((self.path.read_text(), self.path.stat().st_mode & 0o777), ('keep', 0o640))

    def test_open_errors_match_python(self):
        d = Path(self.tmp.name)
        (d / 'target').write_text('x')
        (d / 'link.lock').symlink_to('target')
        (d / 'dir.lock').mkdir()
        cases = [str(d / 'link.lock'), str(d / 'nodir' / 'x.lock'), str(d / 'dir.lock'), str(d / 'target' / 'x.lock')]
        want = []
        for case in cases:
            try:
                os.open(case, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            except OSError as exc:
                want.append(f'{type(exc).__name__}: {exc}')
        run = subprocess.run([NODE, '--input-type=module', '-e', node_script('''
const out = [];
for (const p of JSON.parse(process.argv[1])) {
  try { lock.acquireSync(p); out.push('acquired'); }
  catch (e) { const s = pyerr.fromNodeError(e); out.push(s.name + ': ' + s.message); }
}
console.log(JSON.stringify(out));
'''), json.dumps(cases)], capture_output=True, text=True, timeout=30)
        self.assertEqual(json.loads(run.stdout), want)

    def test_append_mode_file(self):
        old = os.umask(0o022)
        try:
            subprocess.run([NODE, '--input-type=module', '-e', node_script(
                "await lock.withLock(process.argv[1], () => 0, { file: lock.APPEND_LOCK_FILE });"),
                str(self.path)], check=True)
        finally:
            os.umask(old)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o644)

    def test_with_lock_serialises_concurrent_users(self):
        run = subprocess.run([NODE, '--input-type=module', '-e', node_script('''
const events = [];
let inside = 0, overlap = false;
await Promise.all([1, 2, 3, 4, 5].map((n) => lock.withLock(process.argv[1], async () => {
  inside += 1; if (inside > 1) overlap = true;
  events.push('in' + n);
  await new Promise((r) => setTimeout(r, 50));
  events.push('out' + n);
  inside -= 1;
})));
console.log(JSON.stringify({ overlap, events }));
'''), str(self.path)], capture_output=True, text=True, timeout=60)
        result = json.loads(run.stdout)
        self.assertFalse(result['overlap'])
        self.assertEqual(len(result['events']), 10)
        for i in range(0, 10, 2):
            self.assertEqual(result['events'][i][2:], result['events'][i + 1][3:])

    def test_many_processes_mutual_exclusion(self):
        # Python and Node workers increment a shared counter under the same lock; no update may be lost.
        counter = Path(self.tmp.name) / 'counter'
        counter.write_text('0')
        py = '''
import fcntl, os, sys
counter, lockpath, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
for _ in range(n):
    fd = os.open(lockpath, os.O_CREAT | os.O_RDWR, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX)
    value = int(open(counter).read())
    open(counter, 'w').write(str(value + 1))
    os.close(fd)
'''
        js = '''
import { readFileSync, writeFileSync } from 'node:fs';
const [counter, lockpath, n] = process.argv.slice(1);
for (let i = 0; i < Number(n); i++) {
  lock.withLockSync(lockpath, () => writeFileSync(counter, String(Number(readFileSync(counter, 'utf8')) + 1)));
}
'''
        procs = []
        for _ in range(3):
            procs.append(subprocess.Popen([sys.executable, '-c', py, str(counter), str(self.path), '40']))
            procs.append(subprocess.Popen([NODE, '--input-type=module', '-e', node_script(js), str(counter),
                                           str(self.path), '40']))
        for proc in procs:
            self.assertEqual(proc.wait(timeout=180), 0)
        self.assertEqual(counter.read_text(), str(6 * 40))

    # ---- compat-os review findings 6 and 7: cancellation, interruption, bounded waiters ----------------

    def test_abort_signal_before_and_during_wait(self):
        # finding 7 (lock-preaborted): an already-aborted signal must not wait; an abort during the wait
        # ends it promptly; neither disturbs the holder.
        holder = self.python_holder()
        run = subprocess.run([NODE, '--input-type=module', '-e', node_script('''
const out = [];
const pre = new AbortController(); pre.abort(new Error('cancelled'));
let t = Date.now();
try { await lock.acquire(process.argv[1], { signal: pre.signal }); out.push('acquired'); }
catch (e) { out.push(e.message + (Date.now() - t < 500 ? ' fast' : ' slow')); }
try { lock.acquireSync(process.argv[1], { signal: pre.signal }); out.push('acquired'); }
catch (e) { out.push('sync ' + e.message); }
const later = new AbortController(); setTimeout(() => later.abort(new Error('later')), 300);
t = Date.now();
try { await lock.acquire(process.argv[1], { signal: later.signal }); out.push('acquired'); }
catch (e) { out.push(e.message + (Date.now() - t < 1500 ? ' fast' : ' slow')); }
console.log(JSON.stringify(out));
'''), str(self.path)], capture_output=True, text=True, timeout=20)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(json.loads(run.stdout), ['cancelled fast', 'sync cancelled', 'later fast'])
        self.assertEqual(py_try(self.path), 'BUSY')
        holder.stdin.write('\n')
        holder.stdin.flush()
        self.assertEqual(holder.wait(timeout=10), 0)
        self.assertEqual(py_try(self.path), 'FREE', 'no cancelled waiter may keep or take the lock')

    def ctrl_c(self, mode, handler):
        holder = self.python_holder()
        body = ("process.on('SIGINT', () => console.log('HANDLER'));\n" if handler else '') + f'''
console.log('WAITING');
try {{
  const l = {'lock.acquireSync(process.argv[1])' if mode == 'sync' else 'await lock.acquire(process.argv[1])'};
  console.log('ENTERED'); l.release();
}} catch (e) {{ console.log(e.name + ' ' + e.signal); await new Promise((r) => setTimeout(r, 100)); }}
'''
        waiter = self.popen(NODE, '--input-type=module', '-e', node_script(body), str(self.path))
        self.assertEqual(waiter.stdout.readline().strip(), 'WAITING')
        time.sleep(0.5)
        send(waiter, signal.SIGINT, group=True)  # what a terminal Ctrl-C does: the whole foreground group
        out, err = waiter.communicate(timeout=10)
        self.assertEqual(py_try(self.path), 'BUSY')
        holder.stdin.write('\n')
        holder.stdin.flush()
        return waiter.returncode, out.split(), err

    def test_ctrl_c_interrupts_sync_wait_before_critical_section(self):
        # finding 6 (lock-sync-signal-handler): with a JS handler, the wait ends with
        # LockInterruptedError and the handler runs; the critical section is never entered.
        code, out, err = self.ctrl_c('sync', handler=True)
        self.assertEqual((code, out), (0, ['LockInterruptedError', 'SIGINT', 'HANDLER']), err)

    def test_ctrl_c_interrupts_async_wait(self):
        code, out, err = self.ctrl_c('async', handler=True)
        self.assertNotIn('ENTERED', out, err)
        self.assertEqual(code, 0, err)
        self.assertIn('HANDLER', out)

    def test_ctrl_c_without_handler_kills_like_python(self):
        code, out, _ = self.ctrl_c('sync', handler=False)
        self.assertEqual((code, out), (-signal.SIGINT, []))

    @unittest.skipUnless(in_disposable_linux(), 'observes helper processes through /proc (Linux container)')
    def test_waiter_death_leaves_no_helper(self):
        # finding 6 (lock-parent-death-*): kill the waiting Node parent (SIGKILL and SIGINT, sync and
        # async); its flock helper must be gone within ~1 s although the Python holder keeps the lock.
        holder = self.python_holder()

        def alive(pid):
            try:
                return Path(f'/proc/{pid}/stat').read_text().split()[2] != 'Z'
            except OSError:
                return False

        for mode in ('acquireSync', 'acquire'):
            for sig in (signal.SIGKILL, signal.SIGINT):
                with self.subTest(mode=mode, sig=sig.name):
                    waiter = self.popen(NODE, '--input-type=module', '-e', node_script(
                        f"console.log('WAITING'); await lock.{mode}(process.argv[1]); console.log('ENTERED');"),
                        str(self.path))
                    self.assertEqual(waiter.stdout.readline().strip(), 'WAITING')
                    helpers = []
                    for _ in range(300):
                        children = Path(f'/proc/{waiter.pid}/task/{waiter.pid}/children')
                        helpers = children.read_text().split() if children.exists() else []
                        if helpers:
                            break
                        time.sleep(0.01)
                    self.assertTrue(helpers, 'no helper observed')
                    send(waiter, sig)  # the Node process only, not its group
                    waiter.wait(timeout=5)
                    deadline = time.time() + 2.5
                    while time.time() < deadline and any(alive(p) for p in helpers):
                        time.sleep(0.05)
                    self.assertFalse(any(alive(p) for p in helpers), f'helper outlived its parent: {helpers}')
                    self.assertEqual(py_try(self.path), 'BUSY')
        holder.stdin.write('\n')
        holder.stdin.flush()


class HelperSelectionTests(NodeTestCase):
    """findings 2/4/6: absolute trusted helpers, a fixed environment, bounded waits, explicit platform branches."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'x.lock'

    def test_helper_arguments_and_environment(self):
        got = subprocess.run([NODE, '--input-type=module', '-e', node_script(f'''
const sys = await import({json.dumps(SYSTOOL_URL)});
sys._testing.override('flock', '/fake/flock');
sys._testing.override('lockf', '/fake/lockf');
const out = {{}};
for (const platform of ['linux', 'darwin']) {{
  const calls = [];
  let busy = 2;
  lock._testing.set({{ platform, spawnSync: (c, a, o) => {{ calls.push([c, a, o.env, o.stdio.length]); return busy-- > 0 ? {{ status: 75 }} : {{ status: 0 }}; }} }});
  lock.acquireSync(process.argv[1]).release();
  busy = 0;
  try {{ lock.acquireSync(process.argv[1], {{ timeout: 0 }}).release(); }} catch (e) {{ calls.push(e.name); }}
  lock._testing.set({{ spawnSync: () => ({{ status: null, signal: 'SIGINT' }}) }});
  try {{ lock.acquireSync(process.argv[1]); }} catch (e) {{ calls.push(e.name + ' ' + e.signal); }}
  out[platform] = calls;
}}
console.log(JSON.stringify(out));
'''), str(self.path)], capture_output=True, text=True, timeout=30)
        self.assertEqual(got.returncode, 0, got.stderr)
        out = json.loads(got.stdout)
        env = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'LC_ALL': 'C', 'LANG': 'C'}
        flock = ['/fake/flock', ['-E', '75', '-w', '1', '-x', '3'], env, 4]
        self.assertEqual(out['linux'], [flock, flock, flock, ['/fake/flock', ['-E', '75', '-w', '0', '-x', '3'], env, 4],
                                        'LockInterruptedError SIGINT'])
        lockf = ['/fake/lockf', ['-s', '-t', '1', '3'], env, 4]
        self.assertEqual(out['darwin'], [lockf, lockf, lockf, ['/fake/lockf', ['-s', '-t', '0', '3'], env, 4],
                                         'LockInterruptedError SIGINT'])

    def test_environment_cannot_choose_the_helper(self):
        # finding 2: PATH (and stray variables) never select the locker.
        fake = Path(self.tmp.name) / 'bin'
        fake.mkdir()
        marker = Path(self.tmp.name) / 'ran'
        for name in ('flock', 'lockf'):
            (fake / name).write_text(f'#!/bin/sh\necho {name} >> "{marker}"\nexit 0\n')
            (fake / name).chmod(0o755)
        env = {**os.environ, 'PATH': f'{fake}:{os.environ.get("PATH", "")}', 'POSIXLY_CORRECT': '1', 'LC_ALL': 'C'}
        holder = own_session_popen([NODE, '--input-type=module', '-e', node_script('''
const l = lock.acquireSync(process.argv[1]); console.log('HELD');
process.stdin.on('data', () => { l.release(); process.exit(0); });
'''), str(self.path)], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(holder.stdout.readline().strip(), 'HELD')
            self.assertEqual(py_try(self.path), 'BUSY', 'a real lock must be held')
            self.assertFalse(marker.exists(), 'a PATH helper ran')
        finally:
            holder.stdin.write('x\n')
            holder.stdin.flush()
            holder.wait(timeout=10)
            for stream in (holder.stdin, holder.stdout, holder.stderr):
                stream.close()


WIN_FAKE = Path(__file__).resolve().parent / 'win_lock_holder_fake.mjs'


class WindowsHolderFixtureTests(NodeTestCase):
    """finding 4: the msvcrt.locking(fd, LK_LOCK, 1) equivalent, driven through an injected holder.

    Fixture evidence only (no live Windows): the real holder is the PowerShell script whose text is
    checked here; the protocol, the Node-side handle and the error/loss handling run against a stand-in
    that speaks the same protocol on the same stdio.
    """

    def run_win(self, body, path):
        script = node_script(f'''
import {{ spawn }} from 'node:child_process';
const calls = [];
let mode = 'lock';
lock._testing.set({{ platform: 'win32', spawn: (command, args, options) => {{
  calls.push({{ command, args, stdio0: options.stdio[0], env: Object.keys(options.env).sort() }});
  return spawn(process.execPath, [{json.dumps(str(WIN_FAKE))}, mode], {{ stdio: options.stdio }});
}} }});
const out = {{}};
{body}
out.calls = calls;
console.log(JSON.stringify(out));
''')
        done = subprocess.run([NODE, '--input-type=module', '-e', script, str(path)], capture_output=True, text=True,
                              timeout=60, env={**os.environ, 'SystemRoot': 'C:\\Windows'})
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def test_lock_release_deadlock_openfail_and_loss(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'setup.lock'
            out = self.run_win('''
const l = lock.acquireSync(process.argv[1]);
out.held = l.held;
l.release();
out.after = [l.held, l.lost];
mode = 'deadlock';
try { lock.acquireSync(process.argv[1]); } catch (e) { out.deadlock = e.name + ': ' + e.message; }
try { await lock.acquire(process.argv[1]); } catch (e) { out.deadlockAsync = e.name + ': ' + e.message; }
mode = 'openfail';
try { lock.acquireSync(process.argv[1]); } catch (e) { out.openfail = e.name; }
mode = 'die-after-lock';
const lost = await lock.acquire(process.argv[1]);
await new Promise((r) => setTimeout(r, 900));
out.lost = [lost.lost, lost.held];
lost.release();
const { readdirSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
out.leftovers = readdirSync(tmpdir()).filter((n) => n.startsWith(`.lcu-lock-${process.pid}-`));
''', path)
            self.assertEqual(oct(path.stat().st_mode & 0o777), oct(0o600), 'Node opens the file like Python')
        self.assertTrue(out['held'])
        self.assertEqual(out['after'], [False, False])
        self.assertEqual(out['deadlock'], 'OSError: [Errno 36] Resource deadlock avoided')
        self.assertEqual(out['deadlockAsync'], 'OSError: [Errno 36] Resource deadlock avoided')
        self.assertEqual(out['openfail'], 'LockError')
        self.assertEqual(out['lost'], [True, False])
        self.assertEqual(out['leftovers'], [])
        call = out['calls'][0]
        self.assertEqual(call['command'], 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
        self.assertEqual(call['stdio0'], 'pipe')
        self.assertEqual(call['args'][:6], ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                                            '-EncodedCommand'])
        self.assertTrue(set(call['env']) <= {'SystemRoot', 'SYSTEMROOT', 'windir', 'SystemDrive', 'TEMP', 'TMP'})
        script = base64.b64decode(call['args'][6]).decode('utf-16-le')
        for needle in ('$fs.Lock(0, 1)', 'for ($i = 0; $i -lt 10; $i++)', '[Threading.Thread]::Sleep(1000)',
                       '[IO.FileMode]::Open', '[IO.FileAccess]::ReadWrite',
                       '[IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete', 'catch [System.IO.IOException]',
                       '[Console]::In.ReadToEnd()', '$fs.Unlock(0, 1)', 'DEADLOCK', 'RELEASED'):
            self.assertIn(needle, script)
        encoded = script.split("FromBase64String('")[1].split("'")[0]
        self.assertEqual(base64.b64decode(encoded).decode(), str(path))

    def test_holder_gone_before_acceptance_is_not_a_lock(self):
        # .port/requests/compat.md "From P5" item 5 (review R4): a holder that reported LOCKED but had
        # already exited (or released) when acquisition looked must not yield a Lock that is lost at once.
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'setup.lock'
            script = node_script(f'''
import {{ spawnSync }} from 'node:child_process';
const out = [];
for (const mode of ['die-after-lock', 'lock']) {{
  lock._testing.set({{ platform: 'win32', spawn: (command, args, options) => {{
    // run the stand-in to completion first: by the time acquisition polls, it has exited
    const done = spawnSync(process.execPath, [{json.dumps(str(WIN_FAKE))}, mode], {{ stdio: ['ignore', options.stdio[1], 'ignore'] }});
    return {{ pid: done.pid, exitCode: done.status ?? 1, signalCode: null, stdin: null, unref() {{}}, once() {{}}, kill() {{}} }};
  }} }});
  try {{ const l = lock.acquireSync(process.argv[1]); out.push('lock lost=' + l.lost); l.release(); }}
  catch (e) {{ out.push(e.name + ': ' + e.message.replace(process.argv[1], '<path>')); }}
  try {{ const l = await lock.acquire(process.argv[1]); out.push('lock lost=' + l.lost); l.release(); }}
  catch (e) {{ out.push(e.name + ': ' + e.message.replace(process.argv[1], '<path>')); }}
}}
console.log(JSON.stringify(out));
''')
            done = subprocess.run([NODE, '--input-type=module', '-e', script, str(path)], capture_output=True,
                                  text=True, timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr)
        gone = 'LockError: cannot lock <path>: the lock holder exited unexpectedly'
        # 'lock' mode waits for stdin EOF; with stdin ignored it reads EOF at once and reports RELEASED.
        self.assertEqual(json.loads(done.stdout), [gone] * 4)

    def test_powershell_path_is_never_from_path(self):
        out = subprocess.run([NODE, '--input-type=module', '-e', node_script(r'''
const envs = [{ SystemRoot: 'D:\\Win\\' }, { SystemRoot: 'evil;calc' }, { SystemRoot: '\\\\host\\share' }, {}];
console.log(JSON.stringify(envs.map((env) => lock.windowsPowerShell(env))));
''')], capture_output=True, text=True, timeout=30)
        self.assertEqual(json.loads(out.stdout), [
            'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
            'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
            'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
            'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'], out.stderr)


if __name__ == '__main__':
    unittest.main()


