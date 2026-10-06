"""Entry points run as root (docker.sh --root): `lcu setup` and `scripts/install.sh` with and without --user, the
privilege drop to the selected account as seen by a recorder agent CLI, and bin/lcu-session as root.

Root scenarios use the container's `ubuntu` account as the target account (its home is emptied per scenario). The
files the harness creates as root for that account are handed over to it, because the code under test writes them
as the account after dropping privileges.
"""
import os
from pathlib import Path
import pwd
import shlex
import shutil

import fixtures
import fixtures_setup as fs
from fixtures_rt import drive, place as rt_place
from . import scenario

ACCOUNT = 'ubuntu'


def root_scenario(name, **options):
    options.setdefault('hosts', ('linux',))
    options.setdefault('normalise', ('tmpdir-suffix',))
    return scenario(name, needs_root=True, account_home=ACCOUNT, **options)


def own(sb, *paths):
    """Hand the account home (and extra paths) to the account; make the recorder log writable for it."""
    entry = pwd.getpwnam(ACCOUNT)
    for path in (sb.home, *paths):
        os.lchown(path, entry.pw_uid, entry.pw_gid)
        for dirpath, dirnames, filenames in os.walk(path):
            for name in (*dirnames, *filenames):
                os.lchown(Path(dirpath) / name, entry.pw_uid, entry.pw_gid)
    sb.log_path.parent.chmod(0o777)
    sb.log_path.chmod(0o666)
    sb.tmp.chmod(0o1777)
    sb.work.chmod(0o777)


def selfcontained(sb):
    """The fixture app's shell wrappers and recorders read LCU_BB_* from the environment; after the privilege drop
    the environment is the account's, so give each wrapper its own (the variables then reach what it execs)."""
    exports = ('export LCU_BB_NODE=%s LCU_BB_RECORDER=%s LCU_BB_CONFIG=%s LCU_BB_LOG=%s\n' % tuple(
        shlex.quote(str(item)) for item in (fixtures_node(sb), sb.recorder, sb.config_path, sb.log_path)))
    for path in sb.apps.rglob('*'):
        if path.is_file() and not path.is_symlink():
            text = path.read_text(errors='replace') if path.stat().st_size < 4096 else ''
            if text.startswith('#!/bin/sh\n'):
                path.write_text('#!/bin/sh\n' + exports + text[len('#!/bin/sh\n'):])


def fixtures_node(sb):
    return (sb.bb / 'tools/node').resolve()


def id_probe(sb, name='codex', version='codex-cli 9.9.9'):
    """~/.local/bin/NAME: logs the real and effective ids, groups and cwd the account-side process has, then
    behaves as the recorder agent CLI."""
    node = shlex.quote(str(sb.bb / 'tools/node'))
    log = shlex.quote(str(sb.log_path))
    script = ('#!/bin/sh\n'
              f'printf \'{{"tool":"id-probe:%s","euid":%s,"ruid":%s,"egid":%s,"rgid":%s,"groups":"%s","cwd":"%s"}}\\n\' '
              f'"$1" "$(id -u)" "$(id -ru)" "$(id -g)" "$(id -rg)" "$(id -G)" "$(pwd -P)" >> {log}\n'
              f'export LCU_BB_NODE={node} LCU_BB_RECORDER={shlex.quote(str(sb.recorder))} '
              f'LCU_BB_CONFIG={shlex.quote(str(sb.config_path))} LCU_BB_LOG={log}\n'
              f'exec {node} "$LCU_BB_RECORDER" {shlex.quote(name)} "$@"\n')
    fs.put(sb, f'.local/bin/{name}', script, 0o755)
    sb.fake(name, env='*', rules=[{'argv': ['--version'], 'stdout': version + '\n'}])


def release(sb, spy=False, **options):
    """An installed release (real add-mcp/skills from the cached archive set); `spy` logs every Node child."""
    fs.place(sb, **options)
    if spy:
        fs.spy_node(sb)
    selfcontained(sb)


NOISY = {'CODEX_HOME': 'relative/codex', 'XDG_CONFIG_HOME': '/root/.config', 'ROOT_ONLY_VARIABLE': 'leaked',
         'HOME': '/root', 'USER': 'root', 'LOGNAME': 'root', 'LANG': 'en_US.UTF-8', 'NODE_OPTIONS': '--no-warnings',
         'PATH': '/root/bin:/usr/bin:/bin'}


# -- lcu setup as root ---------------------------------------------------------------------------------------
@root_scenario('root/setup-requires-user')
def _(sb):
    release(sb)
    own(sb)
    fs.raw(sb, '--agent', 'codex', '--session', 'direct', '--yes', label='setup without --user')
    # (an empty --user counts as absent and would make root configure /root itself: not run here)
    fs.raw(sb, '--agent', 'codex', '--session', 'direct', '--yes', '--user', '', '--validate-only',
           label='empty --user, validate-only')
    fs.raw(sb, '--agent', 'codex', '--session', 'direct', '--yes', '--validate-only', label='validate-only without --user')
    fs.raw(sb, '--list-agents', label='--list-agents needs no account')
    fs.raw(sb, '--agent', 'codex', '--session', 'direct', '--yes', '--user', 'no-such-account-xyz',
           label='unknown account')
    fs.raw(sb, '--reconcile', label='--reconcile without --user')
    fs.raw(sb, '--export', str(sb.work / 'bundle'), label='export without --user')


@root_scenario('root/setup-privilege-drop')
def _(sb):
    release(sb, spy=True)
    id_probe(sb)
    own(sb)
    fs.raw(sb, '--agent', 'codex', '--user', ACCOUNT, '--session', 'direct', '--yes', env=NOISY,
           label='root drops to the account (hostile caller environment)')
    sb.run(['/bin/sh', '-c', 'ls -lnA --time-style=+ "$1" | grep -v "^total"', 'ls', sb.home / '.codex'],
           label='ownership of what setup wrote')
    fs.raw(sb, '--agent', 'codex', '--user', ACCOUNT, '--session', 'direct', '--yes', env=NOISY,
           label='second run (idempotent)')
    fs.raw(sb, '--agent', 'codex', '--user', ACCOUNT, '--session', 'direct', '--yes',
           env={'CODEX_HOME': '/root/codex-home'}, label='caller CODEX_HOME is not inherited')
    sb.run(['/bin/sh', '-c', 'ls -lnA --time-style=+ "$1" | grep -v "^total"', 'ls', sb.home],
           label='account home after the runs')


@root_scenario('root/setup-privilege-drop-cwd')
def _(sb):
    release(sb, spy=True)
    id_probe(sb)
    own(sb)
    fs.raw(sb, '--agent', 'codex', '--user', ACCOUNT, '--session', 'direct', '--yes', cwd=sb.work,
           label='cwd becomes the account home')
    fs.raw(sb, '--agent', 'codex', '--user', ACCOUNT, '--session', 'direct', '--yes', cwd='/',
           label='from /')
    private = sb.work / 'private'
    private.mkdir()
    private.chmod(0o700)
    fs.raw(sb, '--agent', 'codex', '--user', ACCOUNT, '--session', 'direct', '--yes', cwd=private,
           label='from a directory the account cannot enter')


@root_scenario('root/setup-validate-only')
def _(sb):
    release(sb)
    own(sb)
    base = ['--agent', 'codex', '--session', 'direct', '--yes', '--validate-only']
    fs.raw(sb, *base, '--user', ACCOUNT, env={'CODEX_HOME': 'relative'},
           label='other account: caller environment ignored')
    fs.raw(sb, *base, '--user', ACCOUNT, env={'CODEX_HOME': 'relative'}, cwd='/', label='same from /')
    fs.raw(sb, '--agent', 'claude-code', '--session', 'direct', '--yes', '--validate-only', '--user', ACCOUNT,
           env={'CLAUDE_CONFIG_DIR': '/root/claude'}, label='claude-code with CLAUDE_CONFIG_DIR, other account')
    fs.raw(sb, *base, '--user', 'root', env={'CODEX_HOME': 'relative'}, label='--user root: environment validated')
    fs.raw(sb, '--agent', 'claude-code', '--session', 'direct', '--yes', '--validate-only', '--user', 'root',
           env={'CLAUDE_CONFIG_DIR': '/root/claude'}, label='--user root: unsupported variable refused')
    fs.raw(sb, *base, '--user', 'root', env={'CODEX_HOME': '/root/ok'}, label='--user root: valid')
    fs.raw(sb, '--agent', 'codex', '--scope', 'project', '--session', 'direct', '--yes', '--validate-only',
           '--user', ACCOUNT, label='project scope without --project')
    fs.raw(sb, '--agent', 'nope', '--session', 'direct', '--yes', '--validate-only', '--user', ACCOUNT,
           label='unknown agent')


@root_scenario('root/setup-user-mismatch')
def _(sb):
    release(sb)
    id_probe(sb)
    own(sb)
    # An unprivileged caller selecting another account is refused: run setup as the account (runuser) selecting root.
    sb.run(['/usr/sbin/runuser', '-u', ACCOUNT, '--', sb.release / 'bin/lcu', 'setup', '--agent', 'codex',
            '--user', 'root', '--session', 'direct', '--yes'], label='account selecting root')


# PATH stays the harness's (recorder apt-get first); the rest is a hostile root environment.
INSTALL_ENV = {k: v for k, v in NOISY.items() if k != 'PATH'}


# -- scripts/install.sh as root --------------------------------------------------------------------------------
def _install_flags(sb, *extra, skip_system=True):
    flags = ['--existing-app', sb.apps / 'chatgpt', '--prefix', sb.prefix, '--user', ACCOUNT]
    if skip_system:
        flags += ['--skip-system', '--offline']
    return [*flags, *extra]


def _installer(sb):
    return ['bash', sb.src / 'scripts/install.sh']


def _prepare_install(sb):
    sb.place_src(sealed='linux')
    fixtures.linux_app(sb.apps / 'chatgpt', sb.recorder)
    selfcontained(sb)
    own(sb)


@root_scenario('root/install-requires-user', normalise=('release-id', 'tmpdir-suffix'))
def _(sb):
    _prepare_install(sb)
    base = ['--existing-app', sb.apps / 'chatgpt', '--prefix', sb.prefix, '--skip-system', '--offline']
    sb.run([*_installer(sb), '--runtime-only', *base], label='runtime-only without --user')
    sb.run([*_installer(sb), '--agent', 'codex', *base], label='agent without --user')
    sb.run([*_installer(sb), '--runtime-only', *base, '--user', 'no-such-account-xyz'], label='unknown account')


@root_scenario('root/install-runtime-only', normalise=('release-id', 'tmpdir-suffix'))
def _(sb):
    _prepare_install(sb)
    sb.run([*_installer(sb), '--runtime-only', *_install_flags(sb)], label='install.sh --runtime-only --user')
    sb.run([sb.prefix / 'current/bin/lcu', '--version'], label='installed lcu --version')
    sb.run([*_installer(sb), '--runtime-only', *_install_flags(sb)], label='second install')


@root_scenario('root/install-apt', normalise=('release-id', 'tmpdir-suffix'))
def _(sb):
    _prepare_install(sb)
    sb.fake('apt-get', default={'stdout': 'apt ok\n'})
    sb.run([*_installer(sb), '--runtime-only', *_install_flags(sb, skip_system=False)],
           label='runtime-only with recorder apt-get')
    sb.fake('apt-get', rules=[{'argv': ['update'], 'exit': 100, 'stderr': 'E: no network\n'}])
    sb.run([*_installer(sb), '--runtime-only', *_install_flags(sb, skip_system=False)], label='apt-get update fails')
    sb.fake('apt-get', rules=[{'argv': ['install'], 'exit': 100, 'stderr': 'E: cannot install\n'}])
    sb.run([*_installer(sb), '--runtime-only', *_install_flags(sb, skip_system=False)], label='apt-get install fails')


@root_scenario('root/install-full', normalise=('release-id', 'tmpdir-suffix'))
def _(sb):
    _prepare_install(sb)
    id_probe(sb)
    own(sb)
    sb.fake('apt-get', default={'stdout': 'apt ok\n'})
    sb.run([*_installer(sb), '--agent', 'codex', '--session', 'direct', '--yes',
            *_install_flags(sb, skip_system=False)], env=INSTALL_ENV, label='install.sh --agent codex as root with apt-get')
    sb.run([*_installer(sb), '--agent', 'codex', '--session', 'direct', '--yes', *_install_flags(sb)],
           env=INSTALL_ENV, label='again, --skip-system')
    sb.run(['/bin/sh', '-c', 'ls -lnA --time-style=+ "$1" | grep -v "^total"', 'ls', sb.home],
           label='account home after the installs')


@root_scenario('root/install-full-setup-fails', normalise=('release-id', 'tmpdir-suffix'))
def _(sb):
    _prepare_install(sb)
    id_probe(sb)
    own(sb)
    sb.fake('codex', env='*', rules=[{'argv': ['--version'], 'stdout': 'codex-cli 9.9.9\n'},
                                    {'argv': ['mcp', 'list'], 'exit': 1, 'stderr': 'unknown variant `mcp_tool`\n'}])
    sb.run([*_installer(sb), '--agent', 'codex', '--session', 'direct', '--yes', *_install_flags(sb)],
           label='setup fails after the runtime installed')


# -- bin/lcu-session as root -----------------------------------------------------------------------------------
FULL = {'DISPLAY': ':42', 'XAUTHORITY': '/tmp/xauth-42', 'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/run/user/0/bus',
        'XDG_RUNTIME_DIR': '/run/user/0', 'XDG_SESSION_TYPE': 'x11', 'OTHER': 'not copied'}
GUI = 'DISPLAY|XAUTHORITY|DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR|XDG_SESSION_TYPE'
SHOW = ['/bin/sh', '-c', f'env | grep -E "^({GUI})=" | sort; echo "uid=$(id -u) args: $*"', 'show']


def _sleeper(sb, name='xfce4-session'):
    target = sb.work / 'fake-desktop' / name
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy('/bin/sleep', target)
        target.chmod(0o755)
    return target


def _session_run(sb, ctx, label, args, sessions=(), env=None):
    spec = {'argv': [str(ctx.release / 'bin/lcu-session'), *args],
            'background': [{'argv': [str(_sleeper(sb)), '120'], 'env': s} for s in sessions], 'env': env or {}}
    return drive(sb, ctx, spec, label=label)


@root_scenario('root/session')
def _(sb):
    ctx = rt_place(sb, 'linux')
    own(sb)
    cmd = ['--', *SHOW, 'a b']
    _session_run(sb, ctx, 'root, --user root, root-owned session', ['--user', 'root', *cmd], [FULL])
    _session_run(sb, ctx, 'root, --user root, no session', ['--user', 'root', *cmd])
    _session_run(sb, ctx, 'root, --user root, two different sessions', ['--user', 'root', *cmd],
                 [FULL, {**FULL, 'DISPLAY': ':43'}])
    _session_run(sb, ctx, 'root, --user ubuntu is refused', ['--user', ACCOUNT, *cmd], [FULL])
    _session_run(sb, ctx, 'root, --user=root form', ['--user=root', *cmd], [FULL])
    _session_run(sb, ctx, 'root without --user', cmd, [FULL])
    _session_run(sb, ctx, 'root, unknown account', ['--user', 'no-such-account-xyz', *cmd], [FULL])
    _session_run(sb, ctx, 'root, --user root without a command', ['--user', 'root'], [FULL])
