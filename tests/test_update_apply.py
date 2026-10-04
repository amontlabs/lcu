"""`lcu update` apply step: asset names, checksum and archive safety, installer command lines."""
import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest import mock
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lcu import update_apply

INFO = {'version': '0.9.2', 'tag': 'v0.9.2', 'release_url': 'https://example.invalid/r', 'severity': 'normal'}


class Response(io.BytesIO):
    headers = {}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def tar_bytes(extra=(), name='lcu-0.9.2-linux-x64'):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
        entries = [(f'{name}/bundle.json', b'{}'), (f'{name}/scripts/install.py', b'#')]
        for path, data in [*entries, *extra]:
            member = tarfile.TarInfo(path)
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
    return buffer.getvalue()


def link_tar(link, target, name='lcu-0.9.2-linux-x64'):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
        member = tarfile.TarInfo(f'{name}/bundle.json')
        member.size = 2
        archive.addfile(member, io.BytesIO(b'{}'))
        entry = tarfile.TarInfo(f'{name}/{link}')
        entry.type, entry.linkname = tarfile.SYMTYPE, target
        archive.addfile(entry)
    return buffer.getvalue()


def zip_bytes(name='lcu-0.9.2-windows-x64', extra=()):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        archive.writestr(f'{name}/bundle.json', '{}')
        for path, data in extra:
            archive.writestr(path, data)
    return buffer.getvalue()


def fake_urlopen(archive, *, checksum=None):
    def opener(request, timeout=None):
        url = request.full_url
        if url.endswith('.sha256'):
            name = url.rsplit('/', 1)[1][:-7]
            return Response(f'{checksum or hashlib.sha256(archive).hexdigest()}  {name}\n'.encode())
        return Response(archive)
    return opener


class Installed(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.prefix = Path(self.temp.name).resolve() / 'opt' / 'lcu'

    def install(self, platform='linux', arch='x64', app=None, bundle=True):
        release = self.prefix / 'releases' / '0.9.1-abcdef012345'
        release.mkdir(parents=True)
        (self.prefix / '.lcu-install').touch()
        description = {'platform': platform, 'architecture': arch}
        if app:
            description['app'] = str(app)
        (release / 'installation.json').write_text(json.dumps(description))
        if bundle:
            (release / 'bundle.json').write_text(json.dumps({'version': '0.9.1', 'architecture': arch}))
        return release

    def run_apply(self, release, archive, *, yes=True, status=0, checksum=None):
        with mock.patch.object(update_apply, 'urlopen', fake_urlopen(archive, checksum=checksum)), \
                mock.patch.object(update_apply.subprocess, 'run',
                                  return_value=mock.Mock(returncode=status)) as run, \
                mock.patch('os.getuid', return_value=1000), \
                mock.patch.object(update_apply, 'sys') as fake_sys:
            fake_sys.executable = '/usr/bin/python3'
            fake_sys.stdin.isatty.return_value = False
            fake_sys.stderr = io.StringIO()
            result = update_apply.apply(release, INFO, yes=yes)
        return result, run


class AssetTests(unittest.TestCase):
    def test_names(self):
        self.assertEqual(update_apply.asset_name('0.9.2', 'darwin', 'arm64'), 'lcu-0.9.2-darwin-arm64.tar.gz')
        self.assertEqual(update_apply.asset_name('0.9.2', 'linux', 'arm64'), 'lcu-0.9.2-linux-arm64.tar.gz')
        self.assertEqual(update_apply.asset_name('0.9.2', 'linux', 'x64'), 'lcu-0.9.2-linux-x64.tar.gz')
        self.assertEqual(update_apply.asset_name('0.9.2', 'windows', 'x64'), 'lcu-0.9.2-windows-x64.zip')
        with self.assertRaises(ValueError):
            update_apply.asset_name('0.9.2', 'freebsd', 'x64')

    def test_checksum_format(self):
        digest = 'a' * 64
        self.assertEqual(update_apply._sha256_expected(f'{digest}  f.tar.gz\n', 'f.tar.gz'), digest)
        with self.assertRaises(ValueError):
            update_apply._sha256_expected(f'{digest}  other.tar.gz\n', 'f.tar.gz')


class ApplyTests(Installed):
    def test_source_checkout_refused(self):
        release = self.install(bundle=False)
        result, run = self.run_apply(release, tar_bytes())
        self.assertEqual(result, 1)
        run.assert_not_called()

    def test_outside_prefix_layout_refused(self):
        loose = Path(self.temp.name) / 'loose'
        loose.mkdir()
        (loose / 'bundle.json').write_text('{}')
        result, run = self.run_apply(loose, tar_bytes())
        self.assertEqual(result, 1)
        run.assert_not_called()

    def test_non_tty_without_yes(self):
        release = self.install()
        with mock.patch.object(update_apply, 'urlopen') as opener:
            result, run = self.run_apply(release, tar_bytes(), yes=False)
        self.assertEqual(result, 2)
        run.assert_not_called()
        opener.assert_not_called()

    def test_checksum_mismatch(self):
        release = self.install()
        result, run = self.run_apply(release, tar_bytes(), checksum='0' * 64)
        self.assertEqual(result, 1)
        run.assert_not_called()

    def test_path_traversal_refused(self):
        release = self.install()
        for archive in (tar_bytes([('../evil', b'x')]), tar_bytes([('/abs/evil', b'x')]),
                        link_tar('link', '/etc/passwd'), link_tar('link', '../../outside')):
            result, run = self.run_apply(release, archive)
            self.assertEqual(result, 1)
            run.assert_not_called()

    def test_zip_traversal_refused(self):
        release = self.install('windows')
        result, run = self.run_apply(release, zip_bytes(extra=[('../evil', 'x')]))
        self.assertEqual(result, 1)
        run.assert_not_called()

    def test_linux_command(self):
        app = Path(self.temp.name) / 'chatgpt'
        app.mkdir()
        release = self.install('linux', 'x64', app)
        result, run = self.run_apply(release, tar_bytes())
        self.assertEqual(result, 0)
        command = run.call_args.args[0]
        self.assertEqual(command[:2], ['/usr/bin/python3', '-B'])
        self.assertTrue(command[2].endswith('scripts/install.py'))
        self.assertEqual(command[3:], ['--prefix', str(self.prefix), '--runtime-only',
                                       '--existing-app', str(app), '--skip-system'])

    def test_macos_command(self):
        app = Path(self.temp.name) / 'ChatGPT.app'
        app.mkdir()
        release = self.install('darwin', 'arm64', app)
        archive = tar_bytes(name='lcu-0.9.2-darwin-arm64')
        result, run = self.run_apply(release, archive)
        self.assertEqual(result, 0)
        command = run.call_args.args[0]
        self.assertTrue(command[2].endswith('scripts/install_macos.py'))
        self.assertEqual(command[3:], ['--prefix', str(self.prefix), '--runtime-only', '--existing-app', str(app)])

    def test_windows_command(self):
        release = self.install('windows', 'x64')
        result, run = self.run_apply(release, zip_bytes())
        self.assertEqual(result, 0)
        command = run.call_args.args[0]
        self.assertTrue(command[2].endswith('scripts/install_windows.py'))
        self.assertEqual(command[3:], ['--prefix', str(self.prefix), '--runtime-only'])

    def test_installer_failure_status(self):
        release = self.install()
        result, _ = self.run_apply(release, tar_bytes(), status=7)
        self.assertEqual(result, 7)

    def test_unwritable_linux_prefix_prints_sudo(self):
        release = self.install()
        with mock.patch('os.access', return_value=False):
            result, run = self.run_apply(release, tar_bytes())
        self.assertEqual(result, 1)
        run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
