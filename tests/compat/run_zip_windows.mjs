// Windows ZIP extraction on a virtual Windows filesystem: node run_zip_windows.mjs <spec.json>
// spec: [{id, archive, dest, dirs}]. Every fs operation of the extraction is virtual (nothing touches the disk); the
// archive is read before fs is patched. Output per id: {ok, name?, message?, calls, files: {key: sha256}, dirs}.
// This is fixture evidence only: no live Windows claim.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ZipArchive } from '../../lcu/compat/zip.mjs';

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const key = (p) => p.replaceAll('/', '\\').toLowerCase().replace(/\\+$/, '');
const fail = (code, p) => Object.assign(new Error(`${code}: ${p}`), { code, path: p, syscall: 'fixture' });
const original = Object.fromEntries(['statSync', 'mkdirSync', 'openSync', 'writeSync', 'closeSync'].map((k) => [k, fs[k]]));
const out = {};

for (const s of spec) {
  const data = fs.readFileSync(s.archive);
  const dirs = new Set(s.dirs.map(key));
  const files = new Map();
  const handles = new Map();
  const calls = [];
  fs.statSync = (p) => {
    if (dirs.has(key(p))) return { isDirectory: () => true };
    if (files.has(key(p))) return { isDirectory: () => false };
    throw fail('ENOENT', p);
  };
  fs.mkdirSync = (p) => {
    calls.push(['mkdir', p]);
    if (dirs.has(key(p)) || files.has(key(p))) throw fail('EEXIST', p);
    if (!dirs.has(key(path.win32.dirname(p)))) throw fail('ENOENT', p);
    dirs.add(key(p));
  };
  fs.openSync = (p) => {
    calls.push(['open', p]);
    if (!dirs.has(key(path.win32.dirname(p)))) throw fail('ENOENT', p);
    if (dirs.has(key(p))) throw fail('EACCES', p);
    files.set(key(p), []);
    handles.set(handles.size + 100, key(p));
    return handles.size + 99;
  };
  fs.writeSync = (fd, buf, offset = 0, length = buf.length - offset) => {
    files.get(handles.get(fd)).push(Buffer.from(buf.subarray(offset, offset + length)));
    return length;
  };
  fs.closeSync = () => {};
  let result;
  try {
    new ZipArchive(data, { platform: 'win32' }).extractall(s.dest);
    result = { ok: true };
  } catch (err) {
    result = { ok: false, name: err.name, message: String(err.message) };
  }
  Object.assign(fs, original);
  result.calls = calls;
  result.files = Object.fromEntries([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, parts]) => [k, crypto.createHash('sha256').update(Buffer.concat(parts)).digest('hex')]));
  result.dirs = [...dirs].sort();
  out[s.id] = result;
}
process.stdout.write(JSON.stringify(out));
