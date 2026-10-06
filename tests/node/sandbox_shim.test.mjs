// Port of tests/test_sandbox_shim.py: the shim sandboxes the model's kernel and unsandboxes only the
// genuine Sky worker.
import assert from 'node:assert/strict';
import {
  chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';

import * as sandbox_shim from '../../lcu/sandbox_shim.mjs';

const { Unrecognized, decide, main, internals } = sandbox_shim;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const PROFILE = 'permissions.node_repl={filesystem = {":root" = "read", ":tmpdir" = "read"}, network = {enabled = false}}';
const PREFIX = ['sandbox', '-c', 'shell_environment_policy.inherit="all"', '-c', 'default_permissions="node_repl"'];

const skip = process.platform === 'win32' ? 'The sandbox shim is Linux-only' : false;

describe('ShimTests', { skip }, () => {
  let base; let runtime; let tmp; let folder; let wrapper; let node; let parent; let env;
  const saved = { ...internals };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(path.join(tmpdir(), 'lcu-shim-')));
    runtime = path.join(base, 'runtime');
    for (const name of ['bin/node', 'bin/node_repl']) {
      mkdirSync(path.dirname(path.join(runtime, name)), { recursive: true });
      writeFileSync(path.join(runtime, name), '');
    }
    for (const pkg of ['sky', 'browser-desktop']) {
      mkdirSync(path.join(runtime, `lib/node_modules/@oai/${pkg}`), { recursive: true });
      writeFileSync(path.join(runtime, `lib/node_modules/@oai/${pkg}/package.json`), '{}');
    }
    tmp = path.join(base, 'tmp');
    mkdirSync(tmp);
    folder = path.join(tmp, '.tmpAbC123');
    mkdirSync(folder, { mode: 0o700 });
    chmodSync(folder, 0o700);
    for (const name of ['kernel.js', 'trusted-worker.js']) writeFileSync(path.join(folder, name), '', { mode: 0o644 });
    wrapper = path.join(base, 'lcu/linux_sky_service.mjs');
    mkdirSync(path.dirname(wrapper));
    writeFileSync(wrapper, '');
    node = path.join(runtime, 'bin/node');
    parent = path.join(runtime, 'bin/node_repl');
    env = {
      LCU_SANDBOX_SHIM: JSON.stringify({ codex: '/real/codex', runtime, wrapper }),
      TMPDIR: tmp,
      NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ sky: '@oai/sky/service' }),
    };
  });
  afterEach(() => {
    Object.assign(internals, saved);
    chmodSync(folder, 0o700);
    rmSync(base, { recursive: true, force: true });
  });

  const argv = (command) => [...PREFIX, '-c', PROFILE, '--', ...command];
  const kernel = () => [node, '--experimental-vm-modules', path.join(folder, 'kernel.js'), '--session-id', 'abc', '--working-dir', '/work'];
  const worker = () => [node, '--experimental-vm-modules', path.join(folder, 'trusted-worker.js'), path.join(base, 'socket')];
  const runDecide = ({ command = null, argv: given = null, env: e = null, parent: p = null } = {}) =>
    decide(given ?? argv(command), e ?? env, p ?? parent);
  const throwsUnrecognized = (fn) => assert.throws(fn, (error) => error instanceof Unrecognized);

  it('the kernel goes to the real sandbox unchanged', () => {
    assert.deepEqual(runDecide({ command: kernel() }), ['real', argv(kernel()), '']);
  });

  it('the genuine sky worker runs directly', () => {
    assert.deepEqual(runDecide({ command: worker() }), ['direct', worker(), '']);
  });

  it("the worker may host the browser service and LCU's wrapper", () => {
    for (const services of [{ sky: '@oai/sky/service', browser: '@oai/browser-desktop/service' },
      { sky: wrapper }, { sky: wrapper, browser: '@oai/browser-desktop/service' }]) {
      const changed = { ...env, NODE_REPL_TRUSTED_SERVICES: JSON.stringify(services) };
      assert.equal(runDecide({ command: worker(), env: changed })[0], 'direct', JSON.stringify(services));
    }
  });

  const assertWorkerStaysSandboxed = (notePart, changes = {}) => {
    const [action, args, note] = runDecide({ command: worker(), ...changes });
    assert.deepEqual([action, args], ['real', argv(worker())]);
    assert.ok(note.includes(notePart), note);
  };

  it('a worker not started by the selected node_repl stays sandboxed', () => {
    for (const p of ['/usr/bin/node', null, path.join(runtime, 'bin/node')]) {
      const [action, , note] = decide(argv(worker()), env, p);
      assert.equal(action, 'real');
      assert.ok(note.includes('node_repl'));
    }
  });

  it('a worker run by another node stays sandboxed', () => {
    const other = path.join(base, 'other-node');
    writeFileSync(other, '');
    throwsUnrecognized(() => runDecide({ command: [other, ...worker().slice(1)] }));
    const link = path.join(runtime, 'bin/link');
    symlinkSync(other, link);
    throwsUnrecognized(() => runDecide({ command: [link, ...worker().slice(1)] }));
  });

  it('a lookalike script folder stays sandboxed', () => {
    // Right file names, but not node_repl's own temporary folder.
    const elsewhere = path.join(base, 'other');
    mkdirSync(elsewhere, { mode: 0o700 });
    for (const name of ['kernel.js', 'trusted-worker.js']) writeFileSync(path.join(elsewhere, name), '');
    const command = worker();
    command[2] = path.join(elsewhere, 'trusted-worker.js');
    assert.ok(runDecide({ command })[2].includes('temporary folder'));
    // Named like node_repl's folder but missing the kernel beside it.
    unlinkSync(path.join(folder, 'kernel.js'));
    assertWorkerStaysSandboxed('temporary folder');
  });

  it('a lookalike in the wrong temporary directory stays sandboxed', () => {
    assertWorkerStaysSandboxed('temporary folder', { env: { ...env, TMPDIR: base } });
  });

  it('writable or symlinked scripts stay sandboxed', () => {
    chmodSync(folder, 0o777);
    assertWorkerStaysSandboxed('temporary folder');
    chmodSync(folder, 0o700);
    const script = path.join(folder, 'trusted-worker.js');
    chmodSync(script, 0o666);
    assertWorkerStaysSandboxed('temporary folder');
    unlinkSync(script);
    writeFileSync(path.join(base, 'real.js'), '');
    symlinkSync(path.join(base, 'real.js'), script);
    assertWorkerStaysSandboxed('temporary folder');
  });

  it("group write is allowed only for the account's group", () => {
    chmodSync(folder, 0o770);
    // Python relies on the folder's group being the account's effective group (true for a fresh temp dir).
    const gid = statSync(folder).gid;
    internals.getegid = () => gid;
    assert.equal(runDecide({ command: worker() })[0], 'direct');
    internals.getegid = () => gid + 1;
    assertWorkerStaysSandboxed('temporary folder');
  });

  it("a service map that is not the selected runtime's stays sandboxed", () => {
    for (const services of [{ sky: '@oai/sky/service', extra: '@oai/sky/service' },
      { sky: '/tmp/evil.mjs' }, { sky: wrapper + 'x' }, { browser: '@oai/browser-desktop/service' },
      { sky: '@oai/sky/service', browser: '/tmp/evil.mjs' }, { sky: 5 }, [], 'not-json']) {
      const raw = typeof services === 'string' ? services : JSON.stringify(services);
      const [action, , note] = runDecide({ command: worker(), env: { ...env, NODE_REPL_TRUSTED_SERVICES: raw } });
      assert.equal(action, 'real');
      assert.ok(note);
    }
  });

  it('the original sky package must exist in the selected runtime', () => {
    unlinkSync(path.join(runtime, 'lib/node_modules/@oai/sky/package.json'));
    assertWorkerStaysSandboxed('Sky service');
  });

  it('an unset service map stays sandboxed', () => {
    const changed = { ...env };
    delete changed.NODE_REPL_TRUSTED_SERVICES;
    assert.ok(runDecide({ command: worker(), env: changed })[2]);
  });

  it('unrecognised sandbox invocations are refused', () => {
    const cases = {
      'different prefix': ['sandbox', '-c', 'x=1', '-c', PROFILE, '--', ...kernel()],
      'no profile': [...PREFIX, '--', ...kernel()],
      'other command': argv(['/bin/echo', 'hi']),
      'node flag missing': argv([node, path.join(folder, 'kernel.js'), '--session-id', 'a', '--working-dir', '/w']),
      'kernel arguments': argv(kernel().slice(0, -1)),
      'worker arguments': argv(worker().slice(0, -1)),
      'relative script': argv([node, '--experimental-vm-modules', 'kernel.js', '--session-id', 'a', '--working-dir', '/w']),
      'unknown script': argv([node, '--experimental-vm-modules', path.join(folder, 'x.js'), 'a']),
      'bad profile': [...PREFIX, '-c', 'permissions.node_repl={', '--', ...kernel()],
      'profile with extra keys': [...PREFIX, '-c', 'permissions.node_repl={filesystem = {}, network = {}, x = 1}', '--', ...kernel()],
      'non-string path rule': [...PREFIX, '-c', 'permissions.node_repl={filesystem = {a = 1}, network = {}}', '--', ...kernel()],
      'additional flag': ['sandbox', '--full-auto', ...PREFIX.slice(1), '-c', PROFILE, '--', ...kernel()],
    };
    for (const [label, given] of Object.entries(cases)) {
      assert.throws(() => runDecide({ argv: given }), (error) => error instanceof Unrecognized, label);
    }
  });

  it('refusal reasons match the Python messages', () => {
    const reason = (given) => {
      try {
        runDecide({ argv: given });
      } catch (error) {
        return error.message;
      }
      return null;
    };
    assert.equal(reason([...PREFIX, '-c', 'permissions.node_repl={', '--', ...kernel()]), 'unreadable permission profile');
    assert.equal(reason([...PREFIX, '-c', 'permissions.node_repl="x"', '--', ...kernel()]), 'unexpected permission profile shape');
    assert.equal(reason([...PREFIX, '-c', 'permissions.node_repl={filesystem = {}, network = {}, x = 1}', '--', ...kernel()]),
      'unexpected permission profile shape');
    assert.equal(reason([...PREFIX, '--', ...kernel()]), 'unexpected sandbox arguments');
    assert.equal(reason(argv(['/bin/echo', 'hi'])), 'unexpected command');
    assert.equal(reason(argv(kernel().slice(0, -1))), 'unexpected script or arguments');
  });

  it('missing or malformed configuration refuses a sandbox invocation', () => {
    for (const raw of [null, 'not json', '[]', JSON.stringify({ codex: 1, runtime: 'r' }),
      JSON.stringify({ codex: 'c' }), JSON.stringify({ codex: 'c', runtime: 'r', wrapper: 3 })]) {
      const changed = { ...env };
      delete changed.LCU_SANDBOX_SHIM;
      if (raw !== null) changed.LCU_SANDBOX_SHIM = raw;
      assert.throws(() => decide(argv(kernel()), changed, parent), (error) => error instanceof Unrecognized, String(raw));
    }
  });

  it('the availability probe reaches the real codex', () => {
    const probe = argv(['/bin/sh', '-c', 'exit 12', 'node-repl-sandbox-probe', '/x']);
    assert.deepEqual(runDecide({ argv: probe }), ['real', probe, '']);
  });

  it('other codex subcommands pass through', () => {
    for (const given of [['--version'], ['mcp', 'list'], [], ['sandboxed']]) {
      assert.deepEqual(runDecide({ argv: given }), ['real', given, '']);
    }
  });

  it('fault hook only ever refuses', () => {
    for (const [fault, command, refused] of [
      ['unrecognized-kernel', kernel(), true], ['unrecognized-kernel', worker(), false],
      ['unrecognized-worker', worker(), true], ['unrecognized-worker', kernel(), false],
      ['unrecognized-format', kernel(), true], ['unrecognized-format', worker(), true],
      ['other', worker(), false]]) {
      const changed = { ...env, [sandbox_shim.FAULT_ENV]: fault };
      if (refused) throwsUnrecognized(() => runDecide({ command, env: changed }));
      else runDecide({ command, env: changed });
    }
  });

  const runMain = ({ command = null, argv: given = null, env: e = null, parent: p = null } = {}) => {
    const calls = [];
    let stderr = '';
    const code = main(given ?? argv(command), e ?? env, {
      execv: (file, args) => calls.push([file, args]),
      parent_exe: () => p ?? parent,
      stderr: (text) => { stderr += text; },
    });
    return [code, calls, stderr];
  };

  it('main executes the real codex for the kernel and the worker directly', () => {
    let [code, calls] = runMain({ command: kernel() });
    assert.deepEqual([code, calls], [0, [['/real/codex', ['/real/codex', ...argv(kernel())]]]]);
    [code, calls] = runMain({ command: worker() });
    assert.deepEqual([code, calls], [0, [[node, worker()]]]);
  });

  it('main refuses with a clear message and executes nothing', () => {
    const [code, calls, message] = runMain({ command: kernel(), env: { ...env, [sandbox_shim.FAULT_ENV]: 'unrecognized-format' } });
    assert.deepEqual([code, calls], [70, []]);
    assert.ok(message.includes('never left unsandboxed'));
    assert.ok(message.includes('LCU_NODE_REPL_SANDBOX=off'));
    assert.equal(message, 'LCU: the original node_repl started its sandbox in a way this LCU release does not ' +
      "recognise (unexpected sandbox arguments). Refusing to start it, so the model's JavaScript is never left " +
      'unsandboxed. Run `lcu update` for a release that knows this runtime; LCU_NODE_REPL_SANDBOX=off runs the ' +
      'JavaScript kernel without a sandbox.\n');
  });

  it('main explains a worker that stays sandboxed', () => {
    const [code, calls, message] = runMain({ command: worker(), parent: '/usr/bin/node' });
    assert.equal(code, 0);
    assert.deepEqual(calls, [['/real/codex', ['/real/codex', ...argv(worker())]]]);
    assert.ok(message.includes('stays sandboxed'));
    assert.equal(message, "LCU: the trusted worker stays sandboxed: it was not started by the selected runtime's node_repl.\n");
  });

  it('environment helper restores the real codex', () => {
    const changed = { ...env, CODEX_CLI_PATH: '/shim' };
    assert.equal(sandbox_shim.unshimmed_env(changed).CODEX_CLI_PATH, '/real/codex');
    assert.equal(sandbox_shim.unshimmed_env({ CODEX_CLI_PATH: '/x' }).CODEX_CLI_PATH, '/x');
    assert.equal(changed.CODEX_CLI_PATH, '/shim'); // a copy
  });

  it('configuration is the JSON Python writes', () => {
    assert.equal(sandbox_shim.configuration('/r', '/c', '/w'), '{"codex": "/c", "runtime": "/r", "wrapper": "/w"}');
    assert.equal(sandbox_shim.configuration('/r', '/c', null), '{"codex": "/c", "runtime": "/r", "wrapper": null}');
  });

  it('the launcher is executable', () => {
    assert.ok(statSync(path.join(ROOT, 'bin/lcu-codex-sandbox')).mode & 0o100);
  });
});
