"""Differential test: lcu/compat/pyjson.mjs (Node) against Python's json module, byte for byte."""
import io
import json
import math
import os
from pathlib import Path
import random
import shutil
import struct
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / 'tests/compat/pyjson_helper.mjs'
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parent))
import support as _support  # noqa: E402  (one Node selector for every runner)
NODE = _support.selected_node()

# Every option combination LCU uses (see the header of lcu/compat/pyjson.mjs), plus a few extras.
LCU_OPTIONS = [
    {},
    {'indent': 2},
    {'indent': 2, 'sort_keys': True},
    {'indent': 2, 'ensure_ascii': False},
    {'sort_keys': True},
    {'separators': [',', ':']},
    {'separators': [',', ':'], 'sort_keys': True},
    {'ensure_ascii': False, 'separators': [',', ':']},
]
EXTRA_OPTIONS = [
    {'indent': 0},
    {'indent': 4, 'sort_keys': True, 'ensure_ascii': False},
    {'indent': '\t'},
    {'indent': 2, 'separators': [', ', ' = ']},
    {'allow_nan': False},
    {'ensure_ascii': False},
]

STRING_POOL = [
    '', 'a', 'abc', 'with space', 'quote"inside', 'back\\slash', 'slash/', 'nl\nx', 'cr\rx', 'tab\tx', 'bs\bx',
    'ff\fx', '\x00', '\x1f', '\x7f', '\x80', 'é', 'ñandú', '中文', '  ', '﻿', '￿', '',
    '\U0001f600', '\U00010000', '\U0010ffff', 'a\U0001f600b', '\ud800', '\udbff', '\udc00', '\udfff', 'x\ud83dy',
    'Z', 'z', '～',
    '\U00011000', '퟿', 'x', '</script>', "it's", '1', '10', '-1', '01', '2147483648', '4294967295',
    '4294967296', '1e5', '0', '9', '__proto__', 'constructor', 'toString', ' ',
]
KEY_POOL = STRING_POOL + ['k%d' % i for i in range(10)]
SPECIAL_FLOATS = [
    0.0, -0.0, 1.0, -1.0, 0.1, 0.5, 1.5, 100.0, 1e15, 1e16, 1e17, 1.5e16, 123456789012345678.0, 1e22, 1e21, 1e23,
    1e-4, 1e-5, 0.0001, 0.00001, 1.5e-5, 123e-7, 5e-324, 2.2250738585072014e-308, 1.7976931348623157e308,
    9007199254740993.0, 2.5e-5, 0.3, 1 / 3, 2 / 3, 1e100, 1e-100, 123456.789, 4.35, 0.1 + 0.2,
    float('nan'), float('inf'), float('-inf'), 1e300 * 10, 9.999999999999999e22, 1e16 - 2, 12345678901234567890.0,
]
SPECIAL_INTS = [
    0, 1, -1, 7, 42, 2 ** 31, 2 ** 53 - 1, 2 ** 53, -2 ** 53, 2 ** 53 + 1, -(2 ** 53) - 1, 2 ** 63, 2 ** 64,
    -2 ** 64, 10 ** 30, -10 ** 50, 10 ** 100, 123456789012345678901234567890, 10 ** 308, 10 ** 4299,
]


def random_float(rng):
    roll = rng.random()
    if roll < 0.3:
        return rng.choice(SPECIAL_FLOATS)
    if roll < 0.6:
        while True:
            value = struct.unpack('>d', rng.getrandbits(64).to_bytes(8, 'big'))[0]
            if math.isfinite(value):
                return value
    if roll < 0.8:
        return float('%de%d' % (rng.randint(-10 ** 6, 10 ** 6), rng.randint(-30, 30)))
    return rng.uniform(-1000, 1000)


def split_surrogate_pairs(text):
    """A Python str may hold a high and a low surrogate as two code points; a JS string cannot, so avoid them."""
    out = []
    for char in text:
        if out and '\ud800' <= out[-1] <= '\udbff' and '\udc00' <= char <= '\udfff':
            out.append('x')
        out.append(char)
    return ''.join(out)


def random_string(rng):
    if rng.random() < 0.5:
        return rng.choice(STRING_POOL)
    pool = [c for s in STRING_POOL for c in s]
    return split_surrogate_pairs(''.join(rng.choice(pool) for _ in range(rng.randint(0, 8))))


def random_value(rng, depth=0, plain=False):
    kinds = ['str', 'int', 'float', 'bool', 'none']
    if depth < 4:
        kinds += ['list', 'dict', 'dict']
    kind = rng.choice(kinds)
    if kind == 'str':
        return random_string(rng)
    if kind == 'int':
        return rng.randint(-10 ** 6, 10 ** 6) if plain or rng.random() < 0.5 else rng.choice(SPECIAL_INTS)
    if kind == 'float':
        value = random_float(rng)
        if plain and (not math.isfinite(value) or value == int(value) and abs(value) < 2 ** 63):
            value = 0.25 if not math.isfinite(value) or abs(value) > 1000 else value + 0.5
        return value
    if kind == 'bool':
        return rng.random() < 0.5
    if kind == 'none':
        return None
    if kind == 'list':
        return [random_value(rng, depth + 1, plain) for _ in range(rng.randint(0, 5))]
    result = {}
    for _ in range(rng.randint(0, 6)):
        key = rng.choice(KEY_POOL) if rng.random() < 0.6 else random_string(rng)
        if plain and (key.isdigit() and key.isascii()):
            continue
        result[key] = random_value(rng, depth + 1, plain)
    return result


MUTATION_ALPHABET = list('{}[],:"\\ \t\n\r-+.eE0123456789abfnlrstuNIy/') + ['\x00', '\x1f', '\ud83d', '😀', 'é', '﻿', 'u']


def mutate(rng, text):
    chars = list(text)
    for _ in range(rng.randint(1, 3)):
        action = rng.choice(['delete', 'insert', 'replace', 'truncate', 'append', 'dup'])
        if not chars:
            chars = [rng.choice(MUTATION_ALPHABET)]
            continue
        index = rng.randrange(len(chars))
        if action == 'delete':
            del chars[index]
        elif action == 'insert':
            chars.insert(index, rng.choice(MUTATION_ALPHABET))
        elif action == 'replace':
            chars[index] = rng.choice(MUTATION_ALPHABET)
        elif action == 'truncate':
            chars = chars[:index]
        elif action == 'append':
            chars.extend(rng.choice(MUTATION_ALPHABET) for _ in range(rng.randint(1, 4)))
        else:
            chars[index:index] = chars[index:index + rng.randint(1, 4)]
    return ''.join(chars)


HAND_TEXTS = [
    '', ' ', 'x', '[', ']', '{', '}', '{"a"', '{"a":', '{"a":1', '{"a":1,', '{"a":1,}', '{,}', '{"a" 1}', '{a:1}',
    '[1,]', '[,1]', '[1 2]', '[1', '[1,', '"', '"abc', '"\\', '"\\u', '"\\u12', '"\\u123', '"\\u1234', '"\\u1234"',
    '"\\ud83d"', '"\\ud83d\\ude00', '"\\ud83d\\ude00"', '"\\ud83d\\u0041"', '"\\ud83d\\uzzzz"', '"\\x"', '"\\ "',
    '"a\nb"', '"a\tb"', '"\x1f"', 'nul', 'null', 'nulll', 'tru', 'true', 'fals', 'false', 'NaN', 'NaN1', 'Infinity',
    '-Infinity', '-Infinit', '-', '-x', '--1', '01', '1.', '1.e5', '.5', '1e', '1e+', '1E5', '1.5E+3', '-0', '-0.0',
    '0e0', '﻿[]', '[] x', '[]\n[]', '1 2', '{"a":1,"a":2}', '{"2":1,"1":2,"a":3,"1":4}', '[1e400, -1e400]',
    '\t\r\n [ 1 , 2 ] \n', '"\\/"', '{"a":}', '{"a":,}', '{"a" "b"}', '[nan]', '+1', '0x10', '1_0', '١٢٣', '"\ud83d"',
    'é', '😀', '[😀', '{"😀": x}', '"😀\\u12', '\n\n  [1,\n 2,\n x]', '1' * 4300, '1' * 4301, '-' + '1' * 4301,
    '0.' + '1' * 5000, '[' * 10 + ']' * 10, '[' * 10, '"\\u0000"', '"\\u00e9\\uD83D\\uDE00"', '"\\uDE00\\uD83D"',
]


def python_dumps(value, options):
    options = dict(options)
    if 'separators' in options:
        options['separators'] = tuple(options['separators'])
    return json.dumps(value, **options)


def python_outcome(call):
    try:
        return {'ok': call()}
    except json.JSONDecodeError as exc:
        return {'err': 'JSONDecodeError', 'message': str(exc), 'msg': exc.msg, 'pos': exc.pos,
                'lineno': exc.lineno, 'colno': exc.colno}
    except UnicodeDecodeError as exc:
        return {'err': 'UnicodeDecodeError', 'message': str(exc), 'msg': None, 'pos': None, 'lineno': None, 'colno': None}
    except ValueError as exc:
        return {'err': 'ValueError', 'message': str(exc), 'msg': None, 'pos': None, 'lineno': None, 'colno': None}
    except TypeError as exc:
        return {'err': 'TypeError', 'message': str(exc), 'msg': None, 'pos': None, 'lineno': None, 'colno': None}


def python_canonical(call):
    return python_outcome(lambda: json.dumps(call(), indent=1))


@unittest.skipUnless(NODE, 'node is not on PATH')
class PyJsonDifferentialTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rng = random.Random(int(os.environ.get("PYJSON_SEED", "20261005")))
        cases = []
        expected = []

        def add(case, outcome):
            cases.append(case)
            expected.append(outcome)

        # dumps over lossless values, every option combination LCU uses, plus extras.
        values = [random_value(rng) for _ in range(500)]
        values += [value for value in SPECIAL_FLOATS] + [value for value in SPECIAL_INTS]
        values += [s for s in STRING_POOL] + [{k: 1 for k in STRING_POOL}, {k: i for i, k in enumerate(KEY_POOL)}]
        values += [[], {}, [[]], {'a': []}, {'a': {}}, [{}], None, True, False, '']
        for index, value in enumerate(values):
            text = json.dumps(value)
            options = LCU_OPTIONS if index % 2 == 0 else LCU_OPTIONS + EXTRA_OPTIONS
            for option in options:
                add({'kind': 'dumps', 'text': text, 'opts': option, 'plain': False},
                    python_outcome(lambda v=value, o=option: python_dumps(v, o)))
        # dumps over plain JS values (conventions: safe int -> int, non-integral float -> float)
        for _ in range(500):
            value = random_value(rng, plain=True)
            if isinstance(value, float) and (value == int(value) if math.isfinite(value) else True):
                continue
            text = json.dumps(value)
            for option in LCU_OPTIONS:
                add({'kind': 'dumps', 'text': text, 'opts': option, 'plain': True},
                    python_outcome(lambda v=value, o=option: python_dumps(v, o)))
        # loads over valid text (preserves floats/ints/key order) and over malformed text
        for _ in range(500):
            value = random_value(rng)
            text = json.dumps(value, indent=rng.choice([None, 1, 2]), ensure_ascii=rng.random() < 0.5,
                              sort_keys=rng.random() < 0.3)
            add({'kind': 'loads', 'text': text}, python_canonical(lambda t=text: json.loads(t)))
            for _ in range(5):
                bad = mutate(rng, text)
                add({'kind': 'loads', 'text': bad}, python_canonical(lambda t=bad: json.loads(t)))
        for text in HAND_TEXTS:
            add({'kind': 'loads', 'text': text}, python_canonical(lambda t=text: json.loads(t)))
        for _ in range(1000):
            alphabet = rng.choice([MUTATION_ALPHABET, list('{}[],:" 0123456789')])
            bad = ''.join(rng.choice(alphabet) for _ in range(rng.randint(0, 14)))
            add({'kind': 'loads', 'text': bad}, python_canonical(lambda t=bad: json.loads(t)))
        # Duplicate and integer-like keys, loaded from text.
        for _ in range(100):
            keys = [rng.choice(['1', '2', 'a', '10', '0', '-1', 'b', '4294967295', '4294967296']) for _ in range(rng.randint(1, 8))]
            text = '{' + ','.join('"%s":%d' % (key, i) for i, key in enumerate(keys)) + '}'
            add({'kind': 'loads', 'text': text}, python_canonical(lambda t=text: json.loads(t)))
        # bytes input: encodings and malformed UTF-8
        samples = ['[1, "é😀"]', '{"a": "\ud800"}', '', '  ', '{"k": [true, null, 1.0]}']
        for text in samples:
            for encoding in ('utf-8', 'utf-8-sig', 'utf-16', 'utf-16-le', 'utf-16-be', 'utf-32', 'utf-32-le', 'utf-32-be'):
                try:
                    data = text.encode(encoding, 'surrogatepass')
                except UnicodeError:
                    continue
                add({'kind': 'loads_bytes', 'hex': data.hex()}, python_canonical(lambda d=data: json.loads(d)))
        for _ in range(600):
            base = json.dumps(random_value(rng, 2), ensure_ascii=False).encode('utf-8', 'surrogatepass')
            data = bytearray(base)
            for _ in range(rng.randint(0, 2)):
                action = rng.choice(['flip', 'insert', 'truncate', 'delete'])
                if not data:
                    break
                index = rng.randrange(len(data))
                if action == 'flip':
                    data[index] = rng.choice([0x80, 0xbf, 0xc0, 0xc1, 0xc2, 0xe0, 0xed, 0xa0, 0xf0, 0xf4, 0xf5, 0xff, rng.randrange(256)])
                elif action == 'insert':
                    data.insert(index, rng.choice([0xe2, 0xf0, 0xed, 0x80, 0xa0, 0x9f, 0xc3]))
                elif action == 'truncate':
                    del data[index:]
                else:
                    del data[index]
            data = bytes(data)
            add({'kind': 'loads_bytes', 'hex': data.hex()}, python_canonical(lambda d=data: json.loads(d)))
        for data in (b'\xed\xa0\x80', b'"\xed\xa0\x80"', b'"\xed\xa0\x41"', b'\xf4\x90\x80\x80', b'\xf0\x80\x80\x80',
                     b'\xe0\x80\x80', b'\xef\xbb\xbf\xef\xbb\xbf[]', b'\x00[', b'[\x00'):
            add({'kind': 'loads_bytes', 'hex': data.hex()}, python_canonical(lambda d=data: json.loads(d)))
        # float repr
        for _ in range(3000):
            value = random_float(rng)
            if not math.isfinite(value):
                continue
            add({'kind': 'float', 'bits': struct.pack('>d', value).hex()}, {'ok': repr(value)})
        # Regression (review findings 3, 4, 6, 11): BOM-bearing malformed UTF-16/32, typed sort_keys, NaN equality,
        # json.dump to a stream / fd.
        for text in ['[1, "é😀"]', '"\ud800"', '[', '"x"', '{"a": 1}']:
            for encoding in ('utf-16', 'utf-32'):
                for bom in (False, True):
                    codec = encoding + ('-le' if bom else '-be')
                    base = text.encode(codec, 'surrogatepass')
                    prefix = {'utf-16': (b'\xff\xfe' if bom else b'\xfe\xff'),
                              'utf-32': (b'\xff\xfe\x00\x00' if bom else b'\x00\x00\xfe\xff')}[encoding]
                    for cut in range(0, len(base) + 1):
                        for data in (prefix + base[:cut], prefix + base[:cut] + b'\x00', prefix + base[:cut] + b'\x00\x11\x00\x00'):
                            add({'kind': 'loads_bytes', 'hex': data.hex()}, python_canonical(lambda d=data: json.loads(d)))
        for _ in range(400):
            encoding = rng.choice(['utf-16-le', 'utf-16-be', 'utf-32-le', 'utf-32-be'])
            data = bytearray(json.dumps(random_value(rng, 2), ensure_ascii=False).encode(encoding, 'surrogatepass'))
            if data and rng.random() < 0.7:
                data[rng.randrange(len(data))] = rng.choice([0x00, 0xd8, 0xdc, 0xff, 0x11, 0x7f])
            data = bytes(data[:rng.randint(0, len(data))]) if rng.random() < 0.3 else bytes(data)
            data = rng.choice([b'', b'\xff\xfe', b'\xfe\xff', b'\xff\xfe\x00\x00', b'\x00\x00\xfe\xff']) + data
            add({'kind': 'loads_bytes', 'hex': data.hex()}, python_canonical(lambda d=data: json.loads(d)))
        key_specs = {
            'int': lambda rng: ('int', str(rng.choice([0, 1, 2, 9, 10, 11, 100, -1, -10, 2 ** 70, -2 ** 70])), None),
            'float': lambda rng: ('float', rng.choice(['0.5', '1.5', '-2.5', '10.25', '3.0']), None),
            'bool': lambda rng: ('bool', rng.choice([True, False]), None),
            'str': lambda rng: ('str', rng.choice(['a', 'B', '10', '2', 'é', '\U0001f600', '\ue000', '']), None),
            'none': lambda rng: ('none', None, None),
        }

        def typed(spec):
            kind, value, _ = spec
            return {'int': lambda: int(value), 'float': lambda: float(value), 'bool': lambda: value,
                    'str': lambda: value, 'none': lambda: None}[kind]()

        for _ in range(600):
            kinds = rng.choice([['int'], ['str'], ['float'], ['int', 'float', 'bool'], ['int'], ['str']])
            specs = {}
            for _ in range(rng.randint(2, 7)):
                spec = key_specs[rng.choice(kinds)](rng)
                specs[typed(spec)] = spec
            pairs = [[kind, value, index] for index, (kind, value, _) in enumerate(specs.values())]
            expected_dict = {typed((k, v, None)): i for k, v, i in pairs}
            for option in ({'sort_keys': True}, {'sort_keys': True, 'indent': 2}):
                add({'kind': 'sortkeys', 'pairs': pairs, 'opts': option},
                    python_outcome(lambda d=expected_dict, o=option: python_dumps(d, o)))
        for left, right in ((('int', '2', 0), ('str', 'a', 1)), (('str', 'a', 0), ('int', '2', 1)),
                            (('none', None, 0), ('int', '1', 1)), (('float', '1.5', 0), ('str', 'x', 1))):
            expected_dict = {typed(left): 0, typed(right): 1}
            add({'kind': 'sortkeys', 'pairs': [list(left), list(right)], 'opts': {'sort_keys': True}},
                python_outcome(lambda d=expected_dict: python_dumps(d, {'sort_keys': True})))
        equal_texts = ['NaN', '[NaN]', '{"x": NaN}', '[1, 1.0, true]', '{"a": [NaN, 1]}', '1', '1.0', 'true', '[true]',
                       '[1]', '[1.0]', '{"a": 1}', '{"a": 1.0}', '{"a": true}', '{"b": 1, "a": 2}', '{"a": 2, "b": 1}',
                       'null', '[null]', '"1"', '[]', '{}', 'Infinity', '[-Infinity]', '9007199254740993', '9007199254740992.0',
                       '9007199254740993.0', '1e400', '[1e400]', '-0', '-0.0', '0', '0.0', '[-0.0]', '[0]']
        for left in equal_texts:
            for right in equal_texts:
                add({'kind': 'equal', 'a': left, 'b': right},
                    {'ok': str(json.loads(left) == json.loads(right))})
            value = json.loads(left)
            add({'kind': 'self_equal', 'text': left},
                {'ok': '%s/%s/%s' % tuple(str(v).lower() for v in (
                    value == value, value == json.loads(left), value == (dict(value) if isinstance(value, dict) else value)))})
        for _ in range(150):
            value = random_value(rng)
            text = json.dumps(value, ensure_ascii=False)
            options = rng.choice(LCU_OPTIONS)
            buffer = io.StringIO()
            python_outcome(lambda: json.dump(json.loads(text), buffer, **{
                k: (tuple(v) if k == 'separators' else v) for k, v in options.items()}))
            add({'kind': 'dump_stream', 'text': text, 'opts': options}, {'ok': buffer.getvalue(), 'ret': 'None'})
            if not any('\ud800' <= c <= '\udfff' for c in buffer.getvalue()):
                add({'kind': 'dump_fd', 'text': text, 'opts': options}, {'ok': buffer.getvalue()})
        add({'kind': 'dump_fd', 'text': '"\\ud800"', 'opts': {'ensure_ascii': False}}, {'err': 'UnicodeEncodeError'})
        add({'kind': 'dump_fd', 'text': '"\\ud800"', 'opts': {}}, {'ok': '"\\ud800"'})
        payload = ''.join(json.dumps(case) + '\n' for case in cases)
        result = subprocess.run([NODE, str(HELPER)], input=payload, capture_output=True, text=True, timeout=120)
        if result.returncode != 0:
            raise AssertionError(result.stderr)
        cls.cases = cases
        cls.expected = expected
        cls.actual = [json.loads(line) for line in result.stdout.split('\n')[:-1]]

    def test_case_count(self):
        self.assertEqual(len(self.actual), len(self.cases))
        self.assertGreater(len(self.cases), 10000)

    def test_all_cases_match_python(self):
        failures = []
        for case, expected, actual in zip(self.cases, self.expected, self.actual):
            if 'ok' in expected:
                same = actual.get('ok') == expected['ok'] and 'err' not in actual
            else:
                same = all(actual.get(key) == expected[key] for key in expected)
            if not same:
                failures.append((case, expected, actual))
        if failures:
            self.fail('%d of %d differ; first: %s' % (len(failures), len(self.cases), json.dumps(
                [{'case': c, 'python': e, 'node': a} for c, e, a in failures[:3]], ensure_ascii=True)[:3000]))

    def test_dumps_covers_every_lcu_option_set(self):
        used = {json.dumps(case['opts'], sort_keys=True) for case in self.cases if case['kind'] == 'dumps'}
        for option in LCU_OPTIONS:
            self.assertIn(json.dumps(option, sort_keys=True), used)


if __name__ == '__main__':
    unittest.main()
