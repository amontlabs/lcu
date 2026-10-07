"""Manage the apps that Computer Use may always control, behind owner authentication (macOS)."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import time
from xml.parsers.expat import ExpatError

KEY = 'approvedBundleIdentifiers'
STORE = ('Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService/'
         'Library/Application Support/Software/ComputerUseAppApprovals.json')
HELPER = 'bin/lcu-owner-auth'

# The original runtime refuses these before it asks anyone, so an entry would never take effect.
FORBIDDEN = {
    'com.apple.Terminal': 'Terminal', 'com.googlecode.iterm2': 'iTerm2',
    'com.openai.codex': 'ChatGPT', 'com.apple.UserNotificationCenter': 'Notification Center',
}
# The original runtime marks these "Elevated Risk" (browsers, password managers, iPhone Mirroring).
HIGH_RISK = {
    'com.apple.Safari', 'com.google.Chrome', 'app.zen-browser.zen', 'com.apple.Passwords',
    'com.apple.keychainaccess', 'com.apple.ScreenContinuity', 'org.mozilla.firefox',
    'com.microsoft.edgemac', 'com.brave.Browser', 'company.thebrowser.Browser',
    'com.operasoftware.Opera', 'com.vivaldi.Vivaldi', 'org.chromium.Chromium',
    'com.1password.1password', 'com.bitwarden.desktop',
}
RISK_NOTE = ('This app is marked high risk by Computer Use (browsers, password managers and iPhone '
             'Mirroring are): content it shows can carry prompt injection, and the agent can read '
             'or change what it holds. Watch the agent while it uses this app.')

AUTH_TIMEOUT = 300
WRITE_ATTEMPTS = 8


class AppsError(ValueError):
    """A problem to show the user without a traceback."""


def store_path(home=None):
    return Path(home or Path.home()) / STORE


def read_store(path):
    """(raw bytes or None, parsed document, ids). A damaged file is never overwritten."""
    try:
        raw = Path(path).read_bytes()
    except FileNotFoundError:
        return None, {}, []
    except OSError as exc:
        raise AppsError(f'cannot read {path}: {exc.strerror or exc}') from None
    try:
        document = json.loads(raw)
    except ValueError:
        document = None
    ids = document.get(KEY, []) if isinstance(document, dict) else None
    if not isinstance(ids, list) or not all(isinstance(item, str) for item in ids):
        raise AppsError(f'{path} is not a valid approvals file (expected {{"{KEY}": [bundle ids]}}); '
                        'leaving it untouched. Move it aside to start from an empty list.')
    return raw, document, ids


def modify(path, change, *, attempts=WRITE_ATTEMPTS, sleep=time.sleep):
    """Apply `change(ids) -> ids` with an atomic replace that tolerates the runtime writing too.

    The runtime does not share a lock with LCU, so the file is re-read just before the replace
    and again afterwards. If either read shows another writer got in, the change is recomputed
    from the new content. Keys other than the approved list are preserved.
    """
    path = Path(path)
    for attempt in range(attempts):
        raw, document, ids = read_store(path)
        updated = change(list(ids))
        if updated == ids and raw is not None:
            return ids
        document = dict(document)
        document[KEY] = updated
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
        try:
            with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
                json.dump(document, stream, indent=2, ensure_ascii=False)
                stream.write('\n')
                stream.flush()
                os.fsync(stream.fileno())
            try:
                os.chmod(temporary, path.stat().st_mode & 0o777)
            except FileNotFoundError:
                pass
            if (path.read_bytes() if path.exists() else None) != raw:
                continue
            os.replace(temporary, path)
        finally:
            Path(temporary).unlink(missing_ok=True)
        sleep(0.05 * (attempt + 1) if attempt else 0.05)
        if read_store(path)[2] == updated:
            return updated
    raise AppsError(f'{path} kept changing while it was being updated; try again.')


# App lookup ------------------------------------------------------------------------------------

def app_directories(home=None):
    home = Path(home or Path.home())
    return [Path('/Applications'), Path('/Applications/Utilities'), Path('/System/Applications'),
            Path('/System/Applications/Utilities'), home / 'Applications']


def bundle_info(app):
    """(bundle id, display name) of an .app directory, or None when it is not a bundle."""
    try:
        info = plistlib.loads((Path(app) / 'Contents/Info.plist').read_bytes())
    except (OSError, plistlib.InvalidFileException, ValueError, ExpatError):
        return None
    identifier = info.get('CFBundleIdentifier')
    if not isinstance(identifier, str) or not identifier:
        return None
    name = info.get('CFBundleDisplayName') or info.get('CFBundleName') or Path(app).stem
    return identifier, str(name)


def _mdfind(query):
    try:
        done = subprocess.run(['/usr/bin/mdfind', query], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return []
    return [Path(line) for line in done.stdout.splitlines() if line.endswith('.app')]


def _quote(value):
    return value.replace('\\', '\\\\').replace('"', '\\"')


def _best(candidates, directories):
    """Prefer the standard application folders, then the shortest path."""
    def rank(app):
        return (0 if app.parent in directories else 1, len(str(app)), str(app))
    return sorted(candidates, key=rank)


def find_by_id(identifier, directories):
    """Where the app with this bundle id is installed, or None."""
    standard = [Path(d) / entry for d in directories if Path(d).is_dir()
                for entry in sorted(os.listdir(d)) if entry.endswith('.app')]
    candidates = [app for app in standard if (bundle_info(app) or ('',))[0] == identifier]
    if not candidates:
        candidates = [app for app in _mdfind(f'kMDItemCFBundleIdentifier == "{_quote(identifier)}"')
                      if (bundle_info(app) or ('',))[0] == identifier]
    return _best(candidates, directories)[0] if candidates else None


def display_name(identifier, directories):
    app = find_by_id(identifier, directories)
    info = bundle_info(app) if app else None
    return info[1] if info else None


def resolve(query, *, home=None):
    """(bundle id, display name, installed) for an app name, a bundle id or an .app path."""
    directories = app_directories(home)
    path = Path(query).expanduser()
    if query.endswith('.app') or query.endswith('.app/') or '/' in query:
        if not path.is_dir():
            raise AppsError(f'{query} is not an application bundle.')
        info = bundle_info(path)
        if not info:
            raise AppsError(f'{query} has no bundle identifier in Contents/Info.plist.')
        return info[0], info[1], True
    wanted = query.casefold()
    matches = {}
    for directory in directories:
        if not directory.is_dir():
            continue
        for entry in sorted(os.listdir(directory)):
            if not entry.endswith('.app'):
                continue
            app = directory / entry
            info = bundle_info(app)
            if info and (wanted in (entry[:-4].casefold(), info[1].casefold())):
                matches.setdefault(info[0], (info[1], app))
    if not matches:
        found = [app for app in _mdfind(f'kMDItemKind == "Application" && kMDItemDisplayName == "{_quote(query)}"c')]
        for app in found:
            info = bundle_info(app)
            if info:
                matches.setdefault(info[0], (info[1], app))
    if not matches and '.' in query:
        app = find_by_id(query, directories)
        info = bundle_info(app) if app else None
        if info:
            return info[0], info[1], True
        return query, query, False
    if not matches:
        raise AppsError(f'no installed app named "{query}". Pass its bundle identifier or the path to its .app.')
    if len(matches) > 1:
        options = ', '.join(f'{identifier} ({app})' for identifier, (_, app) in sorted(matches.items()))
        raise AppsError(f'"{query}" matches several apps: {options}. Pass the bundle identifier or path.')
    identifier, (name, _) = next(iter(matches.items()))
    return identifier, name, True


def resolve_approved(query, ids, *, home=None):
    """Like resolve, but a name or id that matches an approved entry wins, even if uninstalled."""
    if query in ids:
        return query, display_name(query, app_directories(home)) or query
    directories = app_directories(home)
    wanted = query.casefold()
    named = [i for i in ids if (display_name(i, directories) or '').casefold() == wanted]
    if len(named) == 1:
        return named[0], display_name(named[0], directories)
    try:
        identifier, name, _ = resolve(query, home=home)
    except AppsError:
        if named:
            raise AppsError(f'"{query}" matches several approved apps: {", ".join(named)}.') from None
        raise AppsError(f'"{query}" is not among the approved apps. Run `lcu apps` to see them.') from None
    return identifier, name


# Authentication --------------------------------------------------------------------------------

def authenticate(root, reason):
    """Ask macOS for Touch ID or the login password. Raises AppsError unless the owner approved."""
    helper = Path(root) / HELPER
    if not helper.is_file() or not os.access(helper, os.X_OK):
        raise AppsError(f'the owner-authentication helper is missing ({helper}); reinstall this LCU release. '
                        'Nothing was changed.')
    print('Waiting for Touch ID or your password...', file=sys.stderr)
    try:
        done = subprocess.run([str(helper), '--reason', reason], stdin=subprocess.DEVNULL,
                              stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
                              timeout=AUTH_TIMEOUT)
    except (OSError, subprocess.SubprocessError) as exc:
        raise AppsError(f'could not run the owner-authentication helper: {exc}. Nothing was changed.') from None
    if done.returncode == 0:
        return
    if done.returncode == 1:
        raise AppsError('authentication was cancelled or failed. Nothing was changed.')
    detail = done.stderr.strip() or f'exit status {done.returncode}'
    raise AppsError(f'cannot ask for authentication: {detail}. Run this from a terminal in your '
                    'logged-in desktop session. Nothing was changed.')


# Commands --------------------------------------------------------------------------------------

def describe(identifier, directories):
    name = display_name(identifier, directories)
    return {'name': name or identifier, 'bundleId': identifier, 'installed': name is not None,
            'risk': 'high' if identifier in HIGH_RISK else 'normal',
            'blocked': identifier in FORBIDDEN}


def command_list(args, *, home, **_):
    path = store_path(home)
    _, _, ids = read_store(path)
    directories = app_directories(home)
    apps = sorted((describe(i, directories) for i in ids), key=lambda a: (a['name'].casefold(), a['bundleId']))
    if args.json:
        print(json.dumps({'apps': apps, 'file': str(path)}, indent=2))
        return 0
    if not apps:
        print('No apps are always allowed for Computer Use.\nAllow one with: lcu apps allow <app>')
        return 0
    width = max(len(a['name']) for a in apps)
    for app in apps:
        notes = []
        if app['risk'] == 'high':
            notes.append('high risk')
        if app['blocked']:
            notes.append('blocked: Computer Use refuses this app')
        if not app['installed']:
            notes.append('not installed')
        suffix = f'  ({"; ".join(notes)})' if notes else ''
        print(f'{app["name"].ljust(width)}  {app["bundleId"]}{suffix}')
    return 0


def command_allow(args, *, root, home, auth, **_):
    path = store_path(home)
    identifier, name, installed = resolve(args.app, home=home)
    label = f'{name} ({identifier})'
    if identifier in FORBIDDEN:
        raise AppsError(f'Computer Use never controls {FORBIDDEN[identifier]} ({identifier}), '
                        'so approving it would have no effect. Nothing was changed.')
    if not installed:
        raise AppsError(f'{identifier} is not installed here; Computer Use would reject it as an invalid app.')
    if identifier in read_store(path)[2]:
        print(f'{label} is already always allowed.')
        return 0
    risky = identifier in HIGH_RISK
    if risky:
        print(f'Warning: {RISK_NOTE}', file=sys.stderr)
    auth(root, ('always allow Computer Use to control ' + label +
                (' (high risk)' if risky else '')))
    def add(ids):
        return ids if identifier in ids else ids + [identifier]
    modify(path, add)
    print(f'Always allowed: {label}. Running sessions pick this up immediately.')
    return 0


def command_revoke(args, *, root, home, auth, **_):
    path = store_path(home)
    ids = read_store(path)[2]
    identifier, name = resolve_approved(args.app, ids, home=home)
    label = f'{name} ({identifier})' if name != identifier else identifier
    if identifier not in ids:
        print(f'{label} is not in the always-allowed list.')
        return 0
    auth(root, 'stop always allowing Computer Use to control ' + label)
    modify(path, lambda current: [item for item in current if item != identifier])
    print(f'Removed: {label}. Computer Use asks again the next time it needs this app.')
    return 0


USAGE = ('lcu apps [list] [--json]\n'
         '       lcu apps allow <app>\n'
         '       lcu apps revoke <app>')


def parser():
    top = argparse.ArgumentParser(
        prog='lcu apps', usage=USAGE, formatter_class=argparse.RawDescriptionHelpFormatter,
        description='Manage the apps Computer Use may always control, without the Codex app.',
        epilog='<app> is an app name ("Zed"), a bundle identifier (dev.zed.Zed) or the path to an .app.\n'
               'allow and revoke ask for Touch ID or your login password; list does not.')
    sub = top.add_subparsers(dest='action')
    listing = sub.add_parser('list', usage='lcu apps list [--json]', help='show the always-allowed apps')
    listing.add_argument('--json', action='store_true', help='print JSON instead of a table')
    for name, summary in (('allow', 'always allow an app (asks for Touch ID or your password)'),
                          ('revoke', 'remove an app (asks for Touch ID or your password)')):
        command = sub.add_parser(name, usage=f'lcu apps {name} <app>', help=summary)
        command.add_argument('app', help='app name, bundle identifier or .app path')
    return top


def main(root, argv, *, platform=None, home=None, auth=authenticate):
    platform = platform or sys.platform
    if platform.startswith('linux'):
        print('lcu apps is macOS-only. The Linux computer-use runtime has no per-app approval: '
              'your harness\'s own tool approval is the only gate, so there is no list to manage. '
              'See docs/ADAPTERS.md.', file=sys.stderr)
        raise SystemExit(1)
    if platform != 'darwin':
        print('lcu apps is not supported on Windows.', file=sys.stderr)
        raise SystemExit(1)
    arguments = list(argv)
    if not arguments or arguments[0].startswith('-') and arguments[0] not in ('-h', '--help'):
        arguments.insert(0, 'list')
    args = parser().parse_args(arguments)
    handler = {'list': command_list, 'allow': command_allow, 'revoke': command_revoke}[args.action or 'list']
    if args.action is None:
        args.json = False
    try:
        status = handler(args, root=root, home=home, auth=auth)
    except AppsError as exc:
        print(f'lcu apps: {exc}', file=sys.stderr)
        raise SystemExit(1) from None
    if status:
        raise SystemExit(status)
