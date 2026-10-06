// Small bounded reader for selected Electron ASAR members.
// Port of lcu/asar.py. The ASAR header JSON is read with compat/pyjson (dict -> Map, int -> BigInt,
// float -> PyFloat) so every isinstance() check of the Python keeps its meaning.
// read_asar_members returns a null-prototype object {name: Buffer} (Python: dict[str, bytes]).
import { closeSync, openSync, readSync, statSync } from 'node:fs';

import { isInt, JSONDecodeError, loads, UnicodeDecodeError, ValueError, compareCodePoints, PyFloat } from './compat/pyjson.mjs';
import { pyfs } from './compat/errors.mjs';
import { pathStr } from './compat/pathlib.mjs';
import { pyInt, PyValueError as ArgparseValueError } from './compat/argparse.mjs';
import { reprStr } from './compat/pyerr.mjs';

export const MAX_HEADER_SIZE = 64 * 1024 * 1024;
export const MAX_MEMBER_SIZE = 64 * 1024 * 1024;

const isDict = (value) => value instanceof Map;

// stream.read(n): fewer bytes only at end of file.
function readExactly(fd, length, position) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(fd, buffer, offset, length - offset, position + offset);
    if (count === 0) break;
    offset += count;
  }
  return buffer.subarray(0, offset);
}

function _read_header(archive) {
  archive = pathStr(archive);
  const size = pyfs(archive, () => statSync(archive).size);
  const fd = pyfs(archive, () => openSync(archive, 'r'));
  let encoded;
  let data_offset;
  try {
    const preamble = readExactly(fd, 16, 0);
    if (preamble.length !== 16) throw new ValueError('ASAR header is truncated.');
    const size_payload = preamble.readUInt32LE(0);
    const header_size = preamble.readUInt32LE(4);
    const header_payload = preamble.readUInt32LE(8);
    const json_size = preamble.readUInt32LE(12);
    data_offset = 8 + header_size;
    if (size_payload !== 4 || header_size < 8 || header_payload !== header_size - 4 ||
        json_size > header_payload - 4 || json_size > MAX_HEADER_SIZE ||
        data_offset > size) {
      throw new ValueError('ASAR header is invalid.');
    }
    encoded = readExactly(fd, json_size, 16);
    if (encoded.length !== json_size) throw new ValueError('ASAR header JSON is truncated.');
  } finally {
    closeSync(fd);
  }
  let header;
  try {
    header = loads(encoded);
  } catch (exc) {
    if (exc instanceof UnicodeDecodeError || exc instanceof JSONDecodeError) {
      throw new ValueError('ASAR header JSON is invalid.');
    }
    throw exc;
  }
  if (!isDict(header) || !isDict(header.get('files'))) {
    throw new ValueError('ASAR header has no file tree.');
  }
  return [archive, header, data_offset, size];
}

const reprName = (name) => (typeof name === 'string' ? reprStr(name) : String(name));

// PurePosixPath(name).parts for a name that does not start with '/': empty and '.' components vanish.
function _valid_path(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\x00') ||
      name.startsWith('/')) {
    throw new ValueError(`Invalid ASAR member path: ${reprName(name)}`);
  }
  const parts = name.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..')) {
    throw new ValueError(`Invalid ASAR member path: ${reprName(name)}`);
  }
  return parts;
}

function _member_node(header, name) {
  let node = header;
  for (const part of _valid_path(name)) {
    // node['files'][part]: KeyError and TypeError both mean "missing".
    const files = isDict(node) ? node.get('files') : undefined;
    const next = isDict(files) ? files.get(part) : undefined;
    if (next === undefined) throw new ValueError(`ASAR member is missing: ${name}`);
    node = next;
  }
  if (!isDict(node)) throw new ValueError(`ASAR member entry is invalid: ${name}`);
  return node;
}

/** List member paths from the bounded ASAR header without reading payloads. */
export function list_asar_members(archive) {
  const [, header] = _read_header(archive);
  const result = [];

  const visit = (directory, prefix = '') => {
    const entries = directory.get('files');
    if (!isDict(entries)) throw new ValueError('ASAR directory entry is invalid.');
    for (const [name, node] of entries) {
      if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\') ||
          name === '.' || name === '..' || name.includes('\x00') || !isDict(node)) {
        throw new ValueError('ASAR member path is invalid.');
      }
      const relative = prefix ? `${prefix}/${name}` : name;
      if (isDict(node.get('files'))) visit(node, relative);
      else result.push(relative);
    }
  };

  visit(header);
  return result.sort(compareCodePoints);
}

// Python truthiness of a parsed JSON value.
function truthy(value) {
  if (value === null || value === undefined || value === false || value === '' || value === 0n || value === 0) return false;
  if (value instanceof PyFloat) return value.value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Map) return value.size > 0;
  return true;
}

/** Read named regular packed members after validating their bounds. */
export function read_asar_members(archive, names) {
  const [path, header, data_offset, archive_size] = _read_header(archive);
  const result = Object.create(null);
  const fd = pyfs(path, () => openSync(path, 'r'));
  try {
    for (const name of names) {
      const node = _member_node(header, name);
      let offset = node.get('offset');
      const size = node.get('size');
      if (typeof offset === 'string') {
        try {
          offset = pyInt(offset);
        } catch (exc) {
          if (exc instanceof ArgparseValueError) throw new ValueError(`ASAR member offset is invalid: ${name}`);
          throw exc;
        }
      }
      if (truthy(node.get('unpacked')) || node.has('link') ||
          !isInt(offset) || BigInt(offset) < 0n ||
          !isInt(size) || BigInt(size) < 0n ||
          BigInt(size) > BigInt(MAX_MEMBER_SIZE) ||
          BigInt(data_offset) + BigInt(offset) + BigInt(size) > BigInt(archive_size)) {
        throw new ValueError(`ASAR member is invalid or out of bounds: ${name}`);
      }
      const content = readExactly(fd, Number(size), data_offset + Number(offset));
      if (content.length !== Number(size)) throw new ValueError(`ASAR member is truncated: ${name}`);
      result[name] = content;
    }
  } finally {
    closeSync(fd);
  }
  return result;
}
