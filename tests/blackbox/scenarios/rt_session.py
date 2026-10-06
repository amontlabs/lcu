"""bin/lcu-session: attach a command to the one XFCE session of the calling account.

Linux (Docker): stand-in sessions are copies of /bin/sleep named `xfce4-session` (so /proc/PID/comm matches) started
by the driver with a chosen environment, each in its own session; the driver stops them through send(). The
command run through lcu-session prints the GUI variables it received.
"""
import base64
import shutil

from fixtures_rt import BOTH, LINUX, drive, place, rt_scenario

GUI = 'DISPLAY|XAUTHORITY|DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR|XDG_SESSION_TYPE|KEEP_ME'
SHOW = ['/bin/sh', '-c', f'env | grep -E "^({GUI})=" | sort; echo "args: $*"', 'show']


def _sleeper(sb):
    target = sb.work / 'fake-desktop/xfce4-session'
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy('/bin/sleep', target)
        target.chmod(0o755)
    return target


def _session(sb, **env):
    return {'argv': [_sleeper(sb), '120'], 'env': env}


FULL = {'DISPLAY': ':42', 'XAUTHORITY': '/tmp/xauth-42', 'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/run/user/1000/bus,guid=ab=cd',
        'XDG_RUNTIME_DIR': '/run/user/1000', 'XDG_SESSION_TYPE': 'x11', 'OTHER': 'not copied'}


def _run(sb, ctx, label, sessions=(), args=None, env=None):
    args = args if args is not None else ['--user', 'ubuntu', '--', *SHOW, 'a b', '-x']
    spec = {'argv': [ctx.release / 'bin/lcu-session', *args], 'background': list(sessions), 'env': env or {}}
    return drive(sb, ctx, {**spec, 'argv': [str(a) for a in spec['argv']],
                           'background': [{'argv': [str(a) for a in b['argv']], 'env': b['env']} for b in sessions]},
                 label=label)


STALE = {'DISPLAY': ':0', 'XAUTHORITY': '/stale', 'DBUS_SESSION_BUS_ADDRESS': 'stale', 'XDG_RUNTIME_DIR': '/stale',
         'XDG_SESSION_TYPE': 'wayland', 'KEEP_ME': 'kept'}


@rt_scenario('rt/session/discover', hosts=LINUX)
def _(sb):
    ctx = place(sb, 'linux')
    _run(sb, ctx, 'no session')
    _run(sb, ctx, 'one session', [_session(sb, **FULL)])
    _run(sb, ctx, 'one session, caller has stale GUI variables', [_session(sb, **FULL)], env=STALE)
    _run(sb, ctx, 'one session with only DISPLAY and DBus', [_session(sb, DISPLAY=':5', DBUS_SESSION_BUS_ADDRESS='x')],
         env=STALE)
    _run(sb, ctx, 'session without DBus does not count', [_session(sb, DISPLAY=':5')])
    _run(sb, ctx, 'session without DISPLAY does not count', [_session(sb, DBUS_SESSION_BUS_ADDRESS='x')])
    _run(sb, ctx, 'session with empty DISPLAY does not count', [_session(sb, DISPLAY='', DBUS_SESSION_BUS_ADDRESS='x')])
    _run(sb, ctx, 'two identical sessions count once', [_session(sb, **FULL), _session(sb, **FULL)])
    _run(sb, ctx, 'two sessions differing only in a non-GUI variable', [_session(sb, **FULL), _session(sb, **{**FULL, 'OTHER': 'y'})])
    _run(sb, ctx, 'two different sessions', [_session(sb, **FULL), _session(sb, **{**FULL, 'DISPLAY': ':43'})])
    _run(sb, ctx, 'one valid and one incomplete', [_session(sb, **FULL), _session(sb, DISPLAY=':9')])
    _run(sb, ctx, 'session environment not UTF-8 is skipped',
         [_session(sb, DISPLAY=':7', DBUS_SESSION_BUS_ADDRESS='b64:' + base64.b64encode(b'caf\xe9').decode())])
    _run(sb, ctx, 'invalid one skipped, valid one used',
         [_session(sb, DISPLAY=':7', DBUS_SESSION_BUS_ADDRESS='b64:' + base64.b64encode(b'\xff').decode()), _session(sb, **FULL)])
    _run(sb, ctx, 'non-ASCII values', [_session(sb, DISPLAY=':1', DBUS_SESSION_BUS_ADDRESS='unix:path=/tmp/é☃')])
    # a process merely named like the session but owned by us with other names does not count
    other = sb.work / 'fake-desktop/xfce4-panel'
    shutil.copy('/bin/sleep', other)
    _run(sb, ctx, 'other XFCE process names do not count', [{'argv': [other, '120'], 'env': FULL}])


@rt_scenario('rt/session/command', hosts=LINUX)
def _(sb):
    ctx = place(sb, 'linux')
    one = [_session(sb, **FULL)]
    _run(sb, ctx, 'command found on PATH', one, ['--user', 'ubuntu', '--', 'env', '-u', 'PATH', 'printenv', 'DISPLAY'])
    _run(sb, ctx, 'command without --', one, ['--user', 'ubuntu', 'printenv', 'DISPLAY'])
    _run(sb, ctx, 'command options after the command', one, ['--user', 'ubuntu', 'printenv', '--user', 'x'])
    _run(sb, ctx, '--user=NAME form', one, ['--user=ubuntu', '--', 'printenv', 'DISPLAY'])
    _run(sb, ctx, 'command not found', one, ['--user', 'ubuntu', '--', 'no-such-command-xyz'])
    _run(sb, ctx, 'command not executable', one, ['--user', 'ubuntu', '--', '/etc/hostname'])
    _run(sb, ctx, 'command exit status passes through', one, ['--user', 'ubuntu', '--', '/bin/sh', '-c', 'exit 7'])
    _run(sb, ctx, 'two -- separators', one, ['--user', 'ubuntu', '--', '--', 'printenv', 'DISPLAY'])
    _run(sb, ctx, 'no session and no command', [], ['--user', 'ubuntu'])


@rt_scenario('rt/session/arguments', hosts=BOTH)
def _(sb):
    # Refusals that do not need a desktop (also on macOS, where the discovery itself cannot work).
    ctx = place(sb)
    for label, args in (
        ('no arguments', []), ('-h', ['-h']), ('--help', ['--help']), ('missing --user value', ['--user']),
        ('unknown option', ['--bogus', '--user', 'root']), ('unknown account', ['--user', 'no-such-account-xyz', '--', 'true']),
        ('another account', ['--user', 'root', '--', 'true']), ('empty account name', ['--user', '', '--', 'true']),
        ('only --', ['--', 'true']),
    ):
        _run(sb, ctx, label, [], args)
