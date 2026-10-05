"""The Python diagnostic log settings must match the adapters' module that applies them."""
from pathlib import Path
import re
import unittest

from lcu import diagnostic_log

DIAGNOSTICS_MJS = Path(__file__).resolve().parents[1] / 'adapters/diagnostics.mjs'


def js_constant(name):
    match = re.search(rf'export const {name} = ([^;]+);', DIAGNOSTICS_MJS.read_text())
    return eval(match.group(1), {'__builtins__': {}}, {})


class DiagnosticLogTests(unittest.TestCase):
    def test_constants_match_the_javascript_module(self):
        self.assertEqual(diagnostic_log.RETENTION_DAYS, js_constant('RETENTION_DAYS'))
        self.assertEqual(diagnostic_log.MAX_TOTAL_MB * 1024 * 1024, js_constant('MAX_TOTAL_BYTES'))
        self.assertEqual(diagnostic_log.MAX_FILE_MB * 1024 * 1024, js_constant('MAX_FILE_BYTES'))

    def test_directory_follows_platform_xdg_and_override(self):
        home = Path('/h')
        self.assertEqual(diagnostic_log.directory({}, 'darwin', home), home / 'Library/Logs/LCU')
        self.assertEqual(diagnostic_log.directory({}, 'linux', home), home / '.local/state/lcu/logs')
        self.assertEqual(diagnostic_log.directory({'XDG_STATE_HOME': '/s'}, 'linux', home), Path('/s/lcu/logs'))
        self.assertEqual(diagnostic_log.directory({'LCU_LOG_DIR': '/o', 'XDG_STATE_HOME': '/s'}, 'darwin', home),
                         Path('/o'))

    def test_disabling_is_reported(self):
        self.assertTrue(diagnostic_log.status({}, 'linux', '/h')['enabled'])
        self.assertFalse(diagnostic_log.status({'LCU_DIAGNOSTIC_LOG': '0'}, 'linux', '/h')['enabled'])


if __name__ == '__main__':
    unittest.main()
