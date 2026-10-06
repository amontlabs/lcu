// Port of tests/test_doctor.py (DoctorTests). Permission onboarding must report only checks the
// original runtime proves. SetupReadinessTests target lcu/setup.py and are ported with setup.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import * as doctor from '../../lcu/doctor.mjs';
import { MAC_HELPER } from '../../lcu/platforms.mjs';
import { ValueError } from '../../lcu/compat/pyjson.mjs';

const { internals } = doctor;

function xmlPlist(values) {
  const body = Object.entries(values).map(([key, value]) => `\t<key>${key}</key>\n\t<string>${value}</string>\n`).join('');
  return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
    '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n' + body + '</dict>\n</plist>\n';
}

describe('DoctorTests', () => {
  let base; let root; let app; let runtime; let resolved; let env; let output;
  const saved = { ...internals };

  // sys.stdin replacement: lines answered by input(), EOF afterwards; isatty() as given
  const stdin = (text, tty) => {
    const lines = text.split('\n');
    internals.isatty = () => tty;
    internals.input = (prompt) => {
      internals.write(prompt);
      if (lines.length <= 1 && lines[0] === '') {
        throw new doctor.EOFError();
      }
      return lines.shift();
    };
  };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(path.join(tmpdir(), 'lcu-doctor-')));
    root = path.join(base, 'release');
    mkdirSync(root);
    app = path.join(base, 'ChatGPT.app');
    runtime = path.join(root, 'app/Contents/Resources/cua_node');
    mkdirSync(runtime, { recursive: true });
    writeFileSync(path.join(root, 'installation.json'), JSON.stringify({ platform: 'darwin' }));
    mkdirSync(path.join(app, 'Contents'), { recursive: true });
    writeFileSync(path.join(app, 'Contents/Info.plist'), xmlPlist({ CFBundleDisplayName: 'Selected ChatGPT' }));
    const helper = path.join(app, 'Contents', MAC_HELPER);
    mkdirSync(path.join(helper, 'Contents'), { recursive: true });
    writeFileSync(path.join(helper, 'Contents/Info.plist'), xmlPlist({ CFBundleDisplayName: 'Selected Computer Use' }));
    resolved = [app, path.join(app, 'Contents/Resources'), runtime, { version: 'fixture-app', runtime: 'fixture-cua' }];
    env = { NODE_REPL_NODE_PATH: '/fixture/node', DISPLAY: ':99', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/fixture' };
    output = '';
    internals.write = (text) => { output += text; };
    stdin('', false);
    // These tests are about permissions guidance, not the account's home folder length (upstream #15).
    internals.mac_socket_path_problem = () => null;
  });
  afterEach(() => {
    Object.assign(internals, saved);
    rmSync(base, { recursive: true, force: true });
  });

  const linux = () => writeFileSync(path.join(root, 'installation.json'), JSON.stringify({ platform: 'linux' }));
  const macProbe = () => ({ target: 'mac', provider: { ok: true, methods: ['list_apps', 'get_app_state'] },
    permissions: { ok: false, unverified: true } });
  const recordOpen = () => {
    const calls = [];
    internals.open_settings = (...args) => calls.push(args);
    return calls;
  };

  it('mac names come from selected app and helper plists', async () => {
    const names = doctor.mac_permission_targets(app);
    assert.equal(names.accessibility[0], 'Selected Computer Use');
    assert.equal(names.screen_capture[0], 'Selected ChatGPT');
    assert.equal(names.accessibility[1], path.join(app, 'Contents', MAC_HELPER));
  });

  it('mac names fall back to bundle names for unreadable or nameless plists', async () => {
    writeFileSync(path.join(app, 'Contents/Info.plist'), 'not a plist');
    rmSync(path.join(app, 'Contents', MAC_HELPER, 'Contents/Info.plist'));
    const names = doctor.mac_permission_targets(app);
    assert.equal(names.screen_capture[0], 'ChatGPT.app');
    assert.equal(names.accessibility[0], 'Codex Computer Use.app');
    writeFileSync(path.join(app, 'Contents/Info.plist'), xmlPlist({ CFBundleDisplayName: '  ', CFBundleName: ' Named ' }));
    assert.equal(doctor.mac_permission_targets(app).screen_capture[0], 'Named');
  });

  it('mac interactive finish keeps privacy readiness unverified', async () => {
    internals.probe = () => macProbe();
    stdin('\n', true);
    const opened = recordOpen();
    const status = await doctor.main(root, [], { resolved, env });
    assert.equal(status, 0);
    assert.ok(output.includes('macOS privacy permissions: not verified by LCU.'));
    assert.ok(output.includes('Selected Computer Use'));
    assert.ok(output.includes('Selected ChatGPT'));
    assert.ok(output.includes('blank TextEdit document'));
    assert.deepEqual(opened, []);
  });

  it('mac settings open only after explicit choice', async () => {
    internals.probe = () => macProbe();
    stdin('a\n\n', true);
    const opened = recordOpen();
    const status = await doctor.main(root, [], { resolved, env });
    assert.equal(status, 0);
    assert.deepEqual(opened, [[doctor.MAC_ACCESSIBILITY_SETTINGS, 'System Settings > Privacy & Security > Accessibility']]);
  });

  it('strict mac check stays nonzero after interactive cancel', async () => {
    internals.probe = () => macProbe();
    stdin('\n', true);
    const opened = recordOpen();
    assert.equal(await doctor.main(root, ['--require-ready'], { resolved, env }), 2);
    assert.deepEqual(opened, []);
  });

  it('mac plain check fails when provider did not load', async () => {
    internals.probe = () => ({ target: 'mac', provider: { ok: false, error: { message: 'sky service unavailable' } },
      permissions: { ok: false, unverified: true } });
    const status = await doctor.main(root, ['--non-interactive'], { resolved, env });
    assert.equal(status, 2);
    assert.ok(output.includes('Original Mac provider check failed.'));
  });

  it('noninteractive mac prints actionable guidance without opening settings', async () => {
    internals.probe = () => macProbe();
    const opened = recordOpen();
    const status = await doctor.main(root, ['--non-interactive'], { resolved, env });
    assert.equal(status, 0);
    assert.ok(output.includes('System Settings > Privacy & Security'));
    assert.ok(output.includes('reconnect your agent'));
    assert.deepEqual(opened, []);
  });

  it('linux screenshot failure never reports ready', async () => {
    linux();
    internals.probe = () => ({ target: 'linux', windows: { ok: true, count: 2 },
      screenshot: { ok: false, error: { message: 'capture unavailable' } } });
    internals.linux_sandbox_works = () => [true, ''];
    const status = await doctor.main(root, ['--non-interactive', '--require-ready'], { resolved, env });
    assert.equal(status, 2);
    assert.ok(output.includes('Window listing: passed (2 windows).'));
    assert.ok(output.includes('Screenshot capture: could not verify.'));
    assert.ok(!output.includes('Computer use is ready'));
  });

  const sandboxStatus = (statusEnv, works) => {
    doctor.print_linux_sandbox_status(statusEnv, { works });
    return output;
  };

  it('linux sandbox status says when the kernel is confined', async () => {
    const text = sandboxStatus({ LCU_SANDBOX_SHIM: '{}' }, () => [true, '']);
    assert.ok(text.includes('JavaScript sandbox: active'));
    assert.ok(text.includes('no network'));
  });

  it('linux sandbox status says when there is no sandbox here', async () => {
    const text = sandboxStatus({ LCU_SANDBOX_SHIM: '{}' }, () => [false, 'exit 1: bwrap denied']);
    assert.ok(text.includes('NOT AVAILABLE'));
    assert.ok(text.includes('bwrap denied'));
    assert.ok(text.includes('not sandboxed'));
  });

  it('linux sandbox status reports a missing shim and the modes', async () => {
    assert.ok(sandboxStatus({}, () => [true, '']).includes('launcher shim is missing'));
    output = '';
    const off = sandboxStatus({ LCU_NODE_REPL_SANDBOX: 'off' }, () => assert.fail('probe not needed'));
    assert.ok(off.includes('OFF'));
    output = '';
    const host = sandboxStatus({ LCU_NODE_REPL_SANDBOX: ' Host ' }, () => assert.fail('probe not needed'));
    assert.ok(host.includes('LCU_NODE_REPL_SANDBOX=host'));
  });

  it('linux sandbox probe uses the real codex and the original probe shape', async () => {
    const probeEnv = { CODEX_CLI_PATH: '/shim', LCU_SANDBOX_SHIM: JSON.stringify({ codex: '/real/codex', runtime: '/r', wrapper: null }) };
    for (const [returncode, expected] of [[12, true], [1, false]]) {
      const calls = [];
      internals.run = (command, options) => {
        calls.push([command, options]);
        return { returncode, stdout: '', stderr: '' };
      };
      assert.equal(doctor.linux_sandbox_works(probeEnv)[0], expected);
      const [command, options] = calls[0];
      assert.ok(path.basename(options.cwd).startsWith('lcu-sandbox-probe-'));
      assert.match(path.basename(options.cwd), /^lcu-sandbox-probe-[a-z0-9_]{8}$/);
      assert.deepEqual(command.slice(0, 2), ['/real/codex', 'sandbox']);
      assert.equal(command[command.indexOf('--') + 1], '/bin/sh');
      assert.equal(options.timeout, 30000);
      assert.equal(options.env.CODEX_CLI_PATH, '/real/codex');
      assert.deepEqual(readdirSync(path.dirname(options.cwd)).filter((name) => name === path.basename(options.cwd)), []);
    }
  });

  it('linux sandbox probe reports the exit status and condensed stderr', async () => {
    internals.run = () => ({ returncode: 1, stdout: '', stderr: '  bwrap:\n  denied  \n' });
    assert.deepEqual(doctor.linux_sandbox_works({ CODEX_CLI_PATH: '/c' }), [false, 'exit 1: bwrap: denied']);
    assert.deepEqual(doctor.linux_sandbox_works({}), [false, 'no Codex executable']);
  });

  it('linux doctor prints the sandbox status once', async () => {
    linux();
    internals.linux_sandbox_works = () => [false, ''];
    internals.probe = () => ({ target: 'linux', windows: { ok: true, count: 1 }, screenshot: { ok: true } });
    await doctor.main(root, ['--non-interactive'], { resolved, env });
    assert.equal(output.split('JavaScript sandbox:').length - 1, 1);
  });

  it('linux without a desktop session stops before the probe', async () => {
    linux();
    internals.linux_sandbox_works = () => [true, ''];
    internals.probe = () => assert.fail('probe not expected');
    assert.equal(await doctor.main(root, ['--non-interactive'], { resolved, env: { ...env, DISPLAY: '' } }), 2);
    assert.ok(output.includes('Window listing: could not verify. A live X11 DISPLAY and DBUS_SESSION_BUS_ADDRESS are required.'));
  });

  it('linux interactive retry can complete readiness', async () => {
    linux();
    const failed = { target: 'linux', windows: { ok: true, count: 1 },
      screenshot: { ok: false, error: { message: 'temporary display error' } } };
    const ready = { target: 'linux', windows: { ok: true, count: 1 }, screenshot: { ok: true, count: 1 } };
    const answers = [failed, ready];
    let count = 0;
    internals.probe = () => { count += 1; return answers.shift(); };
    internals.linux_sandbox_works = () => [true, ''];
    stdin('r\n', true);
    const status = await doctor.main(root, ['--require-ready'], { resolved, env });
    assert.equal(status, 0);
    assert.equal(count, 2);
    assert.ok(output.includes('Computer use is ready for the first agent call.'));
    assert.ok(output.includes('returned image data was discarded by LCU'));
  });

  it('strict linux cancel remains nonzero', async () => {
    linux();
    internals.probe = () => ({ target: 'linux', windows: { ok: true, count: 1 },
      screenshot: { ok: false, error: { message: 'capture unavailable' } } });
    internals.linux_sandbox_works = () => [true, ''];
    stdin('\n', true);
    assert.equal(await doctor.main(root, ['--require-ready'], { resolved, env }), 2);
  });

  it('doctor probe rejects failed process and wrong target', async () => {
    internals.run = () => ({ returncode: 1, stdout: '', stderr: 'failed' });
    assert.throws(() => doctor._probe(runtime, env, 'darwin'), (error) => error instanceof ValueError && /failed/.test(error.message));
    internals.run = () => ({ returncode: 0, stdout: '{"target":"windows"}\n', stderr: '' });
    assert.throws(() => doctor._probe(runtime, env, 'darwin'), (error) => error instanceof ValueError && /target mismatch/.test(error.message));
  });

  it('doctor probe runs the original runtime with the Python argv, cwd and timeout', async () => {
    const calls = [];
    internals.run = (command, options) => {
      calls.push([command, options]);
      return { returncode: 0, stdout: 'noise\n{"target":"mac","provider":{"ok":true}}\n\n', stderr: '' };
    };
    const report = doctor._probe(runtime, env, 'darwin');
    assert.equal(report.provider.ok, true);
    assert.deepEqual(calls[0][0], ['/fixture/node', '--input-type=module', '-e', doctor.PROBE]);
    assert.equal(calls[0][1].cwd, path.join(runtime, 'lib'));
    assert.equal(calls[0][1].timeout, 25000);
    assert.equal(calls[0][1].stdin, 'devnull');
    calls.length = 0;
    assert.throws(() => doctor._probe(runtime, env, 'windows', { timeout: 3 }), /target mismatch: expected windows, received mac\./);
    assert.equal(calls[0][1].cwd, path.join(runtime, 'bin'));
    assert.equal(calls[0][1].timeout, 3000);
  });

  it('EOF at a prompt finishes like Enter', async () => {
    internals.probe = () => macProbe();
    stdin('', true);
    assert.equal(await doctor.main(root, [], { resolved, env }), 0);
    assert.ok(output.includes('Choice [a/s/r/Enter]: Next: reconnect your agent'));
  });

  it('failure text explains the original permission codes', async () => {
    assert.match(doctor._failure_text({ error: { code: -10009 } }), /required permission is not granted/);
    assert.match(doctor._failure_text({ error: { name: 'permissionsPending' } }), /waiting for a permission decision/);
    assert.equal(doctor._failure_text({ error: { message: 'boom' } }), 'Original runtime: boom');
    assert.equal(doctor._failure_text({}), 'The original runtime did not complete this check.');
  });
});
