"""Permission onboarding must report only checks the original runtime proves."""
import io
import json
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

from lcu import doctor
from lcu.platforms import MAC_HELPER
from lcu.setup import desktop_readiness_mode, desktop_readiness_request, run_desktop_doctor


class TTYInput(io.StringIO):
    def isatty(self):
        return True


class DoctorTests(unittest.TestCase):
    def setUp(self):
        # These tests are about permissions guidance, not the account's home folder length.
        patcher = patch('lcu.platforms.mac_socket_path_problem', return_value=None)
        patcher.start()
        self.addCleanup(patcher.stop)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name)
        self.root = base / 'release'
        self.root.mkdir()
        self.app = base / 'ChatGPT.app'
        self.runtime = self.root / 'app/Contents/Resources/cua_node'
        self.runtime.mkdir(parents=True)
        (self.root / 'installation.json').write_text(json.dumps({'platform': 'darwin'}))
        (self.app / 'Contents').mkdir(parents=True)
        (self.app / 'Contents/Info.plist').write_bytes(plistlib.dumps({
            'CFBundleDisplayName': 'Selected ChatGPT'}))
        helper = self.app / 'Contents' / MAC_HELPER
        (helper / 'Contents').mkdir(parents=True)
        (helper / 'Contents/Info.plist').write_bytes(plistlib.dumps({
            'CFBundleDisplayName': 'Selected Computer Use'}))
        self.resolved = (self.app, self.app / 'Contents/Resources', self.runtime,
                         {'version': 'fixture-app', 'runtime': 'fixture-cua'})
        self.env = {'NODE_REPL_NODE_PATH': '/fixture/node', 'DISPLAY': ':99',
                    'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/fixture'}

    def _linux(self):
        (self.root / 'installation.json').write_text(json.dumps({'platform': 'linux'}))

    def _mac_probe(self):
        return {'target': 'mac', 'provider': {'ok': True,
                'methods': ['list_apps', 'get_app_state']},
                'permissions': {'ok': False, 'unverified': True}}

    def test_mac_names_come_from_selected_app_and_helper_plists(self):
        names = doctor.mac_permission_targets(self.app)
        self.assertEqual(names['accessibility'][0], 'Selected Computer Use')
        self.assertEqual(names['screen_capture'][0], 'Selected ChatGPT')
        self.assertEqual(names['accessibility'][1], self.app / 'Contents' / MAC_HELPER)

    def test_mac_interactive_finish_keeps_privacy_readiness_unverified(self):
        output = io.StringIO()
        with patch('lcu.doctor._probe', return_value=self._mac_probe()), \
             patch('lcu.doctor.sys.stdin', TTYInput('\n')), \
             patch('lcu.doctor._open_settings') as open_settings, \
             patch('sys.stdout', output):
            status = doctor.main(self.root, [], resolved=self.resolved, env=self.env)
        self.assertEqual(status, 0)
        self.assertIn('macOS privacy permissions: not verified by LCU.', output.getvalue())
        self.assertIn('Selected Computer Use', output.getvalue())
        self.assertIn('Selected ChatGPT', output.getvalue())
        self.assertIn('blank TextEdit document', output.getvalue())
        open_settings.assert_not_called()

    def test_mac_settings_open_only_after_explicit_choice(self):
        with patch('lcu.doctor._probe', return_value=self._mac_probe()), \
             patch('lcu.doctor.sys.stdin', TTYInput('a\n\n')), \
             patch('lcu.doctor._open_settings') as open_settings, \
             patch('sys.stdout', io.StringIO()):
            status = doctor.main(self.root, [], resolved=self.resolved, env=self.env)
        self.assertEqual(status, 0)
        open_settings.assert_called_once_with(
            doctor.MAC_ACCESSIBILITY_SETTINGS,
            'System Settings > Privacy & Security > Accessibility')

    def test_strict_mac_check_stays_nonzero_after_interactive_cancel(self):
        with patch('lcu.doctor._probe', return_value=self._mac_probe()), \
             patch('lcu.doctor.sys.stdin', TTYInput('\n')), \
             patch('lcu.doctor._open_settings') as open_settings, \
             patch('sys.stdout', io.StringIO()):
            status = doctor.main(self.root, ['--require-ready'],
                                 resolved=self.resolved, env=self.env)
        self.assertEqual(status, 2)
        open_settings.assert_not_called()

    def test_mac_plain_check_fails_when_provider_did_not_load(self):
        broken = {'target': 'mac', 'provider': {'ok': False,
                  'error': {'message': 'sky service unavailable'}},
                  'permissions': {'ok': False, 'unverified': True}}
        output = io.StringIO()
        with patch('lcu.doctor._probe', return_value=broken), \
             patch('lcu.doctor.sys.stdin', io.StringIO()), \
             patch('sys.stdout', output):
            status = doctor.main(self.root, ['--non-interactive'],
                                 resolved=self.resolved, env=self.env)
        self.assertEqual(status, 2)
        self.assertIn('Original Mac provider check failed.', output.getvalue())

    def test_noninteractive_mac_prints_actionable_guidance_without_opening_settings(self):
        output = io.StringIO()
        with patch('lcu.doctor._probe', return_value=self._mac_probe()), \
             patch('lcu.doctor.sys.stdin', io.StringIO()), \
             patch('lcu.doctor._open_settings') as open_settings, \
             patch('sys.stdout', output):
            status = doctor.main(self.root, ['--non-interactive'],
                                 resolved=self.resolved, env=self.env)
        self.assertEqual(status, 0)
        self.assertIn('System Settings > Privacy & Security', output.getvalue())
        self.assertIn('reconnect your agent', output.getvalue())
        open_settings.assert_not_called()

    def test_linux_screenshot_failure_never_reports_ready(self):
        self._linux()
        failed = {'target': 'linux', 'windows': {'ok': True, 'count': 2},
                  'screenshot': {'ok': False, 'error': {'message': 'capture unavailable'}}}
        output = io.StringIO()
        with patch('lcu.doctor._probe', return_value=failed), \
             patch('lcu.doctor.sys.stdin', io.StringIO()), \
             patch('sys.stdout', output):
            status = doctor.main(self.root, ['--non-interactive', '--require-ready'],
                                 resolved=self.resolved, env=self.env)
        self.assertEqual(status, 2)
        self.assertIn('Window listing: passed (2 windows).', output.getvalue())
        self.assertIn('Screenshot capture: could not verify.', output.getvalue())
        self.assertNotIn('Computer use is ready', output.getvalue())

    def sandbox_status(self, env, works):
        output = io.StringIO()
        with patch('sys.stdout', output):
            doctor.print_linux_sandbox_status(env, works=works)
        return output.getvalue()

    def test_linux_sandbox_status_says_when_the_kernel_is_confined(self):
        text = self.sandbox_status({'LCU_SANDBOX_SHIM': '{}'}, lambda env: (True, ''))
        self.assertIn('JavaScript sandbox: active', text)
        self.assertIn('no network', text)

    def test_linux_sandbox_status_says_when_there_is_no_sandbox_here(self):
        text = self.sandbox_status({'LCU_SANDBOX_SHIM': '{}'}, lambda env: (False, 'exit 1: bwrap denied'))
        self.assertIn('NOT AVAILABLE', text)
        self.assertIn('bwrap denied', text)
        self.assertIn('not sandboxed', text)

    def test_linux_sandbox_status_reports_a_missing_shim_and_the_modes(self):
        self.assertIn("launcher shim is missing", self.sandbox_status({}, lambda env: (True, '')))
        off = self.sandbox_status({'LCU_NODE_REPL_SANDBOX': 'off'}, lambda env: self.fail('probe not needed'))
        self.assertIn('OFF', off)
        host = self.sandbox_status({'LCU_NODE_REPL_SANDBOX': 'host'}, lambda env: self.fail('probe not needed'))
        self.assertIn('LCU_NODE_REPL_SANDBOX=host', host)

    def test_linux_sandbox_probe_uses_the_real_codex_and_the_original_probe_shape(self):
        env = {'CODEX_CLI_PATH': '/shim', 'LCU_SANDBOX_SHIM': json.dumps(
            {'codex': '/real/codex', 'runtime': '/r', 'wrapper': None})}
        for returncode, expected in ((12, True), (1, False)):
            with patch('lcu.doctor.subprocess.run', return_value=Mock(returncode=returncode, stderr='')) as run:
                self.assertEqual(doctor.linux_sandbox_works(env)[0], expected)
            command = run.call_args.args[0]
            self.assertTrue(Path(run.call_args.kwargs['cwd']).name.startswith('lcu-sandbox-probe-'))
            self.assertEqual(command[:2], ['/real/codex', 'sandbox'])
            self.assertEqual(command[command.index('--') + 1], '/bin/sh')

    def test_linux_doctor_prints_the_sandbox_status_once(self):
        self._linux()
        output = io.StringIO()
        with patch('lcu.doctor.linux_sandbox_works', return_value=(False, '')), \
             patch('lcu.doctor._probe', return_value={'target': 'linux', 'windows': {'ok': True, 'count': 1},
                                                      'screenshot': {'ok': True}}), \
             patch('lcu.doctor.sys.stdin', io.StringIO()), patch('sys.stdout', output):
            doctor.main(self.root, ['--non-interactive'], resolved=self.resolved, env=self.env)
        self.assertEqual(output.getvalue().count('JavaScript sandbox:'), 1)

    def test_linux_interactive_retry_can_complete_readiness(self):
        self._linux()
        failed = {'target': 'linux', 'windows': {'ok': True, 'count': 1},
                  'screenshot': {'ok': False, 'error': {'message': 'temporary display error'}}}
        ready = {'target': 'linux', 'windows': {'ok': True, 'count': 1},
                 'screenshot': {'ok': True, 'count': 1}}
        output = io.StringIO()
        with patch('lcu.doctor._probe', side_effect=[failed, ready]) as probe, \
             patch('lcu.doctor.sys.stdin', TTYInput('r\n')), \
             patch('sys.stdout', output):
            status = doctor.main(self.root, ['--require-ready'],
                                 resolved=self.resolved, env=self.env)
        self.assertEqual(status, 0)
        self.assertEqual(probe.call_count, 2)
        self.assertIn('Computer use is ready for the first agent call.', output.getvalue())
        self.assertIn('returned image data was discarded by LCU', output.getvalue())

    def test_strict_linux_cancel_remains_nonzero(self):
        self._linux()
        failed = {'target': 'linux', 'windows': {'ok': True, 'count': 1},
                  'screenshot': {'ok': False, 'error': {'message': 'capture unavailable'}}}
        with patch('lcu.doctor._probe', return_value=failed), \
             patch('lcu.doctor.sys.stdin', TTYInput('\n')), \
             patch('sys.stdout', io.StringIO()):
            status = doctor.main(self.root, ['--require-ready'],
                                 resolved=self.resolved, env=self.env)
        self.assertEqual(status, 2)

    def test_doctor_probe_rejects_failed_process_and_wrong_target(self):
        failed = type('Completed', (), {'returncode': 1, 'stdout': '', 'stderr': 'failed'})()
        with patch('lcu.doctor.subprocess.run', return_value=failed):
            with self.assertRaisesRegex(ValueError, 'failed'):
                doctor._probe(self.runtime, self.env, 'darwin')
        mismatch = type('Completed', (), {'returncode': 0, 'stdout': '{"target":"windows"}\n', 'stderr': ''})()
        with patch('lcu.doctor.subprocess.run', return_value=mismatch):
            with self.assertRaisesRegex(ValueError, 'target mismatch'):
                doctor._probe(self.runtime, self.env, 'darwin')


class SetupReadinessTests(unittest.TestCase):
    def test_yes_defers_readiness_and_explicit_check_requires_it(self):
        args = type('Args', (), {'check_desktop': False, 'export': None, 'yes': True})()
        self.assertEqual(desktop_readiness_mode(args, interactive=True), 'deferred')
        args.check_desktop = True
        self.assertEqual(desktop_readiness_mode(args, interactive=True), 'required')


    def test_setup_doctor_invocation_is_guided_unbounded_or_strict_bounded(self):
        desktop_command = ['/opt/lcu/current/bin/lcu-session', '--user', 'alice', '--',
                           '/opt/lcu/current/bin/lcu']
        guided = type('Args', (), {'check_desktop': False, 'export': None, 'yes': False})()
        mode, command, timeout = desktop_readiness_request(
            guided, interactive=True, desktop_command=desktop_command)
        self.assertEqual(mode, 'guided')
        self.assertEqual(command, [*desktop_command, 'doctor'])
        self.assertIsNone(timeout)
        runner = Mock(return_value=subprocess.CompletedProcess(command, 2))
        result = run_desktop_doctor(command, timeout=timeout, runner=runner)
        self.assertEqual(result.returncode, 2)
        runner.assert_called_once_with(command, check=False)

        required = type('Args', (), {'check_desktop': True, 'export': None, 'yes': True})()
        mode, command, timeout = desktop_readiness_request(
            required, interactive=False, desktop_command=desktop_command)
        self.assertEqual(mode, 'required')
        self.assertEqual(command, [*desktop_command, 'doctor', '--non-interactive', '--require-ready'])
        self.assertEqual(timeout, 50)
        runner.reset_mock(return_value=True)
        run_desktop_doctor(command, timeout=timeout, runner=runner)
        runner.assert_called_once_with(command, check=False, timeout=50)

    def test_interactive_setup_guides_and_export_skips_local_desktop(self):
        args = type('Args', (), {'check_desktop': False, 'export': None, 'yes': False})()
        self.assertEqual(desktop_readiness_mode(args, interactive=True), 'guided')
        args.export = Path('/plugin')
        self.assertEqual(desktop_readiness_mode(args, interactive=True), 'skip')


if __name__ == '__main__':
    unittest.main()
