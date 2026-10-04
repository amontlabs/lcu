"""`lcu prune` keeps the current and recent generations and refuses odd layouts."""
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lcu import maintenance

WINDOWS = sys.platform == 'win32'
# Linux and macOS installs take an fcntl lock and link `current`; Windows installs do neither.
posix_layout = unittest.skipIf(WINDOWS, 'Linux and macOS install layouts lock with fcntl')


class PruneTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        # A three-part prefix, as the installers create (e.g. /opt/lcu).
        self.prefix = Path(self.temp.name).resolve() / 'opt' / 'lcu'
        self.prefix.mkdir(parents=True)
        (self.prefix / '.lcu-install').touch()

    def _gen(self, name, *, windows=False):
        if windows:
            path = self.prefix / 'apps' / name / 'app'
        else:
            path = self.prefix / 'apps' / name / 'payload/usr/lib/chatgpt'
        path.mkdir(parents=True)
        (path / 'blob').write_bytes(b'x' * 4096)
        return path

    def _release(self, name, gen_name, mtime, *, windows=False, platform=None):
        release = self.prefix / 'releases' / name
        release.mkdir(parents=True)
        if windows:
            app = str(self.prefix / 'apps' / gen_name / 'app')
        else:
            app = os.path.relpath(self.prefix / 'apps' / gen_name / 'payload/usr/lib/chatgpt', release)
            (release / 'app').symlink_to(app)
        descriptor = {'platform': platform or ('windows' if windows else 'linux'), 'app': app}
        (release / 'installation.json').write_text(json.dumps(descriptor))
        os.utime(release, (mtime, mtime))
        return release

    def _current_posix(self, name):
        (self.prefix / 'current').symlink_to(Path('releases') / name)

    def _current_windows(self, name):
        (self.prefix / 'current.json').write_text(json.dumps({'release': name}))

    # An app generation and `current` in the test host's own install layout.
    GEN = 'a' * 64 if WINDOWS else '1.0.0-x64-0123456789abcdef'

    def _current(self, name):
        (self._current_windows if WINDOWS else self._current_posix)(name)

    def _run(self, root, argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            maintenance.main(root, argv)
        return out.getvalue()

    @posix_layout
    def test_dry_run_lists_without_deleting(self):
        self._gen('1.0.0-x64-0123456789abcdef')
        cur = self._release('0.5.0-aaaaaaaaaaaa', '1.0.0-x64-0123456789abcdef', 200)
        self._release('0.4.0-bbbbbbbbbbbb', '1.0.0-x64-0123456789abcdef', 100)
        self._current_posix(cur.name)
        output = self._run(cur, ['--keep', '1'])
        self.assertIn('Would remove', output)
        self.assertIn('0.4.0-bbbbbbbbbbbb', output)
        self.assertIn('Rerun with --yes to delete. '
                      'Restart or stop agents using older LCU releases first.', output)
        self.assertTrue((self.prefix / 'releases/0.4.0-bbbbbbbbbbbb').is_dir())

    @posix_layout
    def test_yes_deletes_old_release_and_unreferenced_generation(self):
        self._gen('1.0.0-x64-0123456789abcdef')
        self._gen('1.1.0-x64-fedcba9876543210')
        cur = self._release('0.5.0-aaaaaaaaaaaa', '1.0.0-x64-0123456789abcdef', 200)
        self._release('0.4.0-bbbbbbbbbbbb', '1.1.0-x64-fedcba9876543210', 100)
        self._current_posix(cur.name)
        output = self._run(cur, ['--keep', '1', '--yes'])
        self.assertIn('Removed', output)
        self.assertEqual({p.name for p in (self.prefix / 'releases').iterdir()},
                         {'0.5.0-aaaaaaaaaaaa'})
        # The current release still references generation 1.0.0; 1.1.0 is gone.
        self.assertEqual({p.name for p in (self.prefix / 'apps').iterdir()},
                         {'1.0.0-x64-0123456789abcdef'})

    @posix_layout
    def test_keep_count_retains_recent_releases_by_mtime(self):
        self._gen('1.0.0-x64-0123456789abcdef')
        cur = self._release('0.6.0-aaaaaaaaaaaa', '1.0.0-x64-0123456789abcdef', 300)
        self._release('0.5.0-bbbbbbbbbbbb', '1.0.0-x64-0123456789abcdef', 200)
        self._release('0.4.0-cccccccccccc', '1.0.0-x64-0123456789abcdef', 100)
        self._current_posix(cur.name)
        self._run(cur, ['--keep', '2', '--yes'])
        # Current plus the single most recent other survive; the oldest is dropped.
        self.assertEqual({p.name for p in (self.prefix / 'releases').iterdir()},
                         {'0.6.0-aaaaaaaaaaaa', '0.5.0-bbbbbbbbbbbb'})

    @posix_layout
    def test_shared_generation_is_kept_while_referenced(self):
        self._gen('1.0.0-x64-0123456789abcdef')
        cur = self._release('0.6.0-aaaaaaaaaaaa', '1.0.0-x64-0123456789abcdef', 300)
        self._release('0.5.0-bbbbbbbbbbbb', '1.0.0-x64-0123456789abcdef', 200)
        self._current_posix(cur.name)
        self._run(cur, ['--keep', '1', '--yes'])
        # Only the current release remains, but its generation is still referenced.
        self.assertEqual({p.name for p in (self.prefix / 'apps').iterdir()},
                         {'1.0.0-x64-0123456789abcdef'})

    @posix_layout
    def test_nothing_to_prune(self):
        self._gen('1.0.0-x64-0123456789abcdef')
        cur = self._release('0.6.0-aaaaaaaaaaaa', '1.0.0-x64-0123456789abcdef', 300)
        self._current_posix(cur.name)
        self.assertIn('Nothing to prune', self._run(cur, ['--yes']))

    def test_windows_layout_uses_current_json_and_absolute_app(self):
        self._gen('a' * 64, windows=True)
        self._gen('b' * 64, windows=True)
        cur = self._release('0.5.0-aaaaaaaaaaaa', 'a' * 64, 200, windows=True)
        self._release('0.4.0-bbbbbbbbbbbb', 'b' * 64, 100, windows=True)
        self._current_windows(cur.name)
        self._run(cur, ['--keep', '1', '--yes'])
        self.assertEqual({p.name for p in (self.prefix / 'releases').iterdir()},
                         {'0.5.0-aaaaaaaaaaaa'})
        self.assertEqual({p.name for p in (self.prefix / 'apps').iterdir()}, {'a' * 64})

    @posix_layout
    def test_in_place_linux_release_reclaims_copies_from_earlier_versions(self):
        self._gen('1.0.0-x64-0123456789abcdef')
        installed = Path(self.temp.name).resolve() / 'usr/lib/chatgpt'
        installed.mkdir(parents=True)
        cur = self.prefix / 'releases' / '0.8.0-aaaaaaaaaaaa'
        cur.mkdir(parents=True)
        (cur / 'app').symlink_to(installed, target_is_directory=True)
        (cur / 'installation.json').write_text(json.dumps(
            {'app': str(installed), 'architecture': 'x64', 'package_version': '1.0.0', 'runtime': 'r'}))
        os.utime(cur, (300, 300))
        self._release('0.7.0-bbbbbbbbbbbb', '1.0.0-x64-0123456789abcdef', 200)
        self._current_posix(cur.name)
        self._run(cur, ['--keep', '1', '--yes'])
        self.assertEqual({p.name for p in (self.prefix / 'releases').iterdir()},
                         {'0.8.0-aaaaaaaaaaaa'})
        self.assertEqual(list((self.prefix / 'apps').iterdir()), [])
        self.assertTrue(installed.is_dir())

    @posix_layout
    def test_in_place_release_using_an_old_generation_path_keeps_that_generation(self):
        # `--existing-app <prefix>/apps/<old>/payload/usr/lib/chatgpt` after upgrading
        # from 0.7.0 makes the current release absolute-path in place on a copy.
        old = self._gen('1.0.0-x64-0123456789abcdef')
        self._gen('1.1.0-x64-fedcba9876543210')
        cur = self.prefix / 'releases' / '0.8.0-aaaaaaaaaaaa'
        cur.mkdir(parents=True)
        (cur / 'app').symlink_to(old, target_is_directory=True)
        (cur / 'installation.json').write_text(json.dumps(
            {'app': str(old), 'architecture': 'x64', 'package_version': '1.0.0', 'runtime': 'r'}))
        os.utime(cur, (300, 300))
        self._release('0.7.0-bbbbbbbbbbbb', '1.0.0-x64-0123456789abcdef', 200)
        self._current_posix(cur.name)
        self._run(cur, ['--keep', '1', '--yes'])
        self.assertEqual({p.name for p in (self.prefix / 'releases').iterdir()},
                         {'0.8.0-aaaaaaaaaaaa'})
        self.assertEqual({p.name for p in (self.prefix / 'apps').iterdir()},
                         {'1.0.0-x64-0123456789abcdef'})
        self.assertTrue((old / 'blob').is_file())

    @posix_layout
    def test_macos_has_no_app_generations(self):
        cur = self.prefix / 'releases' / '0.5.0-aaaaaaaaaaaa'
        cur.mkdir(parents=True)
        (cur / 'installation.json').write_text(json.dumps(
            {'platform': 'darwin', 'app': '/Applications/ChatGPT.app'}))
        os.utime(cur, (200, 200))
        old = self._release('0.4.0-bbbbbbbbbbbb', 'unused', 100, platform='darwin')
        (old / 'installation.json').write_text(json.dumps(
            {'platform': 'darwin', 'app': '/Applications/ChatGPT.app'}))
        self._current_posix(cur.name)
        self._run(cur, ['--keep', '1', '--yes'])
        self.assertEqual({p.name for p in (self.prefix / 'releases').iterdir()},
                         {'0.5.0-aaaaaaaaaaaa'})

    def test_symlink_entry_in_releases_is_refused(self):
        self._gen(self.GEN, windows=WINDOWS)
        cur = self._release('0.5.0-aaaaaaaaaaaa', self.GEN, 200, windows=WINDOWS)
        self._current(cur.name)
        (self.prefix / 'releases' / 'sneaky').symlink_to(cur)
        with self.assertRaisesRegex(ValueError, 'unexpected entry'):
            self._run(cur, ['--yes'])

    def test_unexpected_named_directory_is_refused(self):
        self._gen(self.GEN, windows=WINDOWS)
        cur = self._release('0.5.0-aaaaaaaaaaaa', self.GEN, 200, windows=WINDOWS)
        self._current(cur.name)
        (self.prefix / 'releases' / 'not-a-release').mkdir()
        with self.assertRaisesRegex(ValueError, 'unexpected entry'):
            self._run(cur, ['--yes'])

    def test_missing_install_marker_is_rejected(self):
        self._gen('1.0.0-x64-0123456789abcdef')
        cur = self._release('0.5.0-aaaaaaaaaaaa', '1.0.0-x64-0123456789abcdef', 200)
        self._current_posix(cur.name)
        (self.prefix / '.lcu-install').unlink()
        with self.assertRaisesRegex(ValueError, 'Not an LCU installation'):
            self._run(cur, ['--yes'])


if __name__ == '__main__':
    unittest.main()
