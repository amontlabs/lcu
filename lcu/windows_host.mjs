// Extract the unchanged original Windows pipe host into a private generation.
// Port of lcu/windows_host.py (LCU 0.9.6, #20; see .port/notes/windows_host.md).
//
// Only the tiny launch entry and the structural analyzer are LCU code. The native
// host and its dependencies come unchanged from the installed application's
// app.asar. The host factory is located by structure (a parsed top-level function
// whose options are the native-pipe settings), never by a minified name, and the
// declarations it needs are copied verbatim into one generated module.
//
// The analyzer (windows_host_analyze.cjs + the vendored acorn parser) is shipped as is and runs in a separate
// process with the given Node, exactly as the Python module ran it.
import { mkdirSync, readFileSync, statSync, lstatSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pyStrip, pySplitlines, pyStr } from './compat/argparse.mjs';
import { list_asar_members, read_asar_members } from './asar.mjs';
import { pyfs, pyRepr } from './compat/errors.mjs';
import { compareCodePoints, dumps, loads, ValueError } from './compat/pyjson.mjs';
import * as posixpath from './compat/pypath.mjs';
import { popen, readLine } from './macos_host.mjs';
import { isOSError, run, SubprocessError, TimeoutExpired } from './compat/subprocess.mjs';
import { decode as decodeUtf8 } from './compat/utf8.mjs';
import { _component } from './windows.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const _MAIN_PATH = /^\.vite\/build\/main(?:-[^/]+)?\.js$/;
const _ANALYZER = path.join(HERE, 'windows_host_analyze.cjs');
const _GENERATED = 'lcu-original-pipe-host.cjs';
const _RESOLVED_SUFFIXES = ['', '.js', '.json', '.node', '/package.json', '/index.js', '/index.json', '/index.node'];
const _MAX_CHUNKS = 400;
const _NODE_MEMBER = 'app/resources/cua_node/bin/node.exe';

/** Test hook: the subprocess.run the analyzer goes through. */
export const internals = { run };

function _required_layout(detail) {
  throw new ValueError(`Required Windows host layout is unavailable: ${detail}`);
}

/** HostPlan: the read-only result of analysing an app.asar; nothing here is written yet. */
export function HostPlan(main, factory, module, contents, uncarried = 0) {
  // uncarried: top-level calls that only touch imported modules; see windows_host_analyze.cjs
  return Object.freeze({ main, factory, module, contents, uncarried });
}

/** dict[key] (KeyError like Python when absent). */
function need(map, key) {
  if (!(map instanceof Map) || !map.has(key)) {
    const error = new Error(pyRepr(key));
    error.name = map instanceof Map ? 'KeyError' : 'TypeError';
    throw error;
  }
  return map.get(key);
}

/** Python truthiness of a JSON value. */
const truthy = (value) => !(value === null || value === undefined || value === false || value === 0 || value === 0n ||
  value === '' || (Array.isArray(value) && value.length === 0) || (value instanceof Map && value.size === 0) ||
  (typeof value?.valueOf() === 'number' && value.valueOf() === 0));

const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const isSymlink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

function _analyzer_env() {
  const env = { PATH: process.env.PATH ?? '' };
  // Node aborts at startup on Windows without it (os.environ is case-insensitive there).
  const systemroot = process.platform === 'win32' ? process.env.SYSTEMROOT
    : Object.hasOwn(process.env, 'SYSTEMROOT') ? process.env.SYSTEMROOT : undefined;
  if (systemroot !== undefined) env.SYSTEMROOT = systemroot;
  return env;
}

export function _analyze(node, request) {
  if (!isFile(node)) _required_layout('the original Node needed to read the host layout is missing');
  let result;
  try {
    result = internals.run([String(node), '--max-old-space-size=2048', _ANALYZER], {
      input: Buffer.from(dumps(request), 'utf8'), stdin: 'pipe', capture: true, text: false,
      env: _analyzer_env(), timeout: 180000, check: false,
    });
  } catch (exc) {
    if (isOSError(exc) || exc instanceof SubprocessError) {
      _required_layout(`the structural analyzer could not run (${exc.name})`);
    }
    throw exc;
  }
  let response;
  try {
    response = loads(result.stdout);
  } catch (exc) {
    if (!(exc instanceof ValueError)) throw exc;
    response = null;
  }
  if (result.returncode !== 0 || !(response instanceof Map)) {
    const detail = pySplitlines(pyStrip(new TextDecoder('utf-8').decode(result.stderr))).slice(0, 1);
    _required_layout('the structural analyzer failed to read the main bundle' +
      (detail.length ? ` (${Array.from(detail[0]).slice(0, 160).join('')})` : ''));
  }
  if (response.get('ok') !== true) {
    const error = response.get('error');
    _required_layout(truthy(error) ? pyStr(error) : 'the structural analyzer rejected the main bundle');
  }
  return response;
}

function _decode(source, name) {
  try {
    return decodeUtf8(source);
  } catch {
    return _required_layout(`${name} is not UTF-8`);
  }
}

export function _member_for(current, specifier, members) {
  const base = posixpath.normpath(posixpath.join(posixpath.dirname(current), specifier));
  if (base === '..' || base.startsWith('../') || posixpath.isabs(base)) {
    _required_layout(`original dependency ${pyRepr(specifier)} leaves the application archive`);
  }
  // Node's own order for a relative specifier: the exact file, then .js, .json, .node,
  // then a directory's package.json "main" (not supported here) or index file.
  // A trailing slash (or `/.`, `/..`) names a directory only; Node then skips file candidates.
  const directory_only = ['/', '/.', '/..'].some((end) => specifier.endsWith(end)) || specifier === '.' || specifier === '..';
  for (const suffix of _RESOLVED_SUFFIXES) {
    if (directory_only && !suffix.startsWith('/')) continue;
    if (members.has(base + suffix)) {
      if (suffix === '/package.json') {
        _required_layout(`original dependency ${base} is a package directory, which is not supported`);
      }
      return base + suffix;
    }
  }
  return _required_layout(`original dependency is missing: ${base}`);
}

/** Resolve one module's static dependencies; fail closed on anything not plain and local. */
export function _local_dependencies(current, requires, imports, members) {
  for (const item of imports) {
    if (!truthy(need(item, 'builtin'))) {
      _required_layout(`${current} imports ${pyRepr(need(item, 'spec'))} statically, which is not supported`);
    }
  }
  const found = [];
  for (const item of requires) {
    const spec = need(item, 'spec');
    if (truthy(need(item, 'builtin'))) continue;
    if (spec === 'electron' || spec.startsWith('electron/')) {
      _required_layout(`the native-pipe host depends on Electron through ${current}`);
    }
    if (!spec.startsWith('.')) {
      _required_layout(`unsupported non-relative original dependency ${pyRepr(spec)} in ${current}`);
    }
    found.push(_member_for(current, spec, members));
  }
  return found;
}

/**
 * Read the selected app's app.asar and plan the host extraction without writing anything.
 *
 * `node` runs the structural analyzer; it defaults to the app's own Node, which
 * the protected Store directory does not let LCU execute (the installer passes a
 * private copy).
 */
export function plan_original_host(app, { node = null } = {}) {
  const archive = path.join(app, 'app/resources/app.asar');
  if (isSymlink(archive) || !isFile(archive)) _required_layout('app/resources/app.asar is missing or redirected');
  return plan_original_asar(archive, { node: node ?? _component(app, _NODE_MEMBER) });
}

/** The same read-only plan for a bare app.asar (the development check uses this). */
export function plan_original_asar(archive, { node } = {}) {
  const members = new Set(list_asar_members(archive));
  const results = [];
  for (const name of [...members].filter((member) => _MAIN_PATH.test(member)).sort(compareCodePoints)) {
    const source = memberContents(read_asar_members(archive, [name])).get(name);
    const response = _analyze(node, new Map([['op', 'host'], ['source', _decode(source, name)]]));
    if ((response.has('matches') ? response.get('matches') : 0) != 0) results.push([name, response]); // eslint-disable-line eqeqeq
  }
  if (results.length === 0) {
    _required_layout('no main bundle has a top-level native-pipe host factory (a function taking ' +
      'codexCliPath, nativePipeDirectory, windowsHelperPath and ' +
      'windowsHelperTransportModulePath options)');
  }
  if (results.length !== 1 || need(results[0][1], 'matches') != 1) { // eslint-disable-line eqeqeq
    _required_layout('more than one top-level native-pipe host factory matches');
  }
  const [main, response] = results[0];
  // Walk the relative-require graph from the generated module's own requirements.
  let queue = [...new Set(_local_dependencies(main, need(response, 'requires'), need(response, 'imports'), members))];
  const chunks = new Map();
  while (queue.length) {
    const batch = queue.filter((name) => !chunks.has(name));
    if (batch.length === 0) break;
    if (chunks.size + batch.length > _MAX_CHUNKS) _required_layout('original dependency graph is unexpectedly large');
    const sources = memberContents(read_asar_members(archive, batch));
    const scripts = new Map();
    for (const name of batch) {
      if (_MAIN_PATH.test(name)) _required_layout(`original dependency graph reaches the main bundle through ${name}`);
      if (name.endsWith('.node')) _required_layout(`original dependency ${name} is a native module`);
      chunks.set(name, need(sources, name));
      if (name.endsWith('.json')) continue;
      if (!name.endsWith('.js') && !name.endsWith('.cjs')) {
        _required_layout(`original dependency ${name} is not a CommonJS module`);
      }
      scripts.set(name, _decode(sources.get(name), name));
    }
    queue = [];
    if (scripts.size) {
      const listed = need(_analyze(node, new Map([['op', 'requires'], ['files', scripts]])), 'files');
      for (const name of scripts.keys()) {
        const entry = need(listed, name);
        queue.push(..._local_dependencies(name, need(entry, 'requires'), need(entry, 'imports'), members));
      }
    }
    queue = [...new Set(queue)];
  }
  return HostPlan(main, need(response, 'factory'), need(response, 'module'), chunks,
    response.has('uncarried') ? response.get('uncarried') : 0);
}

/** read_asar_members' dict[str, bytes] (a null-prototype object or a Map) as a Map. */
const memberContents = (value) => (value instanceof Map ? value : new Map(Object.entries(value)));

/** Path.mkdir(parents=True, exist_ok=...). */
function mkdirPython(target, existOk) {
  try {
    mkdirSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT' && path.dirname(target) !== target) {
      mkdirPython(path.dirname(target), true);
      mkdirPython(target, existOk);
      return;
    }
    if (error?.code === 'EEXIST' && existOk && (() => { try { return statSync(target).isDirectory(); } catch { return false; } })()) return;
    throw pyfs(target, () => { throw error; });
  }
}

/** Extract the structurally selected host factory and its exact dependencies. */
export function materialize_original_host(app, destination, { node = null } = {}) {
  return write_original_host(plan_original_host(app, { node }), destination);
}

function countOf(buffer, needle) {
  let count = 0;
  for (let at = buffer.indexOf(needle); at >= 0; at = buffer.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

/** bytes.replace(old, new) (all occurrences). */
function replaceAll(buffer, needle, replacement) {
  const parts = [];
  let start = 0;
  for (let at = buffer.indexOf(needle); at >= 0; at = buffer.indexOf(needle, start)) {
    parts.push(buffer.subarray(start, at), replacement);
    start = at + needle.length;
  }
  parts.push(buffer.subarray(start));
  return Buffer.concat(parts);
}

/** Write a planned host (generated module, chunks, thin entry) into a new directory. */
export function write_original_host(plan, destination) {
  const templatePath = path.join(HERE, 'windows_host_entry.cjs');
  const template = pyfs(templatePath, () => readFileSync(templatePath));
  const marker = Buffer.from('// ORIGINAL_WINDOWS_PIPE_HOST_MODULE');
  if (countOf(template, marker) !== 1) throw new ValueError('Windows host entry marker is missing or ambiguous.');
  // The generated module sits beside the original main bundle, so every original
  // relative require inside it keeps resolving as written.
  const generated = posixpath.join(posixpath.dirname(plan.main), _GENERATED);
  const entry = replaceAll(template, marker,
    Buffer.from(`const createPipeHost = require(${dumps(`./${generated}`)});`, 'utf8'));
  mkdirPython(destination, false);
  for (const [name, content] of plan.contents) {
    const target = path.join(destination, name);
    mkdirPython(path.dirname(target), true);
    pyfs(target, () => writeFileSync(target, content));
  }
  const module = path.join(destination, generated);
  mkdirPython(path.dirname(module), true);
  pyfs(module, () => writeFileSync(module, Buffer.from(plan.module, 'utf8')));
  const launcher = path.join(destination, 'windows-pipe-host.cjs');
  pyfs(launcher, () => writeFileSync(launcher, entry));
  for (const [source, target] of [
    ['windows_lifetime_host.cjs', 'windows-lifetime-host.cjs'],
    ['windows_sky_service.mjs', 'windows-sky-service.mjs'],
  ]) {
    const from = path.join(HERE, source);
    const to = path.join(destination, target);
    pyfs(to, () => writeFileSync(to, pyfs(from, () => readFileSync(from))));
  }
  return launcher;
}

const cpLength = (text) => Array.from(text).length;

/** Start the extracted original host and wait for its actual pipe readiness. */
export async function start_original_host({ node, entry, helper, transport, env } = {}) {
  if (![node, entry, helper, transport].every((item) => isFile(item))) {
    throw new ValueError('The selected original Windows native host is incomplete.');
  }
  const child_env = { ...env };
  child_env.LCU_WRE_HELPER_PATH = String(helper);
  child_env.LCU_WRE_TRANSPORT_PATH = String(transport);
  const process_ = await popen([String(node), String(entry)], { env: child_env, cwd: path.dirname(entry) });
  try {
    const line = await readLine(process_.stdout, 15);
    const state = loads(line);
    const dict = state instanceof Map;
    const pipe = dict ? state.get('pipePath') : null;
    const lifetime = dict ? state.get('lifetimePath') : null;
    if (!dict || state.get('ready') !== true ||
        typeof pipe !== 'string' ||
        !pipe.startsWith('\\\\.\\pipe\\lcu-wre-') || cpLength(pipe) > 256 ||
        typeof lifetime !== 'string' ||
        !lifetime.startsWith('\\\\.\\pipe\\lcu-lifetime-') || cpLength(lifetime) > 256) {
      throw new ValueError('Original Windows native host did not report its private pipes.');
    }
    return [process_, pipe, lifetime];
  } catch (exc) {
    if (!(exc instanceof ValueError || exc?.name === 'Empty')) throw exc;
    await stop_original_host(process_, { require_success: false });
    throw new ValueError('Original Windows native host failed to become ready.');
  }
}

/** Dispose only the host process owned by this LCU MCP connection. */
export async function stop_original_host(process_, { require_success = true } = {}) {
  if (process_.stdin && !process_.stdin.destroyed && !process_.stdin.writableEnded) process_.stdin.end();
  let status;
  try {
    try {
      status = await process_.wait(10);
    } catch (error) {
      if (!(error instanceof TimeoutExpired)) throw error;
      process_.terminate();
      status = await process_.wait(5);
    }
  } finally {
    process_.stdout?.destroy();
  }
  if (require_success && status !== 0) {
    throw new ValueError(`Original Windows native host exited with status ${status}.`);
  }
}
