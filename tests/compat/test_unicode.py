"""lcu/compat/unicode.mjs against Python's str.casefold / len / ljust / ordering / PurePath.stem."""
import os
import pathlib
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from support import NodeTestCase, require_node, run_node

SAMPLES = ['', 'Zed', 'ZED', 'Straße', 'STRASSE', 'ﬃ', 'ΟΔΟΣ', 'ος', 'İstanbul', 'ǅ', '\U0001F600x', 'é',
           'Ａｂｃ', 'ᾳ', 'ẞ', 'ŉ', 'Ⅷ', 'ⓐ', 'Ꭰ', '\U00010400', '\U0001E900', 'Foo.app', '.app', 'x.', 'a.b.c']


class UnicodeTests(NodeTestCase):
    def test_casefold_matches_python_for_every_code_point(self):
        require_node()
        expected = {}
        for cp in range(0x110000):
            char = chr(cp)
            if char.casefold() != char:
                expected[cp] = char.casefold()
        got = run_node('''
            const { casefold } = await import(COMPAT + 'unicode.mjs');
            const changed = {};
            for (let cp = 0; cp <= 0x10ffff; cp++) {
              const ch = String.fromCodePoint(cp);
              const folded = casefold(ch);
              if (folded !== ch) changed[cp] = Array.from(folded, (c) => c.codePointAt(0));
            }
            emit(changed);''')
        self.assertEqual({int(k): ''.join(map(chr, v)) for k, v in got.items()}, expected)

    def test_helpers_match_python(self):
        require_node()
        cases = [[s, w] for s in SAMPLES for w in (0, 1, 5, 12)]
        got = run_node('''
            const { casefold, len, ljust, stem } = await import(COMPAT + 'unicode.mjs');
            emit(input.map(([s, w]) => [casefold(s), len(s), ljust(s, w), stem(s)]));''', cases)
        for (s, w), result in zip(cases, got):
            self.assertEqual(result, [s.casefold(), len(s), s.ljust(w), pathlib.PurePath(s).stem], (s, w))

    def test_code_point_order_differs_from_utf16_order(self):
        require_node()
        names = ['￿', '\U00010000', 'a', 'a\U00010000', 'a￿', '', 'Z', 'z']
        got = run_node('''
            const { compare } = await import(COMPAT + 'unicode.mjs');
            emit(input.slice().sort(compare));''', names)
        self.assertEqual(got, sorted(names))


if __name__ == '__main__':
    unittest.main()
