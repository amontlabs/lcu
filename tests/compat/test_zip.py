"""Differential test: lcu/compat/zip.mjs against Python zipfile and update_apply._extract_zip."""
import io
import json
import ntpath
import os
from pathlib import Path
import stat
import struct
import sys
import tarfile
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import compat_support as S  # noqa: E402
from lcu import update_apply  # noqa: E402

RUNNER = S.ROOT / 'tests/compat/run_zip.mjs'
# LCU_TEST_INFLATE_FALLBACK=1 runs the runners on the documented zlib.inflateRawSync path (see test_inflate_fallback.py)
FALLBACK = os.environ.get('LCU_TEST_INFLATE_FALLBACK') == '1'


def build(entries, comment=b'', prefix=b'', compression=zipfile.ZIP_DEFLATED):
    import warnings
    warnings.simplefilter('ignore')
    buffer = io.BytesIO()
    buffer.write(prefix)
    with zipfile.ZipFile(buffer, 'w', compression) as archive:
        for e in entries:
            name, data = e[0], e[1]
            opts = e[2] if len(e) > 2 else {}
            info = zipfile.ZipInfo(name, date_time=opts.get('date', (2024, 1, 2, 3, 4, 6)))
            info.compress_type = opts.get('compression', compression)
            info.external_attr = opts.get('attr', 0o644 << 16)
            if 'flag' in opts:
                info.flag_bits |= opts['flag']
            if 'extra' in opts:
                info.extra = opts['extra']
            if opts.get('zip64'):
                with archive.open(info, 'w', force_zip64=True) as handle:
                    handle.write(data)
            else:
                archive.writestr(info, data)
        archive.comment = comment
    return buffer.getvalue()


def patch_crc(blob, index=0):
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        info = archive.infolist()[index]
    data = bytearray(blob)
    central = -1
    for _ in range(index + 1):
        central = blob.index(b'PK\x01\x02', central + 1)
    data[central + 16:central + 20] = b'\xde\xad\xbe\xef'
    data[info.header_offset + 14:info.header_offset + 18] = b'\xde\xad\xbe\xef'
    return bytes(data)


def patch_flag(blob, bit, index=0):
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        info = archive.infolist()[index]
    data = bytearray(blob)
    central = -1
    for _ in range(index + 1):
        central = blob.index(b'PK\x01\x02', central + 1)
    for at in (central + 8, info.header_offset + 6):
        flags = struct.unpack_from('<H', data, at)[0] | bit
        struct.pack_into('<H', data, at, flags)
    return bytes(data)


def python_extract(archive, dest):
    try:
        update_apply._extract_zip(archive, dest)
        return {'ok': True}
    except BaseException as exc:  # noqa: BLE001
        return {'ok': False, 'name': type(exc).__name__, 'message': str(exc)}


def cases():
    big = bytes(range(256)) * 1000
    random_like = os.urandom(150000)
    c = {}
    c['plain'] = [('r/', b''), ('r/a.txt', b'hello'), ('r/b.bin', big), ('r/sub/', b''), ('r/sub/c', b'')]
    c['stored'] = [('s', b'stored data' * 50, {'compression': zipfile.ZIP_STORED})]
    c['mixed'] = [('d', b'deflated' * 100), ('s', b'stored', {'compression': zipfile.ZIP_STORED})]
    c['big-multichunk'] = [('big', random_like), ('big2', big * 3, {'compression': zipfile.ZIP_STORED})]
    c['empty-file'] = [('e', b'')]
    c['implicit-dirs'] = [('x/y/z/f', b'deep')]
    c['dot-names'] = [('./a', b'1'), ('b//c', b'2'), ('d/./e', b'3'), ('./', b'')]
    c['duplicates'] = [('dup', b'first version is longer'), ('dup', b'second')]
    c['dir-then-file'] = [('n/', b''), ('n', b'x')]
    c['file-then-dir'] = [('n', b'x'), ('n/', b'')]
    c['file-under-file'] = [('f', b'x'), ('f/g', b'y')]
    c['unicode-utf8'] = [('caf\u00e9/\u65e5\u672c.txt', b'u'), ('\U0001f600', b'emoji')]
    c['cp437-name'] = [('plain', b'1')]
    c['unix-attrs'] = [('x', b'1', {'attr': 0o100755 << 16}), ('y', b'2', {'attr': 0o4755 << 16})]
    c['zip64'] = [('z', b'zip64 member', {'zip64': True})]
    c['comment'] = [('c', b'with comment')]
    c['backslash'] = [('a\\b', b'x')]
    c['colon'] = [('a:b', b'x')]
    h = {}
    h['dotdot'] = [('ok', b'1'), ('../evil', b'x')]
    h['dotdot-mid'] = [('a/../../evil', b'x')]
    h['absolute'] = [('/abs/evil', b'x')]
    h['drive'] = [('C:\\evil', b'x')]
    h['unc'] = [('\\\\srv\\sh\\x', b'x')]
    h['symlink-entry'] = [('l', b'target', {'attr': (0o120777) << 16})]
    h['symlink-after-good'] = [('good', b'1'), ('l', b'../x', {'attr': (stat.S_IFLNK | 0o777) << 16})]
    h['empty-name'] = [('', b'x')]
    h['nul-in-name'] = [('a\0b', b'x')]
    return c, h


class ZipDifferential(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if S.NODE is None:
            raise unittest.SkipTest('node >= 22 not available')
        cls.tmp = tempfile.TemporaryDirectory()
        cls.base = Path(cls.tmp.name).resolve()
        cls.specs, cls.py, cls.dirs = [], {}, {}
        n = [0]

        def add(label, blob, prefill=None):
            n[0] += 1
            ident = f'{n[0]:03d}-{label}'
            archive = cls.base / f'{ident}.zip'
            archive.write_bytes(blob)
            dirs = {}
            for side in ('py', 'js'):
                dest = cls.base / side / ident
                dest.mkdir(parents=True)
                if prefill:
                    prefill(dest)
                dirs[side] = dest
            cls.specs.append({'id': ident, 'archive': str(archive), 'dest': str(dirs['js'])})
            cls.py[ident] = python_extract(str(archive), str(dirs['py']))
            cls.dirs[ident] = dirs
            return ident

        def existing(dest):
            (dest / 'dup').write_text('old')
            (dest / 'n').mkdir()
            (dest / 'f').write_text('file')
            os.symlink('dup', dest / 'viasym')

        good, hostile = cases()
        cls.expect = {}
        for label, entries in good.items():
            blob = build(entries, comment=b'a zip comment' if label == 'comment' else b'')
            for suffix, fill in (('', None), ('-existing', existing)):
                cls.expect[add(label + suffix, blob, fill)] = label
        for label, entries in hostile.items():
            try:
                blob = build(entries)
            except ValueError:
                continue
            add(label, blob)
        # container-level faults
        base_blob = build([('a', os.urandom(70000)), ('b', b'second' * 100)])
        faults = {
            'not-zip': b'hello world' * 50,
            'empty': b'',
            'tiny': b'PK',
            'truncated': base_blob[:len(base_blob) // 2],
            'truncated-central': base_blob[:-30],
            'prefixed': build([('p', b'prefixed')], prefix=b'#!/bin/sh\nexit\n' * 20),
            'bad-crc-small': patch_crc(build([('a', b'small file'), ('b', b'ok')])),
            'bad-crc-big': patch_crc(build([('a', os.urandom(200000))])),
            'bad-crc-stored-big': patch_crc(build([('a', os.urandom(200000))], compression=zipfile.ZIP_STORED)),
            'bad-crc-second': patch_crc(build([('a', b'fine'), ('b', b'broken'), ('c', b'never')]), 1),
            'bzip2': build([('b', b'bz' * 100, {'compression': zipfile.ZIP_BZIP2})]),
            'lzma': build([('l', b'xz' * 100, {'compression': zipfile.ZIP_LZMA})]),
            'encrypted-flag': patch_flag(build([('e', b'secret')]), 0x1),
            'patched-flag': patch_flag(build([('e', b'x')]), 0x20),
            'strong-enc-flag': patch_flag(build([('e', b'x')]), 0x40),
            'unicode-extra': build([('plain', b'u', {'extra': struct.pack('<HHBL', 0x7075, 5 + 5, 1, 0) + b'wrong'})]),
            'bad-extra': build([('x', b'1', {'extra': struct.pack('<HH', 1, 200)})]),
        }
        for label, blob in faults.items():
            add(label, blob)
        # local header disagreeing with the directory
        renamed = bytearray(build([('abc', b'x')]))
        renamed[30:33] = b'xyz'
        add('local-name-differs', bytes(renamed))
        # data descriptor (streamed) archive
        class Unseekable(io.RawIOBase):
            def __init__(self):
                self.data = bytearray()
            def writable(self):
                return True
            def write(self, b):
                self.data += b
                return len(b)
        sink = Unseekable()
        with zipfile.ZipFile(sink, 'w', zipfile.ZIP_DEFLATED) as archive:
            with archive.open('streamed.txt', 'w') as handle:
                handle.write(b'streamed content' * 100)
        add('data-descriptor', bytes(sink.data))
        # CP437 high bytes without the UTF-8 flag
        info = zipfile.ZipInfo('x')
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as archive:
            archive.writestr(info, b'cp437')
        blob = buffer.getvalue().replace(b'x', bytes([0x82, 0xe1, 0x80, 0xf8]))  # é ß Ç °
        add('cp437-high-bytes', blob.replace(b'PK\x01\x02', b'PK\x01\x02', 1))
        spec = cls.base / 'spec.json'
        spec.write_text(json.dumps(cls.specs))
        result = S.run_node(RUNNER, spec)
        if result.returncode:
            raise AssertionError(result.stderr)
        cls.node = json.loads(result.stdout)

    @classmethod
    def tearDownClass(cls):
        S.rmtree(cls.base)
        cls.tmp.cleanup()

    def normalize(self, text, ident):
        for side in ('py', 'js'):
            for form in (str(self.dirs[ident][side]), os.path.realpath(self.dirs[ident][side])):
                text = text.replace(form, '<D>')
        return text.replace(str(self.base), '<B>')

    # Documented gaps: Python can read these, the Node module must refuse them clearly.
    # the partial file after a CRC failure is reproduced exactly (read windows of copyfileobj) except on the
    # one-shot fallback, which has no zlib read windows (documented deviation, compat/inflate.mjs)
    TREE_SKIP = {'bad-crc-big'} if FALLBACK else set()
    KNOWN_GAPS = {'bzip2': 'UnsupportedCompression', 'lzma': 'UnsupportedCompression'}

    def test_differential(self):
        failures = []
        for spec in self.specs:
            ident = spec['id']
            py, js = self.py[ident], self.node[ident]
            label = ident.split('-', 1)[1]
            if label in self.KNOWN_GAPS:
                self.assertTrue(py['ok'], ident)
                self.assertEqual(js['name'], self.KNOWN_GAPS[label])
                continue
            problems = []
            if py['ok'] != js['ok']:
                problems.append(f'ok {py} vs {js}')
            elif not py['ok']:
                if py['name'] != js['name']:
                    problems.append(f'name {py["name"]} vs {js["name"]}')
                if self.normalize(py['message'], ident) != self.normalize(js['message'], ident):
                    problems.append(f'message {py["message"]!r} vs {js["message"]!r}')
            a, b = S.snapshot(self.dirs[ident]['py']), S.snapshot(self.dirs[ident]['js'])
            if label not in self.TREE_SKIP and not S.same_snapshot(a, b):
                problems.append(f'trees differ\n{json.dumps(a, sort_keys=True)}\n{json.dumps(b, sort_keys=True)}')
            if problems:
                failures.append(f'[{ident}] ' + '; '.join(problems)[:1200])
        self.assertFalse(failures, f'{len(failures)} differ:\n' + '\n'.join(failures))

    def test_error_forms_present(self):
        names = {r['name'] for r in self.py.values() if not r['ok']}
        for required in ('ValueError', 'BadZipFile', 'FileExistsError', 'NotADirectoryError', 'RuntimeError'):
            self.assertIn(required, names)


class ZipHelpers(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if S.NODE is None:
            raise unittest.SkipTest('node >= 22 not available')

    def node_json(self, script, arg):
        import subprocess
        result = subprocess.run([S.NODE, '--input-type=module', '-e', script, json.dumps(arg)], capture_output=True,
                                text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_cp437_table(self):
        script = (f'import {{decodeCp437}} from "{S.ROOT / "lcu/compat/zip.mjs"}";'
                  'const b=Buffer.from(Array.from({length:256},(_, i)=>i));console.log(JSON.stringify(decodeCp437(b)));')
        import subprocess
        out = subprocess.run([S.NODE, '--input-type=module', '-e', script], capture_output=True, text=True)
        self.assertEqual(json.loads(out.stdout), bytes(range(256)).decode('cp437'))

    def test_windows_name_sanitizing_matches_python(self):
        def python_arcname(filename):
            arcname = filename.replace('/', '\\').replace('/', '\\')
            arcname = ntpath.splitdrive(arcname)[1]
            arcname = '\\'.join(x for x in arcname.split('\\') if x not in ('', '.', '..'))
            return zipfile.ZipFile._sanitize_windows_name(arcname, '\\')

        names = ['a/b', 'a:b/c', 'C:/x/y', 'C:x', 'a. /b', 'a/b./c ', 'con<>|"?*x', '\\\\srv\\sh\\f', '//srv/sh/f',
                 '../a', 'a/../b', '. . /x', 'a//b', 'x\\y/z', '...', 'dir/', '/abs', 'a\\..\\b']
        script = (f'import {{arcnameFor}} from "{S.ROOT / "lcu/compat/zip.mjs"}";'
                  'console.log(JSON.stringify(JSON.parse(process.argv[1]).map((n)=>arcnameFor(n,"win32"))));')
        self.assertEqual(self.node_json(script, names), [python_arcname(n) for n in names])


# ---------------------------------------------------------------------------------------------------------------
# Regression tests for the compat-archive-http review (F01 Windows parents, F02 overlap, F03 bounded inflation,
# F07 BOM names, F08 extraction system byte, F17 corrupt deflate) and the ntpath flavour.
# ---------------------------------------------------------------------------------------------------------------
import contextlib  # noqa: E402
import errno  # noqa: E402
import subprocess  # noqa: E402
import types  # noqa: E402
import warnings  # noqa: E402
import zlib  # noqa: E402

WINDOWS_RUNNER = S.ROOT / 'tests/compat/run_zip_windows.mjs'
BOUNDED_RUNNER = S.ROOT / 'tests/compat/run_bounded.mjs'


def central_offsets(blob):
    out, at = [], -1
    while True:
        at = blob.find(b'PK\x01\x02', at + 1)
        if at < 0:
            return out
        out.append(at)


def manual_zip(members):
    """A ZIP assembled by hand: members are (name, compressed stream, method, crc, declared file size)."""
    out, central = bytearray(), bytearray()
    for name, stream, method, crc, size in members:
        nb = name.encode()
        offset = len(out)
        out += struct.pack('<IHHHHHIIIHH', 0x04034b50, 20, 0, method, 0, 0x21, crc, len(stream), size, len(nb), 0) + nb + stream
        central += struct.pack('<IHHHHHHIIIHHHHHII', 0x02014b50, 20, 20, 0, method, 0, 0x21, crc, len(stream), size, len(nb),
                               0, 0, 0, 0, 0o100644 << 16, offset) + nb
    eocd = struct.pack('<IHHHHIIH', 0x06054b50, 0, 0, len(members), len(members), len(central), len(out), 0)
    return bytes(out) + bytes(central) + eocd


def poke(blob, offset, fmt, value):
    data = bytearray(blob)
    struct.pack_into(fmt, data, offset, value)
    return bytes(data)


def regression_blobs():
    """Archives whose Python result is the oracle (name -> bytes)."""
    c = {}
    # F02: central compressed size reaches over the central directory (probe zip-overlap)
    stored = build([('safe', b'hello', {'compression': zipfile.ZIP_STORED})])
    c['overlap-central-intrusion'] = poke(stored, central_offsets(stored)[0] + 20, '<I', len(stored))
    # compressed data of the first member reaches into the second local header
    two = build([('a', b'A' * 3000, {'compression': zipfile.ZIP_STORED}), ('b', b'B', {'compression': zipfile.ZIP_STORED})])
    c['overlap-next-header'] = poke(two, central_offsets(two)[0] + 20, '<I', 3100)
    # both members share one local header (identical header offsets): CPython only warns
    single = build([('a', b'shared', {'compression': zipfile.ZIP_STORED})])
    cd = central_offsets(single)[0]
    record_end = single.index(b'PK\x05\x06')
    record = single[cd:record_end]
    eocd = bytearray(single[record_end:])
    struct.pack_into('<HH', eocd, 4, 0, 0)
    struct.pack_into('<HH', eocd, 8, 2, 2)
    struct.pack_into('<I', eocd, 12, len(record) * 2)
    second = bytearray(record)
    second[46] = ord('b')  # a second directory entry named 'b' pointing at the local header of 'a'
    c['overlap-same-offset-warns'] = single[:cd] + record + bytes(second) + bytes(eocd)
    # a smaller declared compressed size is fine for stored data; for deflate the stream is cut short
    deflated = build([('d', b'0123456789' * 50)])
    info = zipfile.ZipFile(io.BytesIO(deflated)).infolist()[0]
    c['deflate-cut-short'] = poke(deflated, central_offsets(deflated)[0] + 20, '<I', info.compress_size - 3)
    # the declared size is smaller than the stream: data[:file_size] with a CRC of the whole
    c['file-size-smaller'] = poke(deflated, central_offsets(deflated)[0] + 24, '<I', 3)
    short_crc = zlib.crc32(b'012')
    patched = poke(deflated, central_offsets(deflated)[0] + 24, '<I', 3)
    c['file-size-smaller-matching-crc'] = poke(patched, central_offsets(deflated)[0] + 16, '<I', short_crc)
    # F08: the extraction-system byte is not part of the version
    system = bytearray(build([('hello', b'hello')]))
    system[central_offsets(bytes(system))[0] + 7] = 3
    c['extract-system-byte'] = bytes(system)
    version = bytearray(build([('hello', b'hello')]))
    version[central_offsets(bytes(version))[0] + 6] = 64
    c['extract-version-too-new'] = bytes(version)
    # F07: names beginning with U+FEFF (a BOM inside the name, not a document marker)
    c['bom-name'] = build([('\ufeffname', b'bom'), ('name', b'plain')])
    # F17: invalid deflate block type in the first compressed byte
    blob = bytearray(build([('a', b'payload ' * 20)]))
    body = 30 + struct.unpack_from('<H', blob, 26)[0] + struct.unpack_from('<H', blob, 28)[0]
    blob[body] = 0xff
    c['corrupt-deflate-first'] = bytes(blob)
    # a corrupt deflate stream well into a compressible member: 200000 good bytes, then an invalid block header
    import random
    words = [b'alpha', b'bravo', b'charlie', b'delta', b'echo', b'foxtrot']
    text = b' '.join(random.Random(7).choice(words) for _ in range(40000))[:200000]
    packer = zlib.compressobj(6, zlib.DEFLATED, -15)
    stream = packer.compress(text) + packer.flush(zlib.Z_FULL_FLUSH) + b'\x07garbage after an invalid block header'
    c['corrupt-deflate-middle'] = manual_zip([('a', zlib.compress(b'small')[2:-4], 8, zlib.crc32(b'small'), 5),
                                              ('b', stream, 8, zlib.crc32(text), 300000), ('c', b'', 0, 0, 0)])
    # flags that only the central directory carries
    c['patched-flag-central-only'] = poke(build([('p', b'x')]), central_offsets(build([('p', b'x')]))[0] + 8, '<H', 0x20)
    c['strong-flag-central-only'] = poke(build([('p', b'x')]), central_offsets(build([('p', b'x')]))[0] + 8, '<H', 0x40)
    # header offset beyond the file / truncated local header
    far = build([('f', b'x')])
    c['header-offset-far'] = poke(far, central_offsets(far)[0] + 42, '<I', len(far) - 10)
    return c


class ZipRegressions(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if S.NODE is None:
            raise unittest.SkipTest('node >= 22 not available')
        cls.tmp = tempfile.TemporaryDirectory()
        cls.base = Path(cls.tmp.name).resolve()
        cls.blobs = regression_blobs()
        cls.py, cls.warnings, cls.dirs, spec = {}, {}, {}, []
        for label, blob in cls.blobs.items():
            archive = cls.base / f'{label}.zip'
            archive.write_bytes(blob)
            dirs = {}
            for side in ('py', 'js'):
                dest = cls.base / side / label
                dest.mkdir(parents=True)
                dirs[side] = dest
            cls.dirs[label] = dirs
            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter('always')
                cls.py[label] = python_extract(str(archive), str(dirs['py']))
            cls.warnings[label] = [str(w.message) for w in caught]
            spec.append({'id': label, 'archive': str(archive), 'dest': str(dirs['js'])})
        path = cls.base / 'spec.json'
        path.write_text(json.dumps(spec))
        result = S.run_node(RUNNER, path)
        if result.returncode:
            raise AssertionError(result.stderr)
        cls.node, cls.node_stderr = json.loads(result.stdout), result.stderr

    @classmethod
    def tearDownClass(cls):
        S.rmtree(cls.base)
        cls.tmp.cleanup()

    def normalize(self, text, label):
        for side in ('py', 'js'):
            for form in (str(self.dirs[label][side]), os.path.realpath(self.dirs[label][side])):
                text = text.replace(form, '<D>')
        return text

    def assert_same(self, label, tree=True):
        py, js = self.py[label], self.node[label]
        self.assertEqual(py['ok'], js['ok'], f'{label}: python={py} node={js}')
        if not py['ok']:
            self.assertEqual(py['name'], js['name'], f'{label}: {py} {js}')
            self.assertEqual(self.normalize(py['message'], label), self.normalize(js['message'], label), label)
        if tree:
            a, b = S.snapshot(self.dirs[label]['py']), S.snapshot(self.dirs[label]['js'])
            self.assertTrue(S.same_snapshot(a, b), f'{label}: trees differ\n{json.dumps(a, sort_keys=True)}\n'
                                                   f'{json.dumps(b, sort_keys=True)}')
        return py

    # -- F02
    def test_overlap_central_directory_intrusion(self):
        py = self.assert_same('overlap-central-intrusion')
        self.assertEqual(py['name'], 'BadZipFile')
        self.assertIn("Overlapped entries: 'safe' (possible zip bomb)", py['message'])
        self.assertFalse((self.dirs['overlap-central-intrusion']['js'] / 'safe').exists())

    def test_overlap_into_next_local_header(self):
        py = self.assert_same('overlap-next-header')
        self.assertEqual(py['name'], 'BadZipFile')
        self.assertFalse(list(self.dirs['overlap-next-header']['js'].iterdir()))

    def test_overlap_same_header_offset_only_warns(self):
        py = self.assert_same('overlap-same-offset-warns')
        # 'a' is extracted (with a warning); 'b' then fails because its directory name differs from the local header
        self.assertEqual((py['name'], py['message']), ('BadZipFile', "File name in directory 'b' and header b'a' differ."))
        self.assertTrue(any('Overlapped entries' in w for w in self.warnings['overlap-same-offset-warns']))
        self.assertIn("Overlapped entries: 'a' (possible zip bomb)", self.node_stderr)
        self.assertEqual((self.dirs['overlap-same-offset-warns']['js'] / 'a').read_bytes(), b'shared')

    def test_short_compressed_size_and_file_size(self):
        for label in ('deflate-cut-short', 'file-size-smaller', 'file-size-smaller-matching-crc'):
            self.assert_same(label)
        self.assertFalse(self.py['file-size-smaller']['ok'])
        self.assertTrue(self.py['file-size-smaller-matching-crc']['ok'])

    # -- F08 / F07 / F17 and flag handling
    def test_extraction_system_byte(self):
        self.assertTrue(self.assert_same('extract-system-byte')['ok'])
        py = self.assert_same('extract-version-too-new')
        self.assertEqual(py['name'], 'NotImplementedError')
        self.assertEqual(py['message'], 'zip file version 6.4')

    def test_utf8_bom_names_are_kept(self):
        self.assertTrue(self.assert_same('bom-name')['ok'])
        names = {p.name for p in self.dirs['bom-name']['js'].iterdir()}
        self.assertEqual(names, {'\ufeffname', 'name'})

    def test_corrupt_deflate_is_a_zlib_error_after_the_file_is_created(self):
        py = self.assert_same('corrupt-deflate-first')
        self.assertEqual(py['name'], 'error')
        self.assertTrue(py['message'].startswith('Error -3 while decompressing data'))
        self.assertEqual((self.dirs['corrupt-deflate-first']['js'] / 'a').read_bytes(), b'')
        py = self.assert_same('corrupt-deflate-middle')
        self.assertEqual(py['name'], 'error')
        # three whole 64 KiB reads were written before the failing one (the data of that call is lost)
        self.assertEqual(len((self.dirs['corrupt-deflate-middle']['js'] / 'b').read_bytes()), 3 * 65536)

    def test_flags_only_in_the_central_directory(self):
        self.assertEqual(self.assert_same('patched-flag-central-only')['name'], 'NotImplementedError')
        self.assertEqual(self.assert_same('strong-flag-central-only')['name'], 'NotImplementedError')

    def test_header_offset_beyond_the_file(self):
        self.assert_same('header-offset-far')


# ------------------------------------------------------------------------------------------------ Windows (F01)
def nt_key(path):
    return path.replace('/', '\\').lower().rstrip('\\')


class WindowsVFS:
    """A dict-based Windows filesystem used as the oracle's os/open: dirs and files by case-folded path."""

    def __init__(self, dirs):
        self.dirs = {nt_key(d) for d in dirs}
        self.files = {}
        self.calls = []

    def exists(self, path):
        return nt_key(path) in self.dirs or nt_key(path) in self.files

    def isdir(self, path):
        return nt_key(path) in self.dirs

    def mkdir(self, path, mode=0o777):
        self.calls.append(['mkdir', path])
        if self.exists(path):
            raise FileExistsError(errno.EEXIST, 'File exists', path)
        if nt_key(ntpath.dirname(path)) not in self.dirs:
            raise FileNotFoundError(errno.ENOENT, 'No such file or directory', path)
        self.dirs.add(nt_key(path))

    def makedirs(self, name, mode=0o777, exist_ok=False):
        head, tail = ntpath.split(name)
        if not tail:
            head, tail = ntpath.split(head)
        if head and tail and not self.exists(head):
            try:
                self.makedirs(head)
            except FileExistsError:
                pass
            if tail == '.':
                return
        self.mkdir(name)

    def open(self, path, mode='rb'):
        assert mode == 'wb', mode
        self.calls.append(['open', path])
        if nt_key(ntpath.dirname(path)) not in self.dirs:
            raise FileNotFoundError(errno.ENOENT, 'No such file or directory', path)
        if self.isdir(path):
            raise PermissionError(errno.EACCES, 'Permission denied', path)
        self.files[nt_key(path)] = bytearray()
        outer = self

        class Handle:
            def write(self, data):
                outer.files[nt_key(path)] += data
                return len(data)

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        return Handle()


def python_windows_extract(blob, dest, dirs):
    """CPython's real ZipFile.extractall with os replaced by a Windows (ntpath) shim over a virtual filesystem."""
    vfs = WindowsVFS(dirs)
    real_os = os

    class NtPath:
        def __getattr__(self, name):
            return getattr(ntpath, name)

        exists = staticmethod(vfs.exists)
        isdir = staticmethod(vfs.isdir)

    class OsShim:
        sep, altsep, curdir, pardir = '\\', '/', '.', '..'
        path = NtPath()
        makedirs = staticmethod(vfs.makedirs)
        mkdir = staticmethod(vfs.mkdir)

        def __getattr__(self, name):
            return getattr(real_os, name)

    try:
        with mock.patch.object(zipfile, 'os', OsShim()), mock.patch.object(zipfile, 'open', vfs.open, create=True):
            zipfile.ZipFile(io.BytesIO(blob)).extractall(dest)
        result = {'ok': True}
    except BaseException as exc:  # noqa: BLE001
        result = {'ok': False, 'name': type(exc).__name__, 'message': str(exc)}
    result['calls'] = vfs.calls
    result['files'] = {k: hashlib.sha256(bytes(v)).hexdigest() for k, v in sorted(vfs.files.items())}
    result['dirs'] = sorted(vfs.dirs)
    return result


import hashlib  # noqa: E402
from unittest import mock  # noqa: E402

WINDOWS_CASES = {
    # the release builder writes files only (scripts/build_bundle.py): parents must be created
    'file-only-release': ('C:\\stage', ['C:\\stage'],
                          [('release/bin/lcu', b'a'), ('release/lib/x/y.txt', b'b'), ('release/bundle.json', b'{}')]),
    'drive-root': ('C:\\', ['C:\\'], [('release/sub/f', b'x'), ('top', b'y')]),
    'unc-root': ('\\\\srv\\share\\stage', ['\\\\srv\\share\\', '\\\\srv\\share\\stage'], [('release/sub/f', b'x')]),
    'dest-with-trailing-sep': ('D:\\a b\\c\\', ['D:\\', 'D:\\a b', 'D:\\a b\\c'], [('r/s/t.txt', b't')]),
    'explicit-directories': ('C:\\stage', ['C:\\stage'], [('r/', b''), ('r/sub/', b''), ('r/sub/f', b'x'), ('r/empty/', b'')]),
    'existing-parents': ('C:\\stage', ['C:\\stage', 'C:\\stage\\release', 'C:\\stage\\release\\sub'], [('release/sub/f', b'x')]),
    'case-insensitive': ('C:\\stage', ['C:\\stage', 'C:\\STAGE\\Release'], [('release/f', b'x'), ('RELEASE/g', b'y')]),
    'dot-and-dotdot': ('C:\\stage', ['C:\\stage'], [('./a/../b/./c', b'x'), ('../../escape', b'y')]),
    'drive-and-unc-members': ('C:\\stage', ['C:\\stage'], [('C:/evil/x', b'x'), ('\\\\h\\s\\y', b'y'), ('D:rel', b'z')]),
    'illegal-characters': ('C:\\stage', ['C:\\stage'], [('a:b/c<d>.txt', b'x'), ('q?"*|x', b'y'), ('trail. /f. ', b'z')]),
    'backslash-members': ('C:\\stage', ['C:\\stage'], [('win\\style\\path', b'x'), ('mixed/and\\both', b'y')]),
    'file-over-directory': ('C:\\stage', ['C:\\stage', 'C:\\stage\\n'], [('n', b'x')]),
    'empty-name': ('C:\\stage', ['C:\\stage'], [('', b'x')]),
    'missing-destination-drive': ('Z:\\none', ['C:\\'], [('r/f', b'x')]),
    'missing-destination-created': ('C:\\stage\\deep', ['C:\\'], [('r/f', b'x')]),
}


class WindowsZipExtraction(unittest.TestCase):
    """F01: the Windows extraction path creates parents with ntpath semantics (CPython's own code is the oracle)."""

    @classmethod
    def setUpClass(cls):
        if S.NODE is None:
            raise unittest.SkipTest('node >= 22 not available')
        cls.tmp = tempfile.TemporaryDirectory()
        cls.base = Path(cls.tmp.name).resolve()
        spec, cls.expected = [], {}
        for label, (dest, dirs, entries) in WINDOWS_CASES.items():
            blob = build([(name, data, {'compression': zipfile.ZIP_DEFLATED}) for name, data in entries])
            archive = cls.base / f'{label}.zip'
            archive.write_bytes(blob)
            spec.append({'id': label, 'archive': str(archive), 'dest': dest, 'dirs': dirs})
            cls.expected[label] = python_windows_extract(blob, dest, dirs)
        path = cls.base / 'spec.json'
        path.write_text(json.dumps(spec))
        result = S.run_node(WINDOWS_RUNNER, path)
        if result.returncode:
            raise AssertionError(result.stderr)
        cls.node = json.loads(result.stdout)

    @classmethod
    def tearDownClass(cls):
        S.rmtree(cls.base)
        cls.tmp.cleanup()

    def test_matches_cpython_ntpath_extraction(self):
        failures = []
        for label in WINDOWS_CASES:
            py, js = self.expected[label], self.node[label]
            if py != js:
                failures.append(f'[{label}]\npython={json.dumps(py, indent=1)}\nnode={json.dumps(js, indent=1)}')
        self.assertFalse(failures, '\n'.join(failures[:4]))

    def test_the_review_probe_creates_its_parents(self):
        js = self.node['file-only-release']
        self.assertTrue(js['ok'], js)
        self.assertIn(['mkdir', 'C:\\stage\\release\\bin'], js['calls'])
        self.assertEqual(sorted(js['files']), ['c:\\stage\\release\\bin\\lcu', 'c:\\stage\\release\\bundle.json',
                                                'c:\\stage\\release\\lib\\x\\y.txt'])

    def test_error_cases_are_covered(self):
        names = {self.expected[label].get('name') for label in WINDOWS_CASES}
        self.assertIn('ValueError', names)  # empty name
        self.assertIn('PermissionError', names)  # a file where a directory is
        self.assertIn('FileNotFoundError', names)  # missing destination root path component


class NtPathFlavour(unittest.TestCase):
    """compat/pypath.mjs win32 flavour against CPython's ntpath over a corpus."""

    PATHS = ['', '.', '..', 'a', 'a\\b', 'a/b', 'C:', 'C:\\', 'C:/', 'C:a', 'C:\\a\\b', 'C:\\a\\..\\b', 'c:\\A\\\\b\\.\\c\\',
             '\\', '\\a', '/a/b', '\\\\srv\\share', '\\\\srv\\share\\', '\\\\srv\\share\\x\\y', '//srv/share/x',
             '\\\\?\\C:\\x', '\\\\?\\UNC\\srv\\share\\x', '\\\\.\\COM1', '..\\..\\a', 'a\\..\\..\\b', 'C:\\..\\a', 'C:..\\a',
             '\\\\srv', '\\\\srv\\', 'x:\\y\\', 'a\\\\\\b', '.\\a\\.', 'C:\\stage/release\\sub\\f', 'C:\\stage\\release\\sub\\']

    @classmethod
    def setUpClass(cls):
        if S.NODE is None:
            raise unittest.SkipTest('node >= 22 not available')

    def test_functions_match_ntpath(self):
        pairs = [(a, b) for a in self.PATHS for b in ('', 'f', 'sub\\f', '\\abs', 'D:\\other', 'c:rel', 'C:\\Other', 'x/y')]
        script = (f'import {{win32}} from "{S.ROOT / "lcu/compat/pypath.mjs"}";'
                  'const {paths, pairs} = JSON.parse(process.argv[1]);'
                  'console.log(JSON.stringify({split: paths.map((p) => win32.split(p)), dirname: paths.map((p) => win32.dirname(p)),'
                  'normpath: paths.map((p) => win32.normpath(p)), isabs: paths.map((p) => win32.isabs(p)),'
                  'splitdrive: paths.map((p) => win32.splitdrive(p)), join: pairs.map(([a, b]) => win32.join(a, b))}));')
        out = subprocess.run([S.NODE, '--input-type=module', '-e', script, json.dumps({'paths': self.PATHS, 'pairs': pairs})],
                             capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        got = json.loads(out.stdout)
        self.assertEqual(got['split'], [list(ntpath.split(p)) for p in self.PATHS])
        self.assertEqual(got['dirname'], [ntpath.dirname(p) for p in self.PATHS])
        self.assertEqual(got['normpath'], [ntpath.normpath(p) for p in self.PATHS])
        self.assertEqual(got['isabs'], [ntpath.isabs(p) for p in self.PATHS])
        self.assertEqual(got['splitdrive'], [list(ntpath.splitdrive(p)) for p in self.PATHS])
        self.assertEqual(got['join'], [ntpath.join(a, b) for a, b in pairs])


# ---------------------------------------------------------------------------------------------- bounded inflation
def bomb_zip(file_size=1, declared=b'\0'):
    """A tiny ZIP whose deflate stream expands to 32 MiB of zeros while the directory declares `file_size` bytes."""
    packed = zlib.compressobj(9, zlib.DEFLATED, -15)
    stream = packed.compress(b'\0' * (32 << 20)) + packed.flush()
    return manual_zip([('bomb', stream, 8, zlib.crc32(declared), file_size)])


def tar_with_bomb_tail():
    """One small member, the end-of-archive blocks, then 32 MiB of compressible data inside the same gzip stream."""
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode='w') as archive:
        info = tarfile.TarInfo('f')
        info.size = 5
        archive.addfile(info, io.BytesIO(b'hello'))
    raw = out.getvalue()
    compressor = zlib.compressobj(9, zlib.DEFLATED, 31)
    packed = compressor.compress(raw[:raw.index(b'\0' * 1024)] + b'\0' * 1024) + compressor.compress(b'\0' * (32 << 20))
    return packed + compressor.flush()


class BoundedInflation(unittest.TestCase):
    """F03: nothing is inflated beyond what CPython's reads would inflate."""

    @classmethod
    def setUpClass(cls):
        if S.NODE is None:
            raise unittest.SkipTest('node >= 22 not available')
        cls.tmp = tempfile.TemporaryDirectory()
        cls.base = Path(cls.tmp.name).resolve()

    @classmethod
    def tearDownClass(cls):
        S.rmtree(cls.base)
        cls.tmp.cleanup()

    def run_bounded(self, kind, blob):
        archive = self.base / f'a.{kind}'
        archive.write_bytes(blob)
        dest = Path(tempfile.mkdtemp(dir=self.base, prefix=f'{kind}-out-'))
        spec = self.base / 'spec.json'
        spec.write_text(json.dumps({'kind': kind, 'archive': str(archive), 'dest': str(dest)}))
        result = S.run_node(BOUNDED_RUNNER, spec)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout), dest

    def test_zip_declaring_one_byte_inflates_one_read_window(self):
        blob = bomb_zip()
        self.assertLess(len(blob), 40000)
        result, dest = self.run_bounded('zip', blob)
        self.assertTrue(result['ok'], result)
        self.assertEqual((dest / 'bomb').read_bytes(), b'\0')
        python_dest = Path(tempfile.mkdtemp(dir=self.base, prefix='zip-py-'))
        archive = self.base / 'a.zip'
        self.assertEqual(python_extract(str(archive), str(python_dest)), {'ok': True})
        self.assertEqual((python_dest / 'bomb').read_bytes(), b'\0')
        # CPython decompresses at most one 64 KiB window (max_length) for this member
        self.assertLessEqual(result['inflated'], 64 * 1024 + 4096, result)

    def test_zip_with_a_larger_declared_size_stops_at_that_size(self):
        blob = bomb_zip(file_size=100000, declared=b'\0' * 100000)
        result, dest = self.run_bounded('zip', blob)
        self.assertTrue(result['ok'], result)
        self.assertEqual(len(((dest / 'bomb').read_bytes())), 100000)
        self.assertLessEqual(result['inflated'], 2 * 64 * 1024 + 4096, result)

    @unittest.skipIf(FALLBACK, 'the one-shot fallback inflates up to its bound (test_inflate_fallback.py covers it)')
    def test_tar_never_inflates_the_data_behind_the_end_of_archive_blocks(self):
        blob = tar_with_bomb_tail()
        self.assertLess(len(blob), 40000)
        result, dest = self.run_bounded('tar', blob)
        self.assertTrue(result['ok'], result)
        self.assertEqual((dest / 'f').read_bytes(), b'hello')
        self.assertLessEqual(result['inflated'], 256 * 1024, result)
        python_dest = Path(tempfile.mkdtemp(dir=self.base, prefix='tar-py-'))
        self.assertEqual(python_extract_tar(str(self.base / 'a.tar'), str(python_dest)), {'ok': True})


def python_extract_tar(archive, dest):
    try:
        update_apply._extract_tar(archive, dest)
        return {'ok': True}
    except BaseException as exc:  # noqa: BLE001
        return {'ok': False, 'name': type(exc).__name__, 'message': str(exc)}


class UnsupportedZipCompression(unittest.TestCase):
    """F20 (update review): bzip2/lzma ZIPs are refused as a BadZipFile, which update_apply reports and cleans up."""

    @classmethod
    def setUpClass(cls):
        if S.NODE is None:
            raise unittest.SkipTest('node >= 22 not available')

    def test_refusal_is_a_bad_zip_file_with_a_clear_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows = []
            for label, method in (('bzip2', zipfile.ZIP_BZIP2), ('lzma', zipfile.ZIP_LZMA)):
                path = Path(tmp, f'{label}.zip')
                path.write_bytes(build([('b', b'x' * 100, {'compression': method})]))
                dest = Path(tmp, label)
                dest.mkdir()
                rows.append((path, dest))
            script = (f'import {{extractLcuZip, BadZipFile, NotImplementedError}} from "{S.ROOT / "lcu/compat/zip.mjs"}";'
                      'const out = [];'
                      'for (const [archive, dest] of JSON.parse(process.argv[1])) {'
                      ' try { extractLcuZip(archive, dest); out.push("extracted"); }'
                      ' catch (e) { out.push([e.name, e instanceof BadZipFile, e instanceof NotImplementedError, e.message]); } }'
                      'console.log(JSON.stringify(out));')
            import subprocess
            result = subprocess.run([S.NODE, '--input-type=module', '-e', script, json.dumps([[str(a), str(d)] for a, d in rows])],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            got = json.loads(result.stdout)
            self.assertEqual([r[:3] for r in got], [['UnsupportedCompression', True, False]] * 2)
            self.assertIn('compression type 12 (bzip2)', got[0][3])
            self.assertIn('compression type 14 (lzma)', got[1][3])
            for _, dest in rows:
                self.assertEqual(list(dest.iterdir()), [], 'nothing is created before the refusal')


if __name__ == '__main__':
    unittest.main()
