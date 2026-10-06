"""The Python-to-Node bridge the live/acceptance drivers use (tests/lcu_bridge.py). Needs a Node >= 22 on PATH."""
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lcu_bridge  # noqa: E402

NODE = shutil.which('node') or os.environ.get('LCU_TEST_NODE')


@unittest.skipUnless(NODE, 'Node.js >= 22 is required')
class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()

    def test_locate_codex_tools_returns_paths(self):
        resources = self.root / 'resources'
        resources.mkdir()
        for name in ('codex', 'codex-code-mode-host'):
            (resources / name).write_text('x')
        tools = lcu_bridge.locate_codex_tools(resources)
        self.assertEqual(tools.cli, resources / 'codex')
        self.assertEqual(tools.code_mode_host, resources / 'codex-code-mode-host')

    def test_node_value_errors_are_value_errors_with_the_original_text(self):
        with self.assertRaises(ValueError) as caught:
            lcu_bridge.locate_codex_tools(self.root / 'missing')
        self.assertIsInstance(caught.exception, lcu_bridge.BridgeError)
        self.assertEqual(caught.exception.name, 'ValueError')
        self.assertEqual(str(caught.exception),
                         f'Application is missing a complete original Codex CLI layout: {self.root / "missing"}')

    def test_keyword_arguments_become_the_trailing_options_object(self):
        with self.assertRaisesRegex(ValueError, 'Oh My Pi native plugin links are profile-scoped'):
            lcu_bridge.configure_omp(self.root, ['x'], self.root, scope='project', project=None, env={})

    def test_a_dict_the_function_fills_is_returned(self):
        runtime = self.root / 'cua_node'
        env = {'CUA_REPL_ENABLED_SURFACES': 'computer', 'SKY_CUA_SERVICE_PATH': str(self.root / 'Sky.app')}
        client, (_, _, filled) = lcu_bridge.call_with_args('runtime', '_configure_macos_lifecycle',
                                                           lcu_bridge.REPOSITORY, runtime, env)
        self.assertTrue(client.endswith('SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient'))
        self.assertEqual(filled['LCU_MAC_SKY_SERVICE_PATH'].split('/@oai/sky/')[0], str(runtime / 'lib/node_modules'))
        self.assertIn('macos_sky_service.mjs', filled['NODE_REPL_TRUSTED_SERVICES'])

    def test_app_server_session(self):
        cli = self.root / 'fake-codex'
        cli.write_text(f'''#!{sys.executable}
import json, sys
assert sys.argv[1:] == ['--strict-config', 'app-server', '--listen', 'stdio://'], sys.argv
for line in sys.stdin:
    message = json.loads(line)
    if 'id' not in message:
        continue
    if message['method'] == 'initialize':
        result = {{'userAgent': 'fake'}}
    else:
        result = {{'echo': message['params']}}
    print(json.dumps({{'id': message['id'], 'result': result}}), flush=True)
    if message['method'] != 'initialize':
        print(json.dumps({{'method': 'note', 'params': {{'for': message['id']}}}}), flush=True)
''')
        cli.chmod(cli.stat().st_mode | stat.S_IXUSR)
        with lcu_bridge.AppServerSession(cli, self.root, dict(os.environ)) as api:
            self.assertEqual(api.initialization, {'userAgent': 'fake'})
            self.assertEqual(api('thing', {'a': 1}), {'echo': {'a': 1}})
            self.assertEqual(api.receive(5), {'method': 'note', 'params': {'for': 2}})
            self.assertIsNone(api.receive(0.2))


if __name__ == '__main__':
    unittest.main()
