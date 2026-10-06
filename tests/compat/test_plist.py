"""lcu/compat/plist.mjs against CPython's plistlib.loads (XML plists; binary ones on macOS through plutil)."""
import base64
import datetime
import json
import os
import plistlib
import random
import shutil
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from support import NodeTestCase, run_node

DT = '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n' + DT + '\n'


def norm(value):
    if isinstance(value, bool):
        return ['b', value]
    if isinstance(value, str):
        return ['s', value]
    if isinstance(value, int):
        return ['i', str(value)]
    if isinstance(value, float):
        return ['f', 'nan' if value != value else repr(value)]
    if isinstance(value, bytes):
        return ['d', base64.b64encode(value).decode()]
    if isinstance(value, datetime.datetime):
        return ['t', value.strftime('%Y-%m-%dT%H:%M:%S')]
    if isinstance(value, list):
        return ['a', [norm(item) for item in value]]
    if isinstance(value, dict):
        return ['m', [[key, norm(item)] for key, item in value.items()]]
    if value is None:
        return ['n']
    return ['?', repr(value)]


def python_answer(data):
    try:
        return ['ok', norm(plistlib.loads(data))]
    except Exception as exc:  # noqa: BLE001 - differential oracle
        name = type(exc).__name__
        kind = str(exc).split(':')[0] if name == 'ExpatError' else str(exc)
        return ['err', name, kind]


NODE_CODE = r"""
const m = await import(COMPAT + 'plist.mjs');
const norm = (v) => {
  if (typeof v === 'boolean') return ['b', v];
  if (typeof v === 'string') return ['s', v];
  if (typeof v === 'bigint' || (typeof v === 'number' && Number.isInteger(v))) return ['i', String(v)];
  if (v && v.constructor && v.constructor.name === 'PyFloat') v = v.value;
  if (typeof v === 'number') return ['f', Number.isNaN(v) ? 'nan' : v === Infinity ? 'inf' : v === -Infinity ? '-inf' : pyfloat(v)];
  if (Buffer.isBuffer(v)) return ['d', v.toString('base64')];
  if (v instanceof Date) return ['t', v.toISOString().slice(0, 19)];
  if (Array.isArray(v)) return ['a', v.map(norm)];
  if (v instanceof Map) return ['m', [...v].map(([k, x]) => [k, norm(x)])];
  if (v === null) return ['n'];
  return ['?'];
};
const pyfloat = (x) => {
  let s = String(x);
  if (!/[.e]/.test(s)) s += '.0';
  const e = /^(-?[\d.]+)e([+-])(\d+)$/.exec(s);
  if (e) s = e[1] + 'e' + e[2] + e[3].padStart(2, '0');
  return s;
};
emit(input.map((hex) => {
  try { return ['ok', norm(m.loads(Buffer.from(hex, 'hex')))]; }
  catch (e) {
    if (e.name === 'ExpatError') return ['err', e.name, e.message.split(':')[0]];
    return ['err', e.name, e.message];
  }
}));
"""

FIXED = {
    'valid': HEAD + '<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.openai.codex</string>'
             '<key>CFBundleShortVersionString</key><string>26.1</string></dict></plist>\n',
    'dt-undef': f'<?xml version="1.0"?>{DT}<plist><string>a &foo; b</string></plist>',
    'dt-standalone-undef': f'<?xml version="1.0" standalone="yes"?>{DT}<plist><string>a &foo; b</string></plist>',
    'undef-no-dtd': '<plist><string>a &foo; b</string></plist>',
    'internal-entity': '<?xml version="1.0"?><!DOCTYPE plist [<!ENTITY x "y">]><plist><string>&x;</string></plist>',
    'internal-element': '<?xml version="1.0"?><!DOCTYPE plist [<!ELEMENT plist ANY>]><plist><string>a</string></plist>',
    'cr': '<plist><string>a\r\nb\rc</string></plist>',
    'two-objects': '<plist><string>a</string><string>b</string></plist>',
    'missing-value': '<plist><dict><key>k</key></dict></plist>',
    'root-string': '<string>a</string>',
    'unknown-el': '<plist><foo><string>a</string></foo></plist>',
    'comment-dd': '<plist><!-- a -- b --><string>a</string></plist>',
    'cdata': '<plist><string><![CDATA[<x>&]]></string></plist>',
    'gt-in-text': '<plist><string>a]]>b</string></plist>',
    'attr-dup': '<plist version="1" version="2"><string>a</string></plist>',
    'attr-lt': '<plist version="<"><string>a</string></plist>',
    'charref-bad': '<plist><string>&#1;</string></plist>',
    'charref-ok': '<plist><string>&#x41;&#66;&#x1F600;</string></plist>',
    'pi-after': '<plist><string>a</string></plist><?x y?><!-- c -->  ',
    'xmldecl-late': ' <?xml version="1.0"?><plist><string>a</string></plist>',
    'int-hex': '<plist><integer>0x1F</integer></plist>',
    'int-neg-hex': '<plist><integer>-0x1</integer></plist>',
    'int-ws': '<plist><integer> 12 </integer></plist>',
    'int-big': '<plist><integer>123456789012345678901234567890</integer></plist>',
    'int-bad': '<plist><integer>1.5</integer></plist>',
    'real': '<plist><array><real>inf</real><real>1.5</real><real>-2</real><real>1e5</real></array></plist>',
    'real-bad': '<plist><real>abc</real></plist>',
    'date': '<plist><date>2020-01-02T03:04:05Z</date></plist>',
    'date-short': '<plist><date>2020Z</date></plist>',
    'data': '<plist><data>YWI=</data></plist>',
    'key-root': '<plist><key>a</key></plist>',
    'empty-el': '<plist><string/></plist>',
    'key-in-array': '<plist><array><key>a</key></array></plist>',
    'element-in-dict': '<plist><dict><string>a</string></dict></plist>',
    'empty-key': '<plist><dict><key></key><key>b</key><string>x</string></dict></plist>',
    'repeated-key': '<plist><dict><key>a</key><string>1</string><key>b</key><true/><key>a</key><false/></dict></plist>',
    'colon-name': '<plist><a:b/><string>x</string></plist>',
    'bad-name': '<plist><1a/></plist>',
    'unclosed-comment': '<plist><!-- a <string>x</string></plist>',
    'multiple-roots': HEAD + '<plist><dict><key>CFBundleIdentifier</key><string>com.openai.codex</string></dict></plist><junk/>',
    'unknown-entity': '<?xml version="1.0" encoding="UTF-8"?><plist><dict><key>CFBundleIdentifier</key>'
                      '<string>com.openai.codex &unknown;</string></dict></plist>',
    'invalid-control': '<plist><dict><key>CFBundleDisplayName</key><string>Display\x01</string></dict></plist>',
    'malformed': '<plist><dict>',
    'mismatched': '<plist><string>a</strin></plist>',
    'empty-plist': '<plist></plist>',
    'whitespace-only': '<plist>   </plist>',
    'nested': '<plist><dict><key>a</key><array><dict><key>b</key><integer>1</integer></dict><string>x</string></array></dict></plist>',
    'text-around': '<plist>xx<string>a</string>yy</plist>',
    'pi-xml-late': '<plist><?xml version="1.0"?><string>a</string></plist>',
    'decl-bad': '<?xml version="2"?><plist><string>a</string></plist>',
    'decl-single-quote': "<?xml version='1.0' encoding='utf-8'?><plist><string>a</string></plist>",
    'attr-entity': '<plist version="&amp;&#65;"><string>a</string></plist>',
    'attr-undef': '<plist version="&nope;"><string>a</string></plist>',
    'astral': '<plist><string>\U0001F600 é 中</string></plist>',
    'ufffe': '<plist><string>￾</string></plist>',
    'doctype-system': '<!DOCTYPE plist SYSTEM "x.dtd"><plist><string>&x;</string></plist>',
    'doctype-pe': '<!DOCTYPE plist [ %pe; ]><plist><string>&x;</string></plist>',
    'eof-in-tag': '<plist><string',
    'data-padding': '<plist><array><data>YI=</data></array></plist>',
    'data-one-more': '<plist><data>YWJjZ</data></plist>',
    'data-junk': '<plist><data>Y W\nI=*</data></plist>',
    'data-early-pad': '<plist><data>YQ==YWI=</data></plist>',
    'pubid-bad': '<!DOCTYPE plist PUBLIC "a<b" "x"><plist><string>a</string></plist>',
    'pubid-nospace': '<!DOCTYPE plist PUBLIC "a""x"><plist><string>a</string></plist>',
    'entity-malformed': '<!DOCTYPE plist [<!ENTITY x"y">]><plist><string>a</string></plist>',
    'pe-entity': '<!DOCTYPE plist [<!ENTITY % x "y">]><plist><string>a</string></plist>',
}


def encodings():
    text = '<plist><dict><key>CFBundleDisplayName</key><string>Café € ü</string></dict></plist>'
    cases = {
        'utf16le-bom': b'\xff\xfe' + ('<?xml version="1.0" encoding="UTF-16"?>' + text).encode('utf-16-le'),
        'utf16be-bom': b'\xfe\xff' + ('<?xml version="1.0" encoding="UTF-16"?>' + text).encode('utf-16-be'),
        'utf16le-bom-nodecl': b'\xff\xfe' + text.encode('utf-16-le'),
        'utf8-bom': b'\xef\xbb\xbf' + text.encode(),
        'latin1': ('<?xml version="1.0" encoding="ISO-8859-1"?>' + text.replace('€', '')).encode('latin-1'),
        'cp1252': ('<?xml version="1.0" encoding="windows-1252"?>' + text).encode('cp1252'),
        'ascii-ok': ('<?xml version="1.0" encoding="us-ascii"?><plist><string>a</string></plist>').encode(),
        'ascii-bad': ('<?xml version="1.0" encoding="us-ascii"?>' + text).encode('utf-8'),
        'bogus': ('<?xml version="1.0" encoding="bogus"?>' + text).encode(),
        'bad-utf8': ('<plist><string>a').encode() + b'\xff' + b'</string></plist>',
        'not-plist': b'hello',
        'empty': b'',
    }
    return cases


def mutate(rng, text):
    chars = list(text)
    for _ in range(rng.randint(1, 3)):
        spot = rng.randint(0, len(chars))
        action = rng.randint(0, 2)
        piece = rng.choice(['<', '>', '/', '&', ';', '"', '!', '-', '?', ']', '[', 'a', ' ', '\x01', '&amp;', '&x;',
                            '<!-- -->', '<![CDATA[x]]>', '<key>k</key>', '</dict>', '<dict>', '<string>', '</string>',
                            '<array/>', '<true/>', '<integer>3</integer>', '\r', '\n', '#'])
        if action == 0:
            chars[spot:spot] = list(piece)
        elif action == 1 and chars:
            del chars[min(spot, len(chars) - 1)]
        elif chars:
            chars[min(spot, len(chars) - 1)] = piece
    return ''.join(chars)


class PlistTests(NodeTestCase):
    def compare(self, payloads):
        got = run_node(NODE_CODE, [payload.hex() for payload in payloads])
        mismatches = []
        for payload, have in zip(payloads, got):
            want = python_answer(payload)
            if have != want:
                mismatches.append((payload[:200], want, have))
        return mismatches

    def test_fixed_documents(self):
        payloads = [text.encode('utf-8') for text in FIXED.values()]
        self.assertEqual(self.compare(payloads), [])

    def test_encodings(self):
        self.assertEqual(self.compare(list(encodings().values())), [])

    def test_python_generated_plists(self):
        rng = random.Random(5)
        values = []
        for _ in range(200):
            values.append({
                'CFBundleIdentifier': rng.choice(['com.openai.codex', 'a&b<c>"\'', 'é中\U0001F600', '', ' x ']),
                'n': rng.randint(-2**63, 2**63 - 1), 'f': rng.choice([0.5, -1e300, 3.0, 1e-7]),
                'b': rng.random() < 0.5, 'd': bytes(rng.randrange(256) for _ in range(rng.randint(0, 9))),
                'when': datetime.datetime(2001, 2, 3, 4, 5, 6), 'list': [1, 'two', [True], {'k': 'v'}],
            })
        self.assertEqual(self.compare([plistlib.dumps(value) for value in values]), [])

    def test_mutated_documents_agree_on_outcome(self):
        rng = random.Random(77)
        seeds = list(FIXED.values())
        payloads = [mutate(rng, rng.choice(seeds)).encode('utf-8', 'surrogatepass') for _ in range(4000)]
        mismatches = self.compare(payloads)
        # outcome class must always agree; only expat's wording for the same failure may differ
        hard = [m for m in mismatches if m[1][0] != m[2][0] or m[1][1] != m[2][1]]
        self.assertEqual(hard[:10], [])
        # what is left differs only in which expat message names the same failure (both are ExpatError)
        for _, want, have in mismatches:
            self.assertEqual((want[0], want[1], have[0], have[1]), ('err', 'ExpatError', 'err', 'ExpatError'))

    @unittest.skipUnless(sys.platform == 'darwin' and shutil.which('plutil'), 'binary plists need plutil')
    def test_binary_plists(self):
        values = [{'CFBundleIdentifier': 'com.openai.codex', 'CFBundleShortVersionString': '26.1', 'n': 5}, ['a', 1.5]]
        self.assertEqual(self.compare([plistlib.dumps(v, fmt=plistlib.FMT_BINARY) for v in values]), [])


if __name__ == '__main__':
    unittest.main()
