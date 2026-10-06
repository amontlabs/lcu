"""macOS: the computer-surface launch path. The launcher starts the lifecycle host (macos_host) with the signed
client path, waits for its readiness line, runs cua-repl as a supervised child with `LCU_MAC_LIFETIME_SOCKET`,
and stops the host afterwards.

The fake cua-repl (assets/rt/probe.mjs) plays node_repl against the host's Unix sockets with scripted steps; the
fake signed client (assets/rt/client.mjs) records exactly what the host runs. Runs on the macOS host with fixtures
only: no app, no desktop.
"""
import json
import os

import fixtures_rt as rt
from fixtures_rt import DARWIN, drive, place, rt_scenario

STATUSES = ('uuid', 'tmpdir-suffix')


def _mac(sb, ctx, label, script=(), *args, probe=None, env=None, client=None, **spec):
    config = {'stdin': 'none', 'env': False, 'mac': list(script), **(probe or {})}
    environment = dict(env or {})
    if client is not None:
        environment['RT_CLIENT'] = json.dumps(client)
    return drive(sb, ctx, {'args': list(args), 'probe': config, 'env': environment, **spec}, label=label)


def _session(session='s1', turn='t1', **extra):
    return {'session_id': session, 'turn_id': turn, **extra}


def lifetime(name, request, *, recv=True, timeout=6000, **options):
    """Steps: connect to the lifetime socket, send one request, read the reply."""
    steps = [{'op': 'connect', 'name': name, 'to': 'lifetime'}, {'op': 'send', 'name': name, **request, **options}]
    if recv:
        steps.append({'op': 'recv', 'name': name, 'timeoutMs': timeout})
    return steps


@rt_scenario('rt/mac/launch', hosts=DARWIN, normalise=STATUSES)
def _(sb):
    # The environment, argv and process relationships of the supervised child, and the host's sockets.
    ctx = place(sb, 'darwin')
    steps = [{'op': 'stat', 'what': 'lifetime'}, {'op': 'record_addresses'}, {'op': 'host', 'do': 'record'}]
    _mac(sb, ctx, 'lcu (computer surface)', steps, probe={'env': True}, relations=True,
         after=[{'exists': 'lifetime_dir', 'label': 'lifetime directory exists after exit'},
                {'alive': 'host', 'label': 'host alive after exit'}])
    _mac(sb, ctx, 'lcu --chrome --audio', steps, '--chrome', '--audio', probe={'env': True})
    _mac(sb, ctx, 'lcu, control socket requested', [{'op': 'stat', 'what': 'control'}, {'op': 'stat', 'what': 'lifetime'}],
         probe={'env': True}, env={'LCU_MAC_CONTROL_SOCKET': str(sb.tmp / 'control.sock')})
    _mac(sb, ctx, 'lcu, empty control socket variable', [], probe={'env': True}, env={'LCU_MAC_CONTROL_SOCKET': ''})
    _mac(sb, ctx, 'lcu, discovery compat', [], '--mcp-discovery-compat', probe={'env': True},
         stdin='{"jsonrpc":"2.0","id":9,"method":"server/discover"}\n')


@rt_scenario('rt/mac/surfaces', hosts=DARWIN, normalise=STATUSES)
def _(sb):
    # Without the computer surface there is no host and no supervision: the child is exec'd.
    ctx = place(sb, 'darwin')
    for label, surfaces in (('browser only', 'browser'), ('empty', ''), ('unknown', 'telepathy'),
                            ('computer with spaces', ' computer '), ('browser,computer', 'browser,computer')):
        _mac(sb, ctx, f'surfaces {label}', [{'op': 'stat', 'what': 'lifetime'}], probe={'env': True},
             env={'CUA_REPL_ENABLED_SURFACES': surfaces}, relations=True)
    _mac(sb, ctx, 'surfaces browser, --chrome', [], '--chrome', probe={'env': True},
         env={'CUA_REPL_ENABLED_SURFACES': 'browser'})


@rt_scenario('rt/mac/trusted-services', hosts=DARWIN, normalise=STATUSES)
def _(sb):
    ctx = place(sb, 'darwin')
    wrapper = str(ctx.release / 'lcu/macos_sky_service.mjs')
    for label, services in (
        ('not JSON', 'nope'), ('empty string', ''), ('null', 'null'), ('list', '[]'), ('empty map', '{}'),
        ('sky original', '{"sky":"@oai/sky/service"}'), ('sky is the wrapper', json.dumps({'sky': wrapper})),
        ('sky custom', '{"sky":"custom"}'), ('browser only', '{"browser":"@oai/browser-desktop/service"}'),
        ('extra services', '{"sky":"@oai/sky/service","x":"y"}'), ('non-string value', '{"x":1}'),
        ('sky null', '{"sky":null}'), ('unicode', '{"é":"😀"}'),
    ):
        _mac(sb, ctx, f'services {label}', [], probe={'env': True}, env={'NODE_REPL_TRUSTED_SERVICES': services})
    _mac(sb, ctx, 'browser surface adds the browser service', [], '--chrome', probe={'env': True},
         env={'CUA_REPL_ENABLED_SURFACES': 'browser,computer'})
    _mac(sb, ctx, 'trusted code paths preset', [], probe={'env': True},
         env={'NODE_REPL_TRUSTED_CODE_PATHS': '/x::/x:/y'})
    _mac(sb, ctx, 'SKY_CUA_SERVICE_PATH preset elsewhere (client must exist there)', [], probe={'env': True},
         env={'SKY_CUA_SERVICE_PATH': str(sb.work / 'nowhere')})


@rt_scenario('rt/mac/client-checks', hosts=DARWIN, normalise=STATUSES)
def _(sb):
    # The signed client must exist and be executable before the host starts; nothing else is checked.
    ctx = place(sb, 'darwin')
    client = ctx.app_client
    original = client.read_bytes()
    client.unlink()
    _mac(sb, ctx, 'client missing', [])
    client.write_bytes(original)
    client.chmod(0o644)
    _mac(sb, ctx, 'client not executable', [])
    client.chmod(0o755)
    client.unlink()
    client.mkdir()
    _mac(sb, ctx, 'client is a directory', [])
    client.rmdir()
    client.symlink_to('/nonexistent/client')
    _mac(sb, ctx, 'client is a dangling symlink', [])
    client.unlink()
    client.symlink_to(sb.bb / 'fakes/codex')
    _mac(sb, ctx, 'client is a symlink to an executable', [])
    client.unlink()
    client.write_bytes(original)
    client.chmod(0o755)
    host_entry = ctx.release / 'lcu'
    # The host entry file (whatever the implementation ships: macos_host.py and/or .mjs) is gone.
    saved = {}
    for name in ('macos_host.py', 'macos_host.mjs'):
        if (host_entry / name).exists():
            saved[name] = (host_entry / name).read_bytes()
            (host_entry / name).unlink()
    _mac(sb, ctx, 'host entry missing', [])
    for name, data in saved.items():
        (host_entry / name).write_bytes(data)
    _mac(sb, ctx, 'restored', [])


@rt_scenario('rt/mac/descriptor-errors', hosts=DARWIN, normalise=STATUSES)
def _(sb):
    ctx = place(sb, 'darwin')
    descriptor = ctx.release / 'installation.json'
    good = json.loads(descriptor.read_text())
    for label, content in (
        ('arch not in lock', {**good, 'architecture': 'riscv64'}), ('app relative', {**good, 'app': 'app'}),
        ('app elsewhere', {**good, 'app': '/Applications/Nope.app'}), ('no arch', {k: v for k, v in good.items() if k != 'architecture'}),
    ):
        descriptor.write_text(json.dumps(content))
        sb.run([ctx.lcu, '--version'], label=f'{label}: --version')
        _mac(sb, ctx, f'{label}: launch', [])
    descriptor.write_text(json.dumps(good))
    app = sb.apps / 'ChatGPT.app'
    for relative in ('Contents/Info.plist', 'Contents/Resources/codex', 'Contents/Resources/cua_node/manifest.json',
                     'Contents/Resources/cua_node/bin/node_repl',
                     'Contents/Resources/cua_node/lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs',
                     'Contents/Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/Info.plist'):
        path = app / relative
        saved = path.read_bytes()
        path.unlink()
        sb.run([ctx.lcu, '--version'], label=f'missing {relative}: --version')
        _mac(sb, ctx, f'missing {relative}: launch', [])
        path.write_bytes(saved)
        path.chmod(0o755 if relative.endswith(('codex', 'node_repl')) else 0o644)
    for label, rules in (
        ('codesign verify fails', [{'match': r'^--verify', 'exit': 1, 'stderr': 'a sealed resource is missing\n'}]),
        ('codesign identity mismatch', [{'match': r'^--verify', 'exit': 0},
                                         {'match': r'^-dv .*ChatGPT\.app$', 'stderr': 'Identifier=com.evil.app\nTeamIdentifier=ABCDE12345\n'}]),
        ('codesign prints nothing', [{'match': r'^--verify', 'exit': 0}]),
    ):
        sb.fake('codesign', rules=rules)
        sb.run([ctx.lcu, '--version'], label=f'{label}: --version')
        _mac(sb, ctx, f'{label}: launch', [])
    sb.remove_fake('codesign')
    _mac(sb, ctx, 'codesign not found: launch', [])


@rt_scenario('rt/mac/exit-status', hosts=DARWIN, normalise=STATUSES)
def _(sb):
    # The supervised child's exit status becomes the launcher's (statuses by signal: rt/mac/signals, opt-in).
    ctx = place(sb, 'darwin')
    for code in (0, 1, 2, 7, 42, 255):
        _mac(sb, ctx, f'child exits {code}', [{'op': 'record_addresses'}], probe={'exit': code},
             after=[{'exists': 'lifetime_dir', 'label': 'lifetime directory exists after exit'}])
    _mac(sb, ctx, 'child writes stderr and exits 3', [], probe={'exit': 3, 'printErr': 'cua-repl: fatal\n'})
    _mac(sb, ctx, 'stdout 300000 bytes', [], probe={'stdout': 300000}, show={'stdout': 'sha'})
    _mac(sb, ctx, 'stdin passes to the child', [], probe={'stdin': 'all'},
         stdin=[{'write': '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n'}, {'close': True}])
    _mac(sb, ctx, 'stdin 300000 bytes', [], probe={'stdin': 'all'}, stdin=[{'fill': 300000}, {'close': True}])


@rt_scenario('rt/mac/process-tree', hosts=DARWIN, normalise=STATUSES)
def _(sb):
    # The child is NOT the launcher: the launcher stays as its supervisor, with the host as a second child.
    ctx = place(sb, 'darwin')
    _mac(sb, ctx, 'relationships', [{'op': 'host', 'do': 'record'}, {'op': 'ready'}, {'op': 'await', 'file': 'go'}],
         relations=True, steps=[{'waitReady': True}, {'alive': 'host', 'label': 'host alive while the child runs'},
                                {'mark': 'go'}],
         after=[{'alive': 'host', 'label': 'host alive after exit'}])
    _mac(sb, ctx, 'inherited descriptors 20 and 21', [], probe={'fds': [20, 21, 22]}, passFds=[20, 21])


# Signal scenarios on the macOS HOST are opt-in (LCU_BB_RT_HOST_SIGNALS=1; .port/BRIEF.md SAFETY RULE). Every signal
# goes through driver.py send(), which only reaches processes in the launcher's own new session; the probe never
# signals anything and gives up as soon as it is orphaned.
HOST_SIGNALS = os.environ.get('LCU_BB_RT_HOST_SIGNALS') == '1'


def _signal_scenario(*args, **options):
    return rt_scenario(*args, **options) if HOST_SIGNALS else (lambda fn: fn)


def _held(script=()):
    return [{'op': 'record_addresses'}, {'op': 'host', 'do': 'record'}, *script, {'op': 'ready'},
            {'op': 'await', 'file': 'go', 'timeoutMs': 30000}]


@_signal_scenario('rt/mac/signals', hosts=DARWIN, normalise=STATUSES)
def _(sb):
    ctx = place(sb, 'darwin')
    for name in ('SIGKILL', 'SIGTERM', 'SIGHUP', 'SIGINT', 'SIGUSR2'):
        # the child dies by a signal: what the launcher's status becomes
        _mac(sb, ctx, f'child killed by {name}', _held(), steps=[{'waitReady': True}, {'signal': name, 'to': 'probe'}],
             after=[{'exists': 'lifetime_dir', 'label': 'lifetime directory exists after exit'}], timeout=40)
    for name in ('SIGTERM', 'SIGINT', 'SIGHUP', 'SIGUSR2'):
        # the launcher is signalled while it supervises the child and the host
        _mac(sb, ctx, f'{name} to the launcher', _held(), probe={'signals': ['SIGTERM', 'SIGHUP', 'SIGINT']},
             steps=[{'waitReady': True}, {'signal': name, 'to': 'launcher'}, {'sleep': 1.0},
                    {'alive': 'launcher', 'label': 'launcher alive 1s later'},
                    {'alive': 'probe', 'label': 'child alive 1s later'},
                    {'alive': 'host', 'label': 'host alive 1s later'},
                    {'exists': 'lifetime_dir', 'label': 'lifetime directory exists 1s later'},
                    {'mark': 'go'}], timeout=40)


@_signal_scenario('rt/mac/host-killed', hosts=DARWIN, normalise=STATUSES)
def _(sb):
    # The host dies while the child runs: the launcher reports it once the child finishes.
    ctx = place(sb, 'darwin')
    for name in ('SIGKILL', 'SIGTERM', 'SIGHUP', 'SIGINT'):
        _mac(sb, ctx, f'host killed by {name}, child exits 0', _held(),
             steps=[{'waitReady': True}, {'signal': name, 'to': 'host'}, {'sleep': 0.5}, {'mark': 'go'}],
             after=[{'exists': 'lifetime_dir', 'label': 'lifetime directory exists after exit'}], timeout=40)
    _mac(sb, ctx, 'host killed, child exits 5', _held(), probe={'exit': 5},
         steps=[{'waitReady': True}, {'signal': 'SIGKILL', 'to': 'host'}, {'sleep': 0.5}, {'mark': 'go'}], timeout=40)
    _mac(sb, ctx, 'host killed, then a request to the lifetime socket',
         _held() + [{'op': 'connect', 'name': 'x', 'to': 'lifetime'}],
         steps=[{'waitReady': True}, {'signal': 'SIGKILL', 'to': 'host'}, {'sleep': 0.5}, {'mark': 'go'}], timeout=40)


@rt_scenario('rt/mac/hang-on-exit', hosts=DARWIN, normalise=STATUSES)
def _(sb):
    # A connection that stays open does not keep the launcher waiting for the host beyond its stdin closing.
    ctx = place(sb, 'darwin')
    _mac(sb, ctx, 'child leaves a silent connection open, then exits', [
        {'op': 'connect', 'name': 'idle', 'to': 'lifetime'}], timeout=40)
    _mac(sb, ctx, 'child leaves a partial request open, then exits', [
        {'op': 'connect', 'name': 'idle', 'to': 'lifetime'}, {'op': 'send', 'name': 'idle', 'text': '{"session_id":', 'newline': False}],
         timeout=40)
