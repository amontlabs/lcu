"""lcu/compat/accounts.mjs against pwd / grp and the setup.py privilege drop."""
import grp
import json
import os
import pwd
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import os as _os
import sys as _sys

_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from support import NODE, ROOT, NodeTestCase, in_disposable_linux, run_node

sys.path.insert(0, str(ROOT))


def pw(account):
    return {'name': account.pw_name, 'passwd': account.pw_passwd, 'uid': account.pw_uid, 'gid': account.pw_gid,
            'gecos': account.pw_gecos, 'dir': account.pw_dir, 'shell': account.pw_shell}


def gr(group):
    return {'name': group.gr_name, 'gid': group.gr_gid, 'mem': list(group.gr_mem)}


JS_PW = "const pw = (a) => a && ({ name: a.pw_name, passwd: a.pw_passwd, uid: a.pw_uid, gid: a.pw_gid, gecos: a.pw_gecos, dir: a.pw_dir, shell: a.pw_shell });"
JS_GR = "const gr = (g) => g && ({ name: g.gr_name, gid: g.gr_gid, mem: g.gr_mem });"


class LookupTests(NodeTestCase):
    def test_getpwall_matches(self):
        want = sorted((pw(a) for a in pwd.getpwall()), key=lambda a: (a['uid'], a['name'], a['dir']))
        got = run_node(JS_PW + "const m = await import(COMPAT + 'accounts.mjs'); emit(m.getpwall().map(pw));")
        got.sort(key=lambda a: (a['uid'], a['name'], a['dir']))
        # macOS hides the password hash as "*" and Linux as "x"; both libraries agree on the value they show.
        self.assertEqual(got, want)

    def test_getgrall_matches(self):
        want = sorted((gr(g) for g in grp.getgrall()), key=lambda g: (g['gid'], g['name']))
        got = run_node(JS_GR + "const m = await import(COMPAT + 'accounts.mjs'); emit(m.getgrall().map(gr));")
        got.sort(key=lambda g: (g['gid'], g['name']))
        for g in want + got:
            g['mem'] = sorted(g['mem'])
        self.assertEqual(got, want)

    def test_point_lookups(self):
        accounts = pwd.getpwall()
        names = [a.pw_name for a in accounts][:60] + ['nosuchuser_zz', '', 'ROOT', "o'brien", 'a b']
        uids = [a.pw_uid for a in accounts][:60] + [12345, 99999, 0]
        groups = grp.getgrall()
        gnames = [g.gr_name for g in groups][:60] + ['nosuchgroup_zz']
        gids = [g.gr_gid for g in groups][:60] + [54321]

        def py(fn, arg):
            try:
                value = fn(arg)
            except KeyError as exc:
                return {'error': f'KeyError: {exc.args[0]}'}
            return pw(value) if isinstance(value, pwd.struct_passwd) else gr(value)

        expected = {
            'pwnam': [py(pwd.getpwnam, n) for n in names], 'pwuid': [py(pwd.getpwuid, u) for u in uids],
            'grnam': [py(grp.getgrnam, n) for n in gnames], 'grgid': [py(grp.getgrgid, g) for g in gids],
        }
        got = run_node(JS_PW + JS_GR + """
const m = await import(COMPAT + 'accounts.mjs');
const attempt = (fn, conv) => { try { return conv(fn()); } catch (e) { return { error: e.name + ': ' + e.message }; } };
emit({
  pwnam: input.names.map((n) => attempt(() => m.getpwnam(n), pw)),
  pwuid: input.uids.map((n) => attempt(() => m.getpwuid(n), pw)),
  grnam: input.gnames.map((n) => attempt(() => m.getgrnam(n), gr)),
  grgid: input.gids.map((n) => attempt(() => m.getgrgid(n), gr)),
});""", {'names': names, 'uids': uids, 'gnames': gnames, 'gids': gids})
        for key in ('grnam', 'grgid'):
            for entry in expected[key] + got[key]:
                if 'mem' in entry:
                    entry['mem'] = sorted(entry['mem'])
        for key in expected:
            self.assertEqual(got[key], expected[key], key)

    def test_group_members_matches_platforms(self):
        from lcu import platforms
        gids = sorted({g.gr_gid for g in grp.getgrall()} | {a.pw_gid for a in pwd.getpwall()} | {424242})
        want = [sorted(platforms._group_members(gid)) for gid in gids]
        got = run_node("""
const m = await import(COMPAT + 'accounts.mjs');
emit(input.map((gid) => [...m.groupMembers(gid)].sort((a, b) => a - b)));""", gids)
        self.assertEqual(got, want)

    def test_nul_is_value_error(self):
        got = run_node("""
const m = await import(COMPAT + 'accounts.mjs');
try { m.getpwnam('a\\0b'); emit('no error'); } catch (e) { emit(e.message); }""")
        with self.assertRaises(ValueError) as caught:
            pwd.getpwnam('a\0b')
        self.assertEqual(got, str(caught.exception))

    def test_numeric_names_match_names_only(self):
        # finding 8 (numeric-names): a name made of digits is a name, never a uid/gid.
        names = ['0', '1', '00', ' 0', '+0', '4294967295']

        def py(fn, name):
            try:
                return fn(name)[0]
            except KeyError:
                return None
        want = [[py(pwd.getpwnam, n) for n in names], [py(grp.getgrnam, n) for n in names]]
        got = run_node("""
const m = await import(COMPAT + 'accounts.mjs');
emit([input.map((n) => m.findpwnam(n)?.pw_name ?? null), input.map((n) => m.findgrnam(n)?.gr_name ?? null)]);""", names)
        self.assertEqual(got, want)

    @unittest.skipUnless(in_disposable_linux() and os.geteuid() == 0, 'adds accounts: disposable Linux container only')
    def test_numeric_account_records(self):
        # finding 8: real records named "12345" with id 23456 resolve by name like libc does.
        with open('/etc/passwd') as stream:
            present = any(line.startswith('12345:') for line in stream)
        if not present:
            with open('/etc/passwd', 'a') as out:
                out.write('12345:x:23456:23456:Numeric name:/home/numeric:/bin/sh\n')
            with open('/etc/group', 'a') as out:
                out.write('12345:x:23456:\n')
        want = [pwd.getpwnam('12345').pw_uid, grp.getgrnam('12345').gr_gid, pwd.getpwuid(23456).pw_name]
        got = run_node("""
const m = await import(COMPAT + 'accounts.mjs');
emit([m.getpwnam('12345').pw_uid, m.getgrnam('12345').gr_gid, m.getpwuid(23456).pw_name]);""")
        self.assertEqual(got, want)
        self.assertEqual(want, [23456, 23456, '12345'])

    def test_environment_cannot_choose_the_tool(self):
        # finding 2 (account-helper-injection): LCU_GETENT and PATH never select the lookup tool.
        with tempfile.TemporaryDirectory() as tmp:
            marker = Path(tmp) / 'ran'
            for name in ('getent', 'dscacheutil'):
                (Path(tmp) / name).write_text(f'#!/bin/sh\necho {name} >> "{marker}"\nexit 0\n')
                (Path(tmp) / name).chmod(0o755)
            env = {**os.environ, 'LCU_GETENT': f'{tmp}/getent', 'PATH': f'{tmp}:{os.environ.get("PATH", "")}'}
            gid = grp.getgrall()[0].gr_gid
            got = run_node("""
const m = await import(COMPAT + 'accounts.mjs');
emit([...m.groupMembers(input)].sort((a, b) => a - b));""", gid, env=env)
            self.assertFalse(marker.exists())
            from lcu import platforms
            self.assertEqual(got, sorted(platforms._group_members(gid)))

    def test_failed_lookup_is_never_an_answer(self):
        # finding 3 (enumeration-failure-trusted): a tool that fails (getent 1/3, killed, missing) or an
        # enumeration without uid 0 raises AccountLookupError; only getent's "not found" (2) is a miss.
        with tempfile.TemporaryDirectory() as tmp:
            fakes = {}
            for label, body in {'exit1': 'exit 1', 'exit2': 'exit 2', 'exit3': 'exit 3', 'killed': 'kill -9 $$',
                                'empty': 'exit 0', 'noroot': 'echo "u:x:5:5::/:/bin/sh"\necho "g:x:5:"\nexit 0'}.items():
                path = Path(tmp) / label
                path.write_text(f'#!/bin/sh\n{body}\n')
                path.chmod(0o755)
                fakes[label] = str(path)
            fakes['missing'] = None
            got = run_node("""
const sys = await import(COMPAT + 'systool.mjs');
const m = await import(COMPAT + 'accounts.mjs');
const acl = await import(COMPAT + 'acl.mjs');
const out = {};
const attempt = (fn) => { try { const v = fn(); return v instanceof Set ? 'set:' + [...v] : v === null ? 'null' : typeof v === 'object' ? 'entry' : String(v); } catch (e) { return e.name; } };
for (const [label, path] of Object.entries(input)) {
  sys._testing.override('getent', path);
  sys._testing.override('dscacheutil', path);
  out[label] = [
    attempt(() => m.groupMembers(99999)),
    attempt(() => acl.untrustedEntry('/unused', { uid: 0, gid: 99999, mode: 0o100660 }, new Set([0]), m.groupMembers, new Map())),
    attempt(() => m.findpwnam('nosuchuser_zz')),
    attempt(() => m.getpwall().length),
  ];
}
emit(out);""", fakes)
        failed = ['AccountLookupError'] * 4
        self.assertEqual(got['exit1'], failed)
        self.assertEqual(got['exit3'], failed)
        self.assertEqual(got['killed'], failed)
        self.assertEqual(got['missing'], failed)
        self.assertEqual(got['noroot'][0], 'AccountLookupError')
        self.assertEqual(got['noroot'][1], 'AccountLookupError')
        self.assertEqual(got['noroot'][3], 'AccountLookupError')
        if sys.platform == 'darwin':
            # dscacheutil exits 0 even when it cannot answer: an empty keyed answer is a miss, an empty
            # enumeration is a failure.
            self.assertEqual(got['empty'], ['AccountLookupError', 'AccountLookupError', 'null', 'AccountLookupError'])
        else:
            self.assertEqual(got['exit2'][2], 'null')  # getent: key not found
            self.assertEqual(got['empty'][3], 'AccountLookupError')


class DropTests(NodeTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.root = hasattr(os, 'geteuid') and os.geteuid() == 0

    def test_failure_text_without_privilege(self):
        if self.root:
            self.skipTest('needs an unprivileged caller')
        try:
            os.initgroups('root', 0)
        except OSError as exc:
            want = f'{type(exc).__name__}: {exc}'
        else:
            self.skipTest('initgroups unexpectedly allowed')
        got = run_node("""
const m = await import(COMPAT + 'accounts.mjs');
const e = await import(COMPAT + 'pyerr.mjs');
try { m.dropPrivileges({ pw_name: 'root', pw_gid: 0, pw_uid: 0 }); emit('dropped'); }
catch (err) { const s = e.fromNodeError(err); emit(s.name + ': ' + s.message); }""")
        self.assertEqual(got, want)

    def users(self):
        if sys.platform != 'linux' or not self.root:
            self.skipTest('privilege drop needs root on Linux (run via docker.sh)')
        for command in (['groupadd', '-f', 'lcutg1'], ['groupadd', '-f', 'lcutg2'], ['groupadd', '-f', 'lcutg3']):
            subprocess.run(command, check=True)
        if subprocess.run(['id', 'lcutest'], capture_output=True).returncode:
            subprocess.run(['useradd', '-m', '-s', '/bin/sh', '-G', 'lcutg1,lcutg2', 'lcutest'], check=True)
        subprocess.run(['usermod', '-a', '-G', 'lcutg1,lcutg2', 'lcutest'], check=True)
        return pwd.getpwnam('lcutest')

    def test_spawn_as_matches_python_drop(self):
        account = self.users()
        probe = ['/usr/bin/id', '-u']
        script = ('import os,sys;a=sys.argv[1];import pwd;p=pwd.getpwnam(a);'
                  'os.initgroups(p.pw_name,p.pw_gid);os.setgid(p.pw_gid);os.setuid(p.pw_uid);'
                  'print(os.getuid(),os.geteuid(),os.getgid(),os.getegid(),sorted(os.getgroups()))')
        want = subprocess.run([sys.executable, '-c', script, 'lcutest'], capture_output=True, text=True, check=True).stdout
        got = run_node("""
import { spawnSync } from 'node:child_process';
const m = await import(COMPAT + 'accounts.mjs');
const account = m.getpwnam('lcutest');
const child = m.spawnAs(account, process.execPath,
  ['node', '-e', "console.log(process.getuid(), process.geteuid(), process.getgid(), process.getegid(), '[' + process.getgroups().sort((a, b) => a - b).join(', ') + ']')"],
  { stdio: ['ignore', 'pipe', 'inherit'] });
let out = '';
child.stdout.on('data', (c) => (out += c));
await new Promise((r) => child.once('close', r));
emit(out);""")
        self.assertEqual(got, want)
        self.assertIn(str(account.pw_gid), want)

    def test_spawn_as_environment_and_cwd(self):
        account = self.users()
        got = run_node("""
const m = await import(COMPAT + 'accounts.mjs');
const account = m.getpwnam('lcutest');
const child = m.spawnAs(account, '/usr/bin/env', ['env'], { env: m.accountEnvironment(account), cwd: account.pw_dir, stdio: ['ignore', 'pipe', 'inherit'] });
let out = '';
child.stdout.on('data', (c) => (out += c));
await new Promise((r) => child.once('close', r));
emit(out.trim().split('\\n').sort());""")
        home = account.pw_dir
        self.assertEqual(got, sorted([f'HOME={home}', 'USER=lcutest', 'LOGNAME=lcutest', 'LANG=C.UTF-8',
                                      f'PATH={home}/.local/bin:/usr/local/bin:/usr/bin:/bin']))

    def test_spawn_as_reports_exec_failures_like_python(self):
        account = self.users()
        got = run_node("""
const m = await import(COMPAT + 'accounts.mjs');
const account = m.getpwnam('lcutest');
const results = [];
for (const [file, search] of [['/nonexistent/prog', false], ['/etc/passwd', false], ['/root', false], ['nosuchprog-zz', true]]) {
  const child = m.spawnAs(account, file, ['x'], { stdio: ['ignore', 'ignore', 'ignore'], search });
  const event = new Promise((r) => child.once('lcu-spawn-error', r));
  const code = await new Promise((r) => child.once('close', r));
  results.push([code, await Promise.race([event, new Promise((r) => setTimeout(() => r(null), 100))])]);
}
emit(results);""")
        texts = []
        for target in ('/nonexistent/prog', '/etc/passwd', '/root', 'nosuchprog-zz'):
            script = ('import os,pwd,sys;p=pwd.getpwnam("lcutest");os.initgroups(p.pw_name,p.pw_gid);os.setgid(p.pw_gid);'
                      'os.setuid(p.pw_uid)\ntry:\n (os.execvpe if sys.argv[2]=="1" else os.execve)(sys.argv[1],["x"],{"PATH":"/usr/bin:/bin"})\n'
                      'except OSError as e: print(type(e).__name__+": "+str(e))')
            out = subprocess.run([sys.executable, '-c', script, target, '1' if '/' not in target else '0'],
                                 capture_output=True, text=True).stdout.strip()
            texts.append(out)
        for (code, event), text in zip(got, texts):
            self.assertEqual(code, 126)
            self.assertEqual(f"{event['text']}", text)

    def test_become_account_in_process(self):
        account = self.users()
        script = ('import os,pwd,sys;a=pwd.getpwnam("lcutest");os.initgroups(a.pw_name,a.pw_gid);os.setgid(a.pw_gid);os.setuid(a.pw_uid);'
                  'os.environ.clear();os.environ.update(HOME=a.pw_dir,USER=a.pw_name,LOGNAME=a.pw_name,'
                  'PATH=f"{a.pw_dir}/.local/bin:/usr/local/bin:/usr/bin:/bin",LANG="C.UTF-8");os.chdir(a.pw_dir)\n'
                  'print(os.getuid(),os.getgid(),sorted(os.getgroups()),sorted(os.environ.items()),os.getcwd())')
        want = subprocess.run([sys.executable, '-c', script], capture_output=True, text=True, check=True).stdout.strip()
        got = run_node("""
const m = await import(COMPAT + 'accounts.mjs');
m.becomeAccount(m.getpwnam('lcutest'));
const env = Object.entries(process.env).sort(([a], [b]) => (a < b ? -1 : 1));
emit([process.getuid(), process.getgid(), process.getgroups().sort((a, b) => a - b), env, process.cwd()]);""")
        uid, gid, groups, env, cwd = got
        rendered = (f"{uid} {gid} [{', '.join(map(str, groups))}] "
                    f"[{', '.join('(' + repr(k) + ', ' + repr(v) + ')' for k, v in env)}] {cwd}")
        self.assertEqual(rendered, want)

    # Python's oracle for spawnAs: scripts/install.py validate_release's subprocess options.
    PY_RUN_AS = r'''
import json, os, pwd, subprocess, sys
spec = json.load(sys.stdin)
a = pwd.getpwnam(spec['user'])
try:
    done = subprocess.run(spec['argv'], env=spec['env'], cwd=spec['cwd'], capture_output=True, text=True,
                          user=a.pw_uid, group=a.pw_gid, extra_groups=os.getgrouplist(a.pw_name, a.pw_gid))
    print(json.dumps({'status': done.returncode, 'stdout': done.stdout}))
except OSError as e:
    print(json.dumps({'error': type(e).__name__ + ': ' + str(e)}))
'''

    JS_RUN_AS = """
const m = await import(COMPAT + 'accounts.mjs');
const account = m.getpwnam(input.user);
const options = { env: input.env, stdio: ['ignore', 'pipe', 'ignore'] };
if (input.cwd !== null) options.cwd = input.cwd;
const child = m.spawnAs(account, input.argv[0], input.argv, options);
let out = '', failure = null;
child.stdout.on('data', (c) => (out += c));
child.on('lcu-spawn-error', (e) => (failure = e));
const status = await new Promise((r) => child.once('close', r));
const sync = m.spawnAsSync(account, input.argv[0], input.argv, { ...options, encoding: 'utf8' });
const one = (status, stdout, failure) => (failure ? { error: failure.text } : { status, stdout });
emit([one(status, out, failure), one(sync.status, sync.stdout, sync.spawnError)]);
"""

    def run_as_both(self, argv, env, cwd):
        spec = {'user': 'lcutest', 'argv': argv, 'env': env, 'cwd': cwd}
        want = json.loads(subprocess.run([sys.executable, '-c', self.PY_RUN_AS], input=json.dumps(spec),
                                         capture_output=True, text=True, check=True).stdout)
        return run_node(self.JS_RUN_AS, spec), want

    def test_spawn_as_large_environment(self):
        # finding 9 (spawnAs-large-env): an environment that is legal for the target must reach it intact.
        self.users()
        env = {f'E{i}': 'v' * 1000 for i in range(150)}
        env['PATH'] = '/usr/bin:/bin'
        (asynchronous, synchronous), want = self.run_as_both(['/usr/bin/env'], env, None)
        self.assertEqual(want['status'], 0)
        for got in (asynchronous, synchronous):
            self.assertEqual(got['status'], 0)
            self.assertEqual(sorted(got['stdout'].splitlines()), sorted(want['stdout'].splitlines()))

    def test_spawn_as_cwd_like_python(self):
        # finding 10 (spawnAs-empty-cwd): every explicit cwd is entered (before the drop, as Python's
        # child does), '' included; failures carry Python's text.
        account = self.users()
        for cwd in ('', '/nonexistent-dir', '/etc/passwd', '/root', account.pw_dir, None):
            with self.subTest(cwd=cwd):
                got, want = self.run_as_both(['/bin/pwd'], {'PATH': '/usr/bin:/bin'}, cwd)
                self.assertEqual(got, [want, want])
        got, want = self.run_as_both(['/bin/pwd'], {}, '')
        self.assertEqual(want, {'error': "FileNotFoundError: [Errno 2] No such file or directory: ''"})

    def test_spawn_as_leaks_no_descriptors(self):
        # The launch data and report channels must not reach the target.
        self.users()
        script = 'import os; print(sorted(int(x) for x in os.listdir("/proc/self/fd")))'
        got, want = self.run_as_both(['/usr/bin/python3', '-c', script], {'PATH': '/usr/bin:/bin'}, None)
        self.assertEqual(got, [want, want])


if __name__ == '__main__':
    unittest.main()
