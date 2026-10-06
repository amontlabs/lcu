// Local harness packages; host configuration remains with native installers.
//
// Port of lcu/harness_setup.py. Paths are absolute path strings. `internals` holds the injection points the
// Python tests reach with unittest.mock.patch (subprocess.run, shutil.which, os.replace); production code
// never replaces them.
//
// `_package` is a Python context manager; here it takes the body as a callback: _package(destination,
// harness, files, (package) => {...}) returns the callback's value and restores the previous tree on failure.
import { createHash } from 'node:crypto';
import {
  mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { posix as path, win32 } from 'node:path';

import { pyStrip } from './compat/argparse.mjs';
import { pathStr, resolve } from './compat/pathlib.mjs';
import { dumps, equal, fromPlain, loads, ValueError } from './compat/pyjson.mjs';
import { run } from './compat/subprocess.mjs';
import { mkdtemp } from './compat/tempfile.mjs';
import { decode } from './compat/utf8.mjs';
import { which } from './compat/which.mjs';
import {
  winAsPosix, winIsAbsolute, winParent, winPathStr, winRelpath,
} from './compat/winpath.mjs';
import { regular_path } from './setup.mjs';

// `platform` selects pathlib's flavour (PosixPath / WindowsPath), as os.name does in Python.
export const internals = { run, which, replace: renameSync, platform: process.platform, is_file };

const windows = () => internals.platform === 'win32';
// Path(a) / b / ... ; Path.parent ; Path.is_absolute()
const join = (...parts) => (windows() ? winPathStr(...parts) : pathStr(...parts));
const parent = (p) => (windows() ? winParent(p) : path.dirname(p));
const isAbsolute = (p) => (windows() ? winIsAbsolute(p) : p.startsWith('/'));

// `runner` (default internals.run) may be synchronous or return a promise: lcu/setup.mjs passes its awaitable,
// SIGINT-aware runner so an interrupted installer raises KeyboardInterrupt inside _package, which then restores
// the previous tree exactly as Python's context manager does.
function _run(argv, { cwd, env, runner = internals.run }) {
  const check = (result) => {
    if (result.returncode) {
      const detail = pyStrip(result.stderr || result.stdout);
      throw new ValueError(`installer exited ${result.returncode}` + (detail ? `: ${detail}` : ''));
    }
  };
  const result = runner(argv, { cwd, env, stdin: 'devnull', capture: true, errors: 'replace', timeout: 120000 });
  return typeof result?.then === 'function' ? result.then(check) : check(result);
}

const ignorable = (error) => ['ENOENT', 'ENOTDIR', 'EBADF', 'ELOOP'].includes(error?.code);
// Path.exists / is_file with pathlib's error handling (only missing paths are "not there").
function exists(file) {
  try {
    statSync(file);
    return true;
  } catch (error) {
    if (ignorable(error)) return false;
    throw error;
  }
}
function is_file(file) {
  try {
    return statSync(file).isFile();
  } catch (error) {
    if (ignorable(error)) return false;
    throw error;
  }
}

// Path.rglob('*'): every entry below root; a symlinked directory is listed, not entered.
function rglob(root) {
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      found.push(full);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
  return found;
}

/** Replace only our own generated tree and restore it if registration fails. */
function _package(destination, harness, files, body) {
  destination = regular_path(destination);
  const marker = '.lcu-generated.json';
  const identity = { harness };
  if (exists(destination)) {
    const manifest = regular_path(join(destination, marker));
    if (!is_file(manifest) || !equal(loads(decode(readFileSync(manifest))), fromPlain(identity))) {
      throw new ValueError(`Refusing to replace an unowned plugin directory: ${destination}`);
    }
    for (const entry of rglob(destination)) regular_path(entry);
  }
  mkdirSync(parent(destination), { recursive: true });
  const temporary = mkdtemp({ prefix: '.lcu-plugin-', dir: parent(destination) });
  let deferred = null;
  try {
    const stage = join(temporary, 'next');
    mkdirSync(stage);
    for (const [relative, content] of Object.entries(files)) {
      const target = join(stage, relative);
      mkdirSync(parent(target), { recursive: true });
      writeFileSync(target, content);
    }
    writeFileSync(join(stage, marker), dumps(identity) + '\n');
    const previous = join(temporary, 'previous');
    if (exists(destination)) internals.replace(destination, previous);
    const restore = (error) => {
      if (exists(destination)) rmSync(destination, { recursive: true });
      if (exists(previous)) internals.replace(previous, destination);
      throw error;
    };
    let value;
    try {
      internals.replace(stage, destination);
      value = body(destination);
    } catch (error) {
      restore(error);
    }
    if (typeof value?.then === 'function') {
      // An awaitable body: keep the context (previous tree and temporary directory) open until it settles.
      const pending = value;
      value = undefined;
      deferred = pending.then((result) => result, restore)
        .finally(() => rmSync(temporary, { recursive: true, force: true }));
      return deferred;
    }
    return value;
  } finally {
    if (deferred === null) rmSync(temporary, { recursive: true, force: true });
  }
}

const envGet = (env, key) => (Object.hasOwn(env, key) ? env[key] : null);

export function configure_omp(home, command, release, { scope, project, env, run: runner = internals.run }) {
  if (scope !== 'user') {
    throw new ValueError('Oh My Pi native plugin links are profile-scoped. Use --scope user with the intended OMP profile; project scope is not supported.');
  }
  const executable = internals.which('omp', envGet(env, 'PATH'));
  if (!executable) {
    throw new ValueError('Oh My Pi is not on the target account PATH. Install OMP, then rerun `lcu setup --agent omp`.');
  }
  const adapter = join(release, 'adapters/pi/index.ts');
  if (!internals.is_file(adapter)) throw new ValueError(`LCU Pi/OMP adapter missing: ${adapter}`);
  // Separate package trees prevent profile setup from changing another
  // registration's selected runtime command or Chrome opt-in.
  const identity = [scope, project ? (windows() ? win32.resolve(project) : resolve(project)) : '',
    ...['OMP_PROFILE', 'PI_PROFILE', 'PI_CODING_AGENT_DIR'].map((key) => envGet(env, key) ?? '')];
  const suffix = createHash('sha256').update(dumps(identity)).digest('hex').slice(0, 16);
  const data = join(home, windows() ? 'AppData/Local/LCU' : '.local/share/lcu');
  const destination = join(data, 'omp', `${scope}-${suffix}`);
  const manifest = {
    name: 'lcu-computer-use', version: '0.1.0', private: true, type: 'module', omp: { extensions: ['./index.ts'] },
  };
  // OMP's compiled loader walks relative imports to resolve transitive npm
  // dependencies. A file:// import bypasses that graph in OMP 18.1.6.
  let adapterImport;
  if (windows()) {
    try {
      adapterImport = winAsPosix(winRelpath(adapter, destination));
    } catch (error) {
      if (error instanceof ValueError) {
        throw new ValueError('OMP requires its generated plugin and the LCU release on the same filesystem drive.');
      }
      throw error;
    }
  } else {
    adapterImport = path.relative(destination, adapter) || '.';
  }
  if (!adapterImport.startsWith('.')) adapterImport = './' + adapterImport;
  const wrapper = 'import lcu from ' + dumps(adapterImport) + ';\n' +
    'export default pi => lcu(pi, {command: ' + dumps(command) +
    ', connectOnLoad: true, ompEssentialTools: true});\n';
  const files = {
    'package.json': Buffer.from(dumps(manifest, { indent: 2 }) + '\n'),
    'index.ts': Buffer.from(wrapper),
  };
  return _package(destination, 'omp', files, (pkg) => {
    return _run([executable, 'plugin', 'link', pkg], { cwd: home, env, runner });
  });
}

export function configure_hermes(home, command, node, release, { scope, project, env, run: runner = internals.run }) {
  if (scope !== 'user') {
    throw new ValueError('Hermes native plugins are profile-scoped. Use --scope user with the intended HERMES_HOME; project scope is not supported.');
  }
  const executable = internals.which('hermes', envGet(env, 'PATH'));
  if (!executable) {
    throw new ValueError('Hermes is not on the target account PATH. Install Hermes, then rerun `lcu setup --agent hermes`.');
  }
  const root = join(env.HERMES_HOME || join(home, '.hermes'));
  if (!isAbsolute(root)) throw new ValueError('HERMES_HOME must be absolute.');
  const source = join(release, 'adapters/hermes');
  const files = {};
  for (const name of ['plugin.yaml', '__init__.py']) {
    if (!is_file(join(source, name))) throw new ValueError(`LCU Hermes plugin missing: ${join(source, name)}`);
    files[name] = readFileSync(join(source, name));
  }
  const bridge = join(source, 'bridge.mjs');
  if (!is_file(bridge)) throw new ValueError(`LCU Hermes bridge missing: ${bridge}`);
  const config = { command, node: String(node), bridge };
  files['lcu-config.json'] = Buffer.from(dumps(config, { indent: 2 }) + '\n');
  return _package(join(root, 'plugins/lcu-cua'), 'hermes', files, () => {
    return _run([executable, 'plugins', 'enable', 'lcu-cua'], { cwd: home, env: { ...env, HERMES_HOME: root }, runner });
  });
}
