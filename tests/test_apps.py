"""`lcu apps`: resolution, edits, warnings and fail-closed authentication, all against a temp HOME."""
import contextlib
import io
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from lcu import apps


def make_app(directory, name, identifier, display=None):
    contents = Path(directory) / f'{name}.app/Contents'
    contents.mkdir(parents=True)
    info = {'CFBundleIdentifier': identifier, 'CFBundleName': name}
    if display:
        info['CFBundleDisplayName'] = display
    (contents / 'Info.plist').write_bytes(plistlib.dumps(info))
    return contents.parent


class AppsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.home = Path(self.temporary.name)
        self.applications = self.home / 'Applications'
        self.applications.mkdir()
        self.store = apps.store_path(self.home)
        self.calls = []
        for patcher in (mock.patch.object(apps, 'app_directories', return_value=[self.applications]),
                        mock.patch.object(apps, '_mdfind', return_value=[])):
            patcher.start()
            self.addCleanup(patcher.stop)
        make_app(self.applications, 'Zed', 'dev.zed.Zed')
        make_app(self.applications, 'Safari', 'com.apple.Safari')
        make_app(self.applications, 'Terminal', 'com.apple.Terminal')

    def tearDown(self):
        self.temporary.cleanup()

    def auth(self, approve=True):
        def fake(root, reason):
            self.calls.append(reason)
            if not approve:
                raise apps.AppsError('authentication was cancelled or failed. Nothing was changed.')
        return fake

    def run_apps(self, *argv, approve=True, platform='darwin'):
        out, err = io.StringIO(), io.StringIO()
        code = 0
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                apps.main(ROOT, list(argv), platform=platform, home=self.home, auth=self.auth(approve))
            except SystemExit as exit_:
                code = exit_.code
        return code, out.getvalue(), err.getvalue()

    def write_store(self, document):
        self.store.parent.mkdir(parents=True, exist_ok=True)
        self.store.write_text(document if isinstance(document, str) else json.dumps(document))

    def ids(self):
        return json.loads(self.store.read_text())[apps.KEY]

    # Resolution
    def test_name_bundle_id_and_path_resolve_to_the_same_app(self):
        for query in ('Zed', 'zed', 'dev.zed.Zed', str(self.applications / 'Zed.app')):
            self.assertEqual(apps.resolve(query, home=self.home), ('dev.zed.Zed', 'Zed', True))

    def test_display_name_matches_and_ambiguity_is_refused(self):
        make_app(self.applications, 'Code', 'com.example.code', display='Visual Code')
        self.assertEqual(apps.resolve('Visual Code', home=self.home)[0], 'com.example.code')
        make_app(self.applications, 'Zed Preview', 'dev.zed.Zed-Preview', display='Zed')
        with self.assertRaisesRegex(apps.AppsError, 'matches several apps'):
            apps.resolve('Zed', home=self.home)

    def test_unknown_name_is_an_error_and_unknown_bundle_id_is_reported_not_installed(self):
        with self.assertRaisesRegex(apps.AppsError, 'no installed app named "Nope"'):
            apps.resolve('Nope', home=self.home)
        self.assertEqual(apps.resolve('com.gone.App', home=self.home), ('com.gone.App', 'com.gone.App', False))

    # List
    def test_list_shows_names_ids_and_flags_and_needs_no_authentication(self):
        self.write_store({apps.KEY: ['dev.zed.Zed', 'com.apple.Safari', 'com.gone.App']})
        code, out, _ = self.run_apps()
        self.assertEqual(code, 0)
        self.assertIn('Zed', out)
        self.assertIn('dev.zed.Zed', out)
        self.assertRegex(out, r'Safari\s+com\.apple\.Safari\s+\(high risk\)')
        self.assertIn('com.gone.App  (not installed)', out)
        self.assertEqual(self.calls, [])

    def test_bundle_with_unparseable_xml_plist_is_skipped(self):
        # Steam desktop shortcuts end their Info.plist with NUL bytes; plistlib raises ExpatError.
        contents = self.applications / 'Balatro.app/Contents'
        contents.mkdir(parents=True)
        (contents / 'Info.plist').write_bytes(plistlib.dumps({'CFBundleName': 'Balatro'}) + b'\0\0')
        self.assertIsNone(apps.bundle_info(contents.parent))
        self.write_store({apps.KEY: ['dev.zed.Zed']})
        code, out, _ = self.run_apps()
        self.assertEqual(code, 0)
        self.assertIn('dev.zed.Zed', out)
        self.assertNotIn('not installed', out)
        self.assertEqual(apps.resolve('Zed', home=self.home), ('dev.zed.Zed', 'Zed', True))

    def test_list_json_and_empty_list(self):
        code, out, _ = self.run_apps('list')
        self.assertIn('No apps are always allowed', out)
        self.write_store({apps.KEY: ['com.apple.Terminal', 'dev.zed.Zed']})
        code, out, _ = self.run_apps('--json')
        listed = json.loads(out)
        self.assertEqual([a['bundleId'] for a in listed['apps']], ['com.apple.Terminal', 'dev.zed.Zed'])
        self.assertTrue(listed['apps'][0]['blocked'])
        self.assertEqual(listed['apps'][1], {'name': 'Zed', 'bundleId': 'dev.zed.Zed', 'installed': True,
                                              'risk': 'normal', 'blocked': False})
        self.assertEqual(listed['file'], str(self.store))

    # Allow
    def test_allow_authenticates_with_a_clear_reason_then_adds_and_is_idempotent(self):
        code, out, _ = self.run_apps('allow', 'Zed')
        self.assertEqual(code, 0)
        self.assertEqual(self.calls, ['always allow Computer Use to control Zed (dev.zed.Zed)'])
        self.assertEqual(self.ids(), ['dev.zed.Zed'])
        code, out, _ = self.run_apps('allow', 'dev.zed.Zed')
        self.assertEqual(code, 0)
        self.assertIn('already always allowed', out)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.ids(), ['dev.zed.Zed'])

    def test_failed_authentication_changes_nothing(self):
        code, _, err = self.run_apps('allow', 'Zed', approve=False)
        self.assertEqual(code, 1)
        self.assertIn('Nothing was changed', err)
        self.assertFalse(self.store.exists())
        self.write_store({apps.KEY: ['dev.zed.Zed']})
        before = self.store.read_bytes()
        self.assertEqual(self.run_apps('revoke', 'Zed', approve=False)[0], 1)
        self.assertEqual(self.store.read_bytes(), before)

    def test_unknown_keys_and_order_are_preserved(self):
        self.write_store({'schema': 3, apps.KEY: ['b.id'], 'extra': {'a': [1]}})
        self.run_apps('allow', 'Zed')
        document = json.loads(self.store.read_text())
        self.assertEqual(document, {'schema': 3, apps.KEY: ['b.id', 'dev.zed.Zed'], 'extra': {'a': [1]}})
        self.run_apps('revoke', 'dev.zed.Zed')
        self.assertEqual(json.loads(self.store.read_text()),
                         {'schema': 3, apps.KEY: ['b.id'], 'extra': {'a': [1]}})
        self.assertEqual(list(self.store.parent.iterdir()), [self.store])

    def test_forbidden_app_is_refused_without_prompting_or_writing(self):
        code, _, err = self.run_apps('allow', 'Terminal')
        self.assertEqual(code, 1)
        self.assertIn('never controls Terminal', err)
        self.assertEqual(self.calls, [])
        self.assertFalse(self.store.exists())

    def test_high_risk_app_warns_and_says_so_in_the_prompt(self):
        code, _, err = self.run_apps('allow', 'Safari')
        self.assertEqual(code, 0)
        self.assertIn('high risk', err)
        self.assertEqual(self.calls, ['always allow Computer Use to control Safari (com.apple.Safari) (high risk)'])
        self.assertEqual(self.ids(), ['com.apple.Safari'])

    def test_uninstalled_bundle_id_cannot_be_allowed(self):
        code, _, err = self.run_apps('allow', 'com.gone.App')
        self.assertEqual(code, 1)
        self.assertIn('not installed', err)

    # Revoke
    def test_revoke_by_name_id_and_for_uninstalled_entries(self):
        self.write_store({apps.KEY: ['dev.zed.Zed', 'com.gone.App', 'com.apple.Safari']})
        self.assertEqual(self.run_apps('revoke', 'zed')[0], 0)
        self.assertEqual(self.calls[-1], 'stop always allowing Computer Use to control Zed (dev.zed.Zed)')
        self.assertEqual(self.run_apps('revoke', 'com.gone.App')[0], 0)
        self.assertEqual(self.ids(), ['com.apple.Safari'])

    def test_revoke_of_absent_app_is_idempotent_and_does_not_prompt(self):
        self.write_store({apps.KEY: []})
        code, out, _ = self.run_apps('revoke', 'Zed')
        self.assertEqual(code, 0)
        self.assertIn('not in the always-allowed list', out)
        self.assertEqual(self.calls, [])
        code, _, err = self.run_apps('revoke', 'com.never.Seen')
        self.assertEqual(code, 0)

    def test_revoke_reports_unknown_name(self):
        self.write_store({apps.KEY: ['dev.zed.Zed']})
        code, _, err = self.run_apps('revoke', 'Nothing Here')
        self.assertEqual(code, 1)
        self.assertIn('not among the approved apps', err)

    # Malformed stores
    def test_malformed_store_is_reported_and_never_overwritten(self):
        for content in ('{not json', '[]', json.dumps({apps.KEY: 'x'}), json.dumps({apps.KEY: [1]})):
            self.write_store(content)
            for argv in (('list',), ('allow', 'Zed'), ('revoke', 'Zed')):
                code, _, err = self.run_apps(*argv)
                self.assertEqual(code, 1, (content, argv))
                self.assertIn('not a valid approvals file', err)
                self.assertEqual(self.store.read_text(), content)
        self.assertEqual(self.calls, [])

    def test_object_without_the_key_is_empty_and_keeps_its_other_keys_on_write(self):
        self.write_store({'other': 1})
        self.assertIn('No apps are always allowed', self.run_apps('list')[1])
        self.run_apps('allow', 'Zed')
        self.assertEqual(json.loads(self.store.read_text()), {'other': 1, apps.KEY: ['dev.zed.Zed']})

    # Concurrent writers
    def test_a_writer_racing_the_update_is_not_lost(self):
        self.write_store({apps.KEY: ['a.id']})
        real_fsync = os.fsync
        raced = []
        def racing_fsync(descriptor):
            if not raced:
                raced.append(True)
                self.store.write_text(json.dumps({apps.KEY: ['a.id', 'runtime.id']}))
            real_fsync(descriptor)
        with mock.patch.object(apps.os, 'fsync', racing_fsync):
            apps.modify(self.store, lambda ids: ids + ['dev.zed.Zed'], sleep=lambda _: None)
        # The other writer landed while the new file was being prepared, so the first attempt is
        # discarded and recomputed on top of its content.
        self.assertEqual(self.ids(), ['a.id', 'runtime.id', 'dev.zed.Zed'])
        self.assertEqual(len(raced), 1)

    def test_a_write_clobbered_right_after_the_replace_is_redone(self):
        self.write_store({apps.KEY: ['a.id']})
        clobbered = []
        def clobbering_sleep(_):
            if not clobbered:
                clobbered.append(True)
                self.store.write_text(json.dumps({apps.KEY: ['a.id', 'runtime.id']}))
        apps.modify(self.store, lambda ids: ids + ['dev.zed.Zed'], sleep=clobbering_sleep)
        self.assertEqual(self.ids(), ['a.id', 'runtime.id', 'dev.zed.Zed'])

    def test_gives_up_when_the_file_never_settles(self):
        self.write_store({apps.KEY: []})
        counter = []
        def always_changing(_):
            counter.append(1)
            self.store.write_text(json.dumps({apps.KEY: ['n%d' % len(counter)]}))
        with self.assertRaisesRegex(apps.AppsError, 'kept changing'):
            apps.modify(self.store, lambda ids: ids + ['x'], attempts=3, sleep=always_changing)

    @unittest.skipIf(sys.platform == 'win32', 'lcu apps is macOS-only; POSIX replace and mode semantics')
    def test_parallel_updates_all_land(self):
        self.write_store({apps.KEY: []})
        errors = []
        def add(index):
            try:
                apps.modify(self.store, lambda ids: ids + [f'id.{index}'] if f'id.{index}' not in ids else ids)
            except apps.AppsError as exc:
                errors.append(exc)
        threads = [threading.Thread(target=add, args=(i,)) for i in range(5)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertFalse(errors)
        self.assertEqual(sorted(self.ids()), [f'id.{i}' for i in range(5)])

    @unittest.skipIf(sys.platform == 'win32', 'lcu apps is macOS-only; POSIX replace and mode semantics')
    def test_new_store_directory_is_created_and_mode_is_kept(self):
        apps.modify(self.store, lambda ids: ids + ['dev.zed.Zed'])
        self.assertEqual(self.ids(), ['dev.zed.Zed'])
        self.store.chmod(0o640)
        apps.modify(self.store, lambda ids: ids + ['x.y'])
        self.assertEqual(self.store.stat().st_mode & 0o777, 0o640)

    # Platforms
    def test_linux_and_windows_explain_themselves(self):
        code, _, err = self.run_apps('allow', 'Zed', platform='linux')
        self.assertEqual(code, 1)
        self.assertIn('no per-app approval', err)
        code, _, err = self.run_apps(platform='win32')
        self.assertEqual(code, 1)
        self.assertIn('not supported on Windows', err)
        self.assertFalse(self.store.exists())

    def test_runtime_dispatches_apps(self):
        from lcu.runtime import main
        with mock.patch('lcu.apps.main') as handler:
            main(ROOT, ['apps', 'allow', 'Zed'])
        handler.assert_called_once_with(ROOT, ['allow', 'Zed'])


@unittest.skipIf(sys.platform == 'win32', 'the Touch ID helper is macOS-only; the stand-in is a shell script')
class AuthenticationTests(unittest.TestCase):
    """The real authenticate() driven by a stand-in helper script; no prompt ever appears."""

    def helper(self, root, body):
        path = Path(root) / apps.HELPER
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('#!/bin/sh\n' + body)
        path.chmod(0o755)

    def test_exit_codes_map_to_messages_and_fail_closed(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaisesRegex(apps.AppsError, 'helper is missing'):
                apps.authenticate(root, 'why')
            self.helper(root, 'echo "$@" > "$0.args"; exit 0')
            apps.authenticate(root, 'why')
            self.assertEqual((Path(root) / (apps.HELPER + '.args')).read_text().strip(), '--reason why')
            self.helper(root, 'exit 1')
            with self.assertRaisesRegex(apps.AppsError, 'cancelled or failed'):
                apps.authenticate(root, 'why')
            self.helper(root, 'echo no graphical login session >&2; exit 2')
            with self.assertRaisesRegex(apps.AppsError, 'cannot ask for authentication: no graphical'):
                apps.authenticate(root, 'why')
            self.helper(root, 'kill -9 $$')
            with self.assertRaises(apps.AppsError):
                apps.authenticate(root, 'why')


@unittest.skipUnless(sys.platform == 'darwin' and shutil.which('swiftc'), 'needs macOS with swiftc')
class OwnerAuthHelperBuildTests(unittest.TestCase):
    def test_helper_builds_signed_and_rejects_bad_usage_without_prompting(self):
        sys.path.insert(0, str(ROOT / 'scripts'))
        import build_bundle
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
