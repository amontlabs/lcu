// Validate an official Windows Store package and its intact private copy.
// Port of lcu/windows.py (see .port/notes/windows.md). Synchronous (runtime.mjs require()s it).
//
// Paths are strings (node:path of the running platform). Python's platform/subprocess/Path.is_junction lookups
// go through `hooks` so the fixture tests can run on any OS like the Python tests did with mock.patch.
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { XmlParseError, parseAppxManifest } from './compat/appx_xml.mjs';
import { pyStrip } from './compat/argparse.mjs';
import { PY_DECIMAL } from './compat/pyctype.mjs';
import { applicationInventory, inventorySha256 } from './compat/hash.mjs';
import { pathStr, resolve as posixResolve } from './compat/pathlib.mjs';
import { JSONDecodeError, UnicodeDecodeError, ValueError, compareCodePoints, equal, fromPlain, loads } from './compat/pyjson.mjs';
import { decode_strict } from './compat/pycodecs.mjs';
import { CalledProcessError, run } from './compat/subprocess.mjs';

export const PACKAGE_NAME = 'OpenAI.Codex';
export const PACKAGE_PUBLISHER = 'CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B';
export const WINDOWS_REQUIRED_FILES = Object.freeze([
  'app/ChatGPT.exe',
  'app/resources/app.asar',
  'app/resources/cua_node/bin/node.exe',
  'app/resources/cua_node/bin/node_repl.exe',
  'app/resources/cua_node/manifest.json',
  'app/resources/cua_node/bin/node_modules/@oai/cua-repl/bin/cua-repl.mjs',
  'app/resources/cua_node/bin/node_modules/@oai/sky/bin/windows/codex-computer-use.exe',
  'app/resources/cua_node/bin/node_modules/@oai/sky/bin/windows/swift/x64/codex-computer-use-swift.exe',
  'app/resources/cua_node/bin/node_modules/@oai/sky/dist/project/cua/sky_js/src/service.js',
  'app/resources/cua_node/bin/node_modules/@oai/sky/dist/project/cua/sky_js/src/targets/windows/internal/helper_transport.js',
  'app/resources/cua_node/bin/node_modules/@oai/sky/dist/project/cua/sky_js/src/targets/windows/internal/computer_use_client.js',
  'app/resources/codex.exe',
  'app/resources/codex-code-mode-host.exe',
  'app/resources/plugins/openai-bundled/plugins/chrome/.codex-plugin/plugin.json',
  'app/resources/plugins/openai-bundled/plugins/chrome/extension-host/windows/x64/extension-host.exe',
  'app/resources/plugins/openai-bundled/plugins/unified-computer-use/.mcp.json',
]);

const PYTHON_SYSTEM = { win32: 'Windows', darwin: 'Darwin', linux: 'Linux' };

/** platform.system() / platform.machine() for the running Node. */
function pythonMachine() {
  if (process.platform === 'win32') return { x64: 'AMD64', arm64: 'ARM64', ia32: 'x86' }[process.arch] ?? process.arch;
  if (process.platform === 'darwin') return { x64: 'x86_64', arm64: 'arm64' }[process.arch] ?? process.arch;
  return { x64: 'x86_64', arm64: 'aarch64' }[process.arch] ?? process.arch;
}

/** Injection points (Python tests patched platform.system/machine, subprocess.run and Path.is_junction). */
/**
 * locale.getencoding() as Python's subprocess text mode uses it: on Windows the ANSI code page "cp<ACP>" (UTF-8
 * when PYTHONUTF8=1), elsewhere the UTF-8 locale LCU runs under.
 */
let preferred = null;
function preferredEncoding() {
  if (preferred !== null) return preferred;
  preferred = 'utf-8';
  if (process.platform === 'win32' && process.env.PYTHONUTF8 !== '1') {
    const query = run(['reg.exe', 'query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'ACP'],
      { capture: true, text: false });
    const match = /\bACP\s+REG_SZ\s+(\d+)/.exec(query.stdout.toString('latin1'));
    if (match) preferred = `cp${match[1]}`;
  }
  return preferred;
}

export const hooks = {
  system: () => PYTHON_SYSTEM[process.platform] ?? process.platform,
  machine: pythonMachine,
  run,
  preferred_encoding: preferredEncoding,
  // libuv's lstat reports junctions as symbolic links, so Python's separate is_junction() is covered by the
  // symlink test; this hook only exists so tests can simulate a junction that is not a symlink.
  is_junction: () => false,
};

/** InstalledWindowsApplication (frozen dataclass). */
export function InstalledWindowsApplication(app, resources, runtime, launcher, backend, version, arch,
  runtime_version, inventory, inventory_digest) {
  return Object.freeze({ app, resources, runtime, launcher, backend, version, arch, runtime_version, inventory,
    inventory_digest });
}

// --------------------------------------------------------------------------------- pathlib helpers

const IGNORED = new Set(['ENOENT', 'ENOTDIR', 'EBADF', 'ELOOP']);
function probe(fn) {
  try {
    return fn();
  } catch (error) {
    if (IGNORED.has(error?.code)) return false;
    throw error;
  }
}
const isSymlink = (p) => probe(() => lstatSync(p).isSymbolicLink());
const isDir = (p) => probe(() => statSync(p).isDirectory());
const isFile = (p) => probe(() => statSync(p).isFile());

/** Path(p): pathlib normalisation of a selected location string. */
function pathOf(p) {
  if (process.platform === 'win32') return path.win32.normalize(String(p)).replace(/(?<=[^:\\])\\+$/, '');
  return pathStr(String(p));
}

/** Path.resolve(strict=True). */
function resolveStrict(p) {
  if (process.platform === 'win32') return realpathSync(p);
  return posixResolve(p, { strict: true });
}

/** PurePath.is_relative_to (lexical; case-insensitive on Windows). */
function isRelativeTo(child, parent) {
  const fold = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const c = fold(child);
  const p = fold(parent);
  if (c === p) return true;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

// --------------------------------------------------------------------------------- module API

function _redirected(p) {
  return isSymlink(p) || hooks.is_junction(p);
}

/** Hash the selected Store package tree for managed-copy integrity checks. */
export function application_inventory(app) {
  return applicationInventory(app);
}

export function inventory_sha256(inventory) {
  return inventorySha256(inventory);
}

// re.fullmatch(r'\d+\.\d+\.\d+\.\d+'): Python's Unicode decimal digits (CPython's frozen table, R12).
const VERSION_RE = new RegExp(`^[${PY_DECIMAL}]+\\.[${PY_DECIMAL}]+\\.[${PY_DECIMAL}]+\\.[${PY_DECIMAL}]+$`, 'u');

export function _appx_identity(app) {
  if (_redirected(app) || !isDir(app)) {
    throw new ValueError('Windows package application directory is missing or redirected.');
  }
  const manifest_path = path.join(app, 'AppxManifest.xml');
  if (_redirected(manifest_path) || !isFile(manifest_path)) {
    throw new ValueError('Windows package identity manifest is missing or redirected.');
  }
  let identity;
  try {
    ({ identity } = parseAppxManifest(readFileSync(manifest_path)));
  } catch (error) {
    if (error instanceof XmlParseError || typeof error?.code === 'string') {
      throw new ValueError('Windows package identity manifest is invalid.');
    }
    throw error;
  }
  if (identity === null) throw new ValueError('Windows package identity is missing.');
  const name = identity.get('Name') ?? null;
  const publisher = identity.get('Publisher') ?? null;
  const version = identity.get('Version') ?? null;
  const architecture = identity.get('ProcessorArchitecture') ?? null;
  if (name !== PACKAGE_NAME || publisher !== PACKAGE_PUBLISHER ||
      typeof version !== 'string' ||
      !VERSION_RE.test(version) ||
      !['x64', 'X64'].includes(architecture)) {
    throw new ValueError('Windows package identity, version, or architecture is invalid.');
  }
  return [name, publisher, version, architecture.toLowerCase()];
}

/**
 * subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=...): bytes are decoded strictly with
 * the locale encoding (stdout, then stderr; UnicodeDecodeError before any CalledProcessError), then universal
 * newlines are applied.
 */
function _run_text(cmd, timeout) {
  const result = hooks.run(cmd, { capture: true, timeout, text: false });
  const encoding = hooks.preferred_encoding();
  // (An injected hooks.run may hand back already-decoded text.)
  const text = (bytes) => (typeof bytes === 'string' ? bytes : decode_strict(bytes ?? Buffer.alloc(0), encoding)).replace(/\r\n?/g, '\n');
  const stdout = text(result.stdout);
  const stderr = text(result.stderr);
  if (result.returncode) throw new CalledProcessError(result.returncode, cmd, stdout, stderr);
  return { args: cmd, returncode: result.returncode, stdout, stderr };
}

export function _registered_package() {
  // Get-AppxPackage only sees packages registered for this account. Use its
  // InstallLocation rather than guessing the WindowsApps package volume.
  const command = (
    "$ErrorActionPreference='Stop'; " +
    "$packages=@(Get-AppxPackage -Name 'OpenAI.Codex'); " +
    '$packages | Select-Object Name,Publisher,' +
    "@{Name='Version';Expression={$_.Version.ToString()}}," +
    "@{Name='Architecture';Expression={$_.Architecture.ToString()}}," +
    "@{Name='SignatureKind';Expression={$_.SignatureKind.ToString()}}," +
    'InstallLocation ' +
    '| ConvertTo-Json -Compress'
  );
  const result = _run_text(
    ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], 30000);
  if (!pyStrip(result.stdout)) {
    throw new ValueError('Install the official ChatGPT MSIX for this Windows account first.');
  }
  const parsed = loads(result.stdout);
  const packages = Array.isArray(parsed) ? parsed : [parsed];
  if (packages.length !== 1 || !(packages[0] instanceof Map)) {
    throw new ValueError('Expected exactly one registered OpenAI.Codex package for this account.');
  }
  if (typeof packages[0].get('Version') !== 'string' ||
      typeof packages[0].get('Architecture') !== 'string' ||
      typeof packages[0].get('SignatureKind') !== 'string') {
    throw new ValueError('Windows package query did not return string version, architecture and signature kind.');
  }
  return packages[0];
}

export function _component(app, relative) {
  const expected = path.join(app, relative);
  if (isFile(expected)) return expected;
  // MSIX stores `@` as `%40` in its OPC archive. Accept either spelling in
  // the deployed package, but no arbitrary path fallback.
  const encoded = path.join(app, relative.replace('@oai/', '%40oai/'));
  return isFile(encoded) ? encoded : expected;
}

/** Select and structurally validate the current user's official Store app. */
export function resolve_installed_windows_app() {
  _validate_host();
  const pkg = _registered_package();
  if (pkg.get('Name') !== PACKAGE_NAME || pkg.get('Publisher') !== PACKAGE_PUBLISHER ||
      !['x64', 'amd64'].includes(pkg.get('Architecture').toLowerCase()) ||
      pkg.get('SignatureKind') !== 'Store') {
    throw new ValueError('Registered ChatGPT package is not the official Windows x64 Store app.');
  }
  const selected = pkg.get('InstallLocation');
  if (typeof selected !== 'string' || !selected) {
    throw new ValueError('Registered ChatGPT package has no install location.');
  }
  const app = pathOf(selected);
  const [, , version] = _appx_identity(app);
  if (pkg.get('Version') !== version) {
    throw new ValueError('Registered ChatGPT package version does not match its identity manifest.');
  }
  const manifest = _runtime_manifest(app);
  const runtime_version = manifest.get('runtime_archive_version');
  // Capture the registered source's exact tree as the baseline for its
  // managed copy. The validator recomputes it before returning the selection.
  const inventory = application_inventory(app);
  return validate_windows_app_tree(app, {
    expected_version: version, expected_runtime: runtime_version, expected_inventory: inventory });
}

export function _validate_host() {
  if (hooks.system() !== 'Windows' || !['amd64', 'x86_64'].includes(hooks.machine().toLowerCase())) {
    throw new ValueError('The Windows application can only be validated on Windows x64.');
  }
}

export function _runtime_manifest(app) {
  const file = _component(app, 'app/resources/cua_node/manifest.json');
  if (_redirected(file) || !isFile(file)) {
    throw new ValueError('Windows CUA runtime manifest is missing or redirected.');
  }
  let manifest;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(file));
    manifest = loads(text.replace(/\r\n?/g, '\n'));
  } catch (error) {
    if (typeof error?.code === 'string' || error instanceof TypeError || error instanceof JSONDecodeError ||
        error instanceof UnicodeDecodeError) {
      throw new ValueError('Windows CUA runtime manifest is invalid.');
    }
    throw error;
  }
  if (!(manifest instanceof Map)) throw new ValueError('Windows CUA runtime manifest is invalid.');
  const version = manifest.get('runtime_archive_version');
  if (manifest.get('platform') !== 'windows' || manifest.get('arch') !== 'x64' ||
      typeof version !== 'string' || !pyStrip(version)) {
    throw new ValueError('Windows CUA runtime manifest has an unsupported platform or architecture.');
  }
  return manifest;
}

const isMapping = (value) => value instanceof Map ||
  (value !== null && typeof value === 'object' && !Array.isArray(value) &&
   [Object.prototype, null].includes(Object.getPrototypeOf(value)));

/** Validate host layout and exact equality with a source-derived inventory. */
export function validate_windows_app_tree(app, { expected_version, expected_runtime, expected_inventory } = {}) {
  _validate_host();
  if (!expected_version || !expected_runtime || !isMapping(expected_inventory)) {
    throw new ValueError('A selected Windows version, runtime and source inventory are required.');
  }
  app = pathOf(app);
  if (_redirected(app) || !isDir(app)) {
    throw new ValueError('Windows application directory is missing or redirected.');
  }
  app = resolveStrict(app);
  const [, , manifest_version] = _appx_identity(app);
  if (manifest_version !== expected_version) {
    throw new ValueError('Windows application identity version changed after selection.');
  }
  const resources = path.join(app, 'app/resources');
  const runtime = path.join(resources, 'cua_node');
  for (const relative of WINDOWS_REQUIRED_FILES) {
    const file = _component(app, relative);
    const parentRedirected = () => {
      for (let parent = path.dirname(file); parent !== path.dirname(parent); parent = path.dirname(parent)) {
        if (parent !== app && isRelativeTo(parent, app) && _redirected(parent)) return true;
      }
      return false;
    };
    if (!isFile(file) || _redirected(file) || parentRedirected() ||
        !isRelativeTo(resolveStrict(file), app) || !isFile(resolveStrict(file))) {
      throw new ValueError(`Required Windows application file is missing or outside the app: ${relative}`);
    }
  }
  const manifest = _runtime_manifest(app);
  const runtime_version = manifest.get('runtime_archive_version');
  if (runtime_version !== expected_runtime) {
    throw new ValueError('Windows CUA runtime changed after selection.');
  }
  const expected = expected_inventory instanceof Map ? expected_inventory : fromPlain(expected_inventory);
  const actual = application_inventory(app);
  if (!equal(actual, expected)) {
    const differing = [...new Set([...actual.keys(), ...expected.keys()])].sort(compareCodePoints);
    const first = differing.find((key) => !equal(actual.get(key) ?? null, expected.get(key) ?? null)) ?? '<tree>';
    throw new ValueError(`Windows application differs from selected source inventory: ${first}`);
  }
  const launcher = _component(app, 'app/resources/cua_node/bin/node_modules/@oai/cua-repl/bin/cua-repl.mjs');
  return InstalledWindowsApplication(app, resources, runtime, launcher, 'windows',
    expected_version, 'x64', runtime_version, expected_inventory, inventory_sha256(expected_inventory));
}
