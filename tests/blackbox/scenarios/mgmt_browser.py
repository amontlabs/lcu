"""`lcu browser install|status`: the private host copy, its digest/marker/lock, native-host manifest rewrites and the
diagnostics report.

The fake app's Chrome plugin is completed with stand-ins for the upstream scripts (assets/mgmt/chrome-plugin):
installManifest.mjs writes manifests where the real one does (a subset), check-*.js print what the scenario
configures through $LCU_BB_FAKE_BROWSER, and every call is in the recorder log. The relay LCU copies out
(`lcu-native-host`) is code under test whose language changes with the port, so each scenario replaces it at the end
by a summary of its type and mode (fixtures_mgmt.neutralise_relay); everything else is compared byte for byte.
"""
import fcntl
import json
import os
from pathlib import Path
import shutil
import threading

import fixtures
import fixtures_mgmt as fm

from . import scenario

ANY = ('darwin', 'linux')
LINUX = ('linux',)


def _note(sb, text):
    sb.run(['echo', text], label=text)


def _prepare(sb, **plugin):
    sb.place_release()
    fm.chrome_plugin(sb, **plugin)
    return fm.browser_destination(sb)


def _manifests(sb):
    if fm.host() == 'darwin':
        base = sb.home / 'Library/Application Support'
        return [base / 'Google/Chrome/NativeMessagingHosts/com.openai.codexextension.json',
                base / 'Microsoft Edge/NativeMessagingHosts/com.openai.codexextension.json']
    return [sb.home / '.config/google-chrome/NativeMessagingHosts/com.openai.codexextension.json',
            sb.home / '.config/chromium/NativeMessagingHosts/com.openai.codexextension.json']


def _show_state(sb, destination):
    for path in _manifests(sb):
        fm.show(sb, path, f'manifest {path.parent.parent.name}')
    for name in ('.lcu-browser-host', '.lcu-browser-plugin'):
        fm.show(sb, Path(destination) / name, name)
    relay = Path(destination) / 'lcu-native-host'
    sb.run(['test', '-x', relay], label='relay is executable')


@scenario('browser/arguments', hosts=ANY)
def _(sb):
    _prepare(sb)
    for args in (['--help'], ['-h'], [], ['install', '--help'], ['status', '--help'], ['serve'], ['protocol'],
                 ['serve', '--help'], ['bogus'], ['status', '--browser', 'firefox'], ['status', '--browser'],
                 ['install', '--directory'], ['status', 'extra'], ['install', 'extra'], ['--bogus', 'status'],
                 ['status', '--bro', 'edge', '--help']):
        sb.lcu('browser', *args)


@scenario('browser/install-and-status', hosts=ANY)
def _(sb):
    destination = _prepare(sb)
    sb.lcu('browser', 'install')
    _show_state(sb, destination)
    sb.lcu('browser', 'status')
    sb.lcu('browser', 'status', '--browser', 'edge')
    _note(sb, '--- install again: up to date, manifests rewritten again')
    sb.lcu('browser', 'install')
    _show_state(sb, destination)
    _note(sb, '--- the app plugin changes in place: status sees an outdated copy, install refreshes it')
    plugin = fm.app_resources(sb) / 'plugins/openai-bundled/plugins/chrome'
    (plugin / 'scripts/new-file.txt').write_text('added by an app update\n')
    sb.lcu('browser', 'status')
    sb.lcu('browser', 'install')
    _show_state(sb, destination)
    sb.lcu('browser', 'status')
    _note(sb, '--- a mode change counts too')
    (plugin / 'scripts/new-file.txt').chmod(0o755)
    sb.lcu('browser', 'status')
    sb.lcu('browser', 'install')
    sb.lcu('browser', 'status')
    _note(sb, '--- a symlink in the plugin is copied as a link')
    (plugin / 'scripts/alias.mjs').symlink_to('installManifest.mjs')
    sb.lcu('browser', 'install')
    sb.lcu('browser', 'status')
    fm.neutralise_relay(sb, destination)


@scenario('browser/install-directory', hosts=ANY)
def _(sb):
    _prepare(sb)
    custom = sb.work / 'host-dir'
    sb.lcu('browser', 'install', '--directory', custom)
    _show_state(sb, custom)
    sb.lcu('browser', 'status')
    _note(sb, '--- relative --directory (cwd work) and ~ expansion')
    sb.lcu('browser', 'install', '--directory', 'relative/host')
    sb.lcu('browser', 'install', '--directory=~/tilde-host')
    _note(sb, '--- a directory that belongs to another installation')
    other = sb.work / 'foreign'
    other.mkdir()
    (other / 'something').write_text('x')
    sb.lcu('browser', 'install', '--directory', other)
    (other / '.lcu-browser-host').write_text('/some/other/app\n')
    sb.lcu('browser', 'install', '--directory', other)
    (other / '.lcu-browser-host').write_text(str((sb.release / 'app').resolve()))      # no newline: mismatch
    sb.lcu('browser', 'install', '--directory', other)
    (other / '.lcu-browser-host').unlink()
    (other / '.lcu-browser-host').symlink_to(custom / '.lcu-browser-host')
    sb.lcu('browser', 'install', '--directory', other)
    _note(sb, '--- the directory is a symlink')
    link = sb.work / 'link-host'
    link.symlink_to(custom)
    sb.lcu('browser', 'install', '--directory', link)
    _note(sb, '--- an empty existing directory is not adopted')
    empty = sb.work / 'empty'
    empty.mkdir()
    sb.lcu('browser', 'install', '--directory', empty)
    for path in (custom, sb.work / 'relative/host', sb.home / 'tilde-host'):
        fm.neutralise_relay(sb, path)


@scenario('browser/install-errors', hosts=ANY)
def _(sb):
    destination = _prepare(sb)
    plugin = fm.app_resources(sb) / 'plugins/openai-bundled/plugins/chrome'
    for label, config in (
            ('installer exits 3 with stderr', {'install': {'exit': 3, 'stderr': 'boom\n' + 'e' * 2500 + '\nlast\n'}}),
            ('installer exits 4 with stdout only', {'install': {'exit': 4, 'stdout': 'only stdout\n'}}),
            ('installer exits 5 silently', {'install': {'exit': 5}}),
            ('no manifest produced', {'install': {'manifests': []}}),
            ('only foreign manifests', {'install': {'manifests': [{'file': str(_manifests(sb)[0]), 'host': '/opt/other/extension-host'}]}}),
            ('host name differs', {'install': {'manifests': [{'file': str(_manifests(sb)[0]), 'host': 'extension-host/elsewhere/not-the-host'}]}}),
            ('manifest without path', {'install': {'manifests': [{'file': str(_manifests(sb)[0]), 'nopath': True}]}}),
            ('manifest is not JSON', {'install': {'manifests': [{'file': str(_manifests(sb)[0]), 'raw': '{nope'}]}}),
            ('manifest is a symlink', {'install': {'manifests': [{'file': str(_manifests(sb)[0]), 'symlinkTo': '/dev/null'}]}}),
            ('one good, one foreign', {'install': {'manifests': [
                {'file': str(_manifests(sb)[0])}, {'file': str(_manifests(sb)[1]), 'host': '/opt/other/extension-host'}]}})):
        for path in _manifests(sb):
            if path.exists() or path.is_symlink():
                path.unlink()
        env = fm.fake_browser(sb, **config)
        _note(sb, f'--- {label}')
        sb.lcu('browser', 'install', env=env)
        for path in _manifests(sb):
            fm.show(sb, path, f'manifest {path.parent.parent.name}')
    _note(sb, '--- upstream installer script missing from the app plugin')
    (plugin / 'scripts/installManifest.mjs').rename(plugin / 'scripts/installManifest.mjs.away')
    sb.lcu('browser', 'install')
    (plugin / 'scripts/installManifest.mjs.away').rename(plugin / 'scripts/installManifest.mjs')
    _note(sb, '--- app invalid')
    descriptor = sb.release / 'installation.json'
    saved = descriptor.read_text()
    descriptor.write_text('{}')
    sb.lcu('browser', 'install')
    sb.lcu('browser', 'status')
    descriptor.write_text(saved)
    fm.neutralise_relay(sb, destination)


@scenario('browser/status-report', hosts=ANY)
def _(sb):
    destination = _prepare(sb)
    sb.lcu('browser', 'install')
    for label, config in (
            ('enabled, no profile', {'extension': {'installed': True, 'enabled': True}}),
            ('enabled is truthy but not true', {'extension': {'installed': True, 'enabled': 1}}),
            ('disabled in a profile', {'extension': {'installed': True, 'enabled': False,
                                                     'selectedProfileDirectory': 'Profile 2'}}),
            ('not found', {'extension': {'installed': False, 'enabled': False, 'selectedProfileDirectory': 'Default'}}),
            ('problem reported by the diagnostic', {'extension': {'problem': 'Chrome is not installed.'}}),
            ('stderr only', {'extension': {'none': True, 'stderr': '  diagnostic crashed  \n', 'exit': 1}}),
            ('unparsable output', {'extension': {'raw': 'not json at all'}}),
            ('JSON array output', {'extension': {'raw': '[1, 2]'}}),
            ('no output', {'extension': {'none': True}}),
            ('unicode output size counted in bytes', {'extension': {'raw': 'é☃ not json'}}),
            ('manifest not correct', {'manifest': {'correct': False}}),
            ('manifest path missing', {'manifest': {'correct': True, 'manifestPath': str(sb.home / 'missing.json')}}),
            ('manifest check unparsable', {'manifest': {'raw': 'x'}}),
            ('manifest points at a JSON without path', {'manifest': {'correct': True, 'manifestPath': str(sb.release / 'bundle.json')}})):
        env = fm.fake_browser(sb, **config)
        _note(sb, f'--- {label}')
        sb.lcu('browser', 'status', env=env)
        sb.lcu('browser', 'status', '--browser', 'edge', env=env)
    relay = destination / 'lcu-native-host'
    original = relay.read_bytes()
    for label, action, undo in (
            ('relay modified', lambda: relay.write_bytes(original + b'\n# changed\n'), lambda: relay.write_bytes(original)),
            ('relay not executable', lambda: relay.chmod(0o600), lambda: relay.chmod(0o700)),
            ('marker differs', lambda: (destination / '.lcu-browser-host').write_text('/x\n'),
             lambda: (destination / '.lcu-browser-host').write_text(str((sb.release / 'app').resolve()) + '\n')),
            ('stamp differs', lambda: (destination / '.lcu-browser-plugin').write_text('0' * 64 + '\n'), None),
            ('host binary not executable', lambda: next((destination / 'chrome/extension-host').rglob('*-host*'), relay).chmod(0o644)
             if fm.host() == 'linux' else next((destination / 'chrome/extension-host').rglob('ChatGPT for Chrome')).chmod(0o644), None)):
        action()
        _note(sb, f'--- {label}')
        sb.lcu('browser', 'status')
        if undo:
            undo()
    _note(sb, '--- install repairs it')
    sb.lcu('browser', 'install')
    sb.lcu('browser', 'status')
    fm.neutralise_relay(sb, destination)


@scenario('browser/refresh-recovery', hosts=ANY)
def _(sb):
    destination = _prepare(sb)
    sb.lcu('browser', 'install')
    plugin_copy = destination / 'chrome'
    _note(sb, '--- interrupted between the renames: chrome missing, .chrome-previous present')
    plugin_copy.rename(destination / '.chrome-previous')
    sb.lcu('browser', 'install')
    _note(sb, '--- leftovers: a retired copy, scratch directories and files')
    shutil.copytree(plugin_copy, destination / '.chrome-previous', symlinks=True)
    (destination / '.lcu-browser-abc123').mkdir()
    (destination / '.lcu-browser-abc123/x').write_text('scratch')
    (destination / '.lcu-browser-stamp-zz').write_text('stale stamp')
    (destination / '.lcu-native-host-left').write_text('stale relay temp')
    sb.lcu('browser', 'install')
    _note(sb, '--- digest file replaced by a symlink: replaced, never followed')
    target = sb.work / 'stamp-target'
    target.write_text('do not touch\n')
    (destination / '.lcu-browser-plugin').unlink()
    (destination / '.lcu-browser-plugin').symlink_to(target)
    sb.lcu('browser', 'install')
    fm.show(sb, target, 'symlink target untouched')
    _note(sb, '--- the copy is a symlink: replaced by a real copy')
    shutil.rmtree(plugin_copy)
    plugin_copy.symlink_to(fm.app_resources(sb) / 'plugins/openai-bundled/plugins/chrome')
    sb.lcu('browser', 'install')
    _note(sb, '--- the copy lost its installer script')
    (plugin_copy / 'scripts/installManifest.mjs').unlink()
    sb.lcu('browser', 'install')
    _show_state(sb, destination)
    fm.neutralise_relay(sb, destination)


@scenario('browser/lock', hosts=ANY)
def _(sb):
    # Install serializes on flock(.{name}.lock) beside the private copy.
    destination = _prepare(sb)
    sb.lcu('browser', 'install')
    lock_path = destination.parent / f'.{destination.name}.lock'
    handle = open(lock_path, 'a')
    fcntl.flock(handle, fcntl.LOCK_EX)
    sb.lcu('browser', 'install', timeout=3, label='install while the lock is held')
    timer = threading.Timer(1.5, handle.close)
    timer.start()
    sb.lcu('browser', 'install', timeout=60, label='install waits for the lock')
    timer.join()
    fm.show(sb, lock_path, 'lock file')
    _note(sb, '--- the lock file is a symlink (O_NOFOLLOW)')
    lock_path.unlink()
    lock_path.symlink_to(sb.work / 'lock-target')
    sb.lcu('browser', 'install')
    fm.neutralise_relay(sb, destination)


@scenario('browser/linux-manifest-locations', hosts=LINUX)
def _(sb):
    destination = _prepare(sb)
    home = sb.home
    xdg, chrome_home = sb.work / 'xdg', sb.work / 'chrome-home'
    files = [home / '.config/google-chrome/NativeMessagingHosts/com.openai.codexextension.json',
             home / '.config/vendor/browser-beta/NativeMessagingHosts/com.openai.codexextension.json',
             home / '.config/.hidden/NativeMessagingHosts/com.openai.codexextension.json',
             home / '.config/a/b/c/NativeMessagingHosts/com.openai.codexextension.json',
             xdg / 'chromium/NativeMessagingHosts/com.openai.codexextension.json',
             chrome_home / 'x/NativeMessagingHosts/com.openai.codexextension.json',
             home / '.config/google-chrome/NativeMessagingHosts/other-name.json']
    env = {**fm.fake_browser(sb, install={'manifests': [{'file': str(f)} for f in files]}),
           'XDG_CONFIG_HOME': str(xdg), 'CHROME_CONFIG_HOME': str(chrome_home)}
    sb.lcu('browser', 'install', env=env)
    for path in files:
        fm.show(sb, path, str(path.relative_to(sb.root)))
    _note(sb, '--- without the variables only ~/.config is searched')
    for path in files:
        path.unlink()
    env = fm.fake_browser(sb, install={'manifests': [{'file': str(f)} for f in files]})
    sb.lcu('browser', 'install', env=env)
    for path in files:
        fm.show(sb, path, str(path.relative_to(sb.root)))
    _note(sb, '--- XDG_DATA_HOME moves the default host directory')
    sb.lcu('browser', 'install', env={'XDG_DATA_HOME': str(sb.work / 'data')})
    fm.neutralise_relay(sb, destination)
    for path in (sb.work / 'data/lcu/browser').glob('*'):
        fm.neutralise_relay(sb, path)
