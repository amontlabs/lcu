"""LCU's SessionStart update-notice hook: separate from the original lifecycle hooks, trusted like them."""
import io
import json
import os
from pathlib import Path
import shlex
import shutil
import sys
import tempfile
import time
import tomllib
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lcu import update
from lcu.codex_hooks import NOTICE_EVENTS, install_hooks, is_notice_group, notice_hook, original_hooks


class NoticeHookTests(unittest.TestCase):
    def test_hook_runs_the_stable_command_quoted(self):
        group = notice_hook('/a b/current/bin/lcu')
        hook = group['hooks'][0]
        self.assertEqual(hook['type'], 'command')
        self.assertEqual(hook['command'], "'/a b/current/bin/lcu' update --notice --hook SessionStart")
        self.assertTrue(hook['commandWindows'].endswith(' update --notice --hook SessionStart'))
        self.assertEqual((group['matcher'], hook['timeout'], hook['statusMessage']),
                         ('startup|resume', 10, 'Checking for LCU updates'))
        prompt = notice_hook('/a b/current/bin/lcu', 'UserPromptSubmit')
        self.assertNotIn('matcher', prompt)
        hook = prompt['hooks'][0]
        self.assertEqual(hook['command'], "'/a b/current/bin/lcu' update --notice --hook UserPromptSubmit")
        self.assertTrue(hook['commandWindows'].endswith(' update --notice --hook UserPromptSubmit'))
        self.assertEqual(hook['timeout'], 5)
        self.assertNotIn('statusMessage', hook)

    def test_ownership_detection(self):
        self.assertTrue(is_notice_group(notice_hook('/x/current/bin/lcu')))
        self.assertTrue(is_notice_group(notice_hook('/x y/lcu')))
        self.assertTrue(is_notice_group(notice_hook('/x/lcu.cmd', 'UserPromptSubmit')))
        self.assertTrue(is_notice_group(notice_hook('/x/lcu', 'UserPromptSubmit'), 'UserPromptSubmit'))
        self.assertFalse(is_notice_group(notice_hook('/x/lcu', 'UserPromptSubmit'), 'SessionStart'))
        for other in ({'hooks': [{'type': 'command', 'command': 'echo hi'}]},
                      {'hooks': [{'type': 'command', 'command': '/x/other update --notice --hook SessionStart'}]},
                      {'hooks': [{'type': 'command', 'command': '/x/lcu update --notice --hook-json'}]},
                      {'hooks': [{'type': 'command', 'command': '/x/lcu update --notice --hook Stop'}]},
                      {'hooks': [{'type': 'mcp_tool', 'server': 'lcu', 'tool': 'turn_ended'}]},
                      {'hooks': []}):
            self.assertFalse(is_notice_group(other))


class NoticeCooldownTests(unittest.TestCase):
    """The hooks' own command lines, run as Codex runs them for several sessions on one account."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        home = Path(self.tmp.name).resolve() / 'home'
        home.mkdir()
        env = mock.patch.dict(os.environ, {'HOME': str(home), 'XDG_CACHE_HOME': str(home / 'xdg'),
                                           'LOCALAPPDATA': str(home / 'local')})
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop('LCU_NO_UPDATE_CHECK', None)
        patcher = mock.patch('pathlib.Path.home', return_value=home)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.root = home / 'prefix/releases/r1'
        self.root.mkdir(parents=True)
        (self.root / 'bundle.json').write_text(json.dumps({'version': '0.9.1'}))
        self.release('0.9.2')

    def release(self, version, at=None):
        path = update.cache_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        info = {'version': version, 'tag': f'v{version}', 'severity': 'normal',
                'release_url': f'https://github.com/amontlabs/lcu/releases/tag/v{version}'}
        path.write_text(json.dumps({'checked_at': time.time() if at is None else at, 'latest': info, 'error': None}))

    def run_hook(self, event, session):
        argv = shlex.split(notice_hook('/p/current/bin/lcu', event)['hooks'][0]['command'])[2:]  # drop 'lcu update'
        out = io.StringIO()
        with mock.patch('sys.stdin', io.StringIO(json.dumps({'session_id': session}))), \
                mock.patch('sys.stdout', out), mock.patch.object(update.subprocess, 'Popen'):
            self.assertEqual(update.main(self.root, argv), 0)
        return json.loads(out.getvalue())['hookSpecificOutput']['additionalContext'] if out.getvalue() else None

    def test_a_release_is_announced_once_a_day_across_codex_sessions(self):
        self.assertIn('0.9.2', self.run_hook('SessionStart', 'a'))
        for event in NOTICE_EVENTS:
            self.assertIsNone(self.run_hook(event, 'a'))
            self.assertIsNone(self.run_hook(event, 'b'))
        later = time.time() + update.ANNOUNCE_COOLDOWN + 1
        self.release('0.9.2', later)
        with mock.patch.object(update.time, 'time', return_value=later):
            self.assertIsNone(self.run_hook('UserPromptSubmit', 'a'))
            self.assertIn('0.9.2', self.run_hook('UserPromptSubmit', 'b'))
            self.assertIsNone(self.run_hook('SessionStart', 'c'))

    def test_a_newer_release_is_announced_at_once(self):
        self.assertIn('0.9.2', self.run_hook('SessionStart', 'a'))
        self.assertIsNone(self.run_hook('SessionStart', 'b'))
        self.release('0.9.3')
        self.assertIn('0.9.3', self.run_hook('SessionStart', 'b'))
        self.assertIsNone(self.run_hook('UserPromptSubmit', 'a'))


@unittest.skipUnless(shutil.which('codex'), 'Codex CLI not installed')
class InstallTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name).resolve()
        self.host = root / 'host'
        (self.host / 'plugins/unified-computer-use/.codex-plugin').mkdir(parents=True)
        hook = {'type': 'mcp_tool', 'server': 'cua_repl', 'tool': 'turn_ended', 'input': {'session_id': 's', 'turn_id': 't'}}
        manifest = {'hooks': {'hooks': {event: [{'hooks': [dict(hook)]}] for event in ('Stop', 'Interrupt', 'SubagentStop')}}}
        (self.host / 'plugins/unified-computer-use/.codex-plugin/plugin.json').write_text(json.dumps(manifest))
        self.home = root / 'home'
        self.home.mkdir()
        self.config = self.home / 'config.toml'
        self.env = {**os.environ, 'HOME': str(self.home), 'CODEX_HOME': str(self.home)}
        self.root = root

    def tearDown(self):
        self.tmp.cleanup()

    def install(self, notice):
        return install_hooks(shutil.which('codex'), self.config, self.root, self.env,
                             self.host, notice)

    def test_install_is_trusted_idempotent_and_removable(self):
        self.config.write_text('[hooks]\nSessionStart = [{ hooks = [{ type = "command", command = "echo mine" }] }]\n')
        self.install('/p/current/bin/lcu')
        first = self.config.read_bytes()
        data = tomllib.loads(first.decode())
        self.assertEqual(set(data['hooks']) - {'state'}, {'Stop', 'Interrupt', 'SubagentStop', 'SessionStart', 'UserPromptSubmit'})
        start = data['hooks']['SessionStart']
        self.assertEqual(start[0]['hooks'][0]['command'], 'echo mine')
        self.assertEqual(sum(is_notice_group(g) for g in start), 1)
        trusted = [k for k in data['hooks']['state'] if 'session_start:1:0' in k]
        self.assertEqual(len(trusted), 1)
        prompt = data['hooks']['UserPromptSubmit']
        self.assertEqual(len(prompt), 1)
        self.assertTrue(is_notice_group(prompt[0], 'UserPromptSubmit'))
        self.assertEqual(len([k for k in data['hooks']['state'] if 'user_prompt_submit:0:0' in k]), 1)
        self.assertEqual(len(data['hooks']['state']), 5)  # three original hooks + two notices; 'echo mine' stays untrusted
        self.install('/p/current/bin/lcu')
        self.assertEqual(self.config.read_bytes(), first)
        self.install('/q/current/bin/lcu')
        start = tomllib.loads(self.config.read_text())['hooks']['SessionStart']
        self.assertEqual([is_notice_group(g) for g in start], [False, True])
        self.assertIn('/q/current/bin/lcu', start[1]['hooks'][0]['command'])
        prompt = tomllib.loads(self.config.read_text())['hooks']['UserPromptSubmit']
        self.assertEqual(len(prompt), 1)
        self.assertIn('/q/current/bin/lcu', prompt[0]['hooks'][0]['command'])
        self.install(None)
        start = tomllib.loads(self.config.read_text())['hooks']['SessionStart']
        self.assertEqual([g['hooks'][0]['command'] for g in start], ['echo mine'])
        self.assertEqual(tomllib.loads(self.config.read_text())['hooks'].get('UserPromptSubmit', []), [])


if __name__ == '__main__':
    unittest.main()
