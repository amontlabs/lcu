"""`lcu origins`: show and forget the Chrome site decisions the original runtime saves per session.

When a user answers "Allow Browser use to access <origin>?", the original browser service keeps the
answer for that harness session in `$CODEX_HOME/browser/sessions/<session-id>.toml` as
`[origins] allowed = [...] / denied = [...]` and checks it before it asks again. That format is the
original runtime's private storage, not an interface. This module only reads it and removes
entries; it never adds one, so granting access stays with the original prompt. It does not touch
`browser/config.toml` or `browser_use.origins` in `config.toml`.
"""
import argparse
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import tomllib
from urllib.parse import urlsplit

from .runtime import default_codex_home

KINDS = ('allowed', 'denied')
SESSION_ID = re.compile(r'[A-Za-z0-9_-]{1,128}')  # the original runtime's own rule for a session id
WRITE_ATTEMPTS = 5
CACHE_NOTE = ('A running agent may keep its saved decisions in memory for up to 5 minutes. Restart the '
              'agent, or wait, and the next request for the site asks again.')
_DEFAULT_PORTS = {'http': 80, 'https': 443}
_HOST = re.compile(r'[a-z0-9._-]+|[0-9a-f:.]+')
_BARE_KEY = re.compile(r'[A-Za-z0-9_-]+')
_STRING = re.compile(r'"(?:[^"\\\n]|\\.)*"|\'[^\'\n]*\'')


class OriginsError(ValueError):
    """A problem to show the user without a traceback."""


class UnsupportedShape(OriginsError):
    """A session file LCU can read but will not rewrite."""


# Locations -------------------------------------------------------------------------------------

def codex_home(env=None, *, windows=None):
    """CODEX_HOME exactly as the launched runtime sees it (see runtime.environment)."""
    env = os.environ if env is None else env
    windows = sys.platform == 'win32' if windows is None else windows
    if 'CODEX_HOME' not in env:
        return Path(default_codex_home(env, windows))
    value = env['CODEX_HOME']
    if not value:
        raise OriginsError('CODEX_HOME is set but empty; unset it or set an absolute path.')
    path = Path(value)
    if not path.is_absolute():
        raise OriginsError(f'CODEX_HOME must be an absolute path, not {value!r}.')
    return path


def sessions_directory(home):
    return Path(home) / 'browser' / 'sessions'


def check_session_id(value):
    if not SESSION_ID.fullmatch(value):
        raise OriginsError(f'{value!r} is not a session id (1 to 128 letters, digits, "_" or "-").')
    return value


def session_files(directory, session=None):
    """[(session id, path)] of the saved session files; one of them when `session` is given."""
    directory = Path(directory)
    if session is not None:
        path = directory / f'{check_session_id(session)}.toml'
        if not path.is_file():
            raise OriginsError(f'no saved site decisions for session {session} ({path} does not exist).')
        return [(session, path)]
    if not directory.is_dir():
        return []
    found = []
    for path in sorted(directory.glob('*.toml')):
        if SESSION_ID.fullmatch(path.stem) and path.is_file():
            found.append((path.stem, path))
    return found


# Origins ---------------------------------------------------------------------------------------

def normalize_origin(value):
    """`scheme://host[:port]` in the form a browser reports it: lowercase, default port dropped."""
    text = value.strip()
    hint = f'{value!r} is not an origin; pass scheme://host[:port], for example https://example.com.'
    try:
        parts = urlsplit(text)
        port = parts.port
    except ValueError:
        raise OriginsError(hint) from None
    scheme = parts.scheme.lower()
    host = (parts.hostname or '').lower()
    if (scheme not in _DEFAULT_PORTS or not host or '@' in parts.netloc or parts.path not in ('', '/')
            or parts.query or parts.fragment or '?' in text or '#' in text):
        raise OriginsError(hint)
    try:
        host = host.encode('ascii').decode() if host.isascii() else host.encode('idna').decode('ascii')
    except UnicodeError:
        raise OriginsError(hint) from None
    if not _HOST.fullmatch(host) or (port is not None and not 0 < port < 65536):
        raise OriginsError(hint)
    result = f'{scheme}://' + (f'[{host}]' if ':' in host else host)
    if port is not None and port != _DEFAULT_PORTS[scheme]:
        result += f':{port}'
    return result


def _same_origin(stored, origin):
    if stored == origin:
        return True
    try:
        return normalize_origin(stored) == origin
    except OriginsError:
        return False


# Session files ---------------------------------------------------------------------------------

def parse(raw, path):
    """(document, {kind: [origins]}) of a session file, or OriginsError when it is not usable."""
    try:
        document = tomllib.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
        raise OriginsError(f'{path} is not valid TOML ({exc}); leaving it untouched.') from None
    table = document.get('origins', {})
    if not isinstance(table, dict):
        raise OriginsError(f'{path} has an "origins" entry that is not a table; leaving it untouched.')
    origins = {}
    for kind in KINDS:
        entries = table.get(kind, [])
        if not isinstance(entries, list) or not all(isinstance(item, str) for item in entries):
            raise OriginsError(f'{path}: origins.{kind} is not a list of strings; leaving it untouched.')
        origins[kind] = entries
    return document, origins


def read(path):
    path = Path(path)
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise OriginsError(f'cannot read {path}: {exc.strerror or exc}') from None
    return raw, *parse(raw, path)


def _quote(text):
    return json.dumps(text, ensure_ascii=False).replace('\x7f', '\\u007f')


def _key(name):
    return name if _BARE_KEY.fullmatch(name) else _quote(name)


def _value(value, where):
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        return _quote(value)
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return '[' + ', '.join(_quote(item) for item in value) + ']'
    raise UnsupportedShape(f'{where} holds a value LCU does not rewrite ({type(value).__name__}); '
                          'leaving it untouched.')


def render(document, path='the file'):
    """Serialize tables of strings, booleans, integers and string lists; refuse anything else."""
    lines = [f'{_key(key)} = {_value(value, path)}' for key, value in document.items()
             if not isinstance(value, dict)]
    for key, table in document.items():
        if isinstance(table, dict):
            lines += ['', f'[{_key(key)}]'] if lines else [f'[{_key(key)}]']
            lines += [f'{_key(name)} = {_value(value, f"{path}: [{key}] {name}")}'
                      for name, value in table.items()]
    return '\n'.join(lines) + '\n'


def rewritable_text(raw, document, path):
    """The text to write for `document`, or UnsupportedShape when rewriting could lose something."""
    text = raw.decode('utf-8')
    if '"""' in text or "'''" in text or '#' in _STRING.sub('', text):
        raise UnsupportedShape(f'{path} has comments or multi-line strings, which LCU cannot rewrite '
                               'without losing them; leaving it untouched.')
    rendered = render(document, path)
    if tomllib.loads(rendered) != document:
        raise UnsupportedShape(f'{path} has a structure LCU cannot rewrite faithfully; leaving it untouched.')
    return rendered


def write_atomically(path, text, mode):
    """Write `text` next to `path` and return the temporary file's path, ready for os.replace."""
    descriptor, temporary = tempfile.mkstemp(prefix=f'.{path.name}.', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            os.chmod(temporary, mode)
        except OSError:
            pass
        return temporary
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def forget_in(path, origin, kinds, *, attempts=WRITE_ATTEMPTS):
    """Remove `origin` from the given lists of one session file. Returns {kind: count removed}.

    The original runtime does not share a lock with LCU, so the file is read again just before the
    replace and the change is recomputed if the runtime wrote in between.
    """
    path = Path(path)
    for _ in range(attempts):
        if path.is_symlink():
            raise OriginsError(f'{path} is a symbolic link; leaving it untouched.')
        raw, document, origins = read(path)
        removed = {}
        for kind in kinds:
            kept = [entry for entry in origins[kind] if not _same_origin(entry, origin)]
            if len(kept) != len(origins[kind]):
                removed[kind] = len(origins[kind]) - len(kept)
                document['origins'][kind] = kept
        if not removed:
            return {}
        text = rewritable_text(raw, document, path)
        temporary = write_atomically(path, text, path.stat().st_mode & 0o777)
        try:
            if path.read_bytes() != raw:
                continue
            try:
                os.replace(temporary, path)
            except OSError as exc:
                raise OriginsError(f'cannot replace {path}: {exc.strerror or exc}') from None
        finally:
            Path(temporary).unlink(missing_ok=True)
        return removed
    raise OriginsError(f'{path} kept changing while it was being updated; try again.')


# Commands --------------------------------------------------------------------------------------

def command_list(args, *, home):
    directory = sessions_directory(home)
    sessions, problems = [], []
    for session, path in session_files(directory, args.session):
        try:
            _, _, origins = read(path)
        except OriginsError as exc:
            if args.session:
                raise
            problems.append({'session': session, 'file': str(path), 'error': str(exc)})
            continue
        sessions.append({'session': session, 'file': str(path), **origins})
    if args.json:
        print(json.dumps({'codexHome': str(home), 'sessions': sessions, 'problems': problems}, indent=2))
        return 0
    for problem in problems:
        print(f'lcu origins: skipped {problem["file"]}: {problem["error"]}', file=sys.stderr)
    shown = [entry for entry in sessions if entry['allowed'] or entry['denied']]
    if not shown:
        print(f'No saved Chrome site decisions in {directory}.')
        return 0
    for entry in shown:
        print(f'session {entry["session"]}')
        for kind in KINDS:
            for origin in entry[kind]:
                print(f'  {kind:<7} {origin}')
    return 0


def command_forget(args, *, home):
    origin = normalize_origin(args.origin)
    kinds = tuple(kind for kind in KINDS if getattr(args, kind)) or ('denied',)
    directory = sessions_directory(home)
    files = session_files(directory, args.session)
    if not files:
        print(f'No saved Chrome site decisions in {directory}; nothing changed.')
        return 0
    changed, problems = 0, []
    for session, path in files:
        try:
            removed = forget_in(path, origin, kinds)
        except OriginsError as exc:
            if args.session:
                raise
            problems.append(str(exc))
            continue
        for kind, count in removed.items():
            print(f'Removed {origin} from {kind} in session {session}.' if count == 1 else
                  f'Removed {count} entries for {origin} from {kind} in session {session}.')
        changed += bool(removed)
    for problem in problems:
        print(f'lcu origins: skipped: {problem}', file=sys.stderr)
    if changed:
        print(CACHE_NOTE)
    else:
        print(f'{origin} is not in the saved {" or ".join(kinds)} list of '
              f'{"session " + args.session if args.session else str(len(files)) + " saved session(s)"}; '
              'nothing changed.')
    return 1 if problems else 0


USAGE = ('lcu origins [list] [--session ID] [--json]\n'
         '       lcu origins forget ORIGIN [--session ID | --all-sessions] [--allowed | --denied]')


def parser():
    top = argparse.ArgumentParser(
        prog='lcu origins', usage=USAGE, formatter_class=argparse.RawDescriptionHelpFormatter,
        description='Show and forget the Chrome site decisions the original runtime saved for each '
                    'agent session.',
        epilog='forget removes a saved answer so the next request for that site asks again. It never '
               'allows a site: only the original prompt can.\n'
               'By default it removes the origin from the denied list of every saved session; '
               '--allowed removes it from the allowed list instead (both flags: both lists).\n' + CACHE_NOTE)
    sub = top.add_subparsers(dest='action')
    listing = sub.add_parser('list', usage='lcu origins list [--session ID] [--json]',
                             help='show the saved allowed and denied origins per session')
    listing.add_argument('--session', metavar='ID', help='show only this session')
    listing.add_argument('--json', action='store_true', help='print JSON instead of text')
    forget = sub.add_parser(
        'forget', usage='lcu origins forget ORIGIN [--session ID | --all-sessions] [--allowed | --denied]',
        help='remove a saved decision so the site is asked about again')
    forget.add_argument('origin', help='scheme://host[:port], for example https://example.com')
    scope = forget.add_mutually_exclusive_group()
    scope.add_argument('--session', metavar='ID', help='only this session (default: every saved session)')
    scope.add_argument('--all-sessions', action='store_true', help='every saved session (the default)')
    forget.add_argument('--allowed', action='store_true', help='remove from the allowed list')
    forget.add_argument('--denied', action='store_true', help='remove from the denied list (the default)')
    return top


def main(argv, *, env=None, windows=None):
    arguments = list(argv)
    if not arguments or arguments[0].startswith('-') and arguments[0] not in ('-h', '--help'):
        arguments.insert(0, 'list')
    args = parser().parse_args(arguments)
    try:
        home = codex_home(env, windows=windows)
        handler = {'list': command_list, 'forget': command_forget}[args.action]
        status = handler(args, home=home)
    except OriginsError as exc:
        print(f'lcu origins: {exc}', file=sys.stderr)
        raise SystemExit(1) from None
    if status:
        raise SystemExit(status)
