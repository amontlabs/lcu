"""R09 (round-2): XML declarations of any length in plist.loads, against plistlib."""
import base64
import json
import plistlib
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import support as S  # noqa: E402

BODY = '<plist><string>x</string></plist>'


def cases():
    out = {}
    for pad in (0, 4000, 4094, 4096, 4097, 5000, 70000):
        out[f'utf8-space-{pad}'] = ('<?xml version="1.0"' + ' ' * pad + '?>' + BODY).encode()
        out[f'utf8-encoding-{pad}'] = ('<?xml version="1.0"' + ' ' * pad + ' encoding="UTF-8"?>' + BODY).encode()
        out[f'latin1-{pad}'] = ('<?xml version="1.0"' + ' ' * pad + ' encoding="iso-8859-1"?>' + BODY).encode()
        out[f'utf16-{pad}'] = ('<?xml version="1.0"' + ' ' * pad + '?>' + BODY).encode('utf-16')
        out[f'unclosed-{pad}'] = ('<?xml version="1.0"' + ' ' * pad + BODY).encode()
        out[f'bad-{pad}'] = ('<?xml version="1.0" bogus' + ' ' * pad + '?>' + BODY).encode()
    return out


def outcome(data):
    try:
        return ['ok', plistlib.loads(data)]
    except Exception as e:  # noqa: BLE001
        return ['error', type(e).__name__]


class LongDeclaration(unittest.TestCase):
    def test_declarations_of_any_length_match_plistlib(self):
        if S.NODE is None:
            self.skipTest('node is not installed')
        data = cases()
        got = S.run_node("""
const { loads } = await import(COMPAT + 'plist.mjs');
const out = {};
for (const [id, b64] of Object.entries(input)) {
  try { out[id] = ['ok', loads(Buffer.from(b64, 'base64'))]; } catch (e) { out[id] = ['error', e.name]; }
}
emit(out);""", {k: base64.b64encode(v).decode() for k, v in data.items()})
        diffs = {k: (outcome(v), got[k]) for k, v in data.items() if outcome(v) != got[k]}
        self.assertEqual(diffs, {})


if __name__ == '__main__':
    unittest.main()
