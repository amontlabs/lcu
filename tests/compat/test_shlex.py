"""lcu/compat/shlex.mjs against Python's shlex and subprocess.list2cmdline."""
import random
import shlex
import subprocess
import unittest

import os as _os
import sys as _sys

_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from support import NodeTestCase, py_cases, run_node

ALPHABET = ["a", "b", "Z", "0", " ", " ", "\t", "\n", "\r", "'", '"', "\\", "\\", "$", "é", "ß", "中", "\U0001f600",
            "#", ";", "|", "&", "=", "/", "-", ".", "\v", "\f", "\x00", "~", "*", "\u00a0", "\u2028"]


def fuzz(seed, count, max_len=14):
    rng = random.Random(seed)
    return [''.join(rng.choice(ALPHABET) for _ in range(rng.randint(0, max_len))) for _ in range(count)]


FIXED = ['', ' ', 'a b c', "a 'b c' d", 'a "b c" d', "a\\ b", '"a\\"b"', '"a\\b"', '"a\\\\b"', "'a\\b'", 'a\\', '"abc',
         "'abc", "''", '""', "a''b", 'a""b', '  lead and trail  ', "x='1 2'", '$HOME "$X y"', '#not a comment',
         '"\\$"', '\\\n', 'a\\\nb', "echo 'it'\"'\"'s'", '"\\\\"', "\\'", '"\\\'"', "''''", 'a b\n c']


class ShlexTests(NodeTestCase):
    def test_quote_join(self):
        cases = FIXED + fuzz(1, 3000)
        expected = [shlex.quote(c) for c in cases]
        got = run_node("const m = await import(COMPAT + 'shlex.mjs'); emit(input.map(m.quote));", cases)
        self.assertEqual(got, expected)
        lists = [cases[i:i + 4] for i in range(0, 400, 4)] + [[]]
        got = run_node("const m = await import(COMPAT + 'shlex.mjs'); emit(input.map(m.join));", lists)
        self.assertEqual(got, [shlex.join(x) for x in lists])

    def test_quote_roundtrip_through_split(self):
        cases = fuzz(2, 500)
        got = run_node("""
const m = await import(COMPAT + 'shlex.mjs');
emit(input.map((s) => m.split(m.join([s, s + 'x']))));""", cases)
        self.assertEqual(got, [[c, c + 'x'] for c in cases])

    def test_split(self):
        cases = FIXED + fuzz(3, 6000)

        def oracle(text):
            return shlex.split(text)
        expected = py_cases(oracle, cases)
        got = run_node("""
const m = await import(COMPAT + 'shlex.mjs');
const { ValueError } = await import(COMPAT + 'pyjson.mjs');
emit(input.map((s) => { try { return m.split(s); } catch (e) { return { error: (e instanceof ValueError ? '' : 'NOT-ValueError ') + e.name + ': ' + e.message }; } }));
""", cases)
        for case, want, have in zip(cases, expected, got):
            self.assertEqual(have, want, repr(case))

    def test_errors_are_value_error(self):
        # finding 13 (shlex-error-type): the error is the shared ValueError porters catch (codex_hooks'
        # is_notice_group relies on `except ValueError`), not a relabelled generic Error.
        cases = ["'broken", 'a\\', '"x', 'ok "a\\']
        want = py_cases(shlex.split, cases)
        got = run_node("""
const m = await import(COMPAT + 'shlex.mjs');
const { ValueError } = await import(COMPAT + 'pyjson.mjs');
emit(input.map((s) => { try { return m.split(s); } catch (e) { return { error: e.name + ': ' + e.message, isValueError: e instanceof ValueError }; } }));
""", cases)
        self.assertEqual(got, [{**w, 'isValueError': True} for w in want])

    def test_list2cmdline(self):
        lists = [['a', 'b c', '', 'x"y', 'x\\"y', 'tail\\', 'tail \\', 'sp ace\\\\', '\\\\"', '"', '\\', 'a\tb',
                  'C:\\Program Files\\x\\', 'é "中"']]
        lists += [[c for c in fuzz(seed, 4, 10)] for seed in range(4, 1500)]
        lists.append([])
        got = run_node("const m = await import(COMPAT + 'shlex.mjs'); emit(input.map(m.list2cmdline));", lists)
        self.assertEqual(got, [subprocess.list2cmdline(x) for x in lists])


if __name__ == '__main__':
    unittest.main()
