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
        self.home = Path(self.tmp.name).resolve() / 'home'  # /var is a symlink on macOS
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
        self.assertFalse(update.stale({'checked_at': now - 540, 'error': None}, now))
        self.assertTrue(update.stale({'checked_at': now - 601, 'error': None}, now))
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
        update.cache_path().with_name('refresh.stamp').unlink()
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

    def test_post_install_refreshes_whole_claude_mod(self):
        from lcu import claude_mod
        source = self.root / claude_mod.SOURCE
        files = {'.claude-plugin/plugin.json': '{"name": "lcu-approve", "version": "0.3.0"}',
                 'hooks/hooks.json': '{}', 'hooks/register.tsx': 'new', 'types/index.d.ts': 'types',
                 'tests/register.test.tsx': 'test'}
        for name, text in files.items():
            (source / name).parent.mkdir(parents=True, exist_ok=True)
            (source / name).write_text(text)
        # What 0.9.0 left behind: an older mod without types/index.d.ts and a file since dropped.
        target = claude_mod.destination(self.home)
        (target / '.claude-plugin').mkdir(parents=True)
        (target / '.claude-plugin/plugin.json').write_text('{"name": "lcu-approve", "version": "0.2.0"}')
        (target / 'hooks').mkdir()
        (target / 'hooks/register.tsx').write_text('old')
        (target / 'hooks/stale.ts').write_text('stale')
        with mock.patch('sys.stdout', new_callable=io.StringIO) as out:
            self.assertEqual(update.main(self.root, ['--post-install']), 0)
        self.assertIn('Refreshed the Claude Code lcu-approve mod', out.getvalue())
        self.assertEqual((target / 'types/index.d.ts').read_text(), 'types')
        self.assertEqual((target / 'hooks/register.tsx').read_text(), 'new')
        self.assertIn('0.3.0', (target / '.claude-plugin/plugin.json').read_text())
        self.assertFalse((target / 'hooks/stale.ts').exists())
        self.assertFalse((target / 'tests').exists())
        config = json.loads((target / claude_mod.CONFIG).read_text())
        self.assertEqual(config['lcu'], str(self.root.parent.parent / 'current/bin/lcu'))

    def test_post_install_leaves_absent_or_foreign_mod_alone(self):
        from lcu import claude_mod
        with mock.patch('sys.stdout', new_callable=io.StringIO) as out:
            self.assertEqual(update.post_install(self.root, self.home), 0)
        self.assertFalse(claude_mod.destination(self.home).exists())
        target = claude_mod.destination(self.home)
        (target / '.claude-plugin').mkdir(parents=True)
        (target / '.claude-plugin/plugin.json').write_text('{"name": "someone-else"}')
        with mock.patch('sys.stdout', new_callable=io.StringIO) as out:
            update.post_install(self.root, self.home)
        self.assertEqual(out.getvalue(), '')
        self.assertEqual((target / '.claude-plugin/plugin.json').read_text(), '{"name": "someone-else"}')

    def test_codex_hint_only_when_registered_without_notice_hook(self):
        codex = self.home / '.codex'
        codex.mkdir()
        env = {'CODEX_HOME': str(codex)}
        self.assertFalse(update.codex_needs_setup(self.home, env))
        (codex / 'config.toml').write_text('[mcp_servers.lcu]\ncommand = "/p/current/bin/lcu"\n')
        self.assertTrue(update.codex_needs_setup(self.home, env))
        (codex / 'config.toml').write_text(
            '[mcp_servers.lcu]\ncommand = "/p/current/bin/lcu"\n'
            '[[hooks.SessionStart]]\nmatcher = "startup|resume"\n'
            '[[hooks.SessionStart.hooks]]\ntype = "command"\n'
            'command = "/p/current/bin/lcu update --notice --hook SessionStart"\n')
        self.assertTrue(update.codex_needs_setup(self.home, env))
        with (codex / 'config.toml').open('a') as handle:
            handle.write('[[hooks.UserPromptSubmit]]\n'
                         '[[hooks.UserPromptSubmit.hooks]]\ntype = "command"\n'
                         'command = "/p/current/bin/lcu update --notice --hook UserPromptSubmit"\n')
        self.assertFalse(update.codex_needs_setup(self.home, env))

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
        self.cache({**INFO, 'version': '0.9.1'})
        self.assertEqual(self.run_main('--notice', '--json'), (0, '{}\n'))
        self.assertEqual(self.run_main('--notice'), (0, ''))
        self.assertEqual(self.run_main('--notice', '--hook', 'SessionStart'), (0, ''))

    def hook(self, event, stdin='{"session_id": "s1"}'):
        out = io.StringIO()
        with mock.patch('sys.stdin', io.StringIO(stdin)), mock.patch('sys.stdout', out), \
                mock.patch.object(update.subprocess, 'Popen'):
            self.assertEqual(update.main(self.root, ['--notice', '--hook', event]), 0)
        return json.loads(out.getvalue())['hookSpecificOutput'] if out.getvalue() else None

    def test_hook_announces_once_per_session_and_version(self):
        self.cache()
        first = self.hook('SessionStart')
        self.assertEqual(first['hookEventName'], 'SessionStart')
        self.assertTrue(first['additionalContext'].startswith('LCU 0.9.2 is available'))
        self.assertIsNone(self.hook('SessionStart'))
        self.assertIsNone(self.hook('UserPromptSubmit'))
        other = self.hook('UserPromptSubmit', '{"session_id": "s2"}')
        self.assertEqual(other['hookEventName'], 'UserPromptSubmit')
        self.cache({**INFO, 'version': '0.9.3', 'tag': 'v0.9.3'})
        self.assertIn('0.9.3', self.hook('UserPromptSubmit')['additionalContext'])
        self.assertIsNone(self.hook('SessionStart'))

    def test_hook_without_notice_is_silent(self):
        self.cache({**INFO, 'version': '0.9.1'})
        self.assertIsNone(self.hook('SessionStart'))
        self.assertFalse(update.cache_path().with_name('announced.json').exists())

    def test_hook_missing_or_garbage_session_id(self):
        self.cache()
        for stdin in ('', 'garbage{', '[]', '{"session_id": 5}', '{}'):
            self.assertIsNotNone(self.hook('SessionStart', stdin))
            self.assertIsNone(self.hook('UserPromptSubmit', stdin))
        self.assertFalse(update.cache_path().with_name('announced.json').exists())

    def test_hook_prunes_old_announcements(self):
        self.cache()
        path = update.cache_path().with_name('announced.json')
        now = time.time()
        path.write_text(json.dumps({'old': {'version': '0.9.2', 'at': now - 8 * 86400},
                                    'recent': {'version': '0.9.2', 'at': now - 86400}, 'bad': 3}))
        self.assertIsNone(self.hook('UserPromptSubmit', '{"session_id": "recent"}'))
        self.assertIsNotNone(self.hook('UserPromptSubmit', '{"session_id": "old"}'))
        data = json.loads(path.read_text())
        self.assertEqual(set(data), {'old', 'recent'})
        self.assertGreater(data['old']['at'], now - 5)
        path.write_text('{broken')
        self.assertIsNotNone(self.hook('UserPromptSubmit'))

    def test_refresh_stamp_guards_stampede(self):
        with mock.patch.object(update.subprocess, 'Popen') as popen:
            update.notice(self.root)
            update.notice(self.root)
        popen.assert_called_once()
        stamp = update.cache_path().with_name('refresh.stamp')
        old = time.time() - 121
        os.utime(stamp, (old, old))
        with mock.patch.object(update.subprocess, 'Popen') as popen:
            update.notice(self.root)
        popen.assert_called_once()

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
