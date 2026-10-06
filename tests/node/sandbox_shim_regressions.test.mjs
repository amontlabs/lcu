// Regressions for .port/reviews/port-platforms.md findings 5, 8 and 10 on lcu/sandbox_shim.mjs, reproducing
// .port/reviews/probes-platforms/shim/. No process is signalled; the stderr child replaces only itself with
// /usr/bin/true.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { decide, main } from '../../lcu/sandbox_shim.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PREFIX = ['sandbox', '-c', 'shell_environment_policy.inherit="all"', '-c', 'default_permissions="node_repl"'];

let base; let runtime; let folder; let env; let node; let parent;
beforeEach(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'lcu-shim-reg-')));
  runtime = path.join(base, 'runtime');
  for (const name of ['bin/node', 'bin/node_repl']) {
    mkdirSync(path.dirname(path.join(runtime, name)), { recursive: true });
    writeFileSync(path.join(runtime, name), '');
  }
  mkdirSync(path.join(runtime, 'lib/node_modules/@oai/sky'), { recursive: true });
  writeFileSync(path.join(runtime, 'lib/node_modules/@oai/sky/package.json'), '{}');
  const tmp = path.join(base, 'tmp');
  folder = path.join(tmp, '.tmpAbC123');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(folder, 0o700);
  for (const name of ['kernel.js', 'trusted-worker.js']) writeFileSync(path.join(folder, name), '', { mode: 0o644 });
  node = path.join(runtime, 'bin/node');
  parent = path.join(runtime, 'bin/node_repl');
  env = {
    LCU_SANDBOX_SHIM: JSON.stringify({ codex: '/real/codex', runtime, wrapper: null }),
    TMPDIR: tmp,
    NODE_REPL_TRUSTED_SERVICES: JSON.stringify({ sky: '@oai/sky/service' }),
  };
});
afterEach(() => {
  try {
    chmodSync(path.join(base, 'locked'), 0o755);
  } catch { /* ignore */ }
  rmSync(base, { recursive: true, force: true });
});

const kernel = () => [node, '--experimental-vm-modules', path.join(folder, 'kernel.js'), '--session-id', 'abc', '--working-dir', '/work'];
const worker = () => [node, '--experimental-vm-modules', path.join(folder, 'trusted-worker.js'), path.join(base, 'socket')];
const runMain = (argv) => {
  const calls = [];
  let stderr = '';
  const code = main(argv, env, { execv: (file, args) => calls.push([file, args]), parent_exe: () => parent, stderr: (t) => { stderr += t; } });
  return { code, calls, stderr };
};

describe('finding 5: every profile tomllib accepts is accepted (compat/toml.mjs)', () => {
  const profiles = {
    'trailing newline': 'permissions.node_repl={filesystem = {":root" = "read"}, network = {enabled = false}}\n',
    'trailing comment': 'permissions.node_repl={filesystem = {":root" = "read"}, network = {enabled = false}} # comment',
    'dotted key': 'permissions.node_repl={filesystem.root = "read", network = {enabled = false}}',
    'hex number': 'permissions.node_repl={filesystem = {":root" = "read"}, network = {enabled = false, port = 0x1F}}',
  };
  for (const [label, profile] of Object.entries(profiles)) {
    it(`${label}: the kernel goes to the real codex and the worker runs directly`, () => {
      let result = runMain([...PREFIX, '-c', profile, '--', ...kernel()]);
      assert.deepEqual([result.code, result.calls], [0, [['/real/codex', ['/real/codex', ...PREFIX, '-c', profile, '--', ...kernel()]]]]);
      result = runMain([...PREFIX, '-c', profile, '--', ...worker()]);
      assert.deepEqual([result.code, result.calls], [0, [[node, worker()]]]);
    });
  }

  it('invalid TOML is still refused with exit 70', () => {
    const result = runMain([...PREFIX, '-c', 'permissions.node_repl={filesystem = {}, network = {},}', '--', ...kernel()]);
    assert.equal(result.code, 70);
    assert.match(result.stderr, /\(unreadable permission profile\)/);
  });
});

describe('finding 10: an unreadable kernel.js beside the worker is "not readable", like pathlib', { skip: process.getuid() === 0 && 'root ignores directory permissions' }, () => {
  it('EACCES on the sibling check gives its own reason, and the worker stays sandboxed', () => {
    const locked = path.join(base, 'locked');
    mkdirSync(locked);
    writeFileSync(path.join(locked, 'kernel.js'), '');
    rmSync(path.join(folder, 'kernel.js'));
    symlinkSync(path.join(locked, 'kernel.js'), path.join(folder, 'kernel.js'));
    chmodSync(locked, 0o000);
    const argv = [...PREFIX, '-c', 'permissions.node_repl={filesystem = {}, network = {}}', '--', ...worker()];
    const [action, given, note] = decide(argv, env, parent);
    assert.deepEqual([action, given], ['real', argv]);
    assert.equal(note, 'the trusted worker stays sandboxed: its script is not readable');
  });
});

describe('finding 8: the stay-sandboxed warning survives a full stderr pipe and the exec', () => {
  it('writes every byte before replacing the process', async () => {
    const script = `
      import { writeSync } from 'node:fs';
      const { main } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'lcu/sandbox_shim.mjs')).href)});
      process.stderr; // make fd 2 non-blocking, as Node does for a pipe
      let filled = 0;
      for (;;) {
        try { filled += writeSync(2, Buffer.alloc(1024, 120)); } catch (error) { if (error.code === 'EAGAIN') break; throw error; }
        if (filled > 1 << 22) break;
      }
      writeSync(1, String(filled));
      const argv = ['sandbox', '-c', 'shell_environment_policy.inherit="all"', '-c', 'default_permissions="node_repl"', '-c',
        'permissions.node_repl={filesystem = {}, network = {}}', '--', '/fixture/runtime/bin/node', '--experimental-vm-modules',
        '/fixture/trusted-worker.js', '/fixture/socket'];
      const env = { LCU_SANDBOX_SHIM: '{"runtime":"/fixture/runtime","codex":"/fixture/codex"}' };
      main(argv, env, { parent_exe: () => null, execv: () => process.execve('/usr/bin/true', ['/usr/bin/true'], {}) });
    `;
    // stderr is a pipe whose only reader (a shell started first) waits before draining it into a file, so the
    // child sees a full pipe; both processes end on their own.
    const sink = path.join(base, 'stderr.bin');
    const reader = spawn('/bin/sh', ['-c', `sleep 0.5; cat > '${sink}'`], { stdio: ['pipe', 'ignore', 'ignore'] });
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script],
      { stdio: ['ignore', 'pipe', reader.stdin] });
    reader.stdin.destroy();
    const out = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    const readerDone = new Promise((resolve) => reader.on('close', resolve));
    const code = await new Promise((resolve) => child.on('close', resolve));
    await readerDone;
    const filled = Number(Buffer.concat(out).toString());
    const tail = readFileSync(sink).subarray(filled).toString();
    assert.equal(code, 0);
    assert.equal(tail, "LCU: the trusted worker stays sandboxed: it was not started by the selected runtime's node_repl.\n");
  });
});
