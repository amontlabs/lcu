"""scripts/build_bundle.py compiles LCU's own owner-authentication helper (macOS with swiftc)."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import build_bundle


@unittest.skipUnless(sys.platform == 'darwin' and shutil.which('swiftc'), 'needs macOS with swiftc')
class OwnerAuthHelperBuildTests(unittest.TestCase):
    def test_helper_builds_signed_and_rejects_bad_usage_without_prompting(self):
        with tempfile.TemporaryDirectory() as temporary:
            helper = Path(temporary) / 'bin' / build_bundle.OWNER_AUTH
            build_bundle.build_owner_auth(helper)
            self.assertTrue(os.access(helper, os.X_OK))
            subprocess.run(['codesign', '--verify', '--strict', str(helper)], check=True)
            # Usage errors exit before any authentication is attempted.
            for argv in ([], ['--reason'], ['--reason', ''], ['--bogus', 'x']):
                done = subprocess.run([str(helper), *argv], capture_output=True, text=True, timeout=20)
                self.assertEqual(done.returncode, 64, argv)
                self.assertIn('usage: lcu-owner-auth', done.stderr)


if __name__ == '__main__':
    unittest.main()
