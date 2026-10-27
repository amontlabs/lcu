"""Keep the intentional Claude hook setup difference narrower than its surrounding settings."""
import importlib.util
from pathlib import Path
import sys
import unittest


@unittest.skipIf(sys.platform == 'win32', 'the E2E comparison harness requires POSIX')
class ClaudeHookComparisonTests(unittest.TestCase):
    def test_only_exact_lifecycle_handlers_are_expected_changes(self):
        spec = importlib.util.spec_from_file_location('lcu_e2e', Path(__file__).parent / 'e2e/e2e.py')
        e2e = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(e2e)
        for event in ('PreToolUse', 'Stop', 'StopFailure', 'SubagentStop'):
            if event == 'PreToolUse':
                old = {'type': 'mcp_tool', 'server': 'lcu', 'tool': 'set_turn_context', 'input': {
                    'session_id': '${session_id}', 'turn_id': '${prompt_id}', 'tool_use_id': '${tool_use_id}',
                    'agent_id': '${agent_id}'}}
            else:
                old = {'type': 'mcp_tool', 'server': 'lcu', 'tool': 'turn_ended', 'input': {
                    'hook_event_name': 'Interrupt' if event == 'StopFailure' else event,
                    'session_id': '${agent_id}' if event == 'SubagentStop' else '${session_id}', 'turn_id': '${prompt_id}'}}
            new = {'type': 'command', 'command': '<SB>/app/chatgpt/resources/cua_node/bin/node',
                   'args': ['<SB>/opt/lcu/current/lcu/claude_hook.mjs'], 'timeout': 600}
            for settings in ('settings.json', 'settings.local.json'):
                path = f'/files/HOME/.claude/{settings}/json/hooks/{event}[0]/hooks[0]'
                self.assertEqual(e2e.diff(old, new, path), [])
                self.assertEqual(e2e.diff(old, old, path), [])
                self.assertTrue(e2e.diff(old, {**new, 'timeout': 1}, path))
                self.assertTrue(e2e.diff({**old, 'tool': 'foreign'}, new, path))
                self.assertTrue(e2e.diff(old, new, path.replace('[0]/hooks', '[1]/hooks')))
