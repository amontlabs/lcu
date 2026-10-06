// Extract the unchanged original Windows pipe host into a private generation.
// Port of lcu/windows_host.py (see .port/notes/windows_host.md).
//
// Only the tiny launch entry is LCU code. The native host and its dependencies
// come unchanged from the installed application's verified app.asar.
//
// The lexer works on JS strings (UTF-16 code units) where Python used code points; only index arithmetic
// differs, never the result: every character the lexer acts on is ASCII and all slices fall on ASCII positions.
// Python's Unicode `\s`, `\w`, str.isspace() and str.isalpha() are reproduced with explicit classes.
import { mkdirSync, readFileSync, statSync, lstatSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { list_asar_members, read_asar_members } from './asar.mjs';
import { pyfs, pyRepr } from './compat/errors.mjs';
import { PY_ALPHA, PY_SPACE, PY_WORD } from './compat/pyctype.mjs';
import { compareCodePoints, dumps, loads, ValueError } from './compat/pyjson.mjs';
import * as posixpath from './compat/pypath.mjs';
import { popen, readLine } from './macos_host.mjs';
import { TimeoutExpired } from './compat/subprocess.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Python's `\s`/str.isspace(), `\w` and str.isalpha() from CPython's frozen Unicode tables (compat/pyctype),
// so acceptance does not follow the running Node's Unicode version.
const SPACE_RE = new RegExp(`^[${PY_SPACE}]$`, 'u');
const ALPHA_RE = new RegExp(`^[${PY_ALPHA}]$`, 'u');

const _MAIN_PATH = /^\.vite\/build\/main(?:-[^/]+)?\.js$/;
const _BINDING = new RegExp(
  `(?<![${PY_WORD}$])([A-Za-z_$][${PY_WORD}$]*)[${PY_SPACE}]*=[${PY_SPACE}]*require[${PY_SPACE}]*\\([${PY_SPACE}]*(['"])([^'"]+)\\2[${PY_SPACE}]*\\)`,
  'gu');
const _WRE = new RegExp(`(?<![${PY_WORD}])(?=[${PY_WORD}])function[${PY_SPACE}]+Wre[${PY_SPACE}]*\\(`, 'gu');
const _FAMILY = /^\.vite\/build\/(?:rolldown-runtime|src|logger)-[^/]+\.js$/;

function _required_layout(detail) {
  throw new ValueError(`Required Windows host layout is unavailable: ${detail}`);
}

function _skip_quoted(source, index, quote) {
  index += 1;
  while (index < source.length) {
    if (source[index] === '\\') index += 2;
    else if (source[index] === quote) return index + 1;
    else index += 1;
  }
  return _required_layout('unterminated source string');
}

/** Find the Wre factory's end; skip strings, comments, and regex literals. */
function _function_body_end(source, opening) {
  let depth = 1;
  let index = opening + 1;
  const modes = ['code'];
  const interpolation_depths = [];
  while (index < source.length) {
    const mode = modes.at(-1);
    const char = source[index];
    if (mode === 'template') {
      if (char === '\\') {
        index += 2;
      } else if (char === '`') {
        modes.pop();
        index += 1;
      } else if (source.startsWith('${', index)) {
        depth += 1;
        interpolation_depths.push(depth);
        modes.push('code');
        index += 2;
      } else {
        index += 1;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      index = _skip_quoted(source, index, char);
    } else if (char === '`') {
      modes.push('template');
      index += 1;
    } else if (source.startsWith('//', index)) {
      const newline = source.indexOf('\n', index + 2);
      index = newline < 0 ? source.length : newline + 1;
    } else if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      if (end < 0) _required_layout('unterminated source comment');
      index = end + 2;
    } else if (char === '/' && _starts_regex(source, index)) {
      index = _regex_end(source, index);
    } else if (char === '{') {
      depth += 1;
      index += 1;
    } else if (char === '}') {
      const prior = depth;
      depth -= 1;
      index += 1;
      if (interpolation_depths.length && prior === interpolation_depths.at(-1)) {
        interpolation_depths.pop();
        modes.pop();
      } else if (depth === 0) {
        return index;
      }
    } else {
      index += 1;
    }
  }
  return _required_layout('unterminated Wre function');
}

const WORD_CHAR_RE = new RegExp(`^[${PY_WORD}$]$`, 'u');
const TRAILING_WORD = new RegExp(`[A-Za-z_$][${PY_WORD}$]*$`, 'u');

function _starts_regex(source, index) {
  let previous = index - 1;
  while (previous >= 0 && SPACE_RE.test(source[previous])) previous -= 1;
  if (previous >= 0 && '=(:,[!&|?;{}+-*%^~<>'.includes(source[previous])) return true;
  // re.search(r'([A-Za-z_$][\w$]*)\s*$', source[:index]): only the final run of word characters can match.
  let start = previous + 1;
  while (start > 0) {
    const cp = source.codePointAt(start - 1);
    const low = start >= 2 && source.charCodeAt(start - 1) >= 0xdc00 && source.charCodeAt(start - 1) <= 0xdfff &&
      source.charCodeAt(start - 2) >= 0xd800 && source.charCodeAt(start - 2) <= 0xdbff;
    const ch = low ? source.slice(start - 2, start) : String.fromCodePoint(cp);
    if (!WORD_CHAR_RE.test(ch)) break;
    start -= ch.length;
  }
  const word = TRAILING_WORD.exec(source.slice(start, previous + 1));
  return Boolean(word && ['return', 'throw', 'case', 'delete', 'void', 'typeof'].includes(word[0]));
}

function _regex_end(source, index) {
  index += 1;
  let in_class = false;
  let escaped = false;
  while (index < source.length && source[index] !== '\r' && source[index] !== '\n') {
    const char = source[index];
    if (escaped) {
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '[') {
      in_class = true;
    } else if (char === ']') {
      in_class = false;
    } else if (char === '/' && !in_class) {
      index += 1;
      while (index < source.length) {
        const ch = String.fromCodePoint(source.codePointAt(index));
        if (!ALPHA_RE.test(ch)) break;
        index += ch.length;
      }
      return index;
    }
    index += 1;
  }
  return _required_layout('unterminated Wre regular expression');
}

function decodeUtf8(bytes) {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}

export function _wre_source(source) {
  let text;
  try {
    text = decodeUtf8(source);
  } catch {
    throw new ValueError('Required Windows host layout is unavailable: main source is not UTF-8.');
  }
  const matches = [...text.matchAll(_WRE)];
  if (matches.length !== 1) _required_layout('expected one named Wre host factory');
  const match = matches[0];
  let index = match.index + match[0].length;
  let parens = 1;
  while (index < text.length && parens) {
    const char = text[index];
    if (char === "'" || char === '"' || char === '`') {
      index = _skip_quoted(text, index, char);
    } else if (text.startsWith('//', index)) {
      const newline = text.indexOf('\n', index + 2);
      index = newline < 0 ? text.length : newline + 1;
    } else if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2);
      if (end < 0) _required_layout('unterminated function parameter comment');
      index = end + 2;
    } else if (char === '(') {
      parens += 1;
      index += 1;
    } else if (char === ')') {
      parens -= 1;
      index += 1;
    } else {
      index += 1;
    }
  }
  while (index < text.length && SPACE_RE.test(text[index])) index += 1;
  if (parens || index >= text.length || text[index] !== '{') _required_layout('Wre is not a function declaration');
  const end = _function_body_end(text, index);
  const result = Buffer.from(text.slice(match.index, end), 'utf8');
  if (!result.includes('closeActiveTurn') || !result.includes('nativePipeDirectory')) {
    _required_layout('Wre no longer exposes the expected native-pipe and turn-cleanup interface');
  }
  return result;
}

const escapeRegex = (text) => text.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');

export function _referenced(name, source) {
  let text;
  try {
    text = decodeUtf8(source);
  } catch {
    return false;
  }
  return new RegExp(`(?<![${PY_WORD}$])${escapeRegex(name)}(?![${PY_WORD}$])`, 'u').test(text);
}

export function _direct_member(current, specifier, members) {
  if (specifier.startsWith('node:')) return null;
  if (!specifier.startsWith('.')) _required_layout(`unsupported non-relative original dependency ${pyRepr(specifier)}`);
  const target = posixpath.normpath(posixpath.join(posixpath.dirname(current), specifier));
  if (!members.has(target)) _required_layout(`original dependency is missing: ${target}`);
  return target;
}

export function _host_imports(main, host) {
  const bindings = new Map();
  for (const match of decodeUtf8(main).matchAll(_BINDING)) {
    const name = match[1];
    const specifier = match[3];
    if (!_referenced(name, host)) continue;
    if (['c', 'T', 'p', 'v', '_', 'R'].includes(name)) continue;
    if (name !== 'n' && name !== 'r') _required_layout(`unsupported original import binding ${name}`);
    if (!bindings.has(name)) bindings.set(name, specifier);
    if (bindings.get(name) !== specifier) _required_layout(`ambiguous imported binding ${name}`);
  }
  for (const name of ['n', 'r']) {
    if (_referenced(name, host) && !bindings.has(name)) _required_layout(`original Wre import ${name} is missing`);
  }
  if (bindings.size === 0) _required_layout('no supported original module import supplies Wre');
  return [...bindings].sort((a, b) => compareCodePoints(a[0], b[0]) || compareCodePoints(a[1], b[1]));
}

/** read_asar_members result (dict[str, bytes]) as [name, bytes] pairs. */
const entriesOf = (value) => (value instanceof Map ? [...value] : Object.entries(value));

export function _original_members(archive) {
  const members = new Set(list_asar_members(archive));
  const mains = [...members].filter((name) => _MAIN_PATH.test(name)).sort(compareCodePoints);
  const matches = [];
  for (const name of mains) {
    const source = new Map(entriesOf(read_asar_members(archive, [name]))).get(name);
    let host;
    try {
      host = _wre_source(source);
    } catch (exc) {
      if (exc instanceof ValueError && exc.message.endsWith('expected one named Wre host factory')) continue;
      throw exc;
    }
    matches.push([name, source, host]);
  }
  if (matches.length !== 1) _required_layout('expected one main bundle with a unique Wre host factory');
  const [name, main, host] = matches[0];
  const bound_imports = _host_imports(main, host);
  const imports = [];
  const names = [];
  for (const [alias, specifier] of bound_imports) {
    const member = _direct_member(name, specifier, members);
    if (member === null) {
      imports.push([alias, specifier]);
    } else {
      imports.push([alias, `./${member}`]);
      names.push(member);
    }
  }
  // Preserve the original host's small dependency families. Chunk hashes are
  // discovered from this app; no transitive module graph or package resolver
  // is inferred here.
  names.push(...[...members].filter((member) => _FAMILY.test(member)).sort(compareCodePoints));
  names.push('node_modules/tslib/package.json', 'node_modules/tslib/tslib.js');
  const missing = names.filter((member) => !members.has(member));
  if (missing.length) _required_layout(`original host dependency is missing: ${missing[0]}`);
  const contents = entriesOf(read_asar_members(archive, [...new Set(names)]));
  return [host, imports, contents];
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

const isSymlink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

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

/** Extract the unique structurally compatible Wre host and exact dependencies. */
export function materialize_original_host(app, destination) {
  const archive = path.join(app, 'app/resources/app.asar');
  if (isSymlink(archive) || !isFile(archive)) _required_layout('app/resources/app.asar is missing or redirected');
  const [fragment, imports, contents] = _original_members(archive);
  const template = pyfs(path.join(HERE, 'windows_host_entry.cjs'), () => readFileSync(path.join(HERE, 'windows_host_entry.cjs')));
  const imports_marker = Buffer.from('// ORIGINAL_WINDOWS_HOST_IMPORTS');
  const host_marker = Buffer.from('// ORIGINAL_WINDOWS_PIPE_HOST');
  if (countOf(template, imports_marker) !== 1 || countOf(template, host_marker) !== 1) {
    throw new ValueError('Windows host entry markers are missing or ambiguous.');
  }
  const import_source = Buffer.from(
    imports.map(([name, specifier]) => `const ${name} = require(${dumps(specifier)});`).join('\n'), 'utf8');
  const entry = replaceAll(replaceAll(template, imports_marker, import_source), host_marker, fragment);
  mkdirPython(destination, false);
  for (const [name, content] of contents) {
    const target = path.join(destination, name);
    mkdirPython(path.dirname(target), true);
    pyfs(target, () => writeFileSync(target, content));
  }
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
