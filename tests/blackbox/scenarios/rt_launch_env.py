"""bin/lcu: the environment the child receives, flag combinations, invocation forms and working directories."""
import base64
import json
import os

import fixtures_rt as rt
from fixtures_rt import place, rt_scenario
from scenarios.rt_launch import INITIALIZE, STATUSES, _launch

DISCOVER = INITIALIZE.replace('initialize', 'server/discover')


def _env_run(sb, ctx, label, env, *args, **spec):
    return _launch(sb, ctx, label, *args, env=env, probe={'env': True, **spec.pop('probe', {})}, **spec)


@rt_scenario('rt/launch/env-home', normalise=STATUSES)
def _(sb):
    # CODEX_HOME / HOME handling: Node path.join/normpath quirks, empty and relative values.
    ctx = place(sb, 'linux')
    for label, env in (
        ('HOME with trailing slash', {'HOME': '/h/ome/'}),
        ('HOME with double leading slash', {'HOME': '//double/home'}),
        ('HOME with triple leading slash', {'HOME': '///triple/home'}),
        ('HOME with dot segments', {'HOME': '/a/./b/../c'}),
        ('HOME relative', {'HOME': 'rel/home'}),
        ('HOME empty', {'HOME': ''}),
        ('HOME non-ASCII', {'HOME': '/h/ôme/日本語'}),
        ('USERPROFILE is ignored on Linux', {'USERPROFILE': '/profile', 'HOME': '/h/ome'}),
        ('CODEX_HOME set', {'CODEX_HOME': '/custom/codex'}),
        ('CODEX_HOME relative', {'CODEX_HOME': 'relative/codex'}),
        ('CODEX_HOME empty (explicit, kept)', {'CODEX_HOME': ''}),
        ('CODEX_HOME with trailing slash and dots', {'CODEX_HOME': '/c//odex/./x/'}),
        ('CODEX_HOME already in trusted paths', {'CODEX_HOME': '/custom/codex',
                                                 'NODE_REPL_TRUSTED_CODE_PATHS': '/custom/codex:/other'}),
    ):
        _env_run(sb, ctx, label, env)


@rt_scenario('rt/launch/env-no-home', hosts=rt.LINUX, account_home=True, normalise=STATUSES)
def _(sb):
    # With HOME unset the home directory is the account's (passwd) one, which is the disposable container's.
    ctx = place(sb, 'linux')
    _env_run(sb, ctx, 'HOME unset', {'HOME': None})
    _env_run(sb, ctx, 'HOME and CODEX_HOME unset', {'HOME': None, 'CODEX_HOME': None})


@rt_scenario('rt/launch/env-paths', normalise=STATUSES)
def _(sb):
    ctx = place(sb, 'linux')
    base = str(ctx.runtime / 'lib/node_modules')
    for label, env in (
        ('PATH unset (defaults to /usr/bin:/bin)', {'PATH': None}),
        # ('PATH empty') is not comparable: the oracle's `#!/usr/bin/env python3` launcher cannot find its interpreter
        # under PATH='' (exit 127), which is the Python requirement this port removes. The shim never reads PATH.
        ('PATH with duplicates and empties', {'PATH': '/usr/bin::/usr/bin:/bin:'}),
        ('PATH containing the runtime bin already', {'PATH': f'{ctx.runtime}/bin:/usr/bin'}),
        ('NODE_REPL_NODE_MODULE_DIRS empty', {'NODE_REPL_NODE_MODULE_DIRS': ''}),
        ('NODE_REPL_NODE_MODULE_DIRS with empties and duplicates',
         {'NODE_REPL_NODE_MODULE_DIRS': f':/a::/a:{base}:/b:'}),
        ('NODE_REPL_NODE_MODULE_DIRS with spaces', {'NODE_REPL_NODE_MODULE_DIRS': ' /a : /b'}),
        ('NODE_REPL_TRUSTED_CODE_PATHS empty', {'NODE_REPL_TRUSTED_CODE_PATHS': ''}),
        ('NODE_REPL_TRUSTED_CODE_PATHS with empties and duplicates', {'NODE_REPL_TRUSTED_CODE_PATHS': ':/x::/x:/y'}),
        ('NODE_REPL_NODE_PATH and CUA_REPL_NODE_REPL_PATH preset are replaced',
         {'NODE_REPL_NODE_PATH': '/n', 'CUA_REPL_NODE_REPL_PATH': '/r'}),
    ):
        _env_run(sb, ctx, label, env)


@rt_scenario('rt/launch/env-defaults', normalise=STATUSES)
def _(sb):
    # Defaults are filled only where the caller left a variable unset; explicit values (empty included) stay.
    ctx = place(sb, 'linux')
    for label, value in (
        ('surfaces empty', ''), ('surfaces browser', 'browser'), ('surfaces browser,computer', 'browser,computer'),
        ('surfaces with spaces', ' computer , browser '), ('surfaces duplicated', 'computer,computer'),
        ('surfaces unknown', 'telepathy'), ('surfaces computer', 'computer'),
    ):
        _env_run(sb, ctx, label, {'CUA_REPL_ENABLED_SURFACES': value})
        _env_run(sb, ctx, label + ' with --chrome', {'CUA_REPL_ENABLED_SURFACES': value}, '--chrome')
    for label, env, args in (
        ('SKY_ENABLE_AUDIO=0 inherited without --audio', {'SKY_ENABLE_AUDIO': '0', 'NODE_REPL_ENABLE_AUDIO': '0'}, ()),
        ('SKY_ENABLE_AUDIO=0 replaced by --audio', {'SKY_ENABLE_AUDIO': '0', 'NODE_REPL_ENABLE_AUDIO': '0'},
         ('--audio',)),
        ('CUA_REPL_BROWSER_ENV other: no browser defaults', {'CUA_REPL_BROWSER_ENV': 'other'}, ()),
        ('CUA_REPL_BROWSER_ENV empty', {'CUA_REPL_BROWSER_ENV': ''}, ()),
        ('BROWSER_USE_* preset', {'BROWSER_USE_AVAILABLE_BACKENDS': 'a', 'BROWSER_USE_TINYSKY_ENABLED': '0',
                                  'BROWSER_USE_CODEX_APP_BUILD_FLAVOR': 'x', 'BROWSER_USE_CODEX_APP_VERSION': '1'}, ()),
        ('BROWSER_USE_* preset empty', {'BROWSER_USE_AVAILABLE_BACKENDS': '', 'BROWSER_USE_TINYSKY_ENABLED': '',
                                        'BROWSER_USE_CODEX_APP_BUILD_FLAVOR': '', 'BROWSER_USE_CODEX_APP_VERSION': ''},
         ()),
        ('BUILD_FLAVOR dev', {'BUILD_FLAVOR': 'dev'}, ()),
        ('BUILD_FLAVOR with spaces', {'BUILD_FLAVOR': '  agent  '}, ()),
        ('BUILD_FLAVOR upper case is invalid', {'BUILD_FLAVOR': 'DEV'}, ()),
        ('BUILD_FLAVOR internal-alpha', {'BUILD_FLAVOR': 'internal-alpha'}, ()),
        ('BUILD_FLAVOR public-beta', {'BUILD_FLAVOR': 'public-beta'}, ()),
        ('BUILD_FLAVOR nightly', {'BUILD_FLAVOR': 'nightly'}, ()),
        ('BUILD_FLAVOR unknown', {'BUILD_FLAVOR': 'staging'}, ()),
        ('CODEX_CLI_PATH preset (used by the shim)', {'CODEX_CLI_PATH': '/my/codex'}, ()),
        ('analytics/network/timeout presets', {'NODE_REPL_DISABLE_ANALYTICS': '0',
                                              'BROWSER_USE_DISABLE_AMBIENT_NETWORK': '',
                                              'NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS': '50'}, ()),
        ('NODE_REPL_REQUEST_META preset valid',
         {'NODE_REPL_REQUEST_META': '{"x-codex-turn-metadata": {"session_id": "a", "turn_id": "b"}}'}, ()),
        ('NODE_REPL_REQUEST_META preset invalid JSON', {'NODE_REPL_REQUEST_META': 'not json'}, ()),
        ('NODE_REPL_REQUEST_META preset empty', {'NODE_REPL_REQUEST_META': ''}, ()),
        ('python and LCU variables pass through', {'PYTHONPATH': '/p', 'PYTHONHOME': '', 'PYTHONUNBUFFERED': '1',
                                                   'PYTHONSTARTUP': '/s', 'LCU_PYTHON': '/py', 'LC_ALL': 'C',
                                                   'TERM': 'dumb'}, ()),
        ('odd variable names and values', {'A.B': '1', 'FOO-BAR': '2', 'lower': '3', 'EMPTY': '', 'EQ': 'a=b=c',
                                           'UNI': 'héllo ☃ 😀', 'SPACE KEY': 'x'}, ()),
        ('long value (100000 bytes)', {'LONG': 'v' * 100000}, ()),
    ):
        _env_run(sb, ctx, label, env, *args)


@rt_scenario('rt/launch/env-non-utf8', normalise=STATUSES)
def _(sb):
    # Bytes that are not UTF-8 in an inherited variable reach the child unchanged (read raw from the exec'd image).
    ctx = place(sb, 'linux')
    dump = sb.bb / 'rt/envdump.txt'
    probe = {'rawEnv': True, 'env': False}
    _launch(sb, ctx, 'non-UTF-8 value', probe=probe, env={'RT_ENVDUMP': str(dump)},
            envBytes={'LATIN1': base64.b64encode(b'caf\xe9 \xff\xfe end').decode()})
    _launch(sb, ctx, 'non-UTF-8 CODEX_HOME', probe=probe, env={'RT_ENVDUMP': str(dump)},
            envBytes={'CODEX_HOME': base64.b64encode(b'/tmp/\xff/codex').decode()})
    _launch(sb, ctx, 'non-UTF-8 PATH and HOME', probe=probe, env={'RT_ENVDUMP': str(dump)},
            envBytes={'PATH': base64.b64encode(b'/usr/bin:/b\xe9n').decode(),
                      'HOME': base64.b64encode(b'/h\xe9').decode()})


FLAG_CASES = (
    (), ('--chrome',), ('--audio',), ('--chrome', '--audio'), ('--audio', '--chrome'), ('--chrome', '--chrome'),
    ('--audio', '--audio'), ('--chrome', '--audio', '--chrome'), ('--mcp-discovery-compat',),
    ('--mcp-discovery-compat', '--chrome'), ('--chrome', '--mcp-discovery-compat', '--audio'),
    ('--mcp-discovery-compat', '--mcp-discovery-compat'), ('--help',), ('-h',), ('--chrome', '--help'),
    ('--audio', '--chrome', '-h'), ('--help', '--chrome'), ('--chrome', '--chrome', '--help'),
    ('--version',), ('--chrome', '--version'), ('--audio', '--chrome', '--version'), ('--version', '--chrome'),
    ('--chrome', '--chrome', '--version'), ('--bogus',), ('-x',), ('',), ('--chrome=1',), ('--with-browser-host',),
    ('--chrome', '--with-browser-host'), ('doctor', '--help'), ('doctor', '-h'), ('--chrome', 'doctor', '--help'),
    ('--mcp-discovery-compat', 'doctor'), ('--',), ('--chrome', '--', '--audio'), ('extra',), ('--chrome', 'extra'),
    ('--Chrome',), ('--chrome ',),
)


@rt_scenario('rt/launch/flags', normalise=STATUSES)
def _(sb):
    # Every flag combination: what starts the child (and with which surfaces/audio), and what is refused.
    ctx = place(sb, 'linux')
    for args in FLAG_CASES:
        _launch(sb, ctx, 'lcu ' + ' '.join(repr(a) for a in args), *args, probe={'env': False, 'stdin': 'all'},
                stdin=DISCOVER if '--mcp-discovery-compat' in args else '')


@rt_scenario('rt/launch/flag-env', normalise=STATUSES)
def _(sb):
    # What the flags change in the environment (full environment of the child).
    ctx = place(sb, 'linux')
    for args in ((), ('--chrome',), ('--audio',), ('--chrome', '--audio'), ('--mcp-discovery-compat',)):
        _launch(sb, ctx, 'lcu ' + ' '.join(args), *args, probe={'env': True},
                stdin=DISCOVER if args == ('--mcp-discovery-compat',) else '')


@rt_scenario('rt/launch/invocation-forms', normalise=STATUSES)
def _(sb):
    # The release root is found through symlinks, relative paths and PATH lookups; argv[0] is echoed as given.
    ctx = place(sb, 'linux')
    link_dir = sb.work / 'links'
    link_dir.mkdir()
    (link_dir / 'lcu-link').symlink_to(ctx.lcu)
    (link_dir / 'release-link').symlink_to(ctx.release)
    (link_dir / 'chain').symlink_to(link_dir / 'lcu-link')
    for label, argv, cwd in (
        ('absolute path', [str(ctx.lcu)], None),
        ('via prefix/current', [str(sb.prefix / 'current/bin/lcu')], None),
        ('relative ./lcu', ['./lcu'], ctx.release / 'bin'),
        ('relative ../bin/lcu', ['../bin/lcu'], ctx.release / 'lcu'),
        ('symlink to the script', [str(link_dir / 'lcu-link')], None),
        ('symlink chain', [str(link_dir / 'chain')], None),
        ('symlinked release directory', [str(link_dir / 'release-link/bin/lcu')], None),
        ('relative symlink', ['links/lcu-link'], sb.work),
    ):
        _launch(sb, ctx, label, argv=argv, cwd=str(cwd) if cwd else None, relations=True)
    _launch(sb, ctx, 'found on PATH', argv=['lcu'], env={'PATH': f'{ctx.release}/bin:/usr/bin:/bin'}, relations=True)
    for label, argv, cwd in (
        ('tty guard, absolute path', [ctx.lcu], None),
        ('tty guard, relative ./lcu', ['./lcu'], ctx.release / 'bin'),
        ('tty guard, symlink', [link_dir / 'lcu-link'], None),
        ('tty guard, via prefix/current', [sb.prefix / 'current/bin/lcu'], None),
        ('tty guard, with --chrome --audio', [ctx.lcu, '--chrome', '--audio'], None),
    ):
        sb.run(argv, tty=True, cwd=cwd, label=label)


@rt_scenario('rt/launch/cwd', normalise=STATUSES)
def _(sb):
    # The child starts in the caller's directory, except when that cannot be entered (Linux: starts in `/`).
    ctx = place(sb, 'linux')
    unicode_dir = sb.work / 'dïr with spaces ☃'
    unicode_dir.mkdir()
    (sb.work / 'real').mkdir()
    (sb.work / 'linked').symlink_to(sb.work / 'real')
    for label, cwd in (('plain', None), ('unicode and spaces', unicode_dir), ('symlinked cwd', sb.work / 'linked'),
                       ('root', '/')):
        _launch(sb, ctx, f'cwd: {label}', cwd=str(cwd) if cwd else None)
    gone = sb.work / 'gone'
    for mode in ('', 'off'):
        gone.mkdir(exist_ok=True)
        label = 'cwd deleted after the shell entered it' + (f', sandbox {mode}' if mode else '')
        spec = {'argv': ['/bin/sh', '-c', f'cd {gone} && rmdir {gone} && exec "$0" "$@"', str(ctx.lcu)],
                'env': {'LCU_NODE_REPL_SANDBOX': mode} if mode else {},
                'probe': {'env': mode == 'off', 'stdin': 'none'}}
        rt.drive(sb, ctx, spec, label=label)
    blocked = sb.work / 'blocked'
    blocked.mkdir()
    for name, perms in (('unreadable (0311)', 0o311), ('unreadable (0111)', 0o111)):
        os.chmod(blocked, perms)
        try:
            _launch(sb, ctx, f'cwd {name}', cwd=str(blocked))
            _launch(sb, ctx, f'cwd {name}, sandbox off', cwd=str(blocked), env={'LCU_NODE_REPL_SANDBOX': 'off'},
                    probe={'env': True})
        finally:
            os.chmod(blocked, 0o755)
