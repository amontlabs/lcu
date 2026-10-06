"""The development package fixture downloader (tests/package_fixture.py) refuses a corrupt download."""
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from package_fixture import download


class PackageFixtureTests(unittest.TestCase):
    def test_corrupt_download_never_executes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'source'
            source.write_bytes(b'corrupt')
            with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                download({'source': source.as_uri()}, {'deb_arch': 'arm64', 'sha256': '0' * 64}, root / 'download')
            self.assertFalse((root / 'download').exists())


if __name__ == '__main__':
    unittest.main()
