"""Differential test: lcu/compat/pycodecs.mjs and lcu/compat/pyctype.mjs against this CPython 3.12."""
import codecs
import encodings.aliases
import json
import random
import re
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import compat_support as S  # noqa: E402

SCRIPT = r"""
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const root = process.argv[1];
const pycodecs = await import(pathToFileURL(`${root}/lcu/compat/pycodecs.mjs`).href);
const pyctype = await import(pathToFileURL(`${root}/lcu/compat/pyctype.mjs`).href);
const input = JSON.parse(readFileSync(0, 'utf8'));
const out = { handler: {}, decode: [], ctype: {} };
for (const name of input.names) {
  try {
    const result = pycodecs.pyexpat_unknown_encoding(name);
    out.handler[name] = Array.isArray(result) ? 'map:' + result.join(',') : result;
  } catch (error) { out.handler[name] = `${error.name}:${error.message}`; }
}
for (const [hex, name] of input.decode) {
  try { out.decode.push('OK:' + pycodecs.decode_strict(Buffer.from(hex, 'hex'), name)); }
  catch (error) { out.decode.push(`${error.name}:${error.message}`); }
}
const classes = {
  DECIMAL: new RegExp(`^[${pyctype.PY_DECIMAL}]$`, 'u'), WORD: new RegExp(`^[${pyctype.PY_WORD}]$`, 'u'),
  ALPHA: new RegExp(`^[${pyctype.PY_ALPHA}]$`, 'u'), SPACE: new RegExp(`^[${pyctype.PY_SPACE}]$`, 'u'),
};
for (const [name, re] of Object.entries(classes)) {
  out.ctype[name] = input.points.filter((cp) => re.test(String.fromCodePoint(cp)));
}
process.stdout.write(JSON.stringify(out));
"""


def handler(name):
    """What pyexpat's unknown-encoding handler does for `name` (see gen_pycodecs_tables.py)."""
    try:
        info = codecs.lookup(name)
        if not info._is_text_encoding:
            return f"LookupError:'{name}' is not a text encoding; use codecs.decode() to handle arbitrary codecs"
        text = bytes(range(256)).decode(name, 'replace')
    except LookupError:
        return f'LookupError:unknown encoding: {name}'
    except Exception as exc:  # noqa: BLE001
        return f'{type(exc).__name__}:{exc}'
    if len(text) != 256:
        return 'ValueError:multi-byte encodings are not supported'
    import io
    import xml.etree.ElementTree as ET
    try:
        ET.parse(io.BytesIO(f'<?xml version="1.0" encoding="{name}"?><a/>'.encode('ascii')))
    except ET.ParseError:
        return 'expat-refused'
    return 'map:' + ','.join('-1' if c == '�' else str(ord(c)) for c in text)


class PyCodecsPyCtypeTests(unittest.TestCase):
    def setUp(self):
        if not S.NODE:
            self.skipTest('node is not installed')
        if sys.version_info[:2] != (3, 12):
            self.skipTest('tables are frozen from CPython 3.12')

    def test_codecs_and_ctype(self):
        rng = random.Random(7)
        names = sorted(set(encodings.aliases.aliases) | set(encodings.aliases.aliases.values()) |
                       {'never-an-encoding', 'CP1252', 'Latin-1', 'utf--8', 'UTF8', 'x.y', 'cp-1252', 'mbcs'})
        # Only names an XML declaration can carry (EncName) reach pyexpat's handler.
        names = [n for n in names if re.fullmatch(r'[A-Za-z][A-Za-z0-9._-]*', n)]
        decode = []
        for name in ['utf-8', 'cp1252', 'cp1250', 'cp874', 'ascii', 'latin-1', 'koi8_r', 'mac_roman', 'cp65001']:
            for _ in range(40):
                data = bytes(rng.randrange(256) for _ in range(rng.randrange(1, 12)))
                decode.append([data.hex(), name])
        points = sorted({rng.randrange(0x110000) for _ in range(20000)} | set(range(0, 0x3000)) |
                        {0x10D40, 0x105C0, 0x1C89, 0x16130, 0x2028, 0x85, 0x1C, 0xFEFF})
        points = [p for p in points if not 0xD800 <= p <= 0xDFFF]
        done = subprocess.run([S.NODE, '--input-type=module', '-e', SCRIPT, str(S.ROOT)],
                              input=json.dumps({'names': names, 'decode': decode, 'points': points}),
                              capture_output=True, text=True, timeout=300)
        self.assertEqual(done.returncode, 0, done.stderr)
        out = json.loads(done.stdout)
        for name in names:
            self.assertEqual(out['handler'][name], handler(name), name)
        for (hex_data, name), got in zip(decode, out['decode']):
            try:
                want = 'OK:' + bytes.fromhex(hex_data).decode(name)
            except UnicodeDecodeError as exc:
                want = f'UnicodeDecodeError:{exc}'
            self.assertEqual(got, want, (hex_data, name))
        predicates = {'DECIMAL': re.compile(r'\d'), 'WORD': re.compile(r'\w'), 'SPACE': re.compile(r'\s')}
        for key, pattern in predicates.items():
            self.assertEqual(out['ctype'][key], [p for p in points if pattern.match(chr(p))], key)
        self.assertEqual(out['ctype']['ALPHA'], [p for p in points if chr(p).isalpha()])


if __name__ == '__main__':
    unittest.main()
