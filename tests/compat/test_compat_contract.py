"""Caller-boundary contract tests for lcu/compat/pyjson.mjs and argparse.mjs (findings 7-12 of the review)."""
import os
import shutil
import subprocess
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / 'contract_pyjson_argparse.mjs'
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parent))
import support as _support  # noqa: E402  (one Node selector for every runner)
NODE = _support.selected_node()


@unittest.skipUnless(NODE, 'node is not installed')
class CompatContractTests(unittest.TestCase):
    def test_contract(self):
        done = subprocess.run([NODE, str(SCRIPT)], capture_output=True, text=True, timeout=120)
        self.assertEqual((done.returncode, done.stdout.strip()), (0, 'ok'), done.stderr)


if __name__ == '__main__':
    unittest.main()
