// Round-2 review R9: Ctrl-C at the doctor prompt must behave like CPython's input() (KeyboardInterrupt, caught by
// the prompt as "finish"), interrupting the read immediately, with the production input function intact.
//
// 1. PTY: the real `_mac_guidance` loop runs inside a pseudo-terminal (python3 pty.fork()); the test types Ctrl-C
//    (byte 0x03) into the terminal, so the terminal driver itself sends SIGINT to the foreground job, exactly as a
//    user's Ctrl-C does. No process is signalled by the test.
// 2. Pipe: the same loop with stdin an open, empty pipe; SIGINT is sent once to the child this test spawned (its own
//    session leader, identity re-checked before signalling), never to anything else.
// Python (frozen oracle, .port/reviews/round2-evidence/doctor-prompt-signal.py) finishes with exit 0.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { skipOnWindows } from './windows_skip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DOCTOR = pathToFileURL(path.join(ROOT, 'lcu/doctor.mjs')).href;
const SCRIPT = `
  const { internals, _mac_guidance } = await import(${JSON.stringify(DOCTOR)});
  internals.mac_instructions = () => {};
  await _mac_guidance('/fixture/App', () => {});
`;
const PROMPT = 'Choice [a/s/r/Enter]:';
const FINISH = 'Next: reconnect your agent';

function waitFor(predicate, ms) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (predicate() || Date.now() - started > ms) resolve(predicate());
      else setTimeout(tick, 20);
    };
    tick();
  });
}

function exited(child, ms) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => resolve(null), ms);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

// A pseudo-terminal through python3's pty.fork(): the child becomes a session leader whose controlling terminal is
// the pty, then execs Node. The driver types Ctrl-C and reports what happened; it never sends a signal itself.
const PTY_DRIVER = String.raw`
import json, os, pty, select, sys, time
argv = json.loads(sys.argv[1])
pid, master = pty.fork()
if pid == 0:
    os.execve(argv[0], argv, {'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent', 'TERM': 'dumb'})
out = b''
typed = False
status = None
deadline = time.monotonic() + 10
open_master = True
while time.monotonic() < deadline:
    done, waited = os.waitpid(pid, os.WNOHANG)
    if done:
        status = waited
        break
    if open_master and select.select([master], [], [], 0.05)[0]:
        try:
            chunk = os.read(master, 4096)
        except OSError:
            chunk = b''
        if chunk:
            out += chunk
        else:
            open_master = False
    elif not open_master:
        time.sleep(0.05)
    if not typed and b'Choice [a/s/r/Enter]:' in out:
        os.write(master, b'\x03')  # the terminal's interrupt character: the tty driver signals the foreground job
        typed = True
        deadline = time.monotonic() + 3
while open_master and select.select([master], [], [], 0.05)[0]:
    try:
        chunk = os.read(master, 4096)
    except OSError:
        break
    if not chunk:
        break
    out += chunk
if status is None:
    os.close(master)  # hang up: the kernel ends the job (SIGHUP); this driver sends no signal itself
    os.waitpid(pid, 0)
    print(json.dumps({'blocked': True, 'typed': typed, 'output': out.decode(errors='replace')}))
else:
    print(json.dumps({'blocked': False, 'typed': typed, 'exit': os.waitstatus_to_exitcode(status),
                      'output': out.decode(errors='replace')}))
`;
const PYTHON = ['/usr/bin/python3', '/usr/local/bin/python3'].find((file) => existsSync(file));

describe('doctor prompt and SIGINT (R9)', () => {
  it('Ctrl-C typed into a real terminal finishes the guidance and exits 0', { skip: !PYTHON && 'python3 (pty) is unavailable' }, () => {
    const node = [process.execPath, '--input-type=module', '-e', SCRIPT];
    const done = spawnSync(PYTHON, ['-c', PTY_DRIVER, JSON.stringify(node)], { encoding: 'utf8', timeout: 30000 });
    assert.equal(done.status, 0, done.stderr);
    const result = JSON.parse(done.stdout);
    assert.equal(result.blocked, false, `still blocked after Ctrl-C: ${JSON.stringify(result.output)}`);
    assert.equal(result.typed, true, JSON.stringify(result.output));
    assert.equal(result.exit, 0, JSON.stringify(result.output));
    assert.ok(result.output.includes(FINISH), JSON.stringify(result.output));
  });

  it('SIGINT to the waiting process (stdin an open empty pipe) finishes the guidance and exits 0', { skip: skipOnWindows(
    'SIGINT does not exist on Windows: child.kill(SIGINT) is TerminateProcess, there is no KeyboardInterrupt to handle') }, async () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', SCRIPT],
      { stdio: ['pipe', 'pipe', 'pipe'], detached: true, env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' } });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const pid = child.pid;
    try {
      assert.ok(await waitFor(() => output.includes(PROMPT), 10000), `no prompt: ${JSON.stringify(output)}`);
      // signal only this test's own, still-running child, which leads its own session
      assert.equal(child.exitCode, null);
      assert.equal(child.pid, pid);
      if (process.platform === 'linux') {
        const sid = spawnSync('/bin/ps', ['-o', 'sid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
        assert.equal(sid, String(pid));
      }
      child.kill('SIGINT');
      const result = await exited(child, 3000);
      assert.ok(result, `still blocked after SIGINT: ${JSON.stringify(output)}`);
      assert.deepEqual(result, { code: 0, signal: null });
      assert.ok(output.includes(FINISH), JSON.stringify(output));
    } finally {
      child.stdin.end(); // EOF also finishes the prompt, so a failing run still ends on its own
      await exited(child, 3000);
    }
  });

  it('EOF still finishes, and typed answers are read line by line', async () => {
    const done = spawnSync(process.execPath, ['--input-type=module', '-e', SCRIPT],
      { input: 'x\nq\n', encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' }, timeout: 10000 });
    assert.equal(done.status, 0, done.stderr);
    assert.ok(done.stdout.includes('Choose a, s, r, or press Enter to finish.'));
    assert.equal(done.stdout.split(PROMPT).length - 1, 2);
    assert.ok(done.stdout.includes(FINISH));
  });
});
