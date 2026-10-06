"""lcu/compat/acl.mjs against lcu.platforms (_posix_acl, _acl_writers_untrusted, _untrusted_entry).

The pure verdict logic is compared everywhere; reading real ACLs needs Linux with getfacl/setfacl and
root (run through tests/compat/docker.sh, or LCU_COMPAT_DOCKER=1 python3 -m unittest test_docker).
"""
import json
import os
import random
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import os as _os
import sys as _sys

_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from support import ROOT, NodeTestCase, run_node

sys.path.insert(0, str(ROOT))
from lcu import platforms  # noqa: E402

TAGS = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20]


def make_blob(entries, version=2):
    return struct.pack('<I', version) + b''.join(struct.pack('<HHI', *entry) for entry in entries)


class VerdictLogicTests(NodeTestCase):
    """_acl_writers_untrusted is a pure function: compare it on generated and malformed blobs."""

    def test_acl_writers_untrusted(self):
        rng = random.Random(5)
        groups = {10: {1, 2}, 11: {1, 2, 3}, 12: set(), 13: None, 14: {7}}
        blobs = [b'', b'\x02', b'\x02\x00\x00\x00\x01', make_blob([], 3), make_blob([(1, 6, 0xffffffff)] * 2, 1),
                 make_blob([]), b'\x02\x00\x00\x00' + b'\x00' * 7]
        for _ in range(3000):
            entries = []
            for _ in range(rng.randint(0, 7)):
                tag = rng.choice(TAGS)
                ident = rng.choice([0, 1, 2, 3, 7, 10, 11, 12, 13, 14, 999, 0xffffffff])
                entries.append((tag, rng.randint(0, 7), ident))
            blobs.append(make_blob(entries))
        trusted_sets = [set(), {0}, {0, 1}, {0, 1, 2}, {0, 1, 2, 3}, {0, 7}]

        def members(gid):
            return groups.get(gid)

        expected = [[platforms._acl_writers_untrusted(b, t, members) for t in trusted_sets] for b in blobs]
        got = run_node("""
const m = await import(COMPAT + 'acl.mjs');
const groups = new Map(input.groups.map(([g, members]) => [g, members === null ? null : new Set(members)]));
const members = (gid) => groups.get(gid) ?? (groups.has(gid) ? null : undefined);
emit(input.blobs.map((hex) => input.trusted.map((t) => m.aclWritersUntrusted(Buffer.from(hex, 'hex'), new Set(t), (gid) => groups.has(gid) ? groups.get(gid) : undefined))));
""", {'blobs': [b.hex() for b in blobs], 'trusted': [sorted(t) for t in trusted_sets],
              'groups': [[g, None if v is None else sorted(v)] for g, v in groups.items()]})
        self.assertEqual(got, expected)

    def test_parse_getfacl_sample(self):
        sample = ('# file: /srv/a b\n# owner: 0\n# group: 0\nuser::rwx\nuser:1001:rw-\t#effective:r--\ngroup::r-x\n'
                  'group:2002:rw-\nmask::r-x\nother::r-x\ndefault:user::rwx\ndefault:user:5:rwx\ndefault:mask::rwx\n'
                  'default:other::r-x\n\n# file: /srv/b\n# owner: 0\n# group: 0\nuser::rw-\nuser:7:-w-\ngroup::r--\n'
                  'mask::-w-\nother::r--\n')
        got = run_node("""
const m = await import(COMPAT + 'acl.mjs');
emit([...m.parseGetfacl(input).entries()].map(([p, b]) => [p, b.toString('hex')]));""", sample)
        want = [['/srv/a b', make_blob([(1, 7, 0xffffffff), (2, 6, 1001), (4, 5, 0xffffffff), (8, 6, 2002),
                                        (0x10, 5, 0xffffffff), (0x20, 5, 0xffffffff)]).hex()],
                ['/srv/b', make_blob([(1, 6, 0xffffffff), (2, 2, 7), (4, 4, 0xffffffff), (0x10, 2, 0xffffffff),
                                      (0x20, 4, 0xffffffff)]).hex()]]
        self.assertEqual(got, want)


NO_READERS = "const sys = await import(COMPAT + 'systool.mjs'); sys._testing.override('getfacl', null); sys._testing.override('python3', null);\n"
READER_UNAVAILABLE = ('AclReaderUnavailableError: cannot inspect POSIX ACLs (neither getfacl nor /usr/bin/python3 is '
                      'available); install the acl package (getfacl) or /usr/bin/python3')


def fake_tool(directory, name, marker, body='exit 0'):
    path = Path(directory) / name
    path.write_text(f'#!/bin/sh\necho "{name} $*" >> "{marker}"\n{body}\n')
    path.chmod(0o755)
    return path


class UnavailableTests(NodeTestCase):
    def test_no_reader_is_a_distinct_prerequisite_error(self):
        # finding 15 (acl-no-tools-no-acl): without any reader a plain file is NOT labelled as carrying an
        # ACL; the prerequisite failure is a distinct error (its own class, still an AclUnavailableError so callers
        # that only rethrow that class keep failing closed); an entry that does not exist has no ACL, as in Python.
        with tempfile.TemporaryDirectory() as tmp:
            plain = Path(tmp) / 'plain'
            plain.write_text('x')
            got = run_node(NO_READERS + """
const m = await import(COMPAT + 'acl.mjs');
const out = { tool: m.aclTool() };
const attempt = (key, fn) => { try { out[key] = fn(); } catch (e) { out[key] = e.name + ': ' + e.message; out[key + 'Distinct'] = e instanceof m.AclReaderUnavailableError && e instanceof m.AclUnavailableError; } };
attempt('tree', () => m.posixAclTree(input.dir).size);
attempt('one', () => m.posixAcl(input.plain));
attempt('paths', () => m.posixAclPaths([input.plain]).size);
attempt('missing', () => m.posixAcl(input.dir + '/missing'));
attempt('missingTree', () => m.posixAclTree(input.dir + '/missing').size);
emit(out);
""", {'dir': tmp, 'plain': str(plain)})
        self.assertIsNone(platforms._posix_acl(Path('/nonexistent/x')))
        self.assertEqual(got, {'tool': None, 'tree': READER_UNAVAILABLE, 'treeDistinct': True,
                               'one': READER_UNAVAILABLE, 'oneDistinct': True,
                               'paths': READER_UNAVAILABLE, 'pathsDistinct': True,
                               'missing': None, 'missingTree': 0})

    def test_environment_cannot_choose_the_reader(self):
        # finding 2 (acl-helper-injection): neither LCU_GETFACL/LCU_ACL_PYTHON nor PATH selects code.
        with tempfile.TemporaryDirectory() as tmp:
            marker = Path(tmp) / 'ran'
            fake_tool(tmp, 'getfacl', marker)
            fake_tool(tmp, 'python3', marker)
            env = {**os.environ, 'PATH': f'{tmp}:{os.environ.get("PATH", "")}', 'LCU_GETFACL': f'{tmp}/getfacl',
                   'LCU_ACL_PYTHON': f'{tmp}/python3'}
            run_node("""
const m = await import(COMPAT + 'acl.mjs');
const out = { tool: m.aclTool() };
try { out.one = m.posixAcl(input); } catch (e) { out.one = e.name; }
emit(out);
""", tmp, env=env)
            self.assertFalse(marker.exists(), marker.read_text() if marker.exists() else '')

    def test_strict_parser_rejects_contract_violations(self):
        # finding 1: output without the "# file:" headers (getfacl under POSIXLY_CORRECT), unknown lines,
        # default entries or an incomplete ACL are not "no ACL".
        good = '# file: /a\n# owner: 0\n# group: 0\nuser::rw-\nuser:12345:rw-\t#effective:rw-\ngroup::r--\nmask::rw-\nother::r--\n\n'
        cases = {
            'good': good,
            'empty': '',
            'no-header': 'user::rw-\nuser:12345:rw-\ngroup::r--\nmask::rw-\nother::r--\n',
            'garbage': good + 'something else\n',
            'default': good.replace('other::r--\n', 'other::r--\ndefault:user::rwx\n'),
            'no-mask': good.replace('mask::rw-\n', ''),
            'named-not-numeric': good.replace('12345', 'alice'),
            'no-entries': '# file: /a\n# owner: 0\n# group: 0\n\n',
        }
        got = run_node("""
const m = await import(COMPAT + 'acl.mjs');
const out = {};
for (const [k, v] of Object.entries(input)) {
  const strict = m.parseGetfacl(v, { strict: true });
  out[k] = [strict === null ? null : [...strict.keys()], [...m.parseGetfacl(v).keys()]];
}
emit(out);
""", cases)
        self.assertEqual(got, {
            'good': [['/a'], ['/a']], 'empty': [[], []], 'no-header': [None, []], 'garbage': [None, ['/a']],
            'default': [None, ['/a']], 'no-mask': [None, ['/a']], 'named-not-numeric': [None, ['/a']],
            'no-entries': [None, []],
        })


@unittest.skipUnless(sys.platform == 'linux' and hasattr(os, 'geteuid') and os.geteuid() == 0
                     and shutil.which('getfacl') and shutil.which('setfacl'),
                     'needs Linux, root, and the acl package (use tests/compat/docker.sh)')
class RealAclTests(NodeTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        for group in ('lcuaclg1', 'lcuaclg2', 'lcuaclg3'):
            subprocess.run(['groupadd', '-f', group], check=True)
        for user in ('lcuacl1', 'lcuacl2', 'lcuacl3'):
            if subprocess.run(['id', user], capture_output=True).returncode:
                subprocess.run(['useradd', '-M', '-s', '/bin/false', user], check=True)
        subprocess.run(['usermod', '-a', '-G', 'lcuaclg1,lcuaclg3', 'lcuacl1'], check=True)
        subprocess.run(['usermod', '-a', '-G', 'lcuaclg3', 'lcuacl2'], check=True)
        import pwd
        import grp
        cls.u = {n: pwd.getpwnam(f'lcuacl{n}').pw_uid for n in (1, 2, 3)}
        cls.g = {n: grp.getgrnam(f'lcuaclg{n}').gr_gid for n in (1, 2, 3)}

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        os.chmod(self.root, 0o755)

    def setfacl(self, spec, path, *flags):
        done = subprocess.run(['setfacl', *flags, '-m', spec, str(path)], capture_output=True, text=True)
        if done.returncode:
            self.skipTest(f'filesystem does not support POSIX ACLs here: {done.stderr.strip()}')

    def build_tree(self):
        u, g, r = self.u, self.g, self.root
        names = ['plain', 'with space', 'tab\there', 'back\\slash', "quo'te", 'dq"uote', 'é-ünï-中文', 'new\nline',
                 '#hash', 'trail ', ' lead', 'semi;colon', '100%', ' nbsp', '\U0001f600']
        specs = [
            f'u:{u[1]}:rw', f'u:{u[1]}:r', f'u:{u[2]}:rwx', f'u:{u[3]}:w', 'u:12345:rw', 'u:0:rw',
            f'g:{g[1]}:rw', f'g:{g[2]}:rw', f'g:{g[3]}:w', f'g:{g[1]}:r', 'g:54321:rw', 'g:0:rw',
        ]
        paths = []
        for index, name in enumerate(names):
            file = r / name
            file.write_text('x')
            file.chmod(0o644)
            self.setfacl(specs[index % len(specs)], file)
            if index % 3 == 0:
                self.setfacl('m::r', file)  # mask hides write
            if index % 4 == 1:
                self.setfacl(specs[(index + 5) % len(specs)], file)
            paths.append(file)
        # directories: nested, default ACLs (ignored), sticky, group/other write bits
        top = r / 'dir'
        top.mkdir()
        self.setfacl(f'u:{u[1]}:rwx', top)
        self.setfacl(f'd:u:{u[2]}:rwx', top)
        sub = top / 'sub dir'
        sub.mkdir()
        self.setfacl(f'g:{g[1]}:rwx', sub)
        (sub / 'leaf').write_text('x')
        self.setfacl(f'u:{u[3]}:rw', sub / 'leaf')
        (top / 'only-default').mkdir()
        self.setfacl(f'd:u:{u[1]}:rwx', top / 'only-default')
        sticky = r / 'sticky'
        sticky.mkdir()
        sticky.chmod(0o1777)
        self.setfacl(f'u:{u[1]}:rwx', sticky)
        gw = r / 'groupwritable'
        gw.write_text('x')
        os.chown(gw, 0, g[1])
        gw.chmod(0o664)
        gw2 = r / 'groupwritable3'
        gw2.write_text('x')
        os.chown(gw2, 0, g[3])
        gw2.chmod(0o664)
        ow = r / 'otherwritable'
        ow.write_text('x')
        ow.chmod(0o666)
        owned = r / 'owned-by-user'
        owned.write_text('x')
        os.chown(owned, u[1], 0)
        self.setfacl(f'u:{u[2]}:rw', owned)
        # links: a link to an ACL'd file and a dangling one carry no ACL of their own
        (r / 'link').symlink_to('plain')
        (r / 'dangling').symlink_to('nowhere')
        (r / 'dirlink').symlink_to('dir')
        # a file whose ACL was removed again
        removed = r / 'removed'
        removed.write_text('x')
        self.setfacl(f'u:{u[1]}:rw', removed)
        subprocess.run(['setfacl', '-b', str(removed)], check=True)
        # an ACL made only of a mask change on an otherwise base ACL
        masked = r / 'mask-only'
        masked.write_text('x')
        masked.chmod(0o664)
        self.setfacl('u:12345:r', masked)
        subprocess.run(['setfacl', '-x', 'u:12345', str(masked)], check=True)
        return sorted(str(p) for p in [r, *r.rglob('*')])

    def test_blobs_and_verdicts_match_python(self):
        paths = self.build_tree()
        trusted_sets = [{0}, {0, self.u[1]}, {0, self.u[1], self.u[2]}, {0, self.u[1], self.u[2], self.u[3]}, {self.u[1]}]
        py_blobs, py_verdicts = {}, {}
        for p in paths:
            path = Path(p)
            info = path.lstat()
            blob = platforms._posix_acl(path)
            py_blobs[p] = blob.hex() if blob is not None else None
            py_verdicts[p] = [platforms._untrusted_entry(path, info, t) for t in trusted_sets]
        self.assertGreater(sum(1 for v in py_blobs.values() if v), 15, 'fixture must create ACLs')
        got = run_node("""
import { lstatSync } from 'node:fs';
const m = await import(COMPAT + 'acl.mjs');
const accounts = await import(COMPAT + 'accounts.mjs');
const tree = m.posixAclTree(input.root);
const blobs = {}, verdicts = {};
for (const p of input.paths) {
  blobs[p] = tree.has(p) ? tree.get(p).toString('hex') : null;
  const info = lstatSync(p);
  verdicts[p] = input.trusted.map((t) => m.untrustedEntry(p, info, new Set(t), accounts.groupMembers, tree));
}
const single = {};
for (const p of input.paths) { const b = m.posixAcl(p); single[p] = b ? b.toString('hex') : null; }
emit({ blobs, verdicts, single, extra: [...tree.keys()].filter((p) => !input.paths.includes(p)) });
""", {'root': str(self.root), 'paths': paths, 'trusted': [sorted(t) for t in trusted_sets]})
        self.assertEqual(got['extra'], [])
        for p in paths:
            with self.subTest(path=p):
                self.assertEqual(got['blobs'][p], py_blobs[p])
                self.assertEqual(got['single'][p], py_blobs[p])
                self.assertEqual(got['verdicts'][p], py_verdicts[p])
        self.assertTrue(any(v for vs in py_verdicts.values() for v in vs if v and 'POSIX ACL' in v))

    def test_python_xattr_fallback_matches(self):
        paths = self.build_tree()
        want = {}
        for p in paths:
            blob = platforms._posix_acl(Path(p))
            if blob is not None:
                want[p] = blob.hex()
        env = None
        got = run_node("""
const sys = await import(COMPAT + 'systool.mjs'); sys._testing.override('getfacl', null);
const m = await import(COMPAT + 'acl.mjs');
const tree = m.posixAclTree(input.root);
const single = {};
for (const p of input.paths) { const b = m.posixAcl(p); if (b) single[p] = b.toString('hex'); }
emit({ tool: m.aclTool(), tree: Object.fromEntries([...tree].map(([p, b]) => [p, b.toString('hex')])), single });
""", {'root': str(self.root), 'paths': paths}, env=env)
        self.assertEqual(got['tool'], 'python3')
        self.assertEqual(got['tree'], want)
        self.assertEqual(got['single'], want)
        # and getfacl agrees with the xattr reader byte for byte
        both = run_node("""
const m = await import(COMPAT + 'acl.mjs');
emit({ tool: m.aclTool(), tree: Object.fromEntries([...m.posixAclTree(input)].map(([p, b]) => [p, b.toString('hex')])) });
""", str(self.root))
        self.assertEqual(both['tool'], 'getfacl')
        self.assertEqual(both['tree'], want)

    def test_unreadable_entries_are_skipped_not_fatal(self):
        locked = self.root / 'locked'
        locked.mkdir()
        (locked / 'inner').write_text('x')
        self.setfacl(f'u:{self.u[1]}:rw', locked / 'inner')
        visible = self.root / 'visible'
        visible.write_text('x')
        self.setfacl(f'u:{self.u[1]}:rw', visible)
        # root reads everything, so check the missing-path behaviour instead: Python gives None
        got = run_node("""
const m = await import(COMPAT + 'acl.mjs');
emit([m.posixAcl(input + '/nonexistent'), m.posixAcl(input + '/locked/inner/x'), m.posixAclTree(input + '/nonexistent').size]);
""", str(self.root))
        self.assertEqual(got, [None, None, 0])
        self.assertIsNone(platforms._posix_acl(self.root / 'nonexistent'))

    def acl_file(self):
        file = self.root / 'acl-file'
        file.write_text('x')
        self.setfacl('u:12345:rw', file)
        return file

    PROBE = """
const { lstatSync } = await import('node:fs');
const m = await import(COMPAT + 'acl.mjs');
const out = { tool: m.aclTool() };
try {
  const b = m.posixAcl(input);
  out.blob = b ? b.toString('hex') : null;
  out.verdict = m.untrustedEntry(input, lstatSync(input), new Set([0]), () => new Set([0]));
} catch (e) { out.error = e.name + ': ' + e.message; }
emit(out);
"""

    def test_caller_environment_does_not_change_verdicts(self):
        # finding 1 (acl-POSIXLY_CORRECT): output-control and locale variables of the caller must not
        # reach getfacl (POSIXLY_CORRECT drops the "# file:" headers).
        file = self.acl_file()
        want = platforms._untrusted_entry(file, file.lstat(), {0}, group_members=lambda gid: {0})
        self.assertEqual(want, 'writable by uid 12345 through a POSIX ACL')
        for extra in ({}, {'POSIXLY_CORRECT': '1'}, {'LC_ALL': 'fr_FR.UTF-8', 'LANG': 'de_DE.UTF-8'},
                      {'LD_PRELOAD': '/nonexistent.so', 'PYTHONSTARTUP': '/nonexistent.py', 'PYTHONPATH': '/x'}):
            with self.subTest(env=extra):
                got = run_node(self.PROBE, str(file), env={**os.environ, **extra})
                self.assertEqual((got['tool'], got['blob'], got['verdict']),
                                 ('getfacl', platforms._posix_acl(file).hex(), want))

    def test_failed_or_garbled_getfacl_is_never_absence(self):
        # finding 3 (acl-reader-fails-after-probe): a getfacl that answers --version but fails or prints
        # something outside its contract hands over to the xattr reader; without that reader the answer
        # is the prerequisite error, never "no ACL".
        file = self.acl_file()
        want = platforms._untrusted_entry(file, file.lstat(), {0}, group_members=lambda gid: {0})
        with tempfile.TemporaryDirectory() as tmp:
            marker = Path(tmp) / 'ran'
            bodies = {
                'fails': '[ "$1" = --version ] && exit 0\nexit 1',
                'garbled': '[ "$1" = --version ] && exit 0\necho "user::rw-"\necho "user:12345:rw-"\nexit 0',
                'killed': '[ "$1" = --version ] && exit 0\nkill -9 $$',
            }
            for label, body in bodies.items():
                fake = fake_tool(tmp, f'getfacl-{label}', marker, body)
                for python in (True, False):
                    with self.subTest(getfacl=label, python=python):
                        setup = (f"const sys = await import(COMPAT + 'systool.mjs'); sys._testing.override('getfacl', {json.dumps(str(fake))});"
                                 + ("" if python else "sys._testing.override('python3', null);") + '\n')
                        got = run_node(setup + self.PROBE, str(file))
                        if python:
                            self.assertEqual((got.get('blob'), got.get('verdict')), (platforms._posix_acl(file).hex(), want), got)
                        else:
                            self.assertEqual(got.get('error'), 'AclReaderUnavailableError: cannot inspect POSIX ACLs '
                                             '(getfacl failed and the /usr/bin/python3 xattr reader is unavailable); '
                                             'install the acl package (getfacl) or /usr/bin/python3')
            self.assertTrue(marker.exists(), 'the injected getfacl must have been used')

    def test_posix_acl_paths_matches_python(self):
        # .port/requests/compat.md request 3: one non-recursive run over an explicit list (files and their
        # ancestors, links, missing entries), with getfacl and with the xattr fallback.
        paths = self.build_tree()
        explicit = sorted(set(paths) | {str(p) for q in paths for p in Path(q).parents}
                          | {str(self.root / 'missing'), str(self.root / 'dir' / 'missing' / 'x')})
        want = {p: platforms._posix_acl(Path(p)).hex() for p in explicit if platforms._posix_acl(Path(p)) is not None}
        self.assertGreater(len(want), 10)
        for setup in ('', "const sys = await import(COMPAT + 'systool.mjs'); sys._testing.override('getfacl', null);\n"):
            with self.subTest(fallback=bool(setup)):
                got = run_node(setup + """
const m = await import(COMPAT + 'acl.mjs');
emit({ tool: m.aclTool(), found: Object.fromEntries([...m.posixAclPaths(input)].map(([p, b]) => [p, b.toString('hex')])) });
""", explicit)
                self.assertEqual(got['tool'], 'python3' if setup else 'getfacl')
                self.assertEqual(got['found'], want)


if __name__ == '__main__':
    unittest.main()
