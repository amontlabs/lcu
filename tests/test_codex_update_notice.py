"""LCU's SessionStart update-notice hook: separate from the original lifecycle hooks, trusted like them."""
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import tomllib
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lcu.codex_hooks import install_hooks, is_notice_group, notice_hook, original_hooks


class NoticeHookTests(unittest.TestCase):
    def test_hook_runs_the_stable_command_quoted(self):
        hook = notice_hook('/a b/current/bin/lcu')['hooks'][0]
        self.assertEqual(hook['type'], 'command')
        self.assertEqual(hook['command'], "'/a b/current/bin/lcu' update --notice --hook-json")
        self.assertTrue(hook['commandWindows'].endswith(' update --notice --hook-json'))
        self.assertEqual(notice_hook('/x/lcu')['matcher'], 'startup|resume')

    def test_ownership_detection(self):
        self.assertTrue(is_notice_group(notice_hook('/x/current/bin/lcu')))
        self.assertTrue(is_notice_group(notice_hook('/x y/lcu')))
        for other in ({'hooks': [{'type': 'command', 'command': 'echo hi'}]},
                      {'hooks': [{'type': 'command', 'command': '/x/other update --notice --hook-json'}]},
                      {'hooks': [{'type': 'mcp_tool', 'server': 'lcu', 'tool': 'turn_ended'}]},
                      {'hooks': []}):
            self.assertFalse(is_notice_group(other))


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
        self.assertEqual(set(data['hooks']) - {'state'}, {'Stop', 'Interrupt', 'SubagentStop', 'SessionStart'})
        start = data['hooks']['SessionStart']
        self.assertEqual(start[0]['hooks'][0]['command'], 'echo mine')
        self.assertEqual(sum(is_notice_group(g) for g in start), 1)
        trusted = [k for k in data['hooks']['state'] if 'session_start:1:0' in k]
        self.assertEqual(len(trusted), 1)
        self.assertEqual(len(data['hooks']['state']), 4)  # three original hooks + notice; 'echo mine' stays untrusted
        self.install('/p/current/bin/lcu')
        self.assertEqual(self.config.read_bytes(), first)
        self.install('/q/current/bin/lcu')
        start = tomllib.loads(self.config.read_text())['hooks']['SessionStart']
        self.assertEqual([is_notice_group(g) for g in start], [False, True])
        self.assertIn('/q/current/bin/lcu', start[1]['hooks'][0]['command'])
        self.install(None)
        start = tomllib.loads(self.config.read_text())['hooks']['SessionStart']
        self.assertEqual([g['hooks'][0]['command'] for g in start], ['echo mine'])


if __name__ == '__main__':
    unittest.main()
