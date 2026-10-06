"""Run the Linux-only compat tests in Docker from a non-Linux host (opt in with LCU_COMPAT_DOCKER=1).

On Linux the same tests run natively (test_acl, test_accounts and test_lock need root and the `acl`
package for their real-system parts, which is what tests/compat/docker.sh provides).
"""
import os
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().with_name('docker.sh')


@unittest.skipUnless(os.environ.get('LCU_COMPAT_DOCKER') == '1', 'set LCU_COMPAT_DOCKER=1 to run the Linux suite in Docker')
@unittest.skipIf(sys.platform == 'linux', 'already on Linux: the tests run natively')
@unittest.skipUnless(shutil.which('docker'), 'docker is not installed')
class LinuxInDocker(unittest.TestCase):
    def test_compat_suite_on_linux(self):
        # Node 24 (the app's major) and Node 22 (the supported floor), both with --network none.
        for major in ('24', '22'):
            with self.subTest(node=major):
                done = subprocess.run(['/bin/sh', str(SCRIPT)], capture_output=True, text=True, timeout=1800,
                                      env={**os.environ, 'LCU_COMPAT_NODE_MAJOR': major})
                self.assertEqual(done.returncode, 0, done.stdout[-4000:] + done.stderr[-4000:])


if __name__ == '__main__':
    unittest.main()
