// Archive closure: the files scripts/build_bundle.py ships for each platform (runtime_files) contain every module the
// platform's entry points can load. A module imported by a shipped file but absent from the archive would only fail
// on the user's machine, so each platform's missing set must be exactly the other-platform modules that are loaded
// lazily behind a platform check.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { closure } from './closure.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// The archives list POSIX-style relative names whatever the host (Windows paths use backslashes).
const relative = (file) => path.relative(ROOT, file).split(path.sep).join('/');

const LIST_FILES = 'import json, sys; sys.path.insert(0, "scripts"); import build_bundle; ' +
  'print(json.dumps(build_bundle.runtime_files(sys.argv[1])))';

function shipped(target) {
  const result = spawnSync('python3', ['-B', '-c', LIST_FILES, target], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

// Entry points per platform: the launchers' entry module, the installers, and the scripts LCU spawns.
const PLATFORMS = {
  linux: {
    entries: ['lcu/entry.mjs', 'scripts/install.mjs', 'scripts/install_macos.mjs', 'lcu/linux_sky_service.mjs'],
    lazy: ['lcu/macos_host.mjs', 'lcu/windows.mjs', 'lcu/windows_host.mjs'],
  },
  darwin: {
    entries: ['lcu/entry.mjs', 'scripts/install.mjs', 'scripts/install_macos.mjs', 'lcu/macos_sky_service.mjs'],
    lazy: ['lcu/windows.mjs', 'lcu/windows_host.mjs'],
  },
  windows: {
    entries: ['lcu/entry.mjs', 'scripts/install_windows.mjs', 'scripts/windows_launcher.mjs',
      'lcu/windows_host_entry.cjs', 'lcu/windows_host_analyze.cjs', 'lcu/windows_lifetime_host.cjs',
      'lcu/windows_sky_service.mjs'],
    lazy: ['lcu/session.mjs'],
  },
};

for (const [target, { entries, lazy }] of Object.entries(PLATFORMS)) {
  test(`the ${target} archive ships every module its entry points load`, () => {
    const files = new Set(shipped(target));
    const result = closure(entries, ROOT);
    const needed = result.files.map((file) => relative(file));
    const absent = needed.filter((file) => !files.has(file));
    // Modules only reached through a lazy, platform-checked load of another platform's code may be absent.
    assert.deepEqual(absent.filter((file) => !lazy.includes(file)), [], `${target}: needed but not shipped`);
    // windows_host.mjs copies lcu/windows_lifetime_host.cjs next to the host entry as windows-lifetime-host.cjs.
    assert.deepEqual(result.missing.map((file) => relative(file))
      .filter((file) => file !== 'lcu/windows-lifetime-host.cjs'), [],
    `${target}: imported files that do not exist in the repository`);
    for (const file of entries) assert.ok(files.has(file) || lazy.includes(file) || file.startsWith('scripts/install'),
      `${target}: entry ${file} is not shipped`);
  });

  test(`the ${target} archive ships no module that no entry point can load`, () => {
    const files = shipped(target).filter((file) => /\.(mjs|cjs)$/.test(file));
    const result = closure(entries, ROOT);
    const reachable = new Set(result.files.map((file) => relative(file)));
    const unreachable = files.filter((file) => !reachable.has(file));
    assert.deepEqual(unreachable, [], `${target}: shipped but unreachable`);
  });
}

test('POSIX archives ship the launchers and the Windows archive only its dispatcher', () => {
  assert.deepEqual(shipped('linux').filter((file) => file.startsWith('bin/')),
    ['bin/lcu', 'bin/lcu-codex-sandbox', 'bin/lcu-session']);
  assert.deepEqual(shipped('darwin').filter((file) => file.startsWith('bin/')), ['bin/lcu', 'bin/lcu-session']);
  assert.deepEqual(shipped('windows').filter((file) => file.startsWith('bin/')), ['bin/lcu.cmd']);
});
