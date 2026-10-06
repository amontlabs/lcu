"""R07 (round-2): compat/pynum.mjs and argparse's type=int against CPython's int()/float()."""
import json
import random
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import support as S  # noqa: E402

ALPHABET = ['0', '1', '9', '7', '_', '_', '+', '-', ' ', '\t', '\n', '\x0b', '\x0c', '\r', '\x1c', '\x1d', '\x1e', '\x1f',
            '\x85', '\xa0', ' ', '　', '٣', '٠', '𝟚', '१', 'e', 'E', '.', 'x', 'a', 'f', 'inf', 'nan', 'Infinity']


def py_int(text):
    try:
        return str(int(text))
    except ValueError as exc:
        return 'limit' if 'Exceeds the limit' in str(exc) else 'invalid'


def py_float(text):
    try:
        return repr(float(text))
    except ValueError:
        return 'invalid'


def py_hex(text):
    try:
        return format(int(text.encode('latin-1'), 16), 'x')
    except ValueError:
        return 'invalid'


class PyNum(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if S.NODE is None:
            raise unittest.SkipTest('node is not installed')

    def cases(self):
        rng = random.Random(7)
        texts = ['9' * 4300, '9' * 4301, '-' + '9' * 4300, '-' + '9' * 4301, '1_' * 2149 + '1', '1' * 4300 + ' ', ' ' + '1' * 4301,
                 '٣' * 4300, '٣' * 4301, '\x1c5', '5\x1f', '\x1d', '\x1e7', ' \x1c5', '5_5', '_5', '5_', '5__5', '+_5', '', ' ', '+', '-0']
        for _ in range(3000):
            texts.append(''.join(rng.choice(ALPHABET) for _ in range(rng.randint(0, 8))))
        return texts

    def test_int_float_and_hex_match_cpython(self):
        texts = self.cases()
        got = S.run_node("""
const num = await import(COMPAT + 'pynum.mjs');
const args = await import(COMPAT + 'argparse.mjs');
emit(input.map((t) => {
  const i = num.pyInt(t);
  let a;
  try { a = String(args.pyInt(t)); } catch (e) { a = /Exceeds the limit/.test(e.message) ? 'limit' : 'invalid'; }
  const f = num.pyFloat(t);
  const h = /^[\\x00-\\xff]*$/.test(t) ? num.pyInt(t, 16) : null;
  return [i === null ? (num.decimalInt(t).error ?? 'invalid') : String(i), a,
    f === null ? 'invalid' : Number.isNaN(f) ? 'nan' : String(f), h === null ? 'invalid' : h.toString(16)];
}));""", texts, timeout=120)
        bad = []
        for text, (node_int, node_arg, node_float, node_hex) in zip(texts, got):
            expected_int = py_int(text)
            if node_int != expected_int or node_arg != expected_int:
                bad.append(('int', text[:20], len(text), expected_int[:30], node_int[:30], node_arg[:30]))
            expected_float = py_float(text)
            comparable = expected_float if expected_float not in ('nan', '-nan') else 'nan'
            if expected_float == 'nan' or expected_float == '-nan':
                comparable = 'nan'
            expected_float = {'inf': 'Infinity', '-inf': '-Infinity'}.get(expected_float, expected_float)
            if comparable == 'nan':
                expected_float = 'nan'
            try:
                same = node_float == expected_float or (node_float != 'invalid' and expected_float != 'invalid'
                                                       and float(node_float.replace('Infinity', 'inf')) == float(expected_float.replace('Infinity', 'inf')))
            except ValueError:
                same = False
            if not same:
                bad.append(('float', text[:20], expected_float, node_float))
            if all(ord(c) < 256 for c in text):
                if node_hex != py_hex(text):
                    bad.append(('hex', text[:20], py_hex(text), node_hex))
        self.assertEqual(bad[:10], [])

    def test_pax_size_with_4301_digits_is_ignored_like_cpython(self):
        # tarfile catches int()'s ValueError for PAX number fields and uses 0 (the member stays a one-byte file)
        self.assertEqual(py_int('9' * 4301), 'limit')
        got = S.run_node("const m = await import(COMPAT + 'pynum.mjs'); emit([m.pyInt('9'.repeat(4301)), String(m.pyInt('9'.repeat(4300)).toString().length)]);")
        self.assertEqual(got, [None, '4300'])


if __name__ == '__main__':
    unittest.main()
