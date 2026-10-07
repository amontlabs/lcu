"""The macOS launcher reports metadata from the selected signed app."""
import io
import json
import os
import pwd
from pathlib import Path
import socket
import subprocess
import sys
from types import SimpleNamespace
import tempfile
import time
from threading import Thread
import unittest
from unittest.mock import patch

if sys.platform == 'win32':
    raise unittest.SkipTest('macOS launcher and its Unix-socket lifecycle host')

from lcu.runtime import environment, main, paths


class MacRuntimeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name).resolve()
        self.root = base / 'release'
        self.root.mkdir()
        self.app = base / 'ChatGPT.app'
        self.resources = self.app / 'Contents/Resources'
        self.runtime = self.resources / 'cua_node'
        self.runtime.mkdir(parents=True)
        self.codex = self.resources / 'codex-cli/bin/codex'
        self.code_mode_host = self.resources / 'codex-cli/bin/codex-code-mode-host'
        self.codex.parent.mkdir(parents=True)
        self.codex.write_text('original codex')
        self.code_mode_host.write_text('original host')
        (self.root / 'app').symlink_to(self.app, target_is_directory=True)
        self.policy = {'version': 'old-lock-version', 'runtime': 'old-lock-runtime',
                       'architectures': {'arm64': {'components': {'fixture': 'ignored'}}}}
        (self.root / 'runtime.lock.json').write_text(json.dumps({'platforms': {'darwin': self.policy}}))
        (self.root / 'installation.json').write_text(json.dumps({
            'platform': 'darwin', 'app': str(self.app), 'architecture': 'arm64',
            'package_version': 'old-installed-version', 'runtime': 'old-installed-runtime'}))
        self.selected = SimpleNamespace(
            app=self.app, resources=self.resources, runtime=self.runtime, arch='arm64',
            version='26.924.22138', runtime_version='0.0.24/20260924074400-f52ea85e2a98',
            codex_cli=self.codex, code_mode_host=self.code_mode_host)

    def test_launches_original_entrypoint_with_verified_local_app(self):
        with patch('lcu.platforms.resolve_installed_mac_app', return_value=self.selected) as resolve, \
             patch('lcu.runtime.os.execve') as execute, \
             patch('lcu.runtime._configure_macos_lifecycle', return_value=None), \
             patch.dict(os.environ, {'HOME': '/fixture'}, clear=True):
            main(self.root, [])
        resolve.assert_called_once_with(self.app, arch='arm64')
        node = self.runtime / 'bin/node'
        self.assertEqual(execute.call_args.args[:2], (node, [str(node), str(
            self.runtime / 'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs')]))
        env = execute.call_args.args[2]
        self.assertEqual(env['CODEX_CLI_PATH'], str(self.codex))
        self.assertEqual(env['CUA_REPL_ENABLED_SURFACES'], 'computer')
        self.assertEqual(env['SKY_CUA_SERVICE_PATH'], str(
            self.runtime / 'lib/node_modules/@oai/sky/Codex Computer Use.app'))
        self.assertEqual(env['BROWSER_USE_AVAILABLE_BACKENDS'], 'chrome')
        self.assertEqual(env['BROWSER_USE_CODEX_APP_VERSION'], '26.924.22138')
        self.assertNotIn('NODE_REPL_HOST_SERVICES_PIPE_PATH', env)

    def test_macos_main_supervises_lifecycle_host_around_original_repl(self):
        from lcu import macos_host
        client = self.runtime / 'lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient'
        client.parent.mkdir(parents=True)
        client.write_text('fixture')
        client.chmod(0o755)
        host = object()
        temporary = object()
        with patch('lcu.platforms.resolve_installed_mac_app', return_value=self.selected), \
             patch('lcu.macos_host.start_original_host', return_value=(host, temporary, '/tmp/lcu.sock')) as start, \
             patch('lcu.macos_host.stop_original_host') as stop, \
             patch('lcu.runtime.subprocess.run', return_value=SimpleNamespace(returncode=0)) as run, \
             patch.dict(os.environ, {'HOME': pwd.getpwuid(os.getuid()).pw_dir}, clear=True):
            with self.assertRaises(SystemExit) as result:
                main(self.root, [])
        self.assertEqual(result.exception.code, 0)
        start.assert_called_once()
        stop.assert_called_once_with(host, temporary)
        self.assertEqual(run.call_args.args[0], [str(self.runtime / 'bin/node'), str(
            self.runtime / 'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs')])
        self.assertEqual(run.call_args.kwargs['env']['LCU_MAC_LIFETIME_SOCKET'], '/tmp/lcu.sock')
        # The host learns the default socket lock location before it starts, not afterwards.
        host_env = start.call_args.kwargs['env']
        self.assertTrue(host_env['LCU_MAC_SERVICE_LOCK'].endswith(
            '/Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/IPC/computeruse.sock.lock'))
        self.assertEqual(run.call_args.kwargs['env']['LCU_MAC_SERVICE_LOCK'], host_env['LCU_MAC_SERVICE_LOCK'])
        self.assertEqual(json.loads(run.call_args.kwargs['env']['NODE_REPL_TRUSTED_SERVICES'])['sky'],
                         str(self.root / 'lcu/macos_sky_service.mjs'))

    def test_a_custom_socket_path_leaves_the_service_lock_unknown_to_the_host(self):
        client = self.runtime / 'lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient'
        client.parent.mkdir(parents=True)
        client.write_text('fixture')
        client.chmod(0o755)
        with patch('lcu.platforms.resolve_installed_mac_app', return_value=self.selected), \
             patch('lcu.macos_host.start_original_host', return_value=(object(), object(), '/tmp/lcu.sock')) as start, \
             patch('lcu.macos_host.stop_original_host'), \
             patch('lcu.runtime.subprocess.run', return_value=SimpleNamespace(returncode=0)), \
             patch.dict(os.environ, {'HOME': '/fixture', 'SKY_CUA_SERVICE_NATIVE_PIPE_PATH': '/tmp/custom.sock',
                                 'LCU_MAC_SERVICE_LOCK': '/inherited/computeruse.sock.lock'}, clear=True):
            with self.assertRaises(SystemExit):
                main(self.root, [])
        self.assertNotIn('LCU_MAC_SERVICE_LOCK', start.call_args.kwargs['env'])

    def test_a_home_that_is_not_the_accounts_leaves_the_service_lock_unknown_to_the_host(self):
        # The original client builds its socket path from $HOME, so it is then not talking to
        # the account-home socket whose stale holder recovery would stop.
        client = self.runtime / 'lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient'
        client.parent.mkdir(parents=True)
        client.write_text('fixture')
        client.chmod(0o755)
        with patch('lcu.platforms.resolve_installed_mac_app', return_value=self.selected), \
             patch('lcu.macos_host.start_original_host', return_value=(object(), object(), '/tmp/lcu.sock')) as start, \
             patch('lcu.macos_host.stop_original_host'), \
             patch('lcu.runtime.subprocess.run', return_value=SimpleNamespace(returncode=0)), \
             patch.dict(os.environ, {'HOME': '/tmp/isolated-home', 'LCU_MAC_SERVICE_LOCK': '/inherited.lock'}, clear=True):
            with self.assertRaises(SystemExit):
                main(self.root, [])
        self.assertNotIn('LCU_MAC_SERVICE_LOCK', start.call_args.kwargs['env'])

    def test_reports_current_metadata_after_descriptor_and_lock_become_stale(self):
        with patch('lcu.platforms.resolve_installed_mac_app', return_value=self.selected) as resolve:
            actual = paths(self.root)
        resolve.assert_called_once_with(self.app, arch='arm64')
        self.assertEqual(actual[3], {
            'version': '26.924.22138', 'runtime': '0.0.24/20260924074400-f52ea85e2a98'})
        with patch('lcu.platforms.resolve_installed_mac_app', return_value=self.selected), \
             patch.dict(os.environ, {}, clear=True):
            env = environment(self.root)
        self.assertEqual(env['BROWSER_USE_CODEX_APP_VERSION'], '26.924.22138')

        (self.root / 'bundle.json').write_text(json.dumps({'version': '0.3.0'}))
        output = io.StringIO()
        with patch('lcu.platforms.resolve_installed_mac_app', return_value=self.selected), \
             patch('sys.stdout', output):
            main(self.root, ['--version'])
        self.assertIn('ChatGPT darwin 26.924.22138', output.getvalue())
        self.assertIn('CUA 0.0.24/20260924074400-f52ea85e2a98', output.getvalue())

    def test_rejects_descriptor_pointing_at_a_different_app(self):
        descriptor = self.root / 'installation.json'
        data = json.loads(descriptor.read_text())
        data['app'] = str(self.root / 'other.app')
        descriptor.write_text(json.dumps(data))
        with patch('lcu.platforms.resolve_installed_mac_app') as resolve:
            with self.assertRaisesRegex(ValueError, 'does not match'):
                paths(self.root)
        resolve.assert_not_called()

    def test_source_checkout_version_does_not_advertise_old_lock_values(self):
        (self.root / 'installation.json').unlink()
        output = io.StringIO()
        with patch('sys.stdout', output):
            main(self.root, ['--version'])
        self.assertIn('app not selected', output.getvalue())
        self.assertNotIn('old-lock-version', output.getvalue())

    def test_keeps_caller_helper_and_policy_settings(self):
        with patch('lcu.platforms.resolve_installed_mac_app', return_value=self.selected), \
             patch.dict(os.environ, {'SKY_CUA_SERVICE_PATH': '/chosen/helper.app',
                                     'CUA_REPL_ENABLED_SURFACES': 'computer'}, clear=True):
            env = environment(self.root)
        self.assertEqual(env['SKY_CUA_SERVICE_PATH'], '/chosen/helper.app')
        self.assertEqual(env['CUA_REPL_ENABLED_SURFACES'], 'computer')

    def test_configures_original_sky_service_lifecycle_wrapper(self):
        from lcu.runtime import _configure_macos_lifecycle
        wrapper = self.root / 'lcu/macos_sky_service.mjs'
        with patch.dict(os.environ, {'HOME': '/fixture', 'NODE_REPL_TRUSTED_SERVICES': json.dumps({
                'sky': '@oai/sky/service', 'browser': 'custom/browser/service',
                'other': 'custom/other/service'})}, clear=True):
            env = environment(self.root, (self.app, self.resources, self.runtime, {
                'version': '26.924.22138', 'runtime': 'fixture'}))
            client = _configure_macos_lifecycle(self.root, self.runtime, env)
        services = json.loads(env['NODE_REPL_TRUSTED_SERVICES'])
        self.assertEqual(services, {
            'sky': str(wrapper), 'browser': 'custom/browser/service',
            'other': 'custom/other/service'})
        self.assertEqual(env['LCU_MAC_SKY_SERVICE_PATH'], str(
            self.runtime / 'lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/service.js'))
        self.assertEqual(client, Path(env['SKY_CUA_SERVICE_PATH']) /
            'Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient')

    def test_rejects_custom_sky_trusted_service_when_cleanup_wrapper_is_required(self):
        from lcu.runtime import _configure_macos_lifecycle
        env = {'CUA_REPL_ENABLED_SURFACES': 'computer',
               'NODE_REPL_TRUSTED_SERVICES': json.dumps({'sky': 'custom/sky/service'})}
        with self.assertRaisesRegex(ValueError, 'custom Sky trusted-service'):
            _configure_macos_lifecycle(self.root, self.runtime, env)

    def test_lifecycle_host_passes_ids_to_fake_original_client(self):
        from lcu.macos_host import start_original_host, stop_original_host
        capture = self.root / 'client-argv.json'
        client = self.root / 'fake-client'
        client.write_text('#!/usr/bin/env python3\nimport json,sys\n'
                          f'open({str(capture)!r}, "w").write(json.dumps(sys.argv[1:]))\n')
        client.chmod(0o755)
        process, temporary, address = start_original_host(
            python=Path(sys.executable), client=client,
            entry=Path(__file__).resolve().parents[1] / 'lcu/macos_host.py', env=os.environ.copy())
        try:
            def request(raw):
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                    connection.settimeout(4)
                    connection.connect(address)
                    connection.sendall(raw)
                    response = bytearray()
                    while b'\n' not in response:
                        response.extend(connection.recv(1024))
                    return json.loads(response)

            malformed = request(b'{"session_id":"","turn_id":"turn-exact"}\n')
            self.assertFalse(malformed['notified'])
            self.assertIn('turn IDs are missing', malformed['error'])
            self.assertEqual(request(
                b'{"session_id":"session-exact","turn_id":"turn-exact"}\n'), {'notified': True})
            argv = json.loads(capture.read_text())
            self.assertEqual(argv[0], 'turn-ended')
            self.assertEqual(json.loads(argv[1]), {
                'type': 'agent-turn-complete',
                'thread-id': 'session-exact', 'turn-id': 'turn-exact'})
        finally:
            stop_original_host(process, temporary)

    def test_lifecycle_host_reports_original_client_failure(self):
        from lcu.macos_host import start_original_host, stop_original_host
        client = self.root / 'failing-client'
        client.write_text('#!/usr/bin/env python3\nraise SystemExit(23)\n')
        client.chmod(0o755)
        process, temporary, address = start_original_host(
            python=Path(sys.executable), client=client,
            entry=Path(__file__).resolve().parents[1] / 'lcu/macos_host.py', env=os.environ.copy())
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(4)
                connection.connect(address)
                connection.sendall(b'{"session_id":"session","turn_id":"turn"}\n')
                response = bytearray()
                while b'\n' not in response:
                    response.extend(connection.recv(1024))
            result = json.loads(response)
            self.assertFalse(result['notified'])
            self.assertIn('status 23', result['error'])
        finally:
            stop_original_host(process, temporary)

    def fake_client(self, name, body):
        client = self.root / name
        client.write_text('#!/usr/bin/env python3\nimport sys, time\n' + body)
        client.chmod(0o755)
        return client

    def test_lifecycle_host_waits_for_the_original_helper_runtime(self):
        # The signed helper stably takes about 5.2 s (its XPC connect deadline is 5 s).
        from lcu.macos_host import (TURN_ENDED_CLI_TIMEOUT_SECONDS, start_original_host,
                                    stop_original_host)
        self.assertGreater(TURN_ENDED_CLI_TIMEOUT_SECONDS, 6)
        client = self.fake_client('slow-client', 'time.sleep(5.2)\n')
        process, temporary, address = start_original_host(
            python=Path(sys.executable), client=client,
            entry=Path(__file__).resolve().parents[1] / 'lcu/macos_host.py', env=os.environ.copy())
        try:
            started = time.monotonic()
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(TURN_ENDED_CLI_TIMEOUT_SECONDS + 3)
                connection.connect(address)
                connection.sendall(b'{"session_id":"session","turn_id":"turn"}\n')
                response = bytearray()
                while b'\n' not in response:
                    response.extend(connection.recv(1024))
            self.assertEqual(json.loads(response), {'notified': True})
            self.assertGreaterEqual(time.monotonic() - started, 5.2)
        finally:
            stop_original_host(process, temporary)

    def run_turn_ended(self, client, **options):
        from lcu import macos_host
        stderr = io.StringIO()
        started = time.monotonic()
        error = None
        with patch('sys.stderr', stderr):
            try:
                macos_host.run_turn_ended(str(client), '{}', **options)
            except RuntimeError as exc:
                error = exc
        return error, stderr.getvalue(), time.monotonic() - started

    def test_turn_ended_command_past_its_timeout_fails_within_bounds(self):
        client = self.root / 'hung-client'
        client.write_text('#!/bin/sh\nexec sleep 30\n')
        client.chmod(0o755)
        error, log, elapsed = self.run_turn_ended(client, timeout=1)
        self.assertIsNotNone(error)
        self.assertIn('timed out after 1 seconds', str(error))
        self.assertLess(elapsed, 5)
        self.assertIn('exit=timeout', log)
        self.assertRegex(log, r'elapsed=\d{4} ms')

    def test_turn_ended_timeout_logs_the_stderr_captured_so_far(self):
        expired = subprocess.TimeoutExpired(['client'], 10, stderr=b'connect pending')
        with patch('lcu.macos_host.subprocess.run', side_effect=expired):
            error, log, _ = self.run_turn_ended('client')
        self.assertIn('timed out after 10 seconds', str(error))
        self.assertIn('exit=timeout', log)
        self.assertIn('connect pending', log)

    def test_turn_ended_command_failure_logs_exit_code_and_bounded_stderr(self):
        client = self.fake_client('noisy-client',
                                  'sys.stderr.write("e" * 2000)\nraise SystemExit(7)\n')
        error, log, _ = self.run_turn_ended(client)
        self.assertIn('status 7', str(error))
        self.assertIn('exit=7', log)
        self.assertIn('e' * 512, log)
        self.assertNotIn('e' * 513, log)

    def test_turn_ended_command_that_cannot_start_is_logged(self):
        error, log, _ = self.run_turn_ended(self.root / 'missing-client')
        self.assertIn('could not start', str(error))
        self.assertIn('exit=launch-failed', log)

    def test_turn_ended_command_logs_a_slow_success_but_not_a_fast_one(self):
        from lcu import macos_host
        slow = self.fake_client('slow-ok-client', 'time.sleep(0.4)\n')
        with patch.object(macos_host, 'TURN_ENDED_CLI_SLOW_SECONDS', 0.2):
            error, log, _ = self.run_turn_ended(slow)
        self.assertIsNone(error)
        self.assertRegex(log, r'exit=0 elapsed=\d+ ms')
        fast = self.fake_client('fast-ok-client', '')
        error, log, _ = self.run_turn_ended(fast)
        self.assertIsNone(error)
        self.assertEqual(log, '')

    def test_control_socket_routes_only_to_an_active_trusted_session_and_turn(self):
        from lcu.macos_host import start_original_host, stop_original_host
        client = self.root / 'unused-original-client'
        client.write_text('#!/usr/bin/env python3\nraise SystemExit(99)\n')
        client.chmod(0o755)
        control = self.root / 'control.sock'
        process, temporary, lifetime = start_original_host(
            python=Path(sys.executable), client=client,
            entry=Path(__file__).resolve().parents[1] / 'lcu/macos_host.py',
            env=os.environ.copy(), control_address=str(control))
        service = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            deadline = time.monotonic() + 4
            while not control.exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(control.exists())
            service.connect(str(control))
            service.sendall(b'{"type":"service"}\n'
                            b'{"type":"context","token":"tool-1",'
                            b'"session_id":"session-exact","turn_id":"turn-exact",'
                            b'"app":"Fixture App"}\n')
            service.settimeout(3)

            def request(value):
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                    connection.settimeout(4)
                    connection.connect(str(control))
                    connection.sendall((json.dumps(value) + '\n').encode())
                    response = bytearray()
                    while b'\n' not in response:
                        response.extend(connection.recv(1024))
                    return json.loads(response)

            wrong_turn = request({'type': 'status', 'session_id': 'session-exact',
                                  'turn_id': 'other-turn'})
            self.assertFalse(wrong_turn['ok'])
            self.assertIn('not active', wrong_turn['error'])
            wrong_app_result = {}
            wrong_app_worker = Thread(target=lambda: wrong_app_result.setdefault('value', request({
                'type': 'stop', 'session_id': 'session-exact', 'turn_id': 'turn-exact',
                'app': 'com.other.App'})))
            wrong_app_worker.start()
            buffered = bytearray()
            while b'\n' not in buffered:
                buffered.extend(service.recv(1024))
            wrong_app_command = json.loads(buffered.split(b'\n', 1)[0])
            self.assertEqual(wrong_app_command['app'], 'com.other.App')
            service.sendall((json.dumps({'type': 'result',
                'request_id': wrong_app_command['request_id'],
                'response': {'ok': False, 'error': 'selected app is not targeted'}}) + '\n').encode())
            wrong_app_worker.join(4)
            self.assertFalse(wrong_app_worker.is_alive())
            self.assertFalse(wrong_app_result['value']['ok'])
            self.assertIn('not targeted', wrong_app_result['value']['error'])

            result = {}
            request_started = time.time()
            worker = Thread(target=lambda: result.setdefault('value', request({
                'type': 'stop', 'session_id': 'session-exact', 'turn_id': 'turn-exact',
                'app': 'com.fixture.App'})))
            worker.start()
            buffered = bytearray()
            while b'\n' not in buffered:
                buffered.extend(service.recv(1024))
            command = json.loads(buffered.split(b'\n', 1)[0])
            self.assertEqual(command['type'], 'stop')
            self.assertEqual(command['session_id'], 'session-exact')
            self.assertEqual(command['turn_id'], 'turn-exact')
            self.assertEqual(command['app'], 'com.fixture.App')
            remaining_ms = command['deadline_unix_ms'] - int(request_started * 1000)
            self.assertGreaterEqual(remaining_ms, 39000)
            self.assertLessEqual(remaining_ms, 41000)
            service.sendall((json.dumps({'type': 'result', 'request_id': command['request_id'],
                'response': {'ok': True, 'result': {'accepted': True,
                    'applicationId': 'com.fixture.App'}}}) + '\n').encode())
            worker.join(4)
            self.assertFalse(worker.is_alive())
            self.assertEqual(result['value'], {'ok': True, 'result': {
                'accepted': True, 'applicationId': 'com.fixture.App'}})
        finally:
            service.close()
            stop_original_host(process, temporary)

    def test_optional_control_socket_failure_keeps_original_lifecycle_host_alive(self):
        from lcu.macos_host import start_original_host, stop_original_host
        client = self.root / 'unused-original-client'
        client.write_text('#!/usr/bin/env python3\nraise SystemExit(0)\n')
        client.chmod(0o755)
        occupied = self.root / 'occupied-control.sock'
        occupied.write_text('owned by another process')
        process, temporary, address = start_original_host(
            python=Path(sys.executable), client=client,
            entry=Path(__file__).resolve().parents[1] / 'lcu/macos_host.py',
            env=os.environ.copy(), control_address=str(occupied))
        try:
            self.assertIsNone(process.poll())
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(4)
                connection.connect(address)
                connection.sendall(b'{"session_id":"session","turn_id":"turn"}\n')
                response = bytearray()
                while b'\n' not in response:
                    response.extend(connection.recv(1024))
            self.assertEqual(json.loads(response), {'notified': True})
            self.assertEqual(occupied.read_text(), 'owned by another process')
        finally:
            stop_original_host(process, temporary)

    def test_trusted_control_dispatch_preserves_original_runtime_context(self):
        script = Path(__file__).with_name('macos_control_service.mjs')
        result = subprocess.run(['node', str(script)], check=True, capture_output=True,
                                text=True, timeout=20)
        self.assertIn('macOS trusted control dispatch checks passed', result.stdout)


if __name__ == '__main__':
    unittest.main()
