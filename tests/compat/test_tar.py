"""Differential test: lcu/compat/tar.mjs against Python 3.12 tarfile (`filter='data'`) and update_apply._extract_tar."""
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import sys
import tarfile
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import compat_support as S  # noqa: E402
from lcu import update_apply  # noqa: E402

snapshot, same_snapshot = S.snapshot, S.same_snapshot
RUNNER = S.ROOT / 'tests/compat/run_tar.mjs'


def entry(name, kind='file', data=b'', mode=None, mtime=1700000000, linkname='', uid=1000, gid=1000,
          uname='user', gname='group', major=0, minor=0, type=None):
    return dict(name=name, kind=kind, data=data, mode=mode, mtime=mtime, linkname=linkname, uid=uid, gid=gid,
                uname=uname, gname=gname, major=major, minor=minor, type=type)


def raw_tar(entries, fmt=tarfile.GNU_FORMAT, pax_headers=None):
    buffer = io.BytesIO()
    kwargs = {'pax_headers': pax_headers} if pax_headers else {}
    with tarfile.open(fileobj=buffer, mode='w', format=fmt, **kwargs) as archive:
        for e in entries:
            info = tarfile.TarInfo(e['name'])
            kind = e['kind']
            info.type = e['type'] or {'file': tarfile.REGTYPE, 'dir': tarfile.DIRTYPE, 'sym': tarfile.SYMTYPE,
                                      'hard': tarfile.LNKTYPE, 'fifo': tarfile.FIFOTYPE, 'chr': tarfile.CHRTYPE,
                                      'blk': tarfile.BLKTYPE}[kind]
            info.mode = e['mode'] if e['mode'] is not None else (0o755 if kind == 'dir' else 0o644)
            info.mtime, info.uid, info.gid = e['mtime'], e['uid'], e['gid']
            info.uname, info.gname = e['uname'], e['gname']
            info.linkname = e['linkname']
            info.devmajor, info.devminor = e['major'], e['minor']
            info.size = len(e['data']) if kind == 'file' or info.type not in (tarfile.DIRTYPE, tarfile.SYMTYPE,
                                                                               tarfile.LNKTYPE, tarfile.FIFOTYPE,
                                                                               tarfile.CHRTYPE, tarfile.BLKTYPE) else 0
            archive.addfile(info, io.BytesIO(e['data']) if info.size else None)
    return buffer.getvalue()


def gz(raw):
    return gzip.compress(raw, mtime=0)


def F(name, data=b'x', **kw):
    return entry(name, 'file', data, **kw)


def D(name, **kw):
    return entry(name, 'dir', **kw)


def L(name, target, **kw):
    return entry(name, 'sym', linkname=target, **kw)


def H(name, target, **kw):
    return entry(name, 'hard', linkname=target, **kw)


def prefill_none(dest):
    pass


def prefill_existing(dest):
    (dest / 'f').write_text('old content that is long')
    os.chmod(dest / 'f', 0o600)
    (dest / 'd').mkdir()
    (dest / 'd/inner').write_text('keep')
    (dest / 'target').write_text('target-old')
    os.symlink('target', dest / 'viasym')
    os.symlink('d', dest / 'dirlink')
    (dest / 'blocker').write_text('i am a file')


def python_extract(archive, dest, mode):
    try:
        if mode == 'lcu':
            update_apply._extract_tar(archive, dest)
        else:
            with tarfile.open(archive, 'r:gz') as bundle:
                bundle.extractall(dest, bundle.getmembers(), filter='data')
        return {'ok': True}
    except BaseException as exc:  # noqa: BLE001 - the whole point is to compare whatever Python raises
        return {'ok': False, 'name': type(exc).__name__, 'message': str(exc)}


def benign_cases():
    big = bytes(range(256)) * 900
    cases = {}
    cases['plain'] = [D('r'), F('r/a.txt', b'hello'), F('r/b.bin', big), D('r/sub'), F('r/sub/c', b'')]
    cases['modes'] = [F(f'm{i}', b'm', mode=m) for i, m in enumerate(
        [0o755, 0o644, 0o4755, 0o2755, 0o1777, 0o777, 0o000, 0o700, 0o070, 0o666, 0o100755, 0o120777, 0o7777, 0o111,
         0o600, 0o444, 0o10000, 0o200])]
    cases['dir-modes'] = [D(f'd{i}', mode=m) for i, m in enumerate([0o700, 0o555, 0o777, 0o2755, 0o000, 0o1777])] + [
        F('d0/x'), F('d4x', b'1')]
    cases['dir-mtimes'] = [D('a', mtime=100), F('a/b', mtime=200), D('a/c', mtime=300), F('a/c/d', mtime=50)]
    cases['implicit-parents'] = [F('x/y/z/file', b'deep'), F('p/q', b'1')]
    cases['dot-slash'] = [D('./'), D('./top/'), F('./top/f', b'dot'), F('./g', b'g')]
    cases['dir-trailing-slash'] = [D('t/'), F('t/f')]
    cases['symlinks'] = [F('real', b'data'), L('rel', 'real'), L('dangling', 'nowhere'), D('dd'), F('dd/f'),
                         L('dd/up', '../real'), L('todir', 'dd'), L('dot', '.'), L('self', 'self')]
    cases['hardlinks'] = [F('orig', b'content', mode=0o755), H('link1', 'orig', mode=0o600),
                          H('link2', 'orig', mode=0o4755, mtime=5), D('sub'), H('sub/link3', 'orig')]
    cases['hardlink-fallback-exists'] = [F('orig', b'content'), F('l', b'old'), H('l', 'orig')]
    cases['hardlink-target-missing'] = [H('l', 'nonexistent')]
    cases['hardlink-before-target'] = [H('l', 'later'), F('later', b'x')]
    cases['hardlink-to-hardlink'] = [F('o', b'z'), H('l1', 'o'), H('l2', 'l1'), H('l3', 'l1')]
    cases['hardlink-to-symlink'] = [F('o', b'z'), L('s', 'o'), H('h', 's')]
    cases['overwrite-file'] = [F('f', b'first-version-longer'), F('f', b'second', mode=0o755)]
    cases['file-then-dir'] = [F('n', b'x'), D('n')]
    cases['dir-then-file'] = [D('n'), F('n', b'x')]
    cases['file-then-symlink'] = [F('n', b'x'), L('n', 'other')]
    cases['symlink-then-file'] = [F('target', b'orig'), L('s', 'target'), F('s', b'through')]
    cases['dirlink-then-file'] = [D('real'), L('lnk', 'real'), F('lnk/f', b'via link')]
    cases['file-under-file'] = [F('f', b'x'), F('f/g', b'y')]
    cases['unicode'] = [F('caf\u00e9.txt', b'1'), F('\u65e5\u672c/\U0001f600.bin', b'2'), L('sym\u00e9', 'caf\u00e9.txt'),
                        D('d\u00fc/')]
    cases['uid-gid'] = [F('big', uid=2 ** 31, gid=2 ** 32 - 1, uname='root', gname='wheel'), F('neg', mtime=-5)]
    cases['long-100'] = [F('a' * 100, b'l100')]
    cases['long-name-155-split'] = [F('/'.join(['d' * 50] * 3) + '/' + 'f' * 40, b'split')]
    cases['long-name-300'] = [F('/'.join(['segment'] * 40) + '/file', b'longname')]
    cases['long-link'] = [F('t', b'z'), L('l' * 20, 'x/' * 60 + 'y')]
    cases['empty-archive'] = []
    cases['zero-size'] = [F('empty', b'')]
    cases['many'] = [F(f'dir{i % 5}/file{i}', str(i).encode() * (i + 1)) for i in range(60)]
    cases['cont-type'] = [entry('c', 'file', b'cont', type=tarfile.CONTTYPE), entry('a', 'file', b'areg',
                                                                                     type=tarfile.AREGTYPE)]
    cases['unknown-type-file'] = [entry('z', 'file', b'zz', type=b'Z')]
    return cases


def hostile_cases():
    """Archives rejected somewhere (by LCU's pre-checks, by the data filter, or both)."""
    cases = {}
    cases['dotdot-start'] = [F('ok', b'1'), F('../evil', b'x'), F('after')]
    cases['dotdot-middle'] = [D('a'), F('a/../../evil', b'x')]
    cases['dotdot-inside-ok-lexically'] = [D('a'), F('a/../b', b'x')]
    cases['absolute'] = [F('/abs/evil', b'x')]
    cases['absolute-slashes'] = [F('///abs/evil', b'x')]
    cases['abs-dir'] = [D('/abs')]
    cases['windows-drive'] = [F('C:\\evil', b'x')]
    cases['windows-drive-rel'] = [F('C:evil', b'x')]
    cases['windows-unc'] = [F('\\\\srv\\share\\x', b'x')]
    cases['windows-dotdot'] = [F('a\\..\\b', b'x')]
    cases['backslash-plain'] = [F('a\\b', b'x'), F('\\rooted', b'y')]
    cases['colon-name'] = [F('1:foo', b'x')]
    cases['abs-symlink'] = [L('l', '/etc/passwd')]
    cases['abs-hardlink'] = [F('o'), H('l', '/etc/passwd')]
    cases['symlink-dotdot'] = [L('l', '..')]
    cases['symlink-dotdot-file'] = [L('l', '../x')]
    cases['symlink-nested-escape'] = [D('a'), L('a/l', '../../x')]
    cases['symlink-nested-ok'] = [D('a/b'), L('a/b/l', '../../c'), F('c', b'c')]
    cases['symlink-windows-drive'] = [L('l', 'C:\\x')]
    cases['hardlink-dotdot'] = [F('o'), H('l', '../o')]
    cases['hardlink-dotdot-lexical'] = [F('o'), H('l', 'a/../o')]
    cases['symlink-realpath-escape'] = [L('d', '.'), L('l', 'd/../x')]
    cases['symlink-realpath-escape-file'] = [L('d', '.'), F('d/../escape', b'x')]
    cases['via-symlink-dir'] = [L('d', '.'), D('sub'), F('d/sub/ok', b'1')]
    cases['dev-char'] = [entry('c', 'chr', major=1, minor=3)]
    cases['dev-block'] = [entry('b', 'blk', major=8, minor=0)]
    cases['fifo'] = [F('before'), entry('p', 'fifo'), F('after')]
    cases['dev-after-good'] = [F('good1', b'g'), D('dd'), entry('dd/dev', 'chr', major=1, minor=5)]
    return cases


FORMATS = {'gnu': tarfile.GNU_FORMAT, 'pax': tarfile.PAX_FORMAT, 'ustar': tarfile.USTAR_FORMAT}


class TarDifferentialTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if S.NODE is None:
            raise unittest.SkipTest('node >= 22 not available')
        cls.tmp = tempfile.TemporaryDirectory()
        cls.base = Path(cls.tmp.name).resolve()
        cls.specs = []
        cls.python_results = {}
        cls.job_dirs = {}
        cls.count = 0

    @classmethod
    def tearDownClass(cls):
        S.rmtree(cls.base)
        cls.tmp.cleanup()

    # -- helpers
    @classmethod
    def add(cls, label, archive_bytes, mode, prefill=prefill_none):
        cls.count += 1
        ident = f'{cls.count:04d}-{label}-{mode}'
        archive = cls.base / f'{ident}.tgz'
        archive.write_bytes(archive_bytes)
        dirs = {}
        for side in ('py', 'js'):
            dest = cls.base / side / ident
            dest.mkdir(parents=True)
            prefill(dest)
            dirs[side] = dest
        cls.specs.append({'id': ident, 'archive': str(archive), 'dest': str(dirs['js']), 'mode': mode})
        cls.python_results[ident] = python_extract(str(archive), str(dirs['py']), mode)
        cls.job_dirs[ident] = dirs
        return ident

    @classmethod
    def node_results(cls):
        if not hasattr(cls, '_node'):
            spec = cls.base / 'spec.json'
            spec.write_text(json.dumps(cls.specs))
            result = S.run_node(RUNNER, spec)
            if result.returncode:
                raise AssertionError(result.stderr)
            cls._node = json.loads(result.stdout)
        return cls._node

    def normalize(self, text, ident):
        dirs = self.job_dirs[ident]
        for side in ('py', 'js'):
            for form in (str(dirs[side]), os.path.realpath(dirs[side])):
                text = text.replace(form, '<D>')
        for side in ('py', 'js'):
            text = text.replace(str(self.base / side), '<B>/SIDE')
        return text.replace(str(self.base), '<B>')

    def compare(self, ident):
        py, js = self.python_results[ident], self.node_results()[ident]
        dirs = self.job_dirs[ident]
        self.assertEqual(py['ok'], js['ok'], f'{ident}: python={py} node={js}')
        if not py['ok']:
            self.assertEqual(py['name'], js['name'], f'{ident}: {py} {js}')
            self.assertEqual(self.normalize(py['message'], ident), self.normalize(js['message'], ident), ident)
        a, b = snapshot(dirs['py']), snapshot(dirs['js'])
        # a symlink whose target lies inside the per-side tree (the prefilled "outside" directory) differs only by side
        for side, snap in (('py', a), ('js', b)):
            for entry in snap.values():
                if entry[0] == 'symlink' and isinstance(entry[2], str):
                    entry[2] = entry[2].replace(str(self.base / side), '<B>/SIDE')
        self.assertTrue(same_snapshot(a, b), f'{ident}: trees differ\npython={json.dumps(a, indent=1, sort_keys=True)}'
                                             f'\nnode={json.dumps(b, indent=1, sort_keys=True)}')
        return py


def make_tests():
    # Cases are registered eagerly in one class-level pass so Node runs once per mode batch.
    jobs = []
    for label, entries in benign_cases().items():
        for fmt_name, fmt in FORMATS.items():
            if fmt_name == 'ustar' and label.startswith(('long-name-300', 'long-link', 'unicode', 'uid-gid')):
                continue
            try:
                raw = raw_tar(entries, fmt)
            except (ValueError, tarfile.TarError):
                continue
            for mode in ('lcu', 'raw'):
                jobs.append((f'{label}-{fmt_name}', gz(raw), mode, prefill_none))
        raw = raw_tar(entries)
        for mode in ('lcu', 'raw'):
            jobs.append((f'{label}-existing', gz(raw), mode, prefill_existing))
    for label, entries in hostile_cases().items():
        raw = raw_tar(entries)
        for mode in ('lcu', 'raw'):
            jobs.append((f'{label}', gz(raw), mode, prefill_none))
            jobs.append((f'{label}-existing', gz(raw), mode, prefill_existing))
    return jobs


class TarCases(TarDifferentialTest):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.idents = [cls.add(*job) for job in make_tests()]

    def test_all_archives(self):
        failures = []
        for ident in self.idents:
            try:
                self.compare(ident)
            except AssertionError as exc:
                failures.append(str(exc)[:1500])
        self.assertFalse(failures, f'{len(failures)} of {len(self.idents)} differ:\n' + '\n----\n'.join(failures[:6]))

    def test_error_text_forms(self):
        """Pin the exact Python wording the Node module must reproduce for the headline rejections."""
        seen = {}
        for ident in self.idents:
            py = self.python_results[ident]
            if not py['ok']:
                seen.setdefault(py['name'], self.normalize(py['message'], ident))
        for name in ('ValueError', 'OutsideDestinationError', 'SpecialFileError',
                     'AbsoluteLinkError', 'LinkOutsideDestinationError'):
            self.assertIn(name, seen, f'no case produced {name}; saw {sorted(seen)}')
        self.assertTrue(seen['SpecialFileError'].endswith('is a special file'))


class TarArchiveFaults(TarDifferentialTest):
    """Corrupt, truncated and unusual container-level inputs."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        raw = raw_tar([F('f0', os.urandom(3000)), F('f1', os.urandom(5000)), F('f2', os.urandom(40000))])
        packed = gz(raw)
        faults = {
            'not-gzip': b'hello world' * 100,
            'one-byte': b'x',
            'zero-bytes': b'',
            'gzip-empty': gz(b''),
            'truncated-gzip': packed[:len(packed) // 2],
            'truncated-trailer': packed[:-4],
            'bad-crc-trailer': packed[:-8] + b'\0\0\0\0' + packed[-4:],
            'garbage-after-gzip': packed + b'xxxxxxxx',
            'zero-pad-after-gzip': packed + b'\0' * 20,
            'tar-truncated-in-data': gz(raw[:1024 + 3072]),
            'tar-truncated-in-header': gz(raw[:1000]),
            'tar-truncated-block': gz(raw[:700]),
            'bad-checksum-first': gz(raw[:148] + b'0000000\0' + raw[156:]),
            'bad-number-first': gz(raw[:148] + b'9' * 8 + raw[156:]),
            'garbage-header-later': gz(raw[:512 + 3072 + 0] + b'\x07' * 512 + raw[512 + 3072:]),
            'only-zero-blocks': gz(b'\0' * 1024),
            'one-zero-block': gz(b'\0' * 512),
            'short-file': gz(b'abc'),
            'no-end-marker': gz(raw[:raw.index(b'\0' * 1024, 1024)] if b'\0' * 1024 in raw[1024:] else raw),
            'multi-member-gzip': gzip.compress(raw[:4096], mtime=0) + gzip.compress(raw[4096:], mtime=0),
            'gzip-with-name': gzip.compress(raw, mtime=0)[:3] + b'\x08' + gzip.compress(raw, mtime=0)[4:10] + b'name.tar\0'
            + gzip.compress(raw, mtime=0)[10:],
        }
        cls.fault_ids = {label: cls.add(label, blob, mode) for label, blob in faults.items() for mode in ('lcu',)}

    def test_faults(self):
        failures = []
        for label, ident in self.fault_ids.items():
            try:
                self.compare(ident)
            except AssertionError as exc:
                failures.append(f'[{label}] {str(exc)[:900]}')
        self.assertFalse(failures, '\n----\n'.join(failures))


class TarPaxGnu(TarDifferentialTest):
    """Hand-built PAX / GNU long header records."""

    @staticmethod
    def pax_record(key, value):
        body = f' {key}={value}\n'.encode()
        length = len(body) + len(str(len(body)))
        length = len(body) + len(str(length))
        return str(length).encode() + body

    @classmethod
    def header(cls, name, size, type_, mode=0o644, mtime=1700000000, linkname=''):
        info = tarfile.TarInfo(name)
        info.size, info.type, info.mode, info.mtime, info.linkname = size, type_, mode, mtime, linkname
        return info.tobuf(tarfile.USTAR_FORMAT, 'utf-8', 'surrogateescape')

    @classmethod
    def pad(cls, data):
        return data + b'\0' * (-len(data) % 512)

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        r = cls.pax_record
        h = cls.header
        ends = b'\0' * 1024
        cases = {}
        body = b'payload'
        cases['pax-path-override'] = (h('short', 7, b'0') if False else
                                      h('PaxHeader', len(r('path', 'long/dir/name.txt')), b'x')
                                      + cls.pad(r('path', 'long/dir/name.txt')) + h('short', 7, b'0') + cls.pad(body))
        cases['pax-mtime-float'] = (h('PaxHeader', len(r('mtime', '1600000000.75')), b'x')
                                    + cls.pad(r('mtime', '1600000000.75')) + h('f', 7, b'0') + cls.pad(body))
        cases['pax-mtime-bad'] = (h('PaxHeader', len(r('mtime', 'abc')), b'x') + cls.pad(r('mtime', 'abc'))
                                  + h('f', 7, b'0') + cls.pad(body))
        cases['pax-size-override'] = (h('PaxHeader', len(r('size', '3')), b'x') + cls.pad(r('size', '3'))
                                      + h('f', 7, b'0') + cls.pad(body[:3]) + h('g', 7, b'0') + cls.pad(body))
        cases['pax-global'] = (h('GlobalHead', len(r('mtime', '1234567890')), b'g') + cls.pad(r('mtime', '1234567890'))
                               + h('a', 7, b'0') + cls.pad(body) + h('b', 7, b'0') + cls.pad(body))
        cases['pax-linkpath'] = (h('PaxHeader', len(r('linkpath', 'tgt/' * 40)), b'x')
                                 + cls.pad(r('linkpath', 'tgt/' * 40)) + h('l', 0, b'2') + h('f', 0, b'0'))
        cases['pax-dir-slash'] = (h('PaxHeader', len(r('path', 'pd/')), b'x') + cls.pad(r('path', 'pd/'))
                                  + h('x', 0, b'5'))
        cases['pax-unicode'] = (h('PaxHeader', len(r('path', '\u00e9/\u65e5')), b'x')
                                + cls.pad(r('path', '\u00e9/\u65e5').encode() if False else r('path', '\u00e9/\u65e5'))
                                + h('f', 7, b'0') + cls.pad(body))
        cases['pax-bad-record'] = h('PaxHeader', 8, b'x') + cls.pad(b'garbage\n') + h('f', 7, b'0') + cls.pad(body)
        cases['pax-uid'] = (h('PaxHeader', len(r('uid', '99999999999')), b'x') + cls.pad(r('uid', '99999999999'))
                            + h('f', 7, b'0') + cls.pad(body))
        long_name = ('seg/' * 60 + 'file').encode()
        cases['gnu-longname'] = (h('././@LongLink', len(long_name) + 1, b'L') + cls.pad(long_name + b'\0')
                                 + h('x' * 50, 7, b'0') + cls.pad(body))
        cases['gnu-longname-dir'] = (h('././@LongLink', len(long_name) + 2, b'L') + cls.pad(long_name + b'/\0')
                                     + h('x', 0, b'5'))
        link = ('t/' * 90 + 'x').encode()
        cases['gnu-longlink'] = (h('././@LongLink', len(link) + 1, b'K') + cls.pad(link + b'\0')
                                 + h('lnk', 0, b'2', linkname='trunc'))
        cases['gnu-longname-then-eof'] = h('././@LongLink', 10, b'L') + cls.pad(b'abcdefghi\0')
        cases['gnu-longname-bad-next'] = h('././@LongLink', 10, b'L') + cls.pad(b'abcdefghi\0') + b'\x01' * 512
        cases['gnu-longname-abs'] = (h('././@LongLink', 12, b'L') + cls.pad(b'/etc/evil\0\0\0')
                                     + h('x', 7, b'0') + cls.pad(body))
        cases['gnu-longname-dotdot'] = (h('././@LongLink', 12, b'L') + cls.pad(b'../../evil\0\0')
                                        + h('x', 7, b'0') + cls.pad(body))
        cases['sparse-type'] = h('s', 7, b'S') + cls.pad(body)
        cases['old-v7-dir'] = h('v7dir/', 0, b'\0') + h('v7dir/f', 7, b'0') + cls.pad(body)
        cases['v7-regular-slash'] = h('regfile', 7, b'\0') + cls.pad(body)
        cases['negative-size-field'] = None
        cls.ids = {}
        for label, blob in cases.items():
            if blob is None:
                continue
            for mode in ('lcu', 'raw'):
                cls.ids[f'{label}-{mode}'] = cls.add(label, gz(blob + ends), mode)

    def test_pax_gnu(self):
        failures = []
        for label, ident in self.ids.items():
            try:
                self.compare(ident)
            except AssertionError as exc:
                failures.append(f'[{label}] {str(exc)[:900]}')
        self.assertFalse(failures, '\n----\n'.join(failures))


class TarUnitTests(unittest.TestCase):
    """Name-safety predicate and pax/number parsing on adversarial strings."""

    @classmethod
    def setUpClass(cls):
        if S.NODE is None:
            raise unittest.SkipTest('node >= 22 not available')

    def test_unsafe_name_matches_python(self):
        names = ['', '.', './', 'a', 'a/b', '/a', '//a', '///a', 'a/../b', '..', '../a', 'a/..', 'a/./b', 'a//b',
                 'C:\\x', 'C:x', 'c:', '1:a', '\\\\srv\\sh', '\\\\srv', '\\\\\\x', '\\x', 'a\\b', 'a\\..\\b', '..\\x',
                 'a:b/c', 'a/b:c', '//?/C:/x', '\\\\?\\C:\\x', 'x\\y/..', '...', 'a/...', '.hidden', '\u00e9:x', 'é/..']
        script = ('import {unsafeName} from "%s"; const names = JSON.parse(process.argv[1]);'
                  'console.log(JSON.stringify(names.map(unsafeName)));' % (S.ROOT / 'lcu/compat/tar.mjs'))
        result = S.run_node('--input-type=module', '-e', script, json.dumps(names)) if False else __import__(
            'subprocess').run([S.NODE, '--input-type=module', '-e', script, json.dumps(names)], capture_output=True,
                              text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        expected = [update_apply._unsafe(name) for name in names]
        self.assertEqual(json.loads(result.stdout), [bool(x) for x in expected], names)


# ---------------------------------------------------------------------------------------------------------------
# Regression tests for the compat-archive-http review: F03 (lazy gzip: unused tails, error classes), F07 (BOM),
# F09 (PAX number grammar and os.utime classification), F11 (NUL paths) and gzip container details.
# ---------------------------------------------------------------------------------------------------------------
import struct  # noqa: E402
import zlib  # noqa: E402


def pax_tar(entries):
    """entries: (name, kind, value, pax_headers); kind file/sym/hard/dir. PAX format, uncompressed."""
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode='w', format=tarfile.PAX_FORMAT) as archive:
        for name, kind, value, pax in entries:
            info = tarfile.TarInfo(name)
            info.pax_headers = dict(pax)
            info.mtime = 1700000000
            if kind == 'file':
                info.size = len(value)
                archive.addfile(info, io.BytesIO(value))
            else:
                info.type = {'sym': tarfile.SYMTYPE, 'hard': tarfile.LNKTYPE, 'dir': tarfile.DIRTYPE}[kind]
                info.linkname = value
                archive.addfile(info)
    return out.getvalue()


def gzip_member(data, flags=0, extra=b'', name=b'', comment=b'', method=8, crc=None, size=None, trailer=True):
    """One gzip member written by hand (the header fields Python's gzip module reads and discards are exercised)."""
    header = b'\x1f\x8b' + bytes([method, flags]) + b'\0\0\0\0' + b'\x00\x03'
    if flags & 4:
        header += struct.pack('<H', len(extra)) + extra
    if flags & 8:
        header += name + b'\0'
    if flags & 16:
        header += comment + b'\0'
    if flags & 2:
        header += b'\xab\xcd'
    packer = zlib.compressobj(9, zlib.DEFLATED, -15)
    body = packer.compress(data) + packer.flush()
    if not trailer:
        return header + body
    return header + body + struct.pack('<II', zlib.crc32(data) if crc is None else crc,
                                       len(data) & 0xffffffff if size is None else size)


def broken_deflate_gzip(raw, cut):
    """The first `cut` bytes of raw deflated and flushed, then an invalid deflate block header."""
    packer = zlib.compressobj(6, zlib.DEFLATED, -15)
    return (b'\x1f\x8b\x08\x00\0\0\0\0\x00\x03' + packer.compress(raw[:cut]) + packer.flush(zlib.Z_FULL_FLUSH)
            + b'\x07not a deflate block' + b'\0' * 8)


class TarRegressions(TarDifferentialTest):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.groups = {}

        def add(group, label, blob, modes=('lcu', 'raw')):
            cls.groups.setdefault(group, []).extend(cls.add(f'{group}-{label}', blob, mode) for mode in modes)

        # -- F09: PAX numeric grammar and os.utime classification (the member is written, then utime may fail)
        for label, value in {'nan': 'nan', 'nan-upper': 'NaN', 'nan-signed': '-nan', 'inf': 'inf', 'minus-inf': '-inf',
                             'infinity': '+Infinity', 'huge': '1e30', 'minus-huge': '-1e30', 'near-limit': '1e18',
                             'underscore': '1_7', 'double-underscore': '1__7', 'spaces': '  5  ', 'trailing-dot': '7.',
                             'leading-dot': '.5', 'exponent': '2e3', 'garbage': 'abc', 'empty': '', 'hex': '0x10',
                             'arabic-digits': '١٢', 'negative': '-86400.5', 'minus-zero': '-0'}.items():
            add('mtime', label, gz(pax_tar([('f', 'file', b'content', {'mtime': value})])))
        for label, headers in {'uid-garbage': {'uid': 'abc'}, 'gid-underscore': {'gid': '1_0'}, 'size-padded': {'size': ' 7 '},
                               'size-garbage': {'size': 'x'}, 'uid-unicode': {'uid': '٣'},
                               'size-4300-digits': {'size': '9' * 4300}, 'size-4301-digits': {'size': '9' * 4301},
                               'size-2p63': {'size': str(2 ** 63)}, 'size-1e30': {'size': '1' + '0' * 30}}.items():
            add('numbers', label, gz(pax_tar([('f', 'file', b'content', headers)])))
        # -- F07: a leading U+FEFF belongs to the name
        add('bom', 'pax-path', gz(pax_tar([('f', 'file', b'x', {'path': '﻿name'})])))
        add('bom', 'both-names', gz(pax_tar([('name', 'file', b'plain', {}), ('x', 'file', b'bom', {'path': '﻿name'})])))
        add('bom', 'pax-linkpath', gz(pax_tar([('target', 'file', b't', {}), ('l', 'sym', 'x', {'linkpath': '﻿name'})])))
        add('bom', 'ustar-name', gz(raw_tar([F('﻿name', b'bom'), F('name', b'plain')], tarfile.PAX_FORMAT)))
        # -- F11: NUL bytes in paths
        add('nul', 'pax-path', gz(pax_tar([('f', 'file', b'x', {'path': 'evil\0suffix'})])))
        add('nul', 'pax-linkpath', gz(pax_tar([('l', 'sym', 'x', {'linkpath': 'ta\0rget'})])))
        add('nul', 'pax-hardlink', gz(pax_tar([('o', 'file', b'x', {}), ('h', 'hard', 'o', {'linkpath': 'o\0x'})])))
        add('nul', 'pax-dir', gz(pax_tar([('d', 'dir', '', {'path': 'd\0e'})])))
        # -- F03: unused data behind the archive and containers that are not a plain single member
        members = raw_tar([F('f', b'x')])
        terminated = members[:members.index(b'\0' * 1024)] + b'\0' * 1024
        add('tail', 'corrupt-gzip-after-terminator', gz(terminated) + bytes.fromhex('1f8b0800000000000003ff') + b'\0' * 8)
        add('tail', 'garbage-after-gzip', gz(terminated) + b'trailing garbage')
        add('tail', 'second-member-of-zeros', gzip_member(terminated) + gzip_member(b'\0' * 100000))
        normal = bytearray(gz(terminated))
        normal[-8] ^= 1
        add('tail', 'bad-crc-after-terminator', bytes(normal))
        # data ends exactly at the end of the member (no end-of-archive blocks): the next read reaches the trailer
        bare = members[:members.index(b'\0' * 1024)]
        add('trailer', 'ok', gzip_member(bare))
        add('trailer', 'bad-crc', gzip_member(bare, crc=0x12345678))
        add('trailer', 'bad-size', gzip_member(bare, size=7))
        add('trailer', 'missing', gzip_member(bare, trailer=False))
        add('trailer', 'partial', gzip_member(bare)[:-3])
        add('trailer', 'zero-padding', gzip_member(bare) + b'\0' * 37)
        add('trailer', 'padding-then-garbage', gzip_member(bare) + b'\0' * 37 + b'zz')
        add('trailer', 'garbage', gzip_member(bare) + b'zz')
        add('trailer', 'one-garbage-byte', gzip_member(bare) + b'\x1f')
        add('trailer', 'second-bad-method', gzip_member(bare) + b'\x1f\x8b\x07\x00' + b'\0' * 6)
        add('trailer', 'second-member-header-truncated', gzip_member(bare) + b'\x1f\x8b\x08\x00\0\0')
        add('trailer', 'second-member-empty', gzip_member(bare) + gzip_member(b''))
        # gzip header flags that Python reads and discards
        for label, kw in {'extra': dict(flags=4, extra=b'xy' * 50), 'name': dict(flags=8, name=b'archive.tar'),
                          'comment': dict(flags=16, comment=b'a comment'), 'header-crc': dict(flags=2),
                          'all': dict(flags=2 | 4 | 8 | 16, extra=b'e', name=b'n', comment=b'c'),
                          'name-unterminated': dict(flags=8, name=b'')}.items():
            add('header', label, gzip_member(terminated, **kw))
        add('header', 'bad-method-first', gzip_member(terminated, method=7))
        add('header', 'truncated-fixed', gzip_member(terminated)[:5])
        add('header', 'truncated-extra', gzip_member(terminated, flags=4, extra=b'q' * 40)[:14])
        add('header', 'magic-only', b'\x1f\x8b')
        add('header', 'one-byte', b'\x1f')
        # corrupt deflate data: wrapped into ReadError only where TarFile.next() sees it (a header read), raw elsewhere
        two = raw_tar([F('a', bytes(range(256)) * 200), F('b', b'second')])
        first_header_end, first_data_end = 512, 512 + 512 * ((51200 + 511) // 512)
        add('deflate', 'in-first-header', broken_deflate_gzip(two, 0))
        add('deflate', 'in-first-header-block', broken_deflate_gzip(two, 100))
        add('deflate', 'in-member-data', broken_deflate_gzip(two, first_header_end + 20000))
        add('deflate', 'at-second-header', broken_deflate_gzip(two, first_data_end))
        add('deflate', 'in-second-header', broken_deflate_gzip(two, first_data_end + 100))
        add('deflate', 'in-second-data', broken_deflate_gzip(two, first_data_end + 512 + 3))
        # a larger archive: several 128 KiB input chunks, 8 KiB reads and the single rewind
        rng = os.urandom
        many = raw_tar([F(f'd{i % 3}/f{i}', (bytes([i]) * 40000) + rng(3000)) for i in range(30)])
        add('large', 'many-members', gz(many))
        add('large', 'multi-member', gzip_member(many[:200000]) + gzip_member(many[200000:]))

    def check_group(self, group):
        failures = []
        for ident in self.groups[group]:
            try:
                self.compare(ident)
            except AssertionError as exc:
                failures.append(str(exc)[:1200])
        self.assertFalse(failures, f'{len(failures)} of {len(self.groups[group])} differ:\n' + '\n----\n'.join(failures[:5]))

    def test_mtime_grammar_and_utime_classification(self):
        self.check_group('mtime')
        names = {self.python_results[i].get('name') for i in self.groups['mtime']}
        self.assertTrue({'ValueError', 'OverflowError', None} <= names, names)

    def test_other_pax_numbers(self):
        self.check_group('numbers')

    def test_bom_is_part_of_the_name(self):
        self.check_group('bom')
        ident = self.groups['bom'][2]  # both-names, lcu
        self.assertEqual({p.name for p in self.job_dirs[ident]['js'].iterdir()}, {'name', '﻿name'})

    def test_nul_in_paths(self):
        self.check_group('nul')
        ident = self.groups['nul'][0]
        self.assertEqual(self.python_results[ident]['name'], 'ValueError')
        self.assertEqual(self.python_results[ident]['message'], 'lstat: embedded null character in path')

    def test_unused_gzip_tails(self):
        self.check_group('tail')
        self.assertTrue(self.python_results[self.groups['tail'][0]]['ok'])  # corrupt second member is never read

    def test_gzip_trailer_and_padding(self):
        self.check_group('trailer')
        names = {self.python_results[i].get('name') for i in self.groups['trailer']}
        self.assertTrue({'BadGzipFile', 'EOFError'} <= names, names)

    def test_gzip_header_flags(self):
        self.check_group('header')

    def test_deflate_errors(self):
        self.check_group('deflate')
        names = {self.python_results[i].get('name') for i in self.groups['deflate']}
        self.assertTrue({'ReadError', 'error'} <= names, names)

    def test_large_archives(self):
        self.check_group('large')


# ---------------------------------------------------------------------------------------------------------------
# F19 (update review): names that are not UTF-8 keep their raw bytes (surrogateescape + byte paths)
# ---------------------------------------------------------------------------------------------------------------
import random  # noqa: E402
import subprocess  # noqa: E402


def filesystem_accepts_raw_names(base):
    try:
        probe = os.path.join(os.fsencode(str(base)), b'raw-\xff')
        os.close(os.open(probe, os.O_CREAT | os.O_WRONLY))
        os.unlink(probe)
        return True
    except OSError:
        return False


class TarRawNames(TarDifferentialTest):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.groups = []

        def outside_symlink(dest):
            outside = dest.parent / (dest.name + '-outside')
            outside.mkdir()
            (outside / 'f').write_bytes(b'unchanged')
            try:
                os.symlink(outside, os.fsencode(str(dest)) + b'/d\xff')
            except OSError:
                pass  # a filesystem that refuses raw names (APFS): the case degenerates to the plain error path

        for label, entries, prefill in [
            ('file', [F('caf\udce9.txt', b'raw name')], prefill_none),
            ('dir-and-file', [D('d\udcff'), F('d\udcff/f', b'x')], prefill_none),
            ('symlink-target', [F('real', b'r'), L('l', 'real\udcfe')], prefill_none),
            ('symlink-name', [F('real', b'r'), L('s\udcfe', 'real')], prefill_none),
            ('hardlink', [F('o\udcfd', b'o'), H('h', 'o\udcfd')], prefill_none),
            ('long-name', [F('x' * 120 + '\udce9' + 'y' * 20, b'long')], prefill_none),
            ('mixed-valid-and-raw', [F('é\udce9日', b'mix')], prefill_none),
            ('through-prefilled-symlink', [F('d\udcff/f', b'must not escape')], outside_symlink),
        ]:
            for mode in ('lcu', 'raw'):
                cls.groups.append(cls.add(f'rawname-{label}', gz(raw_tar(entries, tarfile.GNU_FORMAT)), mode, prefill))
        cls.groups.append(cls.add('rawname-pax-ustar', gz(pax_tar([('f', 'file', b'x', {'path': 'pax\udce9name'})])), 'lcu'))

    def test_raw_names_match_python(self):
        failures = []
        for ident in self.groups:
            try:
                self.compare(ident)
            except AssertionError as exc:
                failures.append(str(exc)[:1200])
        self.assertFalse(failures, f'{len(failures)} of {len(self.groups)} differ:\n' + '\n----\n'.join(failures[:5]))

    def test_the_byte_path_is_what_reaches_the_filesystem(self):
        if not filesystem_accepts_raw_names(self.base):
            self.skipTest('this filesystem refuses names that are not UTF-8 (the OSError path is compared above)')
        ident = next(i for i in self.groups if '-file-' in i and i.endswith('-raw'))
        names = sorted(os.listdir(os.fsencode(str(self.job_dirs[ident]['js']))))
        self.assertEqual(names, [b'caf\xe9.txt'])


class SurrogateescapeDecoder(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if S.NODE is None:
            raise unittest.SkipTest('node >= 22 not available')

    def test_matches_bytes_decode(self):
        rng = random.Random(20261005)
        corpus = [b'', b'plain', 'café'.encode(), b'\xff', b'\xe2\x82', b'\xe2\x82\xac', b'\xe2\x28\xa1', b'\xf0\x90\x80',
                  b'\xf0\x28\x8c\xbc', b'\xc0\xaf', b'\xed\xa0\x80', b'\xf4\x90\x80\x80', b'\xf5\x80\x80\x80', b'\x80', b'a\x80b',
                  b'\xe0\x80\x80', b'\xf0\x80\x80\x80', b'\xc2', b'\xc2\xc2\xa9', b'\xe2\x82\xe2\x82\xac', '\U0001f600'.encode() + b'\xf0']
        alphabet = [0x41, 0x7f, 0x80, 0xbf, 0xc0, 0xc2, 0xdf, 0xe0, 0xe1, 0xec, 0xed, 0xee, 0xef, 0xf0, 0xf1, 0xf3, 0xf4, 0xf5, 0xff, 0xa0, 0x9f, 0x90, 0x8f]
        for _ in range(4000):
            corpus.append(bytes(rng.choice(alphabet) for _ in range(rng.randrange(1, 9))))
        script = (f'import {{decodeSurrogateescape}} from "{S.ROOT / "lcu/compat/tar.mjs"}";'
                  'const rows = JSON.parse(process.argv[1]).map((hex) => Array.from(decodeSurrogateescape(Buffer.from(hex, "hex")),'
                  ' (ch) => ch.codePointAt(0)));'
                  'console.log(JSON.stringify(rows));')
        out = subprocess.run([S.NODE, '--input-type=module', '-e', script, json.dumps([c.hex() for c in corpus])],
                             capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        got = json.loads(out.stdout)
        expected = [[ord(ch) for ch in c.decode('utf-8', 'surrogateescape')] for c in corpus]
        bad = [(c.hex(), g, e) for c, g, e in zip(corpus, got, expected) if g != e]
        self.assertFalse(bad, bad[:5])


class TarRawNameBytes(unittest.TestCase):
    """Whatever the filesystem does with them, fs receives the raw bytes of a non-UTF-8 member name."""

    @classmethod
    def setUpClass(cls):
        if S.NODE is None:
            raise unittest.SkipTest('node >= 22 not available')

    def test_fs_receives_byte_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp, 'raw.tar.gz')
            archive.write_bytes(gz(raw_tar([F('caf\udce9.txt', b'raw'), L('sym', 'tg\udcff')], tarfile.GNU_FORMAT)))
            dest = Path(tmp, 'out')
            dest.mkdir()
            script = ('import fs from "node:fs";'
                      f'import {{extractall, openTarGz}} from "{S.ROOT / "lcu/compat/tar.mjs"}";'
                      'const seen = [];'
                      'for (const name of ["openSync", "symlinkSync", "lstatSync", "mkdirSync"]) {'
                      ' const real = fs[name]; fs[name] = (...args) => { seen.push([name, args.slice(0, 2).map((a) => Buffer.isBuffer(a) ? a.toString("hex") : String(a))]);'
                      '  return real(...args); }; }'
                      'let error = null; const archive = openTarGz(process.argv[1]);'
                      'try { extractall(archive, process.argv[2]); } catch (e) { error = e.name; } finally { archive.close(); }'
                      'console.log(JSON.stringify([error, seen]));')
            out = subprocess.run([S.NODE, '--input-type=module', '-e', script, str(archive), str(dest)], capture_output=True, text=True)
            self.assertEqual(out.returncode, 0, out.stderr)
            error, seen = json.loads(out.stdout)
            raw_name = b'caf\xe9.txt'.hex()
            opens = [args for name, args in seen if name == 'openSync' and raw_name in args[0]]
            self.assertTrue(opens, seen)  # the file is created through the raw-byte path (a Buffer printed as hex)
            lstats = [args for name, args in seen if name == 'lstatSync' and raw_name in args[0]]
            self.assertTrue(lstats, 'the data filter looked the raw name up too')


if __name__ == '__main__':
    unittest.main()
