"""The signed Mac helper cannot bind a socket path longer than 103 bytes; LCU only detects it."""
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

if sys.platform == 'win32':
    # The checks are macOS-only in production and read the POSIX password database.
    raise unittest.SkipTest('macOS socket path checks need pwd')

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lcu import doctor, platforms
import test_setup_pending as pending

SUFFIX = '/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/IPC/computeruse.sock'


def home_of_length(size):
    """A home folder whose default socket path is exactly `size` bytes."""
    return '/Users/' + 'a' * (size - len(SUFFIX) - len('/Users/'))


def real_home(home):
    return patch('pwd.getpwuid', return_value=SimpleNamespace(pw_dir=home))


class SocketPathTests(unittest.TestCase):
    def test_suffix_matches_the_documented_helper_path(self):
        self.assertEqual(len(SUFFIX.encode()), 83)
        self.assertEqual('/' + platforms.MAC_SOCKET_SUFFIX, SUFFIX)

    def test_103_bytes_is_accepted_and_104_is_not(self):
        with real_home(home_of_length(103)):
            path, overridden = platforms.mac_socket_path({})
            self.assertEqual((len(path.encode()), overridden), (103, False))
            self.assertIsNone(platforms.mac_socket_path_problem({}))
        with real_home(home_of_length(104)):
            message = platforms.mac_socket_path_problem({})
        self.assertIn('is 104 bytes (macOS limit 103)', message)
        self.assertIn(home_of_length(104) + SUFFIX, message)
        self.assertIn('home folder', message)
        self.assertIn('LCU cannot change the signed helper', message)

    def test_13_and_14_character_user_names(self):
        for name, fails in (('a' * 13, False), ('a' * 14, True)):
            with real_home(f'/Users/{name}'):
                self.assertEqual(bool(platforms.mac_socket_path_problem({})), fails, name)

    def test_bytes_not_characters_are_counted(self):
        # 13 characters, but each is two bytes in UTF-8.
        with real_home('/Users/' + 'é' * 13):
            message = platforms.mac_socket_path_problem({})
        self.assertIn('is 116 bytes', message)

    def test_default_path_uses_the_real_home_not_HOME(self):
        with real_home('/Users/real'), patch.dict(os.environ, {'HOME': '/tmp/' + 'x' * 200}):
            os.environ.pop(platforms.MAC_SOCKET_ENV, None)
            self.assertEqual(platforms.mac_socket_path(), ('/Users/real' + SUFFIX, False))
            self.assertIsNone(platforms.mac_socket_path_problem())

    def test_environment_override_replaces_the_default(self):
        override = {platforms.MAC_SOCKET_ENV: '/tmp/s.sock'}
        with real_home(home_of_length(200)):
            self.assertEqual(platforms.mac_socket_path(override), ('/tmp/s.sock', True))
            self.assertIsNone(platforms.mac_socket_path_problem(override))
        long = {platforms.MAC_SOCKET_ENV: '/tmp/' + 'b' * 99}
        with real_home('/Users/a'):
            message = platforms.mac_socket_path_problem(long)
        self.assertIn('104 bytes', message)
        self.assertIn(platforms.MAC_SOCKET_ENV, message)
        self.assertNotIn('home folder, so', message)

    def test_empty_override_is_ignored(self):
        with real_home('/Users/real'):
            self.assertEqual(platforms.mac_socket_path({platforms.MAC_SOCKET_ENV: ''}),
                             ('/Users/real' + SUFFIX, False))

    @unittest.skipIf(sys.platform != 'darwin', 'the limit is the macOS sun_path size')
    def test_the_os_really_refuses_a_104_byte_bind_and_allows_103(self):
        import socket
        with tempfile.TemporaryDirectory(dir='/tmp') as base:
            def bind(size):
                path = f'{base}/' + 'a' * (size - len(base) - 1)
                self.assertEqual(len(path.encode()), size)
                with socket.socket(socket.AF_UNIX) as sock:
                    sock.bind(path)
            bind(103)
            with self.assertRaises(OSError):
                bind(104)


class DoctorSocketTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.resolved = (self.root / 'ChatGPT.app', self.root / 'resources', self.root / 'cua_node',
                         {'version': 'fixture-app', 'runtime': 'fixture-cua'})
        self.env = {'NODE_REPL_NODE_PATH': '/fixture/node'}
        self.probe = {'target': 'mac', 'provider': {'ok': True, 'methods': ['list_apps', 'get_app_state']}}

    def run_doctor(self, home, platform_name='darwin'):
        (self.root / 'installation.json').write_text(json.dumps({'platform': platform_name}))
        output = io.StringIO()
        with real_home(home), patch.dict(os.environ, clear=False), \
             patch.object(sys, 'platform', 'darwin'), \
             patch('lcu.doctor._probe', return_value=self.probe) as probe, \
             patch('lcu.doctor._mac_instructions'), \
             patch('lcu.doctor.print_linux_sandbox_status'), \
             patch('sys.stdout', output):
            os.environ.pop(platforms.MAC_SOCKET_ENV, None)
            status = doctor.main(self.root, ['--non-interactive'], resolved=self.resolved, env=self.env)
        return status, output.getvalue(), probe

    def test_too_long_home_fails_with_a_clear_message(self):
        home = home_of_length(104)
        status, output, probe = self.run_doctor(home)
        self.assertEqual(status, 2)
        self.assertIn("Computer Use cannot start for this macOS account: the ChatGPT helper's "
                      'socket path is 104 bytes (macOS limit 103)', output)
        self.assertIn(home + SUFFIX, output)
        self.assertIn('13 ASCII characters or fewer after /Users/', output)
        self.assertNotIn('Original Mac provider loaded', output)

    def test_short_home_still_passes(self):
        status, output, probe = self.run_doctor(home_of_length(103))
        self.assertEqual(status, 0)
        self.assertNotIn('socket path', output)
        probe.assert_called_once()

    def test_a_macos_install_inspected_on_another_host_is_not_checked(self):
        with patch('lcu.platforms.mac_socket_path_problem') as problem, \
             patch('lcu.doctor._probe', return_value=self.probe), \
             patch('lcu.doctor._mac_instructions'), patch('sys.platform', 'linux'), \
             patch('sys.stdout', io.StringIO()):
            (self.root / 'installation.json').write_text(json.dumps({'platform': 'darwin'}))
            status = doctor.main(self.root, ['--non-interactive'], resolved=self.resolved, env=self.env)
        self.assertEqual(status, 0)
        problem.assert_not_called()

    def test_other_platforms_never_check_the_socket(self):
        self.probe = {'target': 'windows', 'windows': {'ok': True, 'count': 1}}
        with patch('lcu.platforms.mac_socket_path_problem') as problem:
            self.run_doctor(home_of_length(300), platform_name='windows')
        problem.assert_not_called()


class SetupSocketTests(pending.Fixture):
    def run_darwin(self, home):
        self.platform = 'darwin'
        with real_home(home), patch.dict(os.environ, clear=False):
            os.environ.pop(platforms.MAC_SOCKET_ENV, None)
            return self.run_main('--agent', 'codex', agents=('codex',))

    def test_too_long_home_warns_at_the_end_without_failing_setup(self):
        code, out, err = self.run_darwin(home_of_length(104))
        self.assertEqual(code, 0, err)
        warning = out.index('Warning: Computer Use cannot start for this macOS account')
        self.assertGreater(warning, out.index('Configuration prepared.'))
        self.assertEqual(self.registered[0]['names'], ['codex'])

    def test_export_setup_warns_too(self):
        self.platform = 'darwin'
        with real_home(home_of_length(104)), patch.object(pending.setup, 'export_bundle'), \
             patch.dict(os.environ, clear=False):
            os.environ.pop(platforms.MAC_SOCKET_ENV, None)
            code, out, err = self.run_main('--export', str(self.root / 'plugin'), agents=())
        self.assertEqual(code, 0, err)
        self.assertIn('Warning: Computer Use cannot start for this macOS account', out)

    def test_short_home_prints_no_warning(self):
        code, out, err = self.run_darwin(home_of_length(103))
        self.assertEqual(code, 0, err)
        self.assertNotIn('socket path', out)

    def test_linux_setup_never_warns(self):
        with real_home(home_of_length(300)):
            code, out, err = self.run_main('--agent', 'codex', agents=('codex',))
        self.assertEqual(code, 0, err)
        self.assertNotIn('socket path', out)


if __name__ == '__main__':
    unittest.main()
