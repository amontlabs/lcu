"""Find out whether a newer LCU release exists, cache the answer and tell the agent."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

REPO = 'amontlabs/lcu'
LATEST_URL = f'https://github.com/{REPO}/releases/latest'
RELEASE_URL = f'https://github.com/{REPO}/releases/tag/'
NOTES_URL = f'https://raw.githubusercontent.com/{REPO}/%s/docs/releases/%s.md'
INTERVAL = 600
RETRY = 3600
STAMP_TTL = 120
STAMP_SKEW = 2  # Windows file times can run ahead of time.time()
ANNOUNCE_TTL = 7 * 24 * 3600
ANNOUNCE_COOLDOWN = 24 * 3600
ANNOUNCE_ACCOUNT = '*'
TIMEOUT = 5
SEVERITIES = ('security', 'breaking')


def parse_version(text):
    """Dotted integers as a tuple, or None when unparsable."""
    try:
        return tuple(int(part) for part in str(text).strip().lstrip('v').split('.')) if str(text).strip() else None
    except ValueError:
        return None


def installed_version(root):
    """The release version, or None for a source checkout or unreadable bundle."""
    try:
        return json.loads((Path(root) / 'bundle.json').read_text())['version']
    except (OSError, ValueError, KeyError, TypeError):
        return None


def enabled(root, env=None):
    """False for source checkouts and when LCU_NO_UPDATE_CHECK is set."""
    env = os.environ if env is None else env
    if env.get('LCU_NO_UPDATE_CHECK', '').strip() not in ('', '0'):
        return False
    return parse_version(installed_version(root)) is not None


def cache_path():
    """Per-account cache file; the install prefix may be root-owned."""
    home = Path.home()
    if sys.platform == 'win32':
        base = Path(os.environ.get('LOCALAPPDATA') or home / 'AppData/Local') / 'LCU/cache'
    elif sys.platform == 'darwin':
        base = home / 'Library/Caches/lcu'
    else:
        base = Path(os.environ.get('XDG_CACHE_HOME') or home / '.cache') / 'lcu'
    return base / 'update.json'


def read_cache():
    try:
        data = json.loads(cache_path().read_text())
        return data if isinstance(data, dict) and isinstance(data.get('checked_at'), (int, float)) else None
    except (OSError, ValueError):
        return None


def write_cache(latest, error):
    """Atomic write; failures are ignored (the cache is only a courtesy)."""
    path = cache_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(dir=path.parent, prefix='.update-')
        with os.fdopen(fd, 'w') as handle:
            json.dump({'checked_at': time.time(), 'latest': latest, 'error': error}, handle)
        os.replace(name, path)
    except OSError:
        pass


def stale(cache, now=None):
    now = time.time() if now is None else now
    if cache is None:
        return True
    age = now - cache['checked_at']
    return age < 0 or age >= (RETRY if cache.get('error') else INTERVAL)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def _open(request):
    return urllib.request.build_opener(_NoRedirect).open(request, timeout=TIMEOUT)


def cert_failure(exc):
    """True when Python has no usable CA store (python.org builds on macOS ship without one)."""
    return isinstance(getattr(exc, 'reason', exc), ssl.SSLCertVerificationError)


def curl(args, timeout=TIMEOUT):
    """Run the system curl, which uses the system trust store; returns stdout bytes."""
    command = shutil.which('curl')
    if command is None:
        raise OSError('Python cannot verify HTTPS certificates and curl is not installed.')
    result = subprocess.run([command, '-fsS', '--proto', '=https', '--max-time', str(timeout), *args],
                            stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout + 5)
    if result.returncode:
        raise OSError(result.stderr.decode('utf-8', 'replace').strip() or f'curl exited {result.returncode}')
    return result.stdout


def latest_tag():
    """The latest release tag, from the redirect of /releases/latest (no API, no rate limit)."""
    request = urllib.request.Request(LATEST_URL, method='HEAD', headers={'User-Agent': 'lcu-update'})
    try:
        response = _open(request)
        location = response.headers.get('Location')
    except urllib.error.HTTPError as exc:
        location = exc.headers.get('Location') if exc.code in (301, 302, 303, 307, 308) else None
        if location is None:
            raise
    except urllib.error.URLError as exc:
        if not cert_failure(exc):
            raise
        location = curl(['-I', '-o', os.devnull, '-w', '%{redirect_url}', LATEST_URL]).decode().strip()
    match = re.search(r'/releases/tag/([^/?#]+)$', location or '')
    if not match:
        raise ValueError('Unexpected response while looking for the latest LCU release.')
    return match.group(1)


def severity_of(tag, version):
    """`security` or `breaking` from the release notes marker; anything else is `normal`."""
    url = NOTES_URL % (tag, version)
    try:
        try:
            with _open(urllib.request.Request(url, headers={'User-Agent': 'lcu-update'})) as response:
                text = response.read(262144).decode('utf-8', 'replace')
        except urllib.error.URLError as exc:
            if not cert_failure(exc):
                raise
            text = curl([url]).decode('utf-8', 'replace')
    except (OSError, ValueError, subprocess.SubprocessError):
        return 'normal'
    # Only a marker on its own line counts, so notes that mention the syntax inline are not flagged.
    match = re.search(r'^[ \t]*<!--\s*lcu-severity:\s*(\w+)\s*-->[ \t]*$', text, re.MULTILINE)
    return match.group(1) if match and match.group(1) in SEVERITIES else 'normal'


def fetch_latest():
    """Release info dict for the newest release; raises OSError/ValueError on failure."""
    tag = latest_tag()
    version = tag[1:] if tag[:1] == 'v' else tag
    if parse_version(version) is None:
        raise ValueError(f'Unrecognized release tag: {tag}')
    return {'version': version, 'tag': tag, 'release_url': RELEASE_URL + tag,
            'severity': severity_of(tag, version)}


def check(root):
    """Network check now; updates the cache. Returns (info or None, error or None)."""
    try:
        info = fetch_latest()
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        error = str(exc) or type(exc).__name__
        # Keep the last known release so a flaky network does not hide a pending update.
        previous = read_cache()
        write_cache(previous.get('latest') if previous else None, error)
        return None, error
    write_cache(info, None)
    return info, None


def newer(root, info):
    current, latest = parse_version(installed_version(root)), parse_version((info or {}).get('version'))
    return bool(current and latest and latest > current)


def stable_command(root):
    """The stable `lcu` path of this installation (`current` on POSIX, `<prefix>\\lcu.cmd` on Windows)."""
    root = Path(root)
    if sys.platform == 'win32' and root.parent.name == 'releases':
        return root.parent.parent / 'lcu.cmd'
    from .claude_mod import lcu_command
    return lcu_command(root)


def refresh_claimed(now=None):
    """True when this caller should spawn a refresh (touches refresh.stamp); never raises."""
    try:
        stamp = cache_path().with_name('refresh.stamp')
        now = time.time() if now is None else now
        try:
            if -STAMP_SKEW <= now - stamp.stat().st_mtime < STAMP_TTL:
                return False
        except OSError:
            pass
        stamp.parent.mkdir(parents=True, exist_ok=True)
        stamp.touch()
        return True
    except Exception:
        return True


def spawn_refresh(root):
    """Start a detached `lcu update --refresh`; never waits."""
    options = {'stdin': subprocess.DEVNULL, 'stdout': subprocess.DEVNULL, 'stderr': subprocess.DEVNULL}
    if sys.platform == 'win32':
        options['creationflags'] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        options['start_new_session'] = True
    subprocess.Popen([sys.executable, str(Path(root) / 'bin/lcu'), 'update', '--refresh'], **options)


def message(root, info, current):
    prefix = {'security': 'Security update: ', 'breaking': 'Breaking update: '}.get(info.get('severity'), '')
    return (f"{prefix}LCU {info['version']} is available (installed: {current}). Tell the user and offer to run "
            f"`{stable_command(root)} update`; do not upgrade without asking. Agents using LCU must be "
            f"restarted afterwards. Release notes: {info['release_url']}")


def notice(root):
    """The cached update notice dict, or None. Never blocks on the network and never raises."""
    try:
        if not enabled(root):
            return None
        if stale(read_cache()):
            try:
                if refresh_claimed():
                    spawn_refresh(root)
            except Exception:
                pass
        return notice_cached(root)
    except Exception:
        return None


def hook_session_id():
    """session_id from the hook input JSON on stdin (the harness closes it), or None."""
    try:
        if sys.stdin is None or sys.stdin.isatty():
            return None
        data = json.loads(sys.stdin.read(1 << 20))
        value = data.get('session_id') if isinstance(data, dict) else None
        return value if isinstance(value, str) and value else None
    except Exception:
        return None


def announce(session_id, version, now=None):
    """True when an agent session should be told about `version` now; records it. Never raises.

    A release is announced at most once per ANNOUNCE_COOLDOWN across every session on the account (the `*`
    entry of `announced.json`, beside the per-session entries), whatever its severity; a session is never told
    twice about the same release, and a different release is announced at once. A session that was not told
    during the cooldown may be told at its next prompt after it. Without a session id only the account-wide
    cooldown applies.
    """
    try:
        now = time.time() if now is None else now
        path = cache_path().with_name('announced.json')
        try:
            data = json.loads(path.read_text())
            data = data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            data = {}
        data = {k: v for k, v in data.items() if isinstance(v, dict) and isinstance(v.get('at'), (int, float))
                and 0 <= now - v['at'] < ANNOUNCE_TTL}
        if session_id and data.get(session_id, {}).get('version') == version:
            return False
        last = data.get(ANNOUNCE_ACCOUNT, {})
        if last.get('version') == version and now - last['at'] < ANNOUNCE_COOLDOWN:
            return False
        data[ANNOUNCE_ACCOUNT] = {'version': version, 'at': now}
        if session_id:
            data[session_id] = {'version': version, 'at': now}
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            fd, name = tempfile.mkstemp(dir=path.parent, prefix='.announced-')
            with os.fdopen(fd, 'w') as handle:
                json.dump(data, handle)
            os.replace(name, path)
        except OSError:
            pass
        return True
    except Exception:
        return True


def cached_notice(root):
    """The notice from the cache only (no refresh), or None; never raises."""
    try:
        return notice_cached(root) if enabled(root) else None
    except Exception:
        return None


def status_line(root):
    """One human line for status/doctor from the cache only, or None."""
    try:
        found = cached_notice(root)
        return None if found is None else (
            f"LCU {found['latest']} is available (installed {found['current']}): {found['release_url']}. "
            f"Run `{found['command']} update` to upgrade.")
    except Exception:
        return None


def notice_cached(root):
    """Like `notice` without starting a refresh."""
    cache = read_cache()
    info = cache.get('latest') if cache else None
    if not isinstance(info, dict) or not newer(root, info):
        return None
    current = installed_version(root)
    severity = info.get('severity') if info.get('severity') in SEVERITIES else 'normal'
    return {'current': current, 'latest': info['version'], 'severity': severity,
            'release_url': info['release_url'], 'command': str(stable_command(root)),
            'message': message(root, {**info, 'severity': severity}, current)}


def codex_needs_setup(home=None, env=None):
    """True when Codex has LCU registered but not the update-notice hook (added by `lcu setup --agent codex`)."""
    import tomllib
    from .codex_hooks import is_notice_group
    env = os.environ if env is None else env
    config = Path(env.get('CODEX_HOME') or Path(home or Path.home()) / '.codex') / 'config.toml'
    try:
        data = tomllib.loads(config.read_text())
    except (OSError, ValueError):
        return False
    if 'lcu' not in (data.get('mcp_servers') or {}):
        return False
    hooks = data.get('hooks') or {}
    return not all(any(is_notice_group(group) for group in hooks.get(event) or [] if isinstance(group, dict))
                   for event in ('SessionStart', 'UserPromptSubmit'))


def refresh_chrome_relay(root):
    """Refresh the Chrome relay `lcu browser install` set up earlier; never enables Chrome, never fails the update."""
    from . import browser
    command = f'{stable_command(root)} browser install'
    try:
        state, destination, displaced = browser.refresh(root)
        if state == 'absent':
            return
        if state == 'elsewhere':
            print(f'Chrome: the native-host manifest no longer points at the LCU relay, so it was left alone. '
                  f'To use Chrome through LCU again, run `{command}`.')
        elif state == 'root':
            print(f'Chrome: the relay was not refreshed because the update ran as root. As the desktop account, run `{command}`.')
        else:
            print(f'Refreshed the Chrome relay at {destination}.')
            if state == 'changed':
                print('If the extension was already connected, restart Chrome or turn the ChatGPT extension off and on '
                      "so it reconnects through LCU's relay.")
            if displaced:
                print('Chrome: a native-host manifest points somewhere other than the LCU relay and was left alone '
                      f'({displaced[0]}). To use Chrome through LCU again, run `{command}`.')
    except Exception as exc:
        print(f'lcu update: could not refresh the Chrome relay ({exc}); run `{command}`.', file=sys.stderr)


def post_install(root, home=None):
    """Refresh what setup copied out of an earlier release; `lcu update` runs it from the new release."""
    from . import claude_mod
    home = Path(home or Path.home())
    target = claude_mod.destination(home)
    if target.is_dir() and claude_mod._owned(target):
        claude_mod.install(home, root)
        print(f'Refreshed the Claude Code lcu-approve mod at {target}.')
    refresh_chrome_relay(root)
    if codex_needs_setup(home):
        print(f'Codex: run `{stable_command(root)} setup --agent codex` to add the LCU update-notice hook.')
    return 0


def main(root, argv=None):
    parser = argparse.ArgumentParser(prog='lcu update', description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--check', action='store_true', help='Check now without installing')
    mode.add_argument('--notice', action='store_true', help='Print the cached update notice for an agent (never uses the network)')
    mode.add_argument('--refresh', action='store_true', help=argparse.SUPPRESS)
    mode.add_argument('--post-install', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--json', action='store_true', help='Print JSON (with --check or --notice)')
    parser.add_argument('--hook', choices=('SessionStart', 'UserPromptSubmit'), help=argparse.SUPPRESS)
    parser.add_argument('--announce', nargs='?', const='', metavar='SESSION_ID', help=argparse.SUPPRESS)
    parser.add_argument('--yes', action='store_true', help='Do not ask before installing')
    args = parser.parse_args(argv)
    root = Path(root)
    if args.notice:
        try:
            found = notice(root)
            if args.hook:
                # A hook's documented way to add model context: once per session and release, and at most once
                # a day per release across the account, else silent.
                if found:
                    session = hook_session_id()
                    if (session or args.hook == 'SessionStart') and announce(session, found['latest']):
                        print(json.dumps({'hookSpecificOutput': {'hookEventName': args.hook,
                                                                 'additionalContext': found['message']}}))
            else:
                if found and args.announce is not None and not announce(args.announce or None, found['latest']):
                    # An agent integration (the Claude Code mod) under the same cooldown as the hooks.
                    found = None
                print(json.dumps(found or {}) if args.json else (found['message'] if found else ''),
                      end='\n' if args.json or found else '')
        except Exception:
            pass
        return 0
    if args.post_install:
        return post_install(root)
    if args.refresh:
        try:
            if enabled(root):
                check(root)
        except Exception:
            pass
        return 0
    current = installed_version(root)
    if parse_version(current) is None:
        raise ValueError('lcu update needs an installed LCU release, not a source checkout.')
    info, error = check(root)
    available = newer(root, info)
    if args.check:
        if args.json:
            print(json.dumps({'current': current, 'latest': info, 'update_available': available, 'error': error}))
        elif error:
            print(f'lcu update: could not check for updates: {error}', file=sys.stderr)
        elif available:
            print(f"LCU {info['version']} is available (installed {current}): {info['release_url']}\n"
                  f"Run {stable_command(root)} update to upgrade.")
        else:
            print(f'LCU {current} is up to date.')
        return 1 if error else 0
    if error:
        print(f'lcu update: could not check for updates: {error}', file=sys.stderr)
        return 1
    if not available:
        print(f'LCU {current} is up to date.')
        return 0
    from .update_apply import apply
    return apply(root, info, yes=args.yes)
