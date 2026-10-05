"""The sandbox shim sandboxes the model's kernel and unsandboxes only the genuine Sky worker."""
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

if sys.platform == 'win32':
    raise unittest.SkipTest('The sandbox shim is Linux-only')

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lcu import sandbox_shim
from lcu.sandbox_shim import Unrecognized, decide, main

PROFILE = ('permissions.node_repl={filesystem = {":root" = "read", ":tmpdir" = "read"}, '
           'network = {enabled = false}}')
PREFIX = ['sandbox', '-c', 'shell_environment_policy.inherit="all"', '-c', 'default_permissions="node_repl"']


class ShimTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.runtime = self.base / 'runtime'
        for name in ('bin/node', 'bin/node_repl'):
            (self.runtime / name).parent.mkdir(parents=True, exist_ok=True)
            (self.runtime / name).write_text('')
        for package in ('sky', 'browser-desktop'):
            (self.runtime / f'lib/node_modules/@oai/{package}').mkdir(parents=True)
            (self.runtime / f'lib/node_modules/@oai/{package}/package.json').write_text('{}')
        self.tmp = self.base / 'tmp'
        self.tmp.mkdir()
        self.folder = self.tmp / '.tmpAbC123'
        self.folder.mkdir(mode=0o700)
        for name in ('kernel.js', 'trusted-worker.js'):
            (self.folder / name).write_text('')
        self.wrapper = self.base / 'lcu/linux_sky_service.mjs'
        self.wrapper.parent.mkdir()
        self.wrapper.write_text('')
        self.node = str(self.runtime / 'bin/node')
        self.parent = str(self.runtime / 'bin/node_repl')
        self.env = {'LCU_SANDBOX_SHIM': json.dumps({'codex': '/real/codex', 'runtime': str(self.runtime),
                                                   'wrapper': str(self.wrapper)}),
                    'TMPDIR': str(self.tmp),
                    'NODE_REPL_TRUSTED_SERVICES': json.dumps({'sky': '@oai/sky/service'})}

    def argv(self, command):
        return PREFIX + ['-c', PROFILE, '--', *command]

    def kernel(self):
        return [self.node, '--experimental-vm-modules', str(self.folder / 'kernel.js'),
                '--session-id', 'abc', '--working-dir', '/work']

    def worker(self):
        return [self.node, '--experimental-vm-modules', str(self.folder / 'trusted-worker.js'),
                str(self.base / 'socket')]

    def run_decide(self, command=None, argv=None, env=None, parent=None):
        return decide(argv if argv is not None else self.argv(command), env or self.env,
                      parent or self.parent)

    def test_the_kernel_goes_to_the_real_sandbox_unchanged(self):
        action, argv, note = self.run_decide(self.kernel())
        self.assertEqual((action, argv, note), ('real', self.argv(self.kernel()), ''))

    def test_the_genuine_sky_worker_runs_directly(self):
        self.assertEqual(self.run_decide(self.worker()), ('direct', self.worker(), ''))

    def test_the_worker_may_host_the_browser_service_and_lcus_wrapper(self):
        for services in ({'sky': '@oai/sky/service', 'browser': '@oai/browser-desktop/service'},
                         {'sky': str(self.wrapper)}, {'sky': str(self.wrapper),
                                                      'browser': '@oai/browser-desktop/service'}):
            with self.subTest(services=services):
                env = {**self.env, 'NODE_REPL_TRUSTED_SERVICES': json.dumps(services)}
                self.assertEqual(self.run_decide(self.worker(), env=env)[0], 'direct')

    def assert_worker_stays_sandboxed(self, note_part, **changes):
        action, argv, note = self.run_decide(self.worker(), **changes)
        self.assertEqual((action, argv), ('real', self.argv(self.worker())))
        self.assertIn(note_part, note)

    def test_a_worker_not_started_by_the_selected_node_repl_stays_sandboxed(self):
        for parent in ('/usr/bin/node', None, str(self.runtime / 'bin/node')):
            with self.subTest(parent=parent):
                action, _, note = decide(self.argv(self.worker()), self.env, parent)
                self.assertEqual(action, 'real')
                self.assertIn('node_repl', note)

    def test_a_worker_run_by_another_node_stays_sandboxed(self):
        other = self.base / 'other-node'
        other.write_text('')
        command = [str(other), *self.worker()[1:]]
        with self.assertRaises(Unrecognized):
            self.run_decide(command)
        link = self.runtime / 'bin/link'
        link.symlink_to(other)
        with self.assertRaises(Unrecognized):
            self.run_decide([str(link), *self.worker()[1:]])

    def test_a_lookalike_script_folder_stays_sandboxed(self):
        # Right file names, but not node_repl's own temporary folder.
        elsewhere = self.base / 'other'
        elsewhere.mkdir(mode=0o700)
        for name in ('kernel.js', 'trusted-worker.js'):
            (elsewhere / name).write_text('')
        command = self.worker()
        command[2] = str(elsewhere / 'trusted-worker.js')
        self.assertIn('temporary folder', self.run_decide(command)[2])
        # Named like node_repl's folder but missing the kernel beside it.
        (self.folder / 'kernel.js').unlink()
        self.assert_worker_stays_sandboxed('temporary folder')

    def test_a_lookalike_in_the_wrong_temporary_directory_stays_sandboxed(self):
        self.assert_worker_stays_sandboxed('temporary folder', env={**self.env, 'TMPDIR': str(self.base)})

    def test_writable_or_symlinked_scripts_stay_sandboxed(self):
        self.folder.chmod(0o777)
        self.assert_worker_stays_sandboxed('temporary folder')
        self.folder.chmod(0o700)
        script = self.folder / 'trusted-worker.js'
        script.chmod(0o666)
        self.assert_worker_stays_sandboxed('temporary folder')
        script.unlink()
        (self.base / 'real.js').write_text('')
        script.symlink_to(self.base / 'real.js')
        self.assert_worker_stays_sandboxed('temporary folder')

    def test_group_write_is_allowed_only_for_the_account_group(self):
        self.folder.chmod(0o770)
        self.assertEqual(self.run_decide(self.worker())[0], 'direct')
        with patch.object(os, 'getegid', return_value=os.getegid() + 1):
            self.assert_worker_stays_sandboxed('temporary folder')

    def test_a_service_map_that_is_not_the_selected_runtimes_stays_sandboxed(self):
        for services in ({'sky': '@oai/sky/service', 'extra': '@oai/sky/service'},
                         {'sky': '/tmp/evil.mjs'}, {'sky': str(self.wrapper) + 'x'}, {'browser': '@oai/browser-desktop/service'},
                         {'sky': '@oai/sky/service', 'browser': '/tmp/evil.mjs'}, {'sky': 5}, [], 'not-json'):
            with self.subTest(services=services):
                raw = services if isinstance(services, str) else json.dumps(services)
                action, _, note = self.run_decide(self.worker(), env={**self.env, 'NODE_REPL_TRUSTED_SERVICES': raw})
                self.assertEqual(action, 'real')
                self.assertTrue(note)

    def test_the_original_sky_package_must_exist_in_the_selected_runtime(self):
        (self.runtime / 'lib/node_modules/@oai/sky/package.json').unlink()
        self.assert_worker_stays_sandboxed('Sky service')

    def test_an_unset_service_map_stays_sandboxed(self):
        env = {key: value for key, value in self.env.items() if key != 'NODE_REPL_TRUSTED_SERVICES'}
        self.assertTrue(self.run_decide(self.worker(), env=env)[2])

    def test_unrecognised_sandbox_invocations_are_refused(self):
        cases = {
            'different prefix': ['sandbox', '-c', 'x=1', '-c', PROFILE, '--', *self.kernel()],
            'no profile': PREFIX + ['--', *self.kernel()],
            'other command': self.argv(['/bin/echo', 'hi']),
            'node flag missing': self.argv([self.node, str(self.folder / 'kernel.js'), '--session-id', 'a',
                                            '--working-dir', '/w']),
            'kernel arguments': self.argv(self.kernel()[:-1]),
            'worker arguments': self.argv(self.worker()[:-1]),
            'relative script': self.argv([self.node, '--experimental-vm-modules', 'kernel.js',
                                          '--session-id', 'a', '--working-dir', '/w']),
            'unknown script': self.argv([self.node, '--experimental-vm-modules', str(self.folder / 'x.js'), 'a']),
            'bad profile': PREFIX + ['-c', 'permissions.node_repl={', '--', *self.kernel()],
            'profile with extra keys': PREFIX + ['-c', 'permissions.node_repl={filesystem = {}, network = {}, x = 1}',
                                                 '--', *self.kernel()],
            'non-string path rule': PREFIX + ['-c', 'permissions.node_repl={filesystem = {a = 1}, network = {}}',
                                              '--', *self.kernel()],
            'additional flag': ['sandbox', '--full-auto', *PREFIX[1:], '-c', PROFILE, '--', *self.kernel()],
        }
        for label, argv in cases.items():
            with self.subTest(label), self.assertRaises(Unrecognized):
                self.run_decide(argv=argv)

    def test_missing_or_malformed_configuration_refuses_a_sandbox_invocation(self):
        for raw in (None, 'not json', '[]', json.dumps({'codex': 1, 'runtime': 'r'}),
                    json.dumps({'codex': 'c'}), json.dumps({'codex': 'c', 'runtime': 'r', 'wrapper': 3})):
            env = {key: value for key, value in self.env.items() if key != 'LCU_SANDBOX_SHIM'}
            if raw is not None:
                env['LCU_SANDBOX_SHIM'] = raw
            with self.subTest(raw=raw), self.assertRaises(Unrecognized):
                decide(self.argv(self.kernel()), env, self.parent)

    def test_the_availability_probe_reaches_the_real_codex(self):
        probe = self.argv(['/bin/sh', '-c', 'exit 12', 'node-repl-sandbox-probe', '/x'])
        self.assertEqual(self.run_decide(argv=probe), ('real', probe, ''))

    def test_other_codex_subcommands_pass_through(self):
        for argv in (['--version'], ['mcp', 'list'], [], ['sandboxed']):
            self.assertEqual(self.run_decide(argv=argv), ('real', argv, ''))

    def test_fault_hook_only_ever_refuses(self):
        for fault, command, refused in (
                ('unrecognized-kernel', self.kernel(), True), ('unrecognized-kernel', self.worker(), False),
                ('unrecognized-worker', self.worker(), True), ('unrecognized-worker', self.kernel(), False),
                ('unrecognized-format', self.kernel(), True), ('unrecognized-format', self.worker(), True),
                ('other', self.worker(), False)):
            with self.subTest(fault=fault, command=command[2]):
                env = {**self.env, sandbox_shim.FAULT_ENV: fault}
                if refused:
                    with self.assertRaises(Unrecognized):
                        self.run_decide(command, env=env)
                else:
                    self.run_decide(command, env=env)

    def run_main(self, command=None, argv=None, env=None, parent=None):
        calls = []
        stderr = io.StringIO()
        with patch('sys.stderr', stderr):
            code = main(argv if argv is not None else self.argv(command), env or self.env,
                        execv=lambda path, args: calls.append((path, args)), parent_exe=lambda: parent or self.parent)
        return code, calls, stderr.getvalue()

    def test_main_executes_the_real_codex_for_the_kernel_and_the_worker_directly(self):
        code, calls, _ = self.run_main(self.kernel())
        self.assertEqual((code, calls), (0, [('/real/codex', ['/real/codex', *self.argv(self.kernel())])]))
        code, calls, _ = self.run_main(self.worker())
        self.assertEqual((code, calls), (0, [(self.node, self.worker())]))

    def test_main_refuses_with_a_clear_message_and_executes_nothing(self):
        code, calls, message = self.run_main(self.kernel(), env={**self.env, sandbox_shim.FAULT_ENV: 'unrecognized-format'})
        self.assertEqual((code, calls), (70, []))
        self.assertIn('never left unsandboxed', message)
        self.assertIn('LCU_NODE_REPL_SANDBOX=off', message)

    def test_main_explains_a_worker_that_stays_sandboxed(self):
        code, calls, message = self.run_main(self.worker(), parent='/usr/bin/node')
        self.assertEqual(code, 0)
        self.assertEqual(calls, [('/real/codex', ['/real/codex', *self.argv(self.worker())])])
        self.assertIn('stays sandboxed', message)

    def test_environment_helper_restores_the_real_codex(self):
        env = {**self.env, 'CODEX_CLI_PATH': '/shim'}
        self.assertEqual(sandbox_shim.unshimmed_env(env)['CODEX_CLI_PATH'], '/real/codex')
        self.assertEqual(sandbox_shim.unshimmed_env({'CODEX_CLI_PATH': '/x'})['CODEX_CLI_PATH'], '/x')

    def test_the_launcher_is_executable(self):
        launcher = Path(__file__).resolve().parents[1] / 'bin/lcu-codex-sandbox'
        self.assertTrue(launcher.stat().st_mode & stat.S_IXUSR)


if __name__ == '__main__':
    unittest.main()
