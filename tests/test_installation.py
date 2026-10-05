import io
import os
import shutil
import json
from pathlib import Path
from types import SimpleNamespace
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import struct
from unittest.mock import patch

if sys.platform == 'win32':
    raise unittest.SkipTest('Linux installer, sessions and app layout use POSIX accounts, locks and modes')

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / 'scripts')]
from lcu.runtime import environment
from lcu.session import discover
from lcu.setup import Change, apply_changes, regular_path
from install import checked_prefix, install, main as install_main
from installed_app import _download, select as select_app
from lcu import platforms as lcu_platforms
from lcu.platforms import resolve_installed_linux_app
from bundle import seal


def _write_asar(path, members):
    files = {}
    payload = bytearray()
    for name, content in members.items():
        node = files
        parts = name.split('/')
        for part in parts[:-1]:
            node = node.setdefault(part, {'files': {}})['files']
        node[parts[-1]] = {'offset': str(len(payload)), 'size': len(content)}
        payload.extend(content)
    header = json.dumps({'files': files}, separators=(',', ':')).encode()
    path.write_bytes(struct.pack('<4I', 4, 8 + len(header), 4 + len(header), len(header)) +
                     header + payload)


def _application_fixture(root, *, version='26.924.22138', runtime_version='runtime-new',
                         arch='arm64', relocated=False):
    app = Path(root)
    resources = app / 'resources'
    runtime = resources / 'cua_node'
    executable = b'#!/bin/sh\nexit 0\n'
    for relative in ('ChatGPT', 'resources/cua_node/bin/node',
                     'resources/cua_node/bin/node_repl',
                     'resources/cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs'):
        path = app / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(executable if relative != 'resources/cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs' else b'export {};\n')
        if relative != 'resources/cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs':
            path.chmod(0o755)
    tools = resources / ('codex-cli/bin' if relocated else '')
    for name in ('codex', 'codex-code-mode-host'):
        path = tools / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(executable)
        path.chmod(0o755)
    (resources / 'app.asar').parent.mkdir(parents=True, exist_ok=True)
    _write_asar(resources / 'app.asar', {
        'package.json': json.dumps({'name': 'chatgpt', 'version': version}).encode()})
    (runtime / 'manifest.json').write_text(json.dumps({
        'platform': 'linux', 'arch': arch, 'runtime_archive_version': runtime_version}))
    (resources / 'plugins/openai-bundled/plugins/browser').mkdir(parents=True, exist_ok=True)
    for relative in (
        'plugins/openai-bundled/plugins/chrome/.codex-plugin/plugin.json',
        f'plugins/openai-bundled/plugins/chrome/extension-host/linux/{arch}/extension-host',
        'plugins/openai-bundled/plugins/unified-computer-use/.mcp.json',
        'plugins/openai-bundled/plugins/browser/install.js',
    ):
        path = resources / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(executable if relative.endswith('extension-host') else b'{}\n')
        if relative.endswith('extension-host'):
            path.chmod(0o755)
    return app


def _selected(application):
    return application, {'package_version': '26.924.22138', 'runtime': 'runtime-new',
                         'architecture': 'arm64'}


class InstallationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()

    def test_foreign_prefix_is_untouched(self):
        (self.root / 'keep').write_text('valuable')
        with self.assertRaises(ValueError):
            checked_prefix(self.root)
        self.assertEqual((self.root / 'keep').read_text(), 'valuable')

    def test_symlink_destination_is_rejected(self):
        (self.root / 'link').symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            checked_prefix(self.root / 'link/lcu')

    def test_relative_prefix_is_rejected(self):
        with self.assertRaises(ValueError):
            checked_prefix(Path('relative/lcu'))

    def test_offline_requires_skip_system_before_installation_writes(self):
        with patch('install.setup.validate', side_effect=AssertionError('setup reached')), \
             patch('install.subprocess.run', side_effect=AssertionError('network reached')):
            with self.assertRaisesRegex(ValueError, '--offline requires --skip-system'):
                install_main(['--offline', '--runtime-only'])

    def test_installation_inside_its_source_bundle_is_rejected(self):
        with patch('install.SOURCE', self.root):
            with self.assertRaisesRegex(ValueError, 'outside'):
                checked_prefix(self.root / 'nested-prefix')

    def test_corrupt_download_never_executes(self):
        source = self.root / 'source'
        source.write_bytes(b'corrupt')
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            _download({'source': source.as_uri()}, {'deb_arch': 'arm64', 'sha256': '0' * 64},
                      self.root / 'download')

    def test_missing_installed_app_fails_before_prefix_writes(self):
        prefix = self.root / 'lcu'
        missing = self.root / 'missing-chatgpt'
        with patch('installed_app.DEFAULT_APP_PATH', missing):
            with self.assertRaisesRegex(ValueError, 'chatgpt.com/download/'):
                select_app('arm64', execute=False)
        self.assertFalse(prefix.exists())

    def test_missing_installed_app_fails_before_apt_or_prefix_writes(self):
        prefix = self.root / 'lcu'
        missing = self.root / 'missing-chatgpt'
        with patch('installed_app.DEFAULT_APP_PATH', missing), \
             patch('install.setup.validate', return_value=(None, [])), \
             patch('install.architecture', return_value='arm64'), \
             patch('install.verify'), \
             patch('install.subprocess.run', side_effect=AssertionError('apt/network reached')):
            with self.assertRaisesRegex(ValueError, 'chatgpt.com/download/'):
                install_main(['--prefix', str(prefix), '--runtime-only', '--session', 'discover'])
        self.assertFalse(prefix.exists())

    def test_app_package_option_fails_with_existing_app_migration_before_writes(self):
        prefix = self.root / 'lcu'
        with patch('install.subprocess.run', side_effect=AssertionError('apt/network reached')):
            with self.assertRaisesRegex(ValueError, r'--app-package cannot install.*--existing-app PATH'):
                install_main(['--prefix', str(prefix), '--runtime-only', '--app-package',
                              str(self.root / 'chatgpt.deb')])
        self.assertFalse(prefix.exists())

    def test_linux_installer_forwards_audio_opt_in_to_agent_setup(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            home = base / 'account'
            home.mkdir()
            existing_app = base / 'chatgpt'
            existing_app.mkdir()
            account = SimpleNamespace(pw_name='fixture', pw_uid=1001, pw_dir=str(home))
            with patch('install.DEFAULT_APP_PATH', existing_app), \
                 patch('install.setup.validate', return_value=(account, ['pi'])), \
                 patch('install.architecture', return_value='arm64'), \
                 patch('install.verify'), patch('install.select_app'), \
                 patch('install.install'), patch('install.setup.installer_environment'), \
                 patch('install.subprocess.run') as run:
                run.return_value.returncode = 0
                install_main(['--prefix', str(base / 'lcu'), '--existing-app', str(existing_app),
                              '--agent', 'pi', '--audio', '--yes', '--skip-system'])
            command = run.call_args.args[0]
            self.assertIn('--audio', command)
            self.assertIn('--agent', command)
            self.assertIn('pi', command)

    def test_linux_installer_reports_runtime_path_when_agent_registration_fails(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            home = base / 'account'
            home.mkdir()
            existing_app = base / 'chatgpt'
            existing_app.mkdir()
            account = SimpleNamespace(pw_name='fixture', pw_uid=1001, pw_dir=str(home))
            with patch('install.DEFAULT_APP_PATH', existing_app), \
                 patch('install.setup.validate', return_value=(account, ['pi'])), \
                 patch('install.architecture', return_value='arm64'), \
                 patch('install.verify'), patch('install.select_app'), \
                 patch('install.install'), patch('install.setup.installer_environment'), \
                 patch('install.subprocess.run') as run, \
                 patch('sys.stderr', io.StringIO()) as stderr:
                run.return_value.returncode = 5
                with self.assertRaises(SystemExit) as raised:
                    install_main(['--prefix', str(base / 'lcu'), '--existing-app', str(existing_app),
                                  '--agent', 'pi', '--yes', '--skip-system'])
            self.assertEqual(raised.exception.code, 5)
            self.assertIn('setup failed; see the errors above', stderr.getvalue())
            self.assertIn(str(base / 'lcu' / 'current/bin/lcu'), stderr.getvalue())

    def test_existing_app_is_selected_in_place_with_its_actual_versions(self):
        app = _application_fixture(self.root / 'chatgpt', relocated=True)
        application, descriptor = select_app('arm64', existing_app=app, execute=False)
        self.assertEqual(application, app.resolve())
        self.assertEqual(descriptor, {'package_version': '26.924.22138', 'runtime': 'runtime-new',
                                      'architecture': 'arm64'})

    def test_missing_required_runtime_file_rejects_the_app(self):
        app = _application_fixture(self.root / 'chatgpt')
        (app / 'resources/cua_node/bin/node_repl').unlink()
        with self.assertRaisesRegex(ValueError, 'Application payload is incomplete'):
            resolve_installed_linux_app(app, arch='arm64')

    def test_wrong_architecture_app_is_rejected(self):
        app = _application_fixture(self.root / 'chatgpt', arch='x64')
        with self.assertRaisesRegex(ValueError, 'unsupported platform, architecture'):
            resolve_installed_linux_app(app, arch='arm64')

    def test_app_tree_writable_by_other_accounts_is_rejected(self):
        app = _application_fixture(self.root / 'chatgpt')
        resolve_installed_linux_app(app, arch='arm64')
        directory = app / 'resources/cua_node/bin'
        directory.chmod(0o777)
        with self.assertRaisesRegex(ValueError, 'not in a location only root and this account'):
            resolve_installed_linux_app(app, arch='arm64')
        directory.chmod(0o755)
        (app / 'resources/cua_node/bin/node').chmod(0o757)
        with self.assertRaisesRegex(ValueError, 'writable by group or other'):
            resolve_installed_linux_app(app, arch='arm64')

    def test_app_tree_owned_by_another_account_is_rejected_unless_trusted(self):
        if os.getuid() == 0:
            self.skipTest('root-owned files are always trusted')
        app = _application_fixture(self.root / 'chatgpt')
        other = os.getuid()
        with patch('lcu.platforms.os.getuid', return_value=other + 1), \
             patch('lcu.platforms.os.geteuid', return_value=other + 1):
            with self.assertRaisesRegex(ValueError, f'owned by uid {other}'):
                resolve_installed_linux_app(app, arch='arm64')
            self.assertEqual(resolve_installed_linux_app(app, arch='arm64', trusted_uids={other}).app,
                             app.resolve())

    def test_writable_ancestor_directory_is_rejected_but_sticky_is_allowed(self):
        app = _application_fixture(self.root / 'shared/chatgpt')
        (self.root / 'shared').chmod(0o777)
        with self.assertRaisesRegex(ValueError, 'shared is writable'):
            resolve_installed_linux_app(app, arch='arm64')
        (self.root / 'shared').chmod(0o1777)
        resolve_installed_linux_app(app, arch='arm64')

    def test_runtime_path_that_escapes_the_app_tree_is_rejected(self):
        app = _application_fixture(self.root / 'chatgpt')
        outside = _application_fixture(self.root / 'elsewhere')
        shutil.rmtree(app / 'resources/cua_node/bin')
        (app / 'resources/cua_node/bin').symlink_to(outside / 'resources/cua_node/bin',
                                                    target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'outside the application'):
            resolve_installed_linux_app(app, arch='arm64')

    def test_read_only_mount_is_checked_like_any_other_tree(self):
        if os.getuid() == 0:
            self.skipTest('root-owned files are always trusted')
        app = _application_fixture(self.root / 'chatgpt')
        read_only = SimpleNamespace(f_flag=os.ST_RDONLY)
        owner = os.getuid()
        other = owner + 1
        # Another account owns it: a writable view of the same source could change it.
        with patch('lcu.platforms.os.getuid', return_value=other), \
             patch('lcu.platforms.os.geteuid', return_value=other), \
             patch('os.statvfs', return_value=read_only):
            with self.assertRaisesRegex(ValueError, f'owned by uid {owner}'):
                resolve_installed_linux_app(app, arch='arm64')
        # A trusted owner (root in a Silo mount) on a read-only mount still passes.
        with patch('lcu.platforms.os.getuid', return_value=other), \
             patch('lcu.platforms.os.geteuid', return_value=other), \
             patch('os.statvfs', return_value=read_only):
            self.assertEqual(resolve_installed_linux_app(app, arch='arm64', trusted_uids={owner}).app,
                             app.resolve())
        # Mode bits count on a read-only mount too.
        (app / 'resources/cua_node/bin/node').chmod(0o757)
        with patch('os.statvfs', return_value=read_only):
            with self.assertRaisesRegex(ValueError, 'writable by group or other'):
                resolve_installed_linux_app(app, arch='arm64')

    def _chrome_script(self, app, name='scripts/installManifest.mjs'):
        path = app / 'resources/plugins/openai-bundled/plugins/chrome' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('export {};\n')
        return path

    def test_executed_chrome_plugin_scripts_must_be_unwritable_by_others(self):
        app = _application_fixture(self.root / 'chatgpt')
        install_script = self._chrome_script(app)
        diagnostic = self._chrome_script(app, 'scripts/diagnostics/status.mjs')
        resolve_installed_linux_app(app, arch='arm64')
        for target in (install_script, diagnostic, diagnostic.parent):
            before = target.stat().st_mode & 0o7777
            target.chmod(before | 0o002)
            with self.assertRaisesRegex(ValueError, 'writable by group or other'):
                resolve_installed_linux_app(app, arch='arm64')
            target.chmod(before)
        resolve_installed_linux_app(app, arch='arm64')

    def test_other_plugin_trees_are_covered_too(self):
        app = _application_fixture(self.root / 'chatgpt')
        script = app / 'resources/plugins/openai-bundled/plugins/browser/scripts/run.mjs'
        script.parent.mkdir(parents=True)
        script.write_text('export {};\n')
        script.chmod(0o666)
        with self.assertRaisesRegex(ValueError, 'writable by group or other'):
            resolve_installed_linux_app(app, arch='arm64')

    def test_link_to_a_writable_directory_elsewhere_in_the_app_is_followed(self):
        app = _application_fixture(self.root / 'chatgpt')
        shared = app / 'resources/shared'
        shared.mkdir()
        payload = shared / 'dependency.js'
        payload.write_text('export {};\n')
        modules = app / 'resources/cua_node/lib/node_modules'
        (modules / 'linked').symlink_to(shared, target_is_directory=True)
        resolve_installed_linux_app(app, arch='arm64')
        payload.chmod(0o666)
        with self.assertRaisesRegex(ValueError, 'dependency.js is writable by group or other'):
            resolve_installed_linux_app(app, arch='arm64')
        payload.chmod(0o644)
        shared.chmod(0o777)
        with self.assertRaisesRegex(ValueError, 'shared is writable by group or other'):
            resolve_installed_linux_app(app, arch='arm64')

    def test_link_to_a_file_elsewhere_in_the_app_is_validated(self):
        app = _application_fixture(self.root / 'chatgpt')
        target = app / 'resources/helper.mjs'
        target.write_text('export {};\n')
        (app / 'resources/cua_node/lib/node_modules/helper.mjs').symlink_to(target)
        resolve_installed_linux_app(app, arch='arm64')
        target.chmod(0o666)
        with self.assertRaisesRegex(ValueError, 'helper.mjs is writable by group or other'):
            resolve_installed_linux_app(app, arch='arm64')

    def test_link_cycles_and_repeated_links_terminate(self):
        app = _application_fixture(self.root / 'chatgpt')
        modules = app / 'resources/cua_node/lib/node_modules'
        (modules / 'loop').symlink_to(modules, target_is_directory=True)
        (modules / 'again').symlink_to(modules / 'loop', target_is_directory=True)
        resolve_installed_linux_app(app, arch='arm64')

    def test_link_that_escapes_the_app_is_refused_anywhere_in_a_tree(self):
        app = _application_fixture(self.root / 'chatgpt')
        outside = self.root / 'outside'
        outside.mkdir()
        (app / 'resources/plugins/openai-bundled/plugins/chrome/escape').symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'escape links outside the application'):
            resolve_installed_linux_app(app, arch='arm64')

    def test_group_write_requires_every_group_member_to_be_trusted(self):
        app = _application_fixture(self.root / 'chatgpt')
        node = app / 'resources/cua_node/bin/node'
        node.chmod(0o775)
        stranger = os.getuid() + 1000
        with patch('lcu.platforms._group_members', return_value={stranger}):
            with self.assertRaisesRegex(ValueError, 'writable by group or other'):
                resolve_installed_linux_app(app, arch='arm64')
        with patch('lcu.platforms._group_members', return_value=None):
            with self.assertRaisesRegex(ValueError, 'writable by group or other'):
                resolve_installed_linux_app(app, arch='arm64')
        with patch('lcu.platforms._group_members', return_value={0, os.getuid()}):
            resolve_installed_linux_app(app, arch='arm64')

    def test_group_zero_is_not_trusted_by_its_number_alone(self):
        from lcu.platforms import _untrusted_entry
        info = SimpleNamespace(st_uid=0, st_gid=0, st_mode=0o100664)
        self.assertIsNotNone(_untrusted_entry(Path('/x'), info, {0}, lambda gid: {0, 1234}))
        self.assertIsNone(_untrusted_entry(Path('/x'), info, {0}, lambda gid: {0}))

    @staticmethod
    def _acl(*entries):
        blob = (2).to_bytes(4, 'little')
        for tag, perm, ident in entries:
            blob += tag.to_bytes(2, 'little') + perm.to_bytes(2, 'little') + ident.to_bytes(4, 'little')
        return blob

    def test_named_acl_entries_with_write_are_untrusted_unless_masked_or_trusted(self):
        from lcu.platforms import _acl_writers_untrusted
        USER, GROUP, MASK, OBJ = 0x02, 0x08, 0x10, 0x01
        no_group = lambda gid: set()
        base = (OBJ, 6, 0xFFFFFFFF),
        self.assertRegex(_acl_writers_untrusted(self._acl(*base, (USER, 6, 4242), (MASK, 7, 0xFFFFFFFF)),
                                                {0}, no_group), 'uid 4242 through a POSIX ACL')
        self.assertIsNone(_acl_writers_untrusted(self._acl(*base, (USER, 6, 4242), (MASK, 5, 0xFFFFFFFF)),
                                                 {0}, no_group))  # the mask removes write
        self.assertIsNone(_acl_writers_untrusted(self._acl(*base, (USER, 4, 4242), (MASK, 7, 0xFFFFFFFF)),
                                                 {0}, no_group))  # read only
        self.assertIsNone(_acl_writers_untrusted(self._acl(*base, (USER, 6, 4242), (MASK, 7, 0xFFFFFFFF)),
                                                 {0, 4242}, no_group))
        self.assertRegex(_acl_writers_untrusted(self._acl(*base, (GROUP, 6, 50), (MASK, 7, 0xFFFFFFFF)),
                                                {0}, lambda gid: {4242}), 'group 50')
        self.assertRegex(_acl_writers_untrusted(b'garbage', {0}, no_group), 'cannot read')

    def test_a_writable_acl_on_an_app_file_is_rejected(self):
        app = _application_fixture(self.root / 'chatgpt')
        blob = self._acl((0x01, 6, 0xFFFFFFFF), (0x02, 6, os.getuid() + 1000), (0x10, 7, 0xFFFFFFFF))
        target = app / 'resources/cua_node/bin/node_repl'
        real = lcu_platforms._posix_acl
        with patch('lcu.platforms._posix_acl', side_effect=lambda p: blob if p == target.resolve() else real(p)):
            with self.assertRaisesRegex(ValueError, 'node_repl is writable by uid .* through a POSIX ACL'):
                resolve_installed_linux_app(app, arch='arm64')

    def test_install_links_the_installed_app_without_copying_it(self):
        prefix = self.root / 'lcu'
        app = _application_fixture(self.root / 'chatgpt')
        source = self.root / 'bundle'
        source.mkdir()
        (source / 'payload').write_text('new version')
        (source / 'runtime.lock.json').write_text(json.dumps({
            'version': '26.915.31945', 'architectures': {'arm64': {'sha256': '0' * 64}}}))
        seal(source, 'arm64')
        with patch('install.SOURCE', source), patch('install.architecture', return_value='arm64'), \
             patch('install.validate_release'):
            release = install(prefix, existing_app=app)
        self.assertEqual(os.readlink(release / 'app'), str(app.resolve()))
        descriptor = json.loads((release / 'installation.json').read_text())
        self.assertEqual(descriptor, {'package_version': '26.924.22138', 'runtime': 'runtime-new',
                                      'architecture': 'arm64', 'app': str(app.resolve())})
        self.assertFalse((prefix / 'apps').exists())
        self.assertFalse((prefix / 'cache').exists())
        self.assertEqual((prefix / 'current').resolve(), release.resolve())

    def test_failed_upgrade_preserves_active_release(self):
        prefix = self.root / 'lcu'
        old = prefix / 'releases/old'
        old.mkdir(parents=True)
        (old / 'data').write_text('previous version')
        (prefix / '.lcu-install').touch()
        (prefix / 'current').symlink_to('releases/old')
        source = self.root / 'bundle'
        source.mkdir()
        (source / 'payload').write_text('new version')
        (source / 'runtime.lock.json').write_text(json.dumps({
            'version': '26.915.31945', 'architectures': {'arm64': {'sha256': '0' * 64}}}))
        seal(source, 'arm64')
        application = self.root / 'chatgpt'
        application.mkdir()
        provided = _selected(application)
        with patch('install.SOURCE', source), patch('install.architecture', return_value='arm64'), \
             patch('install.select_app', return_value=provided), \
             patch('install.validate_release', side_effect=ValueError('runtime validation failed')):
            with self.assertRaisesRegex(ValueError, 'runtime validation failed'):
                install(prefix, existing_app=application)
        self.assertEqual((prefix / 'current/data').read_text(), 'previous version')
        self.assertEqual(list((prefix / 'releases').iterdir()), [old])
        self.assertFalse(list(prefix.glob('.build-*')))

    def test_simultaneous_installs_to_same_prefix_serialize_release_switches(self):
        prefix = self.root / 'lcu'
        old = prefix / 'releases/old'
        old.mkdir(parents=True)
        (old / 'data').write_text('previous version')
        (prefix / '.lcu-install').touch()
        (prefix / 'current').symlink_to('releases/old')
        source = self.root / 'bundle'
        source.mkdir()
        (source / 'payload').write_text('new version')
        (source / 'runtime.lock.json').write_text(json.dumps({
            'version': '26.915.31945', 'architectures': {'arm64': {'sha256': '0' * 64}}}))
        seal(source, 'arm64')
        application = self.root / 'chatgpt'
        application.mkdir()
        provided = _selected(application)

        start = threading.Barrier(2)
        state_lock = threading.Lock()
        active_validations = 0
        max_active_validations = 0
        errors = []

        def validate(_release, _account=None):
            nonlocal active_validations, max_active_validations
            with state_lock:
                active_validations += 1
                max_active_validations = max(max_active_validations, active_validations)
            time.sleep(0.05)
            with state_lock:
                active_validations -= 1

        def run_install():
            try:
                start.wait(timeout=5)
                install(prefix, existing_app=application)
            except BaseException as exc:
                errors.append(exc)

        with patch('install.SOURCE', source), patch('install.architecture', return_value='arm64'), \
             patch('install.select_app', return_value=provided), \
             patch('install.validate_release', side_effect=validate):
            threads = [threading.Thread(target=run_install) for _ in range(2)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=10)

        self.assertTrue(all(not thread.is_alive() for thread in threads), 'installer thread did not finish')
        self.assertEqual(errors, [])
        self.assertEqual(max_active_validations, 1)
        self.assertEqual((prefix / 'current/payload').read_text(), 'new version')
        self.assertEqual(len(list((prefix / 'releases').iterdir())), 3)

    def test_dependency_acquisition_failure_preserves_active_release(self):
        prefix = self.root / 'lcu'
        existing_app = self.root / 'chatgpt'
        existing_app.mkdir()
        old = prefix / 'releases/old'
        old.mkdir(parents=True)
        (old / 'data').write_text('previous version')
        (prefix / '.lcu-install').touch()
        (prefix / 'current').symlink_to('releases/old')
        failure = subprocess.CalledProcessError(100, ['apt-get', 'install'])

        with patch('install.DEFAULT_APP_PATH', existing_app), \
             patch('install.setup.validate', return_value=(None, [])), \
             patch('install.checked_prefix', return_value=prefix), \
             patch('install.architecture', return_value='arm64'), \
             patch('install.verify'), patch('install.select_app'), \
             patch('install.os.getuid', return_value=0), patch('install.shutil.which', return_value='/usr/bin/apt-get'), \
             patch('install.subprocess.run', side_effect=[None, failure]) as run, \
             patch('install.install', side_effect=AssertionError('release install reached')):
            with self.assertRaises(subprocess.CalledProcessError):
                install_main(['--prefix', str(prefix), '--runtime-only', '--session', 'discover'])

        self.assertEqual(run.call_args_list[0].args[0], ['apt-get', 'update'])
        self.assertEqual(run.call_args_list[1].args[0][:3], ['apt-get', 'install', '-y'])
        self.assertEqual((prefix / 'current/data').read_text(), 'previous version')
        self.assertEqual(list((prefix / 'releases').iterdir()), [old])

    def test_unexpected_next_symlink_preserves_active_release(self):
        prefix = self.root / 'lcu'
        old = prefix / 'releases/old'
        old.mkdir(parents=True)
        (old / 'data').write_text('previous version')
        (prefix / '.lcu-install').touch()
        (prefix / 'current').symlink_to('releases/old')
        conflict = self.root / 'conflict'
        conflict.mkdir()
        (prefix / '.next').symlink_to(conflict, target_is_directory=True)
        source = self.root / 'bundle'
        source.mkdir()
        (source / 'payload').write_text('new version')
        (source / 'runtime.lock.json').write_text(json.dumps({
            'version': '26.915.31945', 'architectures': {'arm64': {'sha256': '0' * 64}}}))
        seal(source, 'arm64')
        application = self.root / 'chatgpt'
        application.mkdir()
        provided = _selected(application)

        with patch('install.SOURCE', source), patch('install.architecture', return_value='arm64'), \
             patch('install.select_app', return_value=provided), \
             patch('install.validate_release'):
            with self.assertRaisesRegex(ValueError, 'Unexpected .next path'):
                install(prefix, existing_app=application)

        self.assertEqual((prefix / 'current/data').read_text(), 'previous version')
        self.assertTrue((prefix / '.next').is_symlink())
        self.assertEqual(list((prefix / 'releases').iterdir()), [old])

    def test_caller_security_settings_survive(self):
        app = _application_fixture(self.root / 'chatgpt').resolve()
        (self.root / 'app').symlink_to(app, target_is_directory=True)
        (self.root / 'runtime.lock.json').write_text(json.dumps({
            'runtime': 'runtime-pin', 'version': '26.915.31945',
            'architectures': {'arm64': {'sha256': 'pinned-digest'}}}))
        (self.root / 'installation.json').write_text(json.dumps({
            'app': str(app), 'architecture': 'arm64',
            'package_version': '26.924.22138', 'runtime': 'runtime-new'}))
        settings = {'NODE_REPL_FORCE_STRICT_AUTO_REVIEW': '1', 'NODE_REPL_ENFORCE_MODEL_CHECK': '1',
                    'CODEX_CLI_PATH': '/trusted/codex', 'NODE_REPL_ENABLE_NETWORK_ISOLATION': '1',
                    'NODE_REPL_JS_BANNER': 'configured startup', 'NODE_REPL_TRUSTED_SERVICES': 'configured services'}
        with patch.dict(os.environ, settings):
            result = environment(self.root)
        for key in settings:
            self.assertEqual(result[key], settings[key])
        self.assertEqual(result['CUA_REPL_ENABLED_SURFACES'], 'computer')

    def session(self, pid, display=':1'):
        process = self.root / str(pid)
        process.mkdir()
        (process / 'comm').write_text('xfce4-session\n')
        (process / 'environ').write_bytes(f'DISPLAY={display}\0DBUS_SESSION_BUS_ADDRESS=unix:path=/run/test\0TOKEN=never-copy\0'.encode())

    def test_discovery_copies_only_gui_environment(self):
        self.session(123)
        self.assertEqual(discover(self.root), {'DISPLAY': ':1', 'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/run/test'})

    def test_ambiguous_desktop_is_rejected(self):
        self.session(123)
        self.session(124, ':2')
        with self.assertRaisesRegex(ValueError, 'found 2'):
            discover(self.root)

    def test_another_users_desktop_is_rejected(self):
        self.session(123)
        with self.assertRaisesRegex(ValueError, 'found 0'):
            discover(self.root, os.getuid() + 1)

    def test_concurrent_config_edit_is_preserved(self):
        path = self.root / 'config'
        path.write_bytes(b'concurrent change')
        with self.assertRaises(ValueError):
            apply_changes([Change(path, b'old config', b'new config')])
        self.assertEqual(path.read_bytes(), b'concurrent change')


if __name__ == '__main__':
    unittest.main()
