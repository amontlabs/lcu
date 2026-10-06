// Reads JSON-lines cases on stdin, writes one JSON result line per case on stdout. Driven by test_pyjson.py.
//   {"kind": "dumps", "text": <JSON text>, "opts": {...}, "plain": bool}   loads(text) then dumps (or toPlain first)
//   {"kind": "loads", "text": <str>}                                        loads then dumps canonical options
//   {"kind": "loads_bytes", "hex": <hex>}                                   same with a Buffer
//   {"kind": "float", "bits": <hex of 8 bytes>}                             reprFloat
//   {"kind": "raw_dumps", "value": ...}                                     (unused placeholder)
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loads, dumps, dump, toPlain, reprFloat, equal, PyFloat } from '../../lcu/compat/pyjson.mjs';

const canonical = { indent: 1, sort_keys: false };

function describe(error) {
  return {
    err: error.name === 'TypeErrorPy' ? 'TypeError' : error.name, message: error.message,
    msg: error.msg ?? null, pos: error.pos ?? null, lineno: error.lineno ?? null, colno: error.colno ?? null,
  };
}

function run(c) {
  try {
    if (c.kind === 'dumps') {
      const value = c.plain ? toPlain(loads(c.text)) : loads(c.text);
      return { ok: dumps(value, c.opts ?? {}) };
    }
    if (c.kind === 'loads') return { ok: dumps(loads(c.text), canonical) };
    if (c.kind === 'loads_bytes') return { ok: dumps(loads(Buffer.from(c.hex, 'hex')), canonical) };
    if (c.kind === 'float') {
      const buffer = Buffer.from(c.bits, 'hex');
      return { ok: reprFloat(buffer.readDoubleBE(0)) };
    }
    if (c.kind === 'sortkeys') {
      // pairs: [[type, value, item]]; the dict keeps the typed keys (int -> BigInt, float -> PyFloat, ...)
      const key = ([t, v]) => (t === 'int' ? BigInt(v) : t === 'float' ? new PyFloat(Number(v)) : t === 'none' ? null : v);
      return { ok: dumps(new Map(c.pairs.map(([t, v, item]) => [key([t, v]), item])), c.opts ?? {}) };
    }
    if (c.kind === 'equal') return { ok: equal(loads(c.a), loads(c.b)) ? 'True' : 'False' };
    if (c.kind === 'self_equal') {
      const x = loads(c.text);
      const y = loads(c.text);
      return { ok: `${equal(x, x)}/${equal(x, y)}/${equal(x, x instanceof Map ? new Map(x) : x)}` };
    }
    if (c.kind === 'dump_stream') {
      let written = '';
      const result = dump(loads(c.text), { write: t => { written += t; } }, c.opts ?? {});
      return { ok: written, ret: result === undefined ? 'None' : 'other' };
    }
    if (c.kind === 'dump_fd') {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pyjson-')), 'out.json');
      const fd = fs.openSync(file, 'w');
      try { dump(loads(c.text), fd, c.opts ?? {}); } finally { fs.closeSync(fd); }
      return { ok: fs.readFileSync(file, 'utf8') };
    }
    return { err: 'bad kind', message: c.kind };
  } catch (error) {
    return describe(error);
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const out = [];
for await (const line of lines) if (line) out.push(JSON.stringify(run(JSON.parse(line))));
process.stdout.write(out.join('\n') + '\n');
