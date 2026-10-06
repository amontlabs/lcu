"""Detect a Computer Use service that outlived an update of its app bundle."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

if sys.platform == 'win32':
    raise unittest.SkipTest('macOS private host')

from lcu.macos_host import (SKY_SERVICE_NAME, bundle_replaced_at, diagnose_response,
                            diagnose_sky_services, parse_process_start, parse_process_table,
                            stale_service_message)

BUNDLE = '/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app'
EXECUTABLE = f'{BUNDLE}/Contents/MacOS/{SKY_SERVICE_NAME}'
PLIST = f'{BUNDLE}/Contents/Info.plist'


def epoch(text):
    return parse_process_start(text.split())


def ps(*lines, returncode=0):
    return Mock(return_value=SimpleNamespace(returncode=returncode, stdout='\n'.join(lines) + '\n', stderr=''))


def stat_with(times):
    def stat(path):
        if str(path) not in times:
            raise FileNotFoundError(path)
        return SimpleNamespace(st_ctime=epoch(times[str(path)]) if isinstance(times[str(path)], str)
                               else times[str(path)])
    return stat


class ProcessTableTests(unittest.TestCase):
    def test_parses_pid_start_and_a_path_with_spaces(self):
        services, unparsed = parse_process_table('\n'.join([
            '    1 Tue Oct  6 08:00:00 2026     /sbin/launchd',
            f'45404 Wed Oct  7 00:34:53 2026     {EXECUTABLE}',
            '  999 Wed Oct  7 01:00:00 2026     /usr/bin/ssh',
        ]))
        self.assertEqual(unparsed, 0)
        self.assertEqual(services, [{'pid': 45404, 'path': EXECUTABLE,
                                     'started': epoch('Wed Oct 7 00:34:53 2026')}])

    def test_counts_unparseable_service_lines_instead_of_guessing(self):
        services, unparsed = parse_process_table('\n'.join([
            f'oops Wed Oct  7 00:34:53 2026 {EXECUTABLE}',
            f'45404 Wed Smarch  7 00:34:53 2026 {EXECUTABLE}',
            f'45405 Wed Oct  7 25:34:53 2026 {EXECUTABLE}',
            f'45406 Wed Oct  7 00:34:53 2026 relative/{SKY_SERVICE_NAME}',
            f'45407 Wed Oct  7 00:34:53 2026 /x/{SKY_SERVICE_NAME}Helper',
            f'45408 {SKY_SERVICE_NAME}',
            'garbage with no service name',
        ]))
        self.assertEqual(services, [])
        self.assertEqual(unparsed, 6)


class BundleTimeTests(unittest.TestCase):
    def test_uses_the_newest_inode_change_of_executable_and_plist(self):
        stat = stat_with({EXECUTABLE: 100.0, PLIST: 250.0})
        self.assertEqual(bundle_replaced_at(EXECUTABLE, stat), 250.0)

    def test_executable_alone_is_enough_and_a_missing_executable_is_none(self):
        self.assertEqual(bundle_replaced_at(EXECUTABLE, stat_with({EXECUTABLE: 100.0})), 100.0)
        self.assertIsNone(bundle_replaced_at(EXECUTABLE, stat_with({PLIST: 250.0})))


class DiagnoseTests(unittest.TestCase):
    def test_flags_a_service_started_before_its_bundle_was_replaced(self):
        run = ps(f'45404 Tue Oct  6 11:00:00 2026   {EXECUTABLE}')
        stat = stat_with({EXECUTABLE: 'Wed Oct 7 00:21:00 2026', PLIST: 'Wed Oct 7 00:21:00 2026'})
        diagnosis = diagnose_sky_services(run=run, stat=stat)
        self.assertEqual(diagnosis['stale'], [45404])
        self.assertTrue(diagnosis['services'][0]['stale'])
        self.assertEqual(diagnosis['message'], stale_service_message([45404]))
        self.assertTrue(diagnosis['message'].startswith('A Computer Use service (pid 45404) started before '
                                                        'ChatGPT was updated still holds the connection. '))
        self.assertTrue(diagnosis['message'].endswith('wait, or quit it, then retry.'))
        self.assertEqual(run.call_args.args[0], ['ps', '-axo', 'pid=,lstart=,comm='])
        self.assertEqual(run.call_args.kwargs['env']['LC_ALL'], 'C')

    def test_a_service_started_after_the_replacement_is_fresh(self):
        run = ps(f'45404 Wed Oct  7 00:34:53 2026   {EXECUTABLE}')
        stat = stat_with({EXECUTABLE: 'Wed Oct 7 00:21:00 2026', PLIST: 'Wed Oct 7 00:21:00 2026'})
        diagnosis = diagnose_sky_services(run=run, stat=stat)
        self.assertEqual(diagnosis['stale'], [])
        self.assertNotIn('message', diagnosis)
        self.assertFalse(diagnosis['services'][0]['stale'])

    def test_a_change_within_the_start_time_resolution_is_not_stale(self):
        start = epoch('Wed Oct 7 00:34:53 2026')
        run = ps(f'45404 Wed Oct  7 00:34:53 2026   {EXECUTABLE}')
        for replaced, stale in ((start + 1.9, False), (start + 2.5, True)):
            diagnosis = diagnose_sky_services(run=run, stat=stat_with({EXECUTABLE: replaced}))
            self.assertEqual(diagnosis['stale'] == [45404], stale, replaced)

    def test_no_service_running(self):
        diagnosis = diagnose_sky_services(run=ps('    1 Tue Oct  6 08:00:00 2026 /sbin/launchd'),
                                          stat=stat_with({}))
        self.assertEqual(diagnosis, {'services': [], 'stale': [], 'unparsed': 0})

    def test_missing_bundle_is_reported_but_not_flagged(self):
        diagnosis = diagnose_sky_services(run=ps(f'45404 Tue Oct  6 11:00:00 2026 {EXECUTABLE}'),
                                          stat=stat_with({}))
        self.assertEqual(diagnosis['stale'], [])
        self.assertTrue(diagnosis['services'][0]['bundle_missing'])
        self.assertIsNone(diagnosis['services'][0]['bundle_replaced'])

    def test_unparseable_output_flags_nothing(self):
        diagnosis = diagnose_sky_services(run=ps(f'??? {EXECUTABLE}', 'not a process table'),
                                          stat=stat_with({EXECUTABLE: 'Wed Oct 7 00:21:00 2026'}))
        self.assertEqual((diagnosis['services'], diagnosis['stale'], diagnosis['unparsed']), ([], [], 1))

    def test_only_the_older_of_two_services_is_flagged(self):
        other = '/Users/x/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/' + SKY_SERVICE_NAME
        run = ps(f'45404 Wed Oct  7 00:34:53 2026 {other}',
                 f'  200 Tue Oct  6 11:00:00 2026 {EXECUTABLE}')
        stat = stat_with({EXECUTABLE: 'Wed Oct 7 00:21:00 2026',
                          other: 'Wed Oct 7 00:34:50 2026'})
        diagnosis = diagnose_sky_services(run=run, stat=stat)
        self.assertEqual(diagnosis['stale'], [200])
        self.assertEqual([service['pid'] for service in diagnosis['services']], [45404, 200])

    def test_several_stale_services_are_all_named(self):
        message = stale_service_message([7, 9])
        self.assertIn('(pids 7, 9)', message)
        self.assertIn('wait, or quit it, then retry.', message)

    def test_ps_failure_is_an_error_response_not_a_guess(self):
        with self.assertRaises(ValueError):
            diagnose_sky_services(run=ps(returncode=1), stat=stat_with({}))
        with patch('lcu.macos_host.diagnose_sky_services', side_effect=subprocess.TimeoutExpired('ps', 2)):
            reply = diagnose_response()
        self.assertFalse(reply['ok'])
        self.assertIn('ps', reply['error'])

    def test_real_file_times_compare_with_process_start(self):
        with tempfile.TemporaryDirectory() as base:
            executable = Path(base) / 'Codex Computer Use.app/Contents/MacOS' / SKY_SERVICE_NAME
            executable.parent.mkdir(parents=True)
            executable.write_text('service')
            changed = os.stat(executable).st_ctime
            older = time.strftime('%a %b %e %H:%M:%S %Y', time.localtime(changed - 600))
            newer = time.strftime('%a %b %e %H:%M:%S %Y', time.localtime(changed + 600))
            self.assertEqual(diagnose_sky_services(run=ps(f'10 {older} {executable}'))['stale'], [10])
            self.assertEqual(diagnose_sky_services(run=ps(f'10 {newer} {executable}'))['stale'], [])

    def test_the_diagnosis_only_lists_processes_and_never_signals_one(self):
        run = ps(f'45404 Tue Oct  6 11:00:00 2026 {EXECUTABLE}')
        with patch('os.kill') as kill, patch('os.killpg') as killpg:
            diagnose_sky_services(run=run, stat=stat_with({EXECUTABLE: 'Wed Oct 7 00:21:00 2026'}))
        kill.assert_not_called()
        killpg.assert_not_called()
        run.assert_called_once()


class HostRequestTests(unittest.TestCase):
    def test_host_answers_a_diagnose_request_without_a_session(self):
        from lcu.macos_host import start_original_host, stop_original_host
        with tempfile.TemporaryDirectory() as base:
            client = Path(base) / 'client'
            client.write_text('#!/bin/sh\nexit 0\n')
            client.chmod(0o755)
            process, temporary, address = start_original_host(
                python=Path(sys.executable), client=client,
                entry=Path(__file__).resolve().parents[1] / 'lcu/macos_host.py', env=os.environ.copy())
            try:
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                    connection.settimeout(8)
                    connection.connect(address)
                    connection.sendall(b'{"type":"diagnose"}\n')
                    response = bytearray()
                    while b'\n' not in response:
                        response.extend(connection.recv(4096))
                reply = json.loads(response)
                self.assertTrue(reply['ok'], reply)
                self.assertIsInstance(reply['services'], list)
                self.assertIsInstance(reply['stale'], list)
                # The host keeps serving turn cleanup afterwards.
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                    connection.settimeout(8)
                    connection.connect(address)
                    connection.sendall(b'{"session_id":"s","turn_id":"t"}\n')
                    self.assertEqual(json.loads(connection.recv(1024)), {'notified': True})
            finally:
                stop_original_host(process, temporary)


if __name__ == '__main__':
    unittest.main()
