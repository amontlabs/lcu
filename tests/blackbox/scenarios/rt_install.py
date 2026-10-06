"""Installers: scripts/install.sh -> install.py (Linux, Docker, offline, as the container account), the macOS
installer's refusals on the host (everything before it would validate the release as the real account, which uses
the real home: a full macOS install is a GAP for the macOS guest), and the Windows installer/launcher parts that
run off Windows.

Full Linux installs write the account home (validation runs there), so they are `account_home` scenarios that only
run in the disposable container (docker.sh).
"""
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import fixtures
import fixtures_rt as rt
from fixtures_rt import BOTH, DARWIN, LINUX, drive, rt_scenario

NORMALISE = ('release-id', 'tmpdir-suffix')


def _ctx(sb, target=None, *, sealed=True):
    target = target or rt.host_target()
    sb.place_src(sealed=target if sealed else None)
    tools = rt.install_tools(sb)
    app = (fixtures.mac_app(sb.apps / 'ChatGPT.app', sb.recorder) if target == 'darwin'
           else fixtures.linux_app(sb.apps / 'chatgpt', sb.recorder))
    return SimpleNamespace(tools=tools, app=app, target=target, installer=['bash', str(sb.src / 'scripts/install.sh')],
                           lcu=sb.prefix / 'current/bin/lcu')


def _install(sb, ctx, label, *args, flags=True, **options):
    base = ['--existing-app', str(ctx.app), '--prefix', str(sb.prefix), '--skip-system', '--offline'] if flags else []
    return sb.run([*ctx.installer, *[str(a) for a in args], *base], label=label, **options)


def _state(sb, label):
    """What the prefix holds now (release names normalised by the scenario's release-id normaliser)."""
    script = ("import os,sys; p=sys.argv[1]; r=os.path.join(p,'releases');"
              "print('releases:', sorted(os.listdir(r)) if os.path.isdir(r) else None);"
              "c=os.path.join(p,'current'); print('current ->', os.readlink(c) if os.path.islink(c) else None);"
              "print('.next exists:', os.path.lexists(os.path.join(p,'.next')))")
    sb.run([sb.bb / 'tools/python3', '-c', script, sb.prefix], label=label)


# -- Linux (Docker) ------------------------------------------------------------------------------------------------
@rt_scenario('rt/install/linux-runtime-only', hosts=LINUX, account_home=True, normalise=NORMALISE)
def _(sb):
    ctx = _ctx(sb, 'linux')
    _install(sb, ctx, 'first install', '--runtime-only')
    sb.run([ctx.lcu, '--version'], label='installed lcu --version')
    _state(sb, 'prefix after the first install')
    _install(sb, ctx, 'reinstall over the existing prefix', '--runtime-only')
    _state(sb, 'prefix after the reinstall')
    _install(sb, ctx, 'explicit --user of this account', '--runtime-only', '--user', 'ubuntu')
    _state(sb, 'prefix after the third install')


@rt_scenario('rt/install/linux-legacy-forms', hosts=LINUX, account_home=True, normalise=NORMALISE)
def _(sb):
    ctx = _ctx(sb, 'linux')
    sb.run([*ctx.installer, str(sb.prefix), '--existing-app', str(ctx.app), '--skip-system', '--offline'],
           label='legacy positional prefix (implies --runtime-only)')
    _state(sb, 'prefix after the legacy form')
    sb.run([*ctx.installer, '--runtime-only', '--existing-app', '~/../../' + str(ctx.app).lstrip('/'),
            '--prefix', str(sb.prefix), '--skip-system', '--offline'], label='--existing-app with ~')
    sb.run([*ctx.installer, '--runtime-only', '--existing-app=' + str(ctx.app), '--prefix=' + str(sb.prefix),
            '--skip-system', '--offline'], label='--opt=value forms')
    _state(sb, 'prefix after three installs')


@rt_scenario('rt/install/linux-refusals', hosts=LINUX, account_home=True, normalise=NORMALISE)
def _(sb):
    ctx = _ctx(sb, 'linux')
    run = lambda label, *args: sb.run([*ctx.installer, *[str(a) for a in args]], label=label)
    app, prefix = str(ctx.app), str(sb.prefix)
    common = ['--existing-app', app, '--skip-system', '--offline']
    run('without --skip-system as a non-root account', '--runtime-only', '--existing-app', app, '--prefix', prefix)
    run('--app-package', '--runtime-only', '--app-package', '/x.deb', *common, '--prefix', prefix)
    run('--reconcile', '--reconcile', *common, '--prefix', prefix)
    run('--user root from a non-root account', '--runtime-only', '--user', 'root', *common, '--prefix', prefix)
    run('--user unknown', '--runtime-only', '--user', 'no-such-user-xyz', *common, '--prefix', prefix)
    run('no agent and no --runtime-only, stdin not a tty', *common, '--prefix', prefix)
    run('--yes without an agent', '--yes', *common, '--prefix', prefix)
    for flag in (['--chrome'], ['--audio'], ['--no-chrome'], ['--approval', 'auto'], ['--allow-missing'],
                 ['--check-desktop'], ['--session', 'direct'], ['--scope', 'project', '--project', '/tmp'],
                 ['--export', '/tmp/x'], ['--agent', 'codex'], ['--browser-host']):
        run('--runtime-only with ' + ' '.join(flag), '--runtime-only', *flag, *common, '--prefix', prefix)
    run('--chrome and --no-chrome', '--agent', 'codex', '--chrome', '--no-chrome', *common, '--prefix', prefix)
    run('missing app', '--runtime-only', '--existing-app', '/nonexistent/app', '--skip-system', '--offline', '--prefix', prefix)
    run('app path is a file', '--runtime-only', '--existing-app', str(ctx.app / 'ChatGPT'), '--skip-system', '--offline', '--prefix', prefix)
    run('relative prefix', '--runtime-only', *common, '--prefix', 'rel/prefix')
    run('prefix too short', '--runtime-only', *common, '--prefix', '/opt')
    run('prefix /usr/local', '--runtime-only', *common, '--prefix', '/usr/local')
    run('prefix with ..', '--runtime-only', *common, '--prefix', prefix + '/../x')
    run('prefix inside the extracted bundle', '--runtime-only', *common, '--prefix', str(sb.src / 'inner'))
    occupied = sb.work / 'occupied'
    occupied.mkdir()
    (occupied / 'file').write_text('x')
    run('prefix is an occupied non-LCU directory', '--runtime-only', *common, '--prefix', occupied)
    linked = sb.work / 'linked-prefix'
    linked.mkdir()
    (linked / '.lcu-install').symlink_to(sb.work / 'occupied/file')
    run('prefix with a symlinked .lcu-install', '--runtime-only', *common, '--prefix', linked)
    linked2 = sb.work / 'linked-releases'
    linked2.mkdir()
    (linked2 / '.lcu-install').write_text('')
    (linked2 / 'releases').symlink_to(sb.work)
    run('prefix with a symlinked releases directory', '--runtime-only', *common, '--prefix', linked2)
    via = sb.work / 'via-link'
    via.symlink_to(sb.work / 'occupied')
    run('prefix through a symlinked directory', '--runtime-only', *common, '--prefix', str(via / 'sub'))
    run('unknown agent', '--agent', 'nope', *common, '--prefix', prefix)
    run('--list-agents', '--list-agents')
    _state(sb, 'nothing was installed')


@rt_scenario('rt/install/linux-validation-failures', hosts=LINUX, account_home=True, normalise=NORMALISE)
def _(sb):
    # Failures while selecting the app (nothing written) and while validating the new release (rolled back).
    ctx = _ctx(sb, 'linux')
    _install(sb, ctx, 'good install first', '--runtime-only')
    runtime = ctx.app / 'resources/cua_node'
    wrapper = runtime / 'bin/node'
    good = wrapper.read_text()
    for label, guard in (
        ('node --version fails', '"$1" = --version'),
        ('the Sky setup check fails (release rolled back)', '"$1" = --input-type=module'),
    ):
        wrapper.write_text(good.replace('#!/bin/sh\n', f'#!/bin/sh\nif [ {guard} ]; then echo "boom: $1" >&2; exit 3; fi\n', 1))
        _install(sb, ctx, label, '--runtime-only')
        _state(sb, f'prefix after: {label}')
    wrapper.write_text(good)
    sb.fake('node_repl', default={'exit': 2, 'stderr': 'node_repl: broken\n'})
    _install(sb, ctx, 'node_repl --help fails', '--runtime-only')
    sb.fake('node_repl')
    sb.fake('app-codex', rules=[{'argv': ['--version'], 'exit': 1, 'stderr': 'codex: broken\n'}])
    _install(sb, ctx, 'codex --version fails', '--runtime-only')
    sb.fake('app-codex', env=['HOME', 'CODEX_HOME'], appServer=True,
            rules=[{'argv': ['--version'], 'stdout': 'codex-cli 0.0.0-fake\n'}])
    service = runtime / 'lib/node_modules/@oai/sky/dist/project/cua/sky_js/src/service.js'
    original = service.read_text()
    service.write_text("export async function handleRpc() { return { target: 'mac' }; }\n")
    _install(sb, ctx, 'Sky reports the wrong platform (release rolled back)', '--runtime-only')
    service.write_text(original)
    (sb.prefix / '.next').symlink_to('releases')
    _install(sb, ctx, 'stale .next link (release rolled back)', '--runtime-only')
    (sb.prefix / '.next').unlink()
    _state(sb, 'prefix at the end')
    sb.run([ctx.lcu, '--version'], label='the first install is still selected')


@rt_scenario('rt/install/linux-concurrent', hosts=LINUX, account_home=True, normalise=NORMALISE)
def _(sb):
    # Two installers at once serialise on the prefix lock; both releases are published, `current` is one of them.
    # (The second one does not record its probes: how two processes interleave in one log is a race, not behavior.)
    ctx = _ctx(sb, 'linux')
    argv = [*ctx.installer, '--runtime-only', '--existing-app', str(ctx.app), '--prefix', str(sb.prefix),
            '--skip-system', '--offline']
    drive(sb, ctx, {'argv': argv, 'parallel': [{'argv': argv, 'label': 'second installer', 'env': {'LCU_BB_LOG': '/dev/null'}}], 'timeout': 120},
          label='two concurrent installs')
    script = ("import os,sys; p=sys.argv[1]; r=sorted(os.listdir(os.path.join(p,'releases')));"
              "c=os.readlink(os.path.join(p,'current')); print('releases:', len(r));"
              "print('current is one of them:', c in ['releases/'+n for n in r])")
    sb.run([sb.bb / 'tools/python3', '-c', script, sb.prefix], label='prefix after both')
    # a held lock blocks a third installer until released (flock on <prefix>/.lcu-install)
    holder = ['/usr/bin/flock', str(sb.prefix / '.lcu-install'), '/bin/sleep', '3']
    drive(sb, ctx, {'argv': argv, 'background': [{'argv': holder, 'env': {}}], 'timeout': 120},
          label='install while another process holds the prefix lock for 3 s')


@rt_scenario('rt/install/linux-agent-setup', hosts=LINUX, account_home=True, normalise=NORMALISE)
def _(sb):
    # With an agent the installer hands over to `<prefix>/current/bin/lcu setup` with the forwarded options; a
    # failing setup keeps the runtime and says how to retry.
    ctx = _ctx(sb, 'linux')
    sb.remove_fake('codex')
    quiet = {'env': {'NODE_DISABLE_COMPILE_CACHE': '1'}}  # Node's compile cache in TMPDIR is not behaviour
    _install(sb, ctx, 'install with --agent codex but no codex CLI', '--agent', 'codex', '--yes', '--chrome',
             '--audio', '--session', 'direct', '--approval', 'auto', **quiet)
    _state(sb, 'runtime stays installed')
    _install(sb, ctx, 'install with --agent pi --allow-missing (pi missing)', '--agent', 'pi', '--yes',
             '--allow-missing', '--session', 'direct', **quiet)


# -- macOS host: refusals only ---------------------------------------------------------------------------------------
@rt_scenario('rt/install/macos-refusals', hosts=DARWIN, normalise=NORMALISE)
def _(sb):
    # Every case stops before the installer creates the prefix or validates as the real account.
    ctx = _ctx(sb, 'darwin')
    run = lambda label, *args: sb.run([*ctx.installer, *[str(a) for a in args]], label=label)
    app, prefix = str(ctx.app), str(sb.prefix)
    common = ['--existing-app', app, '--skip-system', '--offline']
    run('--help', '--help')
    run('--list-agents', '--list-agents')
    run('--session discover', '--runtime-only', '--session', 'discover', *common, '--prefix', prefix)
    run('--reconcile', '--reconcile', *common, '--prefix', prefix)
    run('--app-package is unknown on macOS', '--app-package', '/x', *common, '--prefix', prefix)
    run('no agent, stdin not a tty', *common, '--prefix', prefix)
    for flag in (['--chrome'], ['--audio'], ['--approval', 'ask'], ['--agent', 'codex'], ['--check-desktop'],
                 ['--export', '/tmp/x']):
        run('--runtime-only with ' + ' '.join(flag), '--runtime-only', *flag, *common, '--prefix', prefix)
    run('--user unknown', '--runtime-only', '--user', 'no-such-user-xyz', *common, '--prefix', prefix)
    run('--user root from a non-root account', '--runtime-only', '--user', 'root', *common, '--prefix', prefix)
    run('missing app', '--runtime-only', '--existing-app', '/nonexistent/ChatGPT.app', '--prefix', prefix)
    run('relative prefix', '--runtime-only', *common, '--prefix', 'rel')
    run('prefix inside the bundle', '--runtime-only', *common, '--prefix', str(sb.src / 'x'))
    occupied = sb.work / 'occupied'
    occupied.mkdir()
    (occupied / 'f').write_text('x')
    run('occupied prefix', '--runtime-only', *common, '--prefix', occupied)
    sb.fake('codesign', rules=[{'match': '^--verify', 'exit': 1, 'stderr': 'invalid signature\n'}])
    run('app signature does not verify', '--runtime-only', *common, '--prefix', prefix)
    sb.fake('codesign', rules=[{'match': '^--verify'}, {'match': '^-dv', 'stderr': 'Identifier=x\nTeamIdentifier=Y\n'}])
    run('app identity is not OpenAI', '--runtime-only', *common, '--prefix', prefix)
    plist = ctx.app / 'Contents/Info.plist'
    plist.unlink()
    run('app without Info.plist', '--runtime-only', *common, '--prefix', prefix)
    _state(sb, 'nothing was created')


@rt_scenario('rt/install/unsealed', hosts=BOTH, normalise=NORMALISE)
def _(sb):
    # A source tree without bundle.json, and a tampered bundle, are refused before any write.
    ctx = _ctx(sb, sealed=False)
    common = ['--existing-app', str(ctx.app), '--skip-system', '--offline', '--prefix', str(sb.prefix)]
    sb.run([*ctx.installer, '--runtime-only', *common], label='no bundle.json')
    fixtures.seal(sb.src, ctx.target)
    (sb.src / 'README.md').write_text('tampered\n')
    sb.run([*ctx.installer, '--runtime-only', *common], label='tampered bundle')
    manifest = json.loads((sb.src / 'bundle.json').read_text())
    for label, change in (('wrong architecture', {'architecture': 'x64' if fixtures.architecture() == 'arm64' else 'arm64'}),
                          ('wrong platform', {'platform': 'windows'}), ('wrong format', {'format': 2}),
                          ('wrong version', {'version': '0.0.1'})):
        (sb.src / 'bundle.json').write_text(json.dumps({**manifest, **change}))
        sb.run([*ctx.installer, '--runtime-only', *common], label=label)
    (sb.src / 'bundle.json').write_text('not json')
    sb.run([*ctx.installer, '--runtime-only', *common], label='bundle.json not JSON')
    _state(sb, 'nothing was created')


# -- Windows parts that run off Windows -------------------------------------------------------------------------------
@rt_scenario('rt/install/windows-installer-offhost', hosts=BOTH, normalise=NORMALISE)
def _(sb):
    # The Windows installer's argument handling and its refusal to run off Windows (no prefix is created).
    ctx = _ctx(sb, sealed=False)
    script = sb.src / 'scripts/install_windows.py'
    python = sb.bb / 'tools/python3'
    for label, args in (
        ('--help', ['--help']), ('no arguments', []), ('--runtime-only with --agent', ['--runtime-only', '--agent', 'codex']),
        ('--runtime-only with --chrome', ['--runtime-only', '--chrome']), ('unknown agent', ['--agent', 'nope']),
        ('--scope other', ['--scope', 'x', '--agent', 'codex']), ('--runtime-only', ['--runtime-only', '--prefix', str(sb.prefix)]),
        ('--agent codex', ['--agent', 'codex', '--prefix', str(sb.prefix)]),
        ('default prefix', ['--runtime-only']),
    ):
        sb.run([python, '-B', script, *args], label='install_windows.py ' + label, env={'LOCALAPPDATA': str(sb.work / 'appdata')})
    _state(sb, 'nothing was created')


@rt_scenario('rt/install/windows-launcher-offhost', hosts=BOTH)
def _(sb):
    # The stable Windows launcher selects `releases/<current.json release>/bin/lcu` and runs it with its arguments.
    ctx = _ctx(sb, sealed=False)
    prefix = sb.work / 'LCU'
    (prefix / 'releases').mkdir(parents=True)
    launcher = prefix / 'windows_launcher.py'
    launcher.write_bytes((sb.src / 'scripts/windows_launcher.py').read_bytes())
    release = prefix / 'releases/0.9.4-aaaaaaaaaaaa'
    fixtures.write(release / 'bin/lcu', 'import sys\nprint("release lcu", sys.argv[1:])\nsys.exit(4)\n')
    python = sb.bb / 'tools/python3'
    run = lambda label, *args: sb.run([python, '-B', launcher, *args], label=label)
    run('no current.json')
    for label, content in (
        ('valid', {'release': release.name}), ('not JSON', 'x'), ('no release', {}), ('release empty', {'release': ''}),
        ('release with slash', {'release': 'a/b'}), ('release with backslash', {'release': 'a\\b'}),
        ('release ..', {'release': '..'}), ('release with control character', {'release': 'a\nb'}),
        ('release missing', {'release': 'nope'}), ('release not a string', {'release': 3}),
    ):
        (prefix / 'current.json').write_text(content if isinstance(content, str) else json.dumps(content))
        run(f'current.json {label}', '--version', 'a b')
    (prefix / 'current.json').write_text(json.dumps({'release': release.name}))
    (release / 'bin/lcu').unlink()
    run('release without bin/lcu')
    (prefix / 'releases/linked').symlink_to(sb.work)
    (prefix / 'current.json').write_text(json.dumps({'release': 'linked'}))
    run('release is a symlink')
