"""R03/R04 (round-2): Expat's amplification accounting and deep DTD recursion, against CPython's ElementTree.

CPython 3.12's bundled Expat counts input bytes of the document (direct) and the UTF-8 bytes of expanded entity text
(indirect); documents over 8 MiB total whose ratio exceeds 100 are rejected. The oracle here is the Python running this
test (3.12.10 for the project; other patch levels bundle other Expat versions and are skipped).
"""
import base64
import json
import random
import subprocess
import sys
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import compat_support as S  # noqa: E402

RUNNER = S.ROOT / 'tests/compat/run_xml_limits.mjs'
ORACLE_OK = sys.version_info[:3] == (3, 12, 10)


def python_result(data):
    try:
        ET.fromstring(data)
        return 'OK'
    except ET.ParseError as e:
        return 'amplification' if 'amplification' in str(e) else 'ParseError'
    except RecursionError:
        return 'RecursionError'


def node_results(cases):
    payload = json.dumps([{'id': i, 'b64': base64.b64encode(d).decode()} for i, d in cases.items()])
    done = subprocess.run([S.NODE, str(RUNNER)], input=payload, capture_output=True, text=True, timeout=600)
    assert done.returncode == 0, done.stderr
    raw = json.loads(done.stdout)
    return {i: ('OK' if v == 'OK' else 'amplification' if 'amplification' in v else 'RangeError' if 'RangeError' in v else 'ParseError')
            for i, v in raw.items()}


def declarations(char, last, width=1000, fanout=10):
    return '<!ENTITY e0 "' + char * width + '">' + ''.join(
        '<!ENTITY e%d "%s">' % (i, ('&e%d;' % (i - 1)) * fanout) for i in range(1, last + 1))


def encode(text, encoding):
    if encoding == 'utf-8':
        return text.encode('utf-8')
    if encoding == 'utf-16':
        return text.encode('utf-16')  # BOM + native order
    if encoding == 'latin-1':
        return text.replace('<a>', '<?xml version="1.0" encoding="iso-8859-1"?><a>', 1).encode('latin-1', 'replace')
    raise ValueError(encoding)


@unittest.skipUnless(ORACLE_OK and S.NODE, 'needs CPython 3.12.10 (Expat 2.7.1) and node')
class AmplificationAndDepth(unittest.TestCase):
    def check(self, cases):
        expected = {i: python_result(d) for i, d in cases.items()}
        actual = node_results(cases)
        diffs = {i: (expected[i], actual[i]) for i in cases if expected[i] != actual[i]}
        self.assertEqual(diffs, {}, 'differences (python, node)')
        return expected

    def test_review_cases(self):
        cases = {
            'utf8-amplification': ('<!DOCTYPE a [' + declarations('漢', 3) + ']><a>' + '&e3;' * 5 + '</a>').encode(),
            'padded-amplification': ('<!DOCTYPE a [' + declarations('x', 4) + ']><!--' + 'p' * 200000 + '--><a>&e4;</a>').encode(),
        }
        expected = self.check(cases)
        self.assertEqual(expected['utf8-amplification'], 'amplification')
        self.assertEqual(expected['padded-amplification'], 'OK')

    def test_deep_dtd_recursion_is_accepted(self):
        d = '<!ENTITY e0 "x">' + ''.join('<!ENTITY e%d "&e%d;">' % (i, i - 1) for i in range(1, 10001))
        cases = {
            'deep-entity-content': ('<!DOCTYPE a [' + d + ']><a>&e10000;</a>').encode(),
            'deep-entity-attribute': ('<!DOCTYPE a [' + d + ']><Identity Name="&e10000;"/>').encode(),
            'deep-content-model': ('<!DOCTYPE a [<!ELEMENT a ' + '(' * 15000 + 'b' + ')' * 15000 + '>]><a/>').encode(),
            'unbalanced-content-model': ('<!DOCTYPE a [<!ELEMENT a ' + '(' * 15000 + 'b' + ')' * 14999 + '>]><a/>').encode(),
            'mixed-separators-deep': ('<!DOCTYPE a [<!ELEMENT a ' + '(b,' * 5000 + 'c' + ')' * 5000 + '>]><a/>').encode(),
        }
        expected = self.check(cases)
        for key in ('deep-entity-content', 'deep-entity-attribute', 'deep-content-model'):
            self.assertEqual(expected[key], 'OK', key)
        self.assertEqual(expected['unbalanced-content-model'], 'ParseError')

    def test_fuzz_around_the_threshold(self):
        rng = random.Random(20261006)
        cases = {}
        for n in range(400):
            char = rng.choice(['x', 'é', '漢', '😀'])
            width = rng.choice([1, 10, 100, 1000, 5000])
            levels = rng.randint(1, 4)
            fanout = rng.randint(2, 12)
            refs = rng.randint(1, 8)
            pad = rng.choice([0, 0, 1000, 50000, 300000])
            where = rng.choice(['content', 'attribute'])
            encoding = rng.choice(['utf-8', 'utf-8', 'utf-16', 'latin-1'])
            if encoding == 'latin-1':
                char = rng.choice(['x', 'é'])
            reference = '&e%d;' % levels
            dtd = '<!DOCTYPE a [' + declarations(char, levels, width, fanout) + ']>'
            comment = '<!--' + 'p' * pad + '-->' if pad else ''
            if where == 'content':
                body = '<a>' + reference * refs + '</a>'
            else:
                body = '<a ' + ' '.join('x%d="%s"' % (k, reference) for k in range(refs)) + '/>'
            cases[f'fuzz{n}'] = encode(dtd + comment + body, encoding)
        expected = self.check(cases)
        self.assertGreater(sum(v == 'amplification' for v in expected.values()), 20)
        self.assertGreater(sum(v == 'OK' for v in expected.values()), 20)


if __name__ == '__main__':
    unittest.main()
