import io
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest import mock
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from lcu import update


def release(directory, version='0.9.1'):
    root = Path(directory) / 'prefix/releases/r1'
    root.mkdir(parents=True)
    if version:
        (root / 'bundle.json').write_text(json.dumps({'version': version}))
    return root


INFO = {'version': '0.9.2', 'tag': 'v0.9.2', 'severity': 'normal',
        'release_url': 'https://github.com/amontlabs/lcu/releases/tag/v0.9.2'}


class UpdateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / 'home'
        self.home.mkdir()
        env = {'HOME': str(self.home), 'XDG_CACHE_HOME': str(self.home / 'xdg'),
               'LOCALAPPDATA': str(self.home / 'local')}
        patcher = mock.patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)
        os.environ.pop('LCU_NO_UPDATE_CHECK', None)
        home = mock.patch('pathlib.Path.home', return_value=self.home)
        home.start()
        self.addCleanup(home.stop)
        self.root = release(self.tmp.name)

    def cache(self, latest=INFO, error=None, age=0):
        path = update.cache_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({'checked_at': time.time() - age, 'latest': latest, 'error': error}))

    def test_version_compare(self):
        self.assertEqual(update.parse_version('v0.9.2'), (0, 9, 2))
        self.assertIsNone(update.parse_version('0.9.x'))
        self.assertIsNone(update.parse_version(''))
        self.assertTrue(update.newer(self.root, INFO))
        self.assertFalse(update.newer(self.root, {'version': '0.9.1'}))
        self.assertFalse(update.newer(self.root, {'version': '0.8.9'}))
        self.assertTrue(update.newer(self.root, {'version': '0.10.0'}))
        self.assertFalse(update.newer(self.root, {'version': 'garbage'}))

    def test_cache_path_is_per_account(self):
        path = str(update.cache_path())
        self.assertTrue(path.startswith(str(self.home)))
        self.assertTrue(path.endswith('update.json'))

    def test_latest_tag_from_redirect(self):
        error = urllib.error.HTTPError(update.LATEST_URL, 302, 'Found',
                                       {'Location': 'https://github.com/amontlabs/lcu/releases/tag/v0.9.2'}, None)
        with mock.patch.object(update, '_open', side_effect=error):
            self.assertEqual(update.latest_tag(), 'v0.9.2')
        error = urllib.error.HTTPError(update.LATEST_URL, 404, 'No', {}, None)
        with mock.patch.object(update, '_open', side_effect=error), self.assertRaises(urllib.error.HTTPError):
            update.latest_tag()
        response = mock.Mock(headers={'Location': '/amontlabs/lcu/releases/tag/0.9.3'})
        with mock.patch.object(update, '_open', return_value=response):
            self.assertEqual(update.latest_tag(), '0.9.3')
        response = mock.Mock(headers={})
        with mock.patch.object(update, '_open', return_value=response), self.assertRaises(ValueError):
            update.latest_tag()

    def test_fetch_latest_handles_both_tag_formats_and_severity(self):
        for tag in ('v0.9.2', '0.9.2'):
            with mock.patch.object(update, 'latest_tag', return_value=tag), \
                    mock.patch.object(update, 'severity_of', return_value='security'):
                info = update.fetch_latest()
            self.assertEqual((info['version'], info['tag'], info['severity']), ('0.9.2', tag, 'security'))
            self.assertTrue(info['release_url'].endswith('/releases/tag/' + tag))
        with mock.patch.object(update, 'latest_tag', return_value='nightly'), self.assertRaises(ValueError):
            update.fetch_latest()

    def test_severity_marker(self):
        def opened(text):
            return mock.MagicMock(**{'__enter__.return_value.read.return_value': text.encode()})
        for text, expected in (('# LCU 0.9.2\n\n<!-- lcu-severity: security -->\n', 'security'),
                               ('Add `<!-- lcu-severity: security -->` to the notes.', 'normal'),
                               ('<!-- lcu-severity: breaking -->', 'breaking'),
                               ('<!-- lcu-severity: weird -->', 'normal'), ('nothing', 'normal')):
            with mock.patch.object(update, '_open', return_value=opened(text)):
                self.assertEqual(update.severity_of('v0.9.2', '0.9.2'), expected)
        with mock.patch.object(update, '_open', side_effect=OSError('down')):
            self.assertEqual(update.severity_of('v0.9.2', '0.9.2'), 'normal')

    def test_staleness_and_error_backoff(self):
        now = time.time()
        self.assertTrue(update.stale(None))
        self.assertFalse(update.stale({'checked_at': now - 3600, 'error': None}, now))
        self.assertTrue(update.stale({'checked_at': now - 25 * 3600, 'error': None}, now))
        self.assertFalse(update.stale({'checked_at': now - 600, 'error': 'down'}, now))
        self.assertTrue(update.stale({'checked_at': now - 4000, 'error': 'down'}, now))
        self.assertTrue(update.stale({'checked_at': now + 999, 'error': None}, now))

    def test_check_writes_cache_and_keeps_known_release_on_error(self):
        with mock.patch.object(update, 'fetch_latest', return_value=INFO):
            self.assertEqual(update.check(self.root), (INFO, None))
        self.assertEqual(update.read_cache()['latest'], INFO)
        with mock.patch.object(update, 'fetch_latest', side_effect=OSError('offline')):
            self.assertEqual(update.check(self.root), (None, 'offline'))
        cache = update.read_cache()
        self.assertEqual((cache['latest'], cache['error']), (INFO, 'offline'))

    def test_disabled_by_env_and_source_checkout(self):
        self.assertTrue(update.enabled(self.root))
        for value, expected in (('1', False), ('yes', False), ('0', True), ('', True)):
            self.assertEqual(update.enabled(self.root, {'LCU_NO_UPDATE_CHECK': value}), expected)
        source = release(self.tmp.name + '/src', version=None)
        self.assertFalse(update.enabled(source))
        self.cache()
        with mock.patch.object(update.subprocess, 'Popen') as popen:
            self.assertIsNone(update.notice(source))
            popen.assert_not_called()
        with mock.patch.dict(os.environ, {'LCU_NO_UPDATE_CHECK': '1'}), \
                mock.patch.object(update.subprocess, 'Popen') as popen:
            self.assertIsNone(update.notice(self.root))
            self.assertIsNone(update.status_line(self.root))
            popen.assert_not_called()

    def test_notice_shape_and_messages(self):
        self.cache()
        with mock.patch.object(update.subprocess, 'Popen') as popen:
            found = update.notice(self.root)
            popen.assert_not_called()  # fresh cache
        command = str(self.root.parent.parent / 'current/bin/lcu')
        self.assertEqual(set(found), {'current', 'latest', 'severity', 'release_url', 'command', 'message'})
        self.assertEqual((found['current'], found['latest'], found['severity'], found['command']),
                         ('0.9.1', '0.9.2', 'normal', command))
        self.assertIn(f'`{command} update`', found['message'])
        self.assertIn('without asking', found['message'])
        self.assertIn(INFO['release_url'], found['message'])
        self.assertTrue(found['message'].startswith('LCU 0.9.2 is available'))
        self.cache({**INFO, 'severity': 'security'})
        self.assertTrue(update.notice(self.root)['message'].startswith('Security update: '))
        self.cache({**INFO, 'severity': 'breaking'})
        self.assertTrue(update.notice(self.root)['message'].startswith('Breaking update: '))
        self.assertIn('0.9.2', update.status_line(self.root))

    def test_no_notice_when_current_or_missing(self):
        self.assertIsNone(update.notice_cached(self.root))
        self.cache({**INFO, 'version': '0.9.1'})
        self.assertIsNone(update.notice_cached(self.root))
        self.assertIsNone(update.status_line(self.root))

    def test_stale_cache_spawns_detached_refresh(self):
        with mock.patch.object(update.subprocess, 'Popen') as popen:
            self.assertIsNone(update.notice(self.root))
        popen.assert_called_once()
        args, kwargs = popen.call_args
        self.assertEqual(args[0][1:], [str(self.root / 'bin/lcu'), 'update', '--refresh'])
        self.assertIs(kwargs['stdout'], update.subprocess.DEVNULL)
        self.assertTrue(kwargs['start_new_session'])
        self.cache(age=90000)
        with mock.patch.object(update.subprocess, 'Popen') as popen:
            self.assertEqual(update.notice(self.root)['latest'], '0.9.2')
        popen.assert_called_once()

    def test_notice_never_raises(self):
        with mock.patch.object(update.subprocess, 'Popen', side_effect=OSError('no')):
            self.assertIsNone(update.notice(self.root))
        update.cache_path().parent.mkdir(parents=True, exist_ok=True)
        update.cache_path().write_text('{not json')
        with mock.patch.object(update.subprocess, 'Popen'):
            self.assertIsNone(update.notice(self.root))
        self.cache({'version': None})
        with mock.patch.object(update.subprocess, 'Popen'):
            self.assertIsNone(update.notice(self.root))
        with mock.patch.object(update, 'enabled', side_effect=RuntimeError('boom')):
            self.assertIsNone(update.notice(self.root))
            self.assertIsNone(update.status_line(self.root))
            out = io.StringIO()
            with mock.patch('sys.stdout', out):
                self.assertEqual(update.main(self.root, ['--notice', '--json']), 0)
            self.assertEqual(json.loads(out.getvalue()), {})

    def run_main(self, *argv):
        out = io.StringIO()
        with mock.patch('sys.stdout', out), mock.patch('sys.stderr', io.StringIO()):
            status = update.main(self.root, list(argv))
        return status, out.getvalue()

    def test_stable_command_per_platform(self):
        prefix = self.root.parent.parent
        with mock.patch.object(update.sys, 'platform', 'darwin'):
            self.assertEqual(update.stable_command(self.root), prefix / 'current/bin/lcu')
        with mock.patch.object(update.sys, 'platform', 'win32'):
            self.assertEqual(update.stable_command(self.root), prefix / 'lcu.cmd')

    def test_notice_cli(self):
        self.cache()
        status, out = self.run_main('--notice', '--json')
        self.assertEqual(status, 0)
        self.assertEqual(json.loads(out)['latest'], '0.9.2')
        status, out = self.run_main('--notice')
        self.assertTrue(out.startswith('LCU 0.9.2 is available'))
        status, out = self.run_main('--notice', '--hook-json')
        output = json.loads(out)['hookSpecificOutput']
        self.assertEqual(output['hookEventName'], 'SessionStart')
        self.assertTrue(output['additionalContext'].startswith('LCU 0.9.2 is available'))
        self.cache({**INFO, 'version': '0.9.1'})
        self.assertEqual(self.run_main('--notice', '--json'), (0, '{}\n'))
        self.assertEqual(self.run_main('--notice'), (0, ''))
        self.assertEqual(self.run_main('--notice', '--hook-json'), (0, ''))

    def test_check_cli(self):
        with mock.patch.object(update, 'fetch_latest', return_value=INFO):
            status, out = self.run_main('--check')
            self.assertEqual(status, 0)
            self.assertIn('LCU 0.9.2 is available (installed 0.9.1)', out)
            self.assertIn('update to upgrade.', out)
            data = json.loads(self.run_main('--check', '--json')[1])
            self.assertEqual((data['current'], data['update_available'], data['error']), ('0.9.1', True, None))
            self.assertEqual(data['latest'], INFO)
        with mock.patch.object(update, 'fetch_latest', return_value={**INFO, 'version': '0.9.1'}):
            self.assertEqual(self.run_main('--check'), (0, 'LCU 0.9.1 is up to date.\n'))
        with mock.patch.object(update, 'fetch_latest', side_effect=OSError('down')):
            status, out = self.run_main('--check', '--json')
            self.assertEqual(status, 1)
            self.assertEqual(json.loads(out)['error'], 'down')

    def test_refresh_cli_is_silent(self):
        with mock.patch.object(update, 'fetch_latest', return_value=INFO):
            self.assertEqual(self.run_main('--refresh'), (0, ''))
        self.assertEqual(update.read_cache()['latest'], INFO)
        with mock.patch.object(update, 'fetch_latest', side_effect=OSError('down')):
            self.assertEqual(self.run_main('--refresh'), (0, ''))

    def test_update_applies_only_when_newer(self):
        fake = mock.Mock(apply=mock.Mock(return_value=7))
        with mock.patch.dict(sys.modules, {'lcu.update_apply': fake}), \
                mock.patch.object(update, 'fetch_latest', return_value=INFO):
            self.assertEqual(self.run_main('--yes')[0], 7)
            fake.apply.assert_called_once_with(self.root, INFO, yes=True)
        fake.apply.reset_mock()
        with mock.patch.dict(sys.modules, {'lcu.update_apply': fake}), \
                mock.patch.object(update, 'fetch_latest', return_value={**INFO, 'version': '0.9.1'}):
            self.assertEqual(self.run_main(), (0, 'LCU 0.9.1 is up to date.\n'))
            fake.apply.assert_not_called()


if __name__ == '__main__':
    unittest.main()
