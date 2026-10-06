// Port of tests/test_macos_socket_path.py (upstream #15): the signed Mac helper cannot bind a socket path longer
// than 103 bytes; LCU only detects it. SocketPathTests and DoctorSocketTests are here; SetupSocketTests target
// lcu/setup.mjs (item U5, see .port/requests/setup.md).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import * as doctor from '../../lcu/doctor.mjs';
import * as platforms from '../../lcu/platforms.mjs';

const SUFFIX = '/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/IPC/computeruse.sock';

/** A home folder whose default socket path is exactly `size` bytes. */
const home_of_length = (size) => '/Users/' + 'a'.repeat(size - SUFFIX.length - '/Users/'.length);

const savedPlatforms = { ...platforms.internals };
const savedDoctor = { ...doctor.internals };
afterEach(() => {
  Object.assign(platforms.internals, savedPlatforms);
  Object.assign(doctor.internals, savedDoctor);
});

// patch('pwd.getpwuid', return_value=SimpleNamespace(pw_dir=home))
const real_home = (home) => {
  platforms.internals.getpwuid = () => ({ pw_dir: home });
};

describe('SocketPathTests', () => {
  it('suffix matches the documented helper path', () => {
    assert.equal(Buffer.byteLength(SUFFIX), 83);
    assert.equal('/' + platforms.MAC_SOCKET_SUFFIX, SUFFIX);
  });

  it('103 bytes is accepted and 104 is not', () => {
    real_home(home_of_length(103));
    const [socket, overridden] = platforms.mac_socket_path({});
    assert.deepEqual([Buffer.byteLength(socket), overridden], [103, false]);
    assert.equal(platforms.mac_socket_path_problem({}), null);
    real_home(home_of_length(104));
    const message = platforms.mac_socket_path_problem({});
    assert.ok(message.includes('is 104 bytes (macOS limit 103)'));
    assert.ok(message.includes(home_of_length(104) + SUFFIX));
    assert.ok(message.includes('home folder'));
    assert.ok(message.includes('LCU cannot change the signed helper'));
    assert.equal(message, "Computer Use cannot start for this macOS account: the ChatGPT helper's socket path is " +
      `104 bytes (macOS limit 103): ${home_of_length(104)}${SUFFIX}. The path comes from your home folder, so the ` +
      'ChatGPT app is affected too. LCU cannot change the signed helper. Use an account whose home folder path is ' +
      'short enough (13 ASCII characters or fewer after /Users/).');
  });

  it('13 and 14 character user names', () => {
    for (const [name, fails] of [['a'.repeat(13), false], ['a'.repeat(14), true]]) {
      real_home(`/Users/${name}`);
      assert.equal(Boolean(platforms.mac_socket_path_problem({})), fails, name);
    }
  });

  it('bytes not characters are counted', () => {
    // 13 characters, but each is two bytes in UTF-8.
    real_home('/Users/' + 'é'.repeat(13));
    assert.ok(platforms.mac_socket_path_problem({}).includes('is 116 bytes'));
  });

  it('default path uses the real home, not HOME', () => {
    real_home('/Users/real');
    const saved = { HOME: process.env.HOME, override: process.env[platforms.MAC_SOCKET_ENV] };
    process.env.HOME = '/tmp/' + 'x'.repeat(200);
    delete process.env[platforms.MAC_SOCKET_ENV];
    try {
      assert.deepEqual(platforms.mac_socket_path(), ['/Users/real' + SUFFIX, false]);
      assert.equal(platforms.mac_socket_path_problem(), null);
    } finally {
      process.env.HOME = saved.HOME;
      if (saved.override !== undefined) process.env[platforms.MAC_SOCKET_ENV] = saved.override;
    }
  });

  it('the real home comes from the account database of the current uid', () => {
    const calls = [];
    platforms.internals.getuid = () => 4242;
    platforms.internals.getpwuid = (uid) => {
      calls.push(uid);
      return { pw_dir: '/Users/x/' };
    };
    assert.deepEqual(platforms.mac_socket_path({}), ['/Users/x/' + SUFFIX.slice(1), false]); // os.path.join, no normalising
    assert.deepEqual(calls, [4242]);
  });

  it('environment override replaces the default', () => {
    const override = { [platforms.MAC_SOCKET_ENV]: '/tmp/s.sock' };
    real_home(home_of_length(200));
    assert.deepEqual(platforms.mac_socket_path(override), ['/tmp/s.sock', true]);
    assert.equal(platforms.mac_socket_path_problem(override), null);
    const long = { [platforms.MAC_SOCKET_ENV]: '/tmp/' + 'b'.repeat(99) };
    real_home('/Users/a');
    const message = platforms.mac_socket_path_problem(long);
    assert.ok(message.includes('104 bytes'));
    assert.ok(message.includes(platforms.MAC_SOCKET_ENV));
    assert.ok(!message.includes('home folder, so'));
  });

  it('empty override is ignored', () => {
    real_home('/Users/real');
    assert.deepEqual(platforms.mac_socket_path({ [platforms.MAC_SOCKET_ENV]: '' }), ['/Users/real' + SUFFIX, false]);
  });

  // Node cannot show this: libuv silently truncates an over-long AF_UNIX path on macOS instead of failing, so the
  // kernel's answer is asked through bind(2) directly (python3's socket module, as the upstream test does).
  const PYTHON = ['/usr/bin/python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3'].find((file) => existsSync(file));
  it('the OS really refuses a 104 byte bind and allows 103', {
    skip: process.platform !== 'darwin' ? 'the limit is the macOS sun_path size' : !PYTHON && 'python3 is unavailable',
  }, () => {
    const base = mkdtempSync('/tmp/lcu-sock-');
    const bind = (size) => {
      const socket = `${base}/` + 'a'.repeat(size - base.length - 1);
      assert.equal(Buffer.byteLength(socket), size);
      return spawnSync(PYTHON, ['-c', 'import socket, sys\ns = socket.socket(socket.AF_UNIX)\ns.bind(sys.argv[1])', socket],
        { encoding: 'utf8' }).status;
    };
    try {
      assert.equal(bind(103), 0);
      assert.notEqual(bind(104), 0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('DoctorSocketTests', () => {
  let root; let resolved; let env; let probe; let output;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'lcu-socket-doctor-'));
    resolved = [path.join(root, 'ChatGPT.app'), path.join(root, 'resources'), path.join(root, 'cua_node'),
      { version: 'fixture-app', runtime: 'fixture-cua' }];
    env = { NODE_REPL_NODE_PATH: '/fixture/node' };
    probe = { target: 'mac', provider: { ok: true, methods: ['list_apps', 'get_app_state'] } };
    output = '';
    doctor.internals.write = (text) => { output += text; };
    doctor.internals.isatty = () => false;
    doctor.internals.mac_instructions = () => {};
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const run_doctor = async (home, platform_name = 'darwin') => {
    writeFileSync(path.join(root, 'installation.json'), JSON.stringify({ platform: platform_name }));
    real_home(home);
    doctor.internals.sys_platform = () => 'darwin';
    let probed = 0;
    doctor.internals.probe = () => {
      probed += 1;
      return probe;
    };
    const saved = process.env[platforms.MAC_SOCKET_ENV];
    delete process.env[platforms.MAC_SOCKET_ENV];
    try {
      const status = await doctor.main(root, ['--non-interactive'], { resolved, env });
      return [status, output, probed];
    } finally {
      if (saved !== undefined) process.env[platforms.MAC_SOCKET_ENV] = saved;
    }
  };

  it('too long home fails with a clear message', async () => {
    const home = home_of_length(104);
    const [status, text, probed] = await run_doctor(home);
    assert.equal(status, 2);
    assert.ok(text.includes("Computer Use cannot start for this macOS account: the ChatGPT helper's " +
      'socket path is 104 bytes (macOS limit 103)'));
    assert.ok(text.includes(home + SUFFIX));
    assert.ok(text.includes('13 ASCII characters or fewer after /Users/'));
    assert.ok(!text.includes('Original Mac provider loaded'));
    assert.equal(probed, 0);
  });

  it('short home still passes', async () => {
    const [status, text, probed] = await run_doctor(home_of_length(103));
    assert.equal(status, 0);
    assert.ok(!text.includes('socket path'));
    assert.equal(probed, 1);
  });

  it('a macOS install inspected on another host is not checked', async () => {
    let called = 0;
    doctor.internals.mac_socket_path_problem = () => {
      called += 1;
      return null;
    };
    doctor.internals.probe = () => probe;
    doctor.internals.sys_platform = () => 'linux';
    writeFileSync(path.join(root, 'installation.json'), JSON.stringify({ platform: 'darwin' }));
    const status = await doctor.main(root, ['--non-interactive'], { resolved, env });
    assert.equal(status, 0);
    assert.equal(called, 0);
  });

  it('other platforms never check the socket', async () => {
    probe = { target: 'windows', windows: { ok: true, count: 1 } };
    let called = 0;
    doctor.internals.mac_socket_path_problem = () => {
      called += 1;
      return null;
    };
    await run_doctor(home_of_length(300), 'windows');
    assert.equal(called, 0);
  });
});
