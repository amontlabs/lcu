"""bin/lcu-codex-sandbox (CODEX_CLI_PATH shim for node_repl on Linux): every branch of the decision.

Configuration parsing (fails closed), pass-through of non-sandbox subcommands, the availability probe, the exact
`codex sandbox` format node_repl uses (TOML permission profile included), kernel vs trusted-worker classification,
fault injection, and identification of the genuine Sky worker (which needs /proc: Docker only). The real Codex is
the fixture app's recorder, so the log shows exactly what was exec'd.
"""
import json
import os

from fixtures_rt import BOTH, LINUX, drive, place, rt_scenario

PREFIX = ['sandbox', '-c', 'shell_environment_policy.inherit="all"', '-c', 'default_permissions="node_repl"']
PROFILE = 'permissions.node_repl={filesystem={":root"="read", ":tmpdir"="write"}, network={enabled=false}}'


def _ctx(sb):
    ctx = place(sb, 'linux')
    ctx.shim = ctx.release / 'bin/lcu-codex-sandbox'
    ctx.rt = ctx.release / 'app/resources/cua_node'
    ctx.codex = ctx.release / 'app/resources/codex'
    ctx.wrapper = ctx.release / 'lcu/linux_sky_service.mjs'
    return ctx


def _config(ctx, **override):
    return json.dumps({'codex': str(ctx.codex), 'runtime': str(ctx.rt), 'wrapper': str(ctx.wrapper), **override})


def _shim(sb, ctx, label, args, *, config=None, env=None):
    environment = {'LCU_SANDBOX_SHIM': config if config is not None else _config(ctx), **(env or {})}
    if config is False:
        environment['LCU_SANDBOX_SHIM'] = None
    return sb.run([ctx.shim, *args], env=environment, label=label)


def _kernel(ctx, *extra):
    return [str(ctx.rt / 'bin/node'), '--experimental-vm-modules', '/tmp/x/kernel.js', '--session-id', 's',
            '--working-dir', '/w', *extra]


@rt_scenario('rt/shim/configuration', hosts=BOTH)
def _(sb):
    ctx = _ctx(sb)
    for label, config in (
        ('no configuration', False), ('empty', ''), ('not JSON', '{'), ('list', '[]'), ('null', 'null'),
        ('codex missing', json.dumps({'runtime': str(ctx.rt), 'wrapper': None})),
        ('codex not a string', json.dumps({'codex': 1, 'runtime': str(ctx.rt), 'wrapper': None})),
        ('runtime missing', json.dumps({'codex': str(ctx.codex), 'wrapper': None})),
        ('wrapper missing (allowed)', json.dumps({'codex': str(ctx.codex), 'runtime': str(ctx.rt)})),
        ('wrapper null', _config(ctx, wrapper=None)), ('wrapper a number', _config(ctx, wrapper=3)),
        ('extra keys', _config(ctx, extra=[1])),
        ('duplicate keys', '{"codex":"/x","codex":%s,"runtime":%s,"wrapper":null}' % (json.dumps(str(ctx.codex)), json.dumps(str(ctx.rt)))),
    ):
        _shim(sb, ctx, f'--version, configuration {label}', ['--version'], config=config)
    _shim(sb, ctx, 'no arguments', [])
    _shim(sb, ctx, 'other subcommand with options', ['exec', '--json', '-c', 'x=1', 'prompt with spaces'])
    _shim(sb, ctx, 'empty argument', [''])
    _shim(sb, ctx, 'Sandbox (capitalised) is not the sandbox subcommand', ['Sandbox', '--bogus'])


@rt_scenario('rt/shim/sandbox-format', hosts=BOTH)
def _(sb):
    ctx = _ctx(sb)
    _shim(sb, ctx, 'availability probe', ['sandbox', '--', '/bin/sh', '-c', 'true'])
    _shim(sb, ctx, 'probe with options before --', ['sandbox', '-c', 'x=1', '--', '/bin/sh', '-c', 'echo hi'])
    _shim(sb, ctx, 'probe only after the first --', ['sandbox', '--', 'x', '--', '/bin/sh'])
    _shim(sb, ctx, '/bin/sh not right after --', ['sandbox', '--', 'env', '/bin/sh'])
    _shim(sb, ctx, 'sandbox alone', ['sandbox'])
    _shim(sb, ctx, 'sandbox --', ['sandbox', '--'])
    _shim(sb, ctx, 'kernel', [*PREFIX, '-c', PROFILE, '--', *_kernel(ctx)])
    variants = (
        ('prefix: inherit value differs', ['sandbox', '-c', 'shell_environment_policy.inherit="core"', *PREFIX[3:], '-c', PROFILE, '--', *_kernel(ctx)]),
        ('prefix: options swapped', ['sandbox', *PREFIX[3:], *PREFIX[1:3], '-c', PROFILE, '--', *_kernel(ctx)]),
        ('no profile', [*PREFIX, '--', *_kernel(ctx)]),
        ('profile key differs', [*PREFIX, '-c', PROFILE.replace('node_repl=', 'other='), '--', *_kernel(ctx)]),
        ('no -- after the profile', [*PREFIX, '-c', PROFILE, *_kernel(ctx)]),
        ('nothing after --', [*PREFIX, '-c', PROFILE, '--']),
        ('-c spelled --config', [*PREFIX, '--config', PROFILE, '--', *_kernel(ctx)]),
    )
    for label, args in variants:
        _shim(sb, ctx, label, args)


PROFILES = (
    ('spaces everywhere', 'permissions.node_repl= { filesystem = { ":root" = "read" } , network = { enabled = false } }'),
    ('empty tables', 'permissions.node_repl={filesystem={}, network={}}'),
    ('literal strings', "permissions.node_repl={filesystem={':root'='read'}, network={}}"),
    ('bare keys', 'permissions.node_repl={filesystem={root="read"}, network={}}'),
    ('escapes in strings', 'permissions.node_repl={filesystem={"/a\\"b"="r\\u00e9ad", "\\t"="x"}, network={}}'),
    ('unicode', 'permissions.node_repl={filesystem={"/é☃"="read"}, network={}}'),
    ('network with nested values', 'permissions.node_repl={filesystem={}, network={enabled=false, ports=[1,2], m={a=1}, t=1979-05-27T07:32:00Z}}'),
    ('dotted key inside', 'permissions.node_repl={filesystem={a.b="read"}, network={}}'),
    ('filesystem value not a string', 'permissions.node_repl={filesystem={":root"=true}, network={}}'),
    ('filesystem value a table', 'permissions.node_repl={filesystem={":root"={a="b"}}, network={}}'),
    ('filesystem missing', 'permissions.node_repl={network={}}'),
    ('network missing', 'permissions.node_repl={filesystem={}}'),
    ('network not a table', 'permissions.node_repl={filesystem={}, network=false}'),
    ('extra key', 'permissions.node_repl={filesystem={}, network={}, other={}}'),
    ('not a table', 'permissions.node_repl=[1,2]'),
    ('a string', 'permissions.node_repl="x"'),
    ('empty value', 'permissions.node_repl='),
    ('trailing comma', 'permissions.node_repl={filesystem={}, network={},}'),
    ('newline inside the table', 'permissions.node_repl={filesystem={},\nnetwork={}}'),
    ('newline then another key', 'permissions.node_repl={filesystem={}, network={}}\nfoo = 1'),
    ('newline then profile again', 'permissions.node_repl={filesystem={}, network={}}\nprofile = 1'),
    ('comment after', 'permissions.node_repl={filesystem={}, network={}} # c'),
    ('duplicate key', 'permissions.node_repl={filesystem={}, filesystem={}, network={}}'),
    ('unterminated', 'permissions.node_repl={filesystem={}, network={}'),
    ('invalid escape', 'permissions.node_repl={filesystem={"\\q"="r"}, network={}}'),
    ('multi-line string', 'permissions.node_repl={filesystem={a="""x"""}, network={}}'),
    ('integer forms', 'permissions.node_repl={filesystem={}, network={a=0x10, b=1_000, c=+1, d=inf, e=nan}}'),
    ('CRLF after', 'permissions.node_repl={filesystem={}, network={}}\r\n'),
    ('NUL character', 'permissions.node_repl={filesystem={"a\\u0000"="r"}, network={}}'),
)


@rt_scenario('rt/shim/profiles', hosts=BOTH)
def _(sb):
    # The TOML permission profile is parsed with the TOML 1.0 rules of Python's tomllib; anything else refuses.
    ctx = _ctx(sb)
    for label, profile in PROFILES:
        _shim(sb, ctx, 'profile: ' + label, [*PREFIX, '-c', profile, '--', *_kernel(ctx)])


@rt_scenario('rt/shim/commands', hosts=BOTH)
def _(sb):
    ctx = _ctx(sb)
    node = str(ctx.rt / 'bin/node')
    (sb.work / 'node-link').symlink_to(ctx.rt / 'bin/node')
    commands = (
        ('kernel with node through a symlink', [str(sb.work / 'node-link'), '--experimental-vm-modules', '/k/kernel.js', '--session-id', 's', '--working-dir', '/w']),
        ('kernel with real node path', [os.path.realpath(node), '--experimental-vm-modules', '/k/kernel.js', '--session-id', 's', '--working-dir', '/w']),
        ('kernel, other node', ['/usr/bin/node', '--experimental-vm-modules', '/k/kernel.js', '--session-id', 's', '--working-dir', '/w']),
        ('kernel, relative node', ['bin/node', '--experimental-vm-modules', '/k/kernel.js', '--session-id', 's', '--working-dir', '/w']),
        ('kernel, missing flag', [node, '/k/kernel.js', '--session-id', 's', '--working-dir', '/w']),
        ('kernel, relative script', [node, '--experimental-vm-modules', 'kernel.js', '--session-id', 's', '--working-dir', '/w']),
        ('kernel, one argument short', [node, '--experimental-vm-modules', '/k/kernel.js', '--session-id', 's', '--working-dir']),
        ('kernel, one argument extra', _kernel(ctx, 'x')),
        ('kernel, options swapped', [node, '--experimental-vm-modules', '/k/kernel.js', '--working-dir', '/w', '--session-id', 's']),
        ('script named differently', [node, '--experimental-vm-modules', '/k/kernel.mjs', '--session-id', 's', '--working-dir', '/w']),
        ('worker, not node_repl parent', [node, '--experimental-vm-modules', '/k/trusted-worker.js', '/abs']),
        ('worker, relative argument', [node, '--experimental-vm-modules', '/k/trusted-worker.js', 'rel']),
        ('worker, extra argument', [node, '--experimental-vm-modules', '/k/trusted-worker.js', '/abs', 'x']),
        ('only node', [node]), ('node and flag', [node, '--experimental-vm-modules']),
    )
    for label, command in commands:
        _shim(sb, ctx, label, [*PREFIX, '-c', PROFILE, '--', *command])
    for fault in ('unrecognized-kernel', 'unrecognized-worker', 'unrecognized-format', 'other', ''):
        _shim(sb, ctx, f'fault {fault!r}, kernel', [*PREFIX, '-c', PROFILE, '--', *_kernel(ctx)],
              env={'LCU_TEST_SANDBOX_SHIM_FAULT': fault})
        _shim(sb, ctx, f'fault {fault!r}, worker', [*PREFIX, '-c', PROFILE, '--', node, '--experimental-vm-modules',
                                                  '/k/trusted-worker.js', '/abs'], env={'LCU_TEST_SANDBOX_SHIM_FAULT': fault})
        _shim(sb, ctx, f'fault {fault!r}, probe', ['sandbox', '--', '/bin/sh', '-c', 'true'],
              env={'LCU_TEST_SANDBOX_SHIM_FAULT': fault})


WORKER = ("require('node:fs').appendFileSync(process.env.LCU_BB_LOG, JSON.stringify({tool: 'trusted-worker', "
          "argv: process.argv.slice(2), execArgv: process.execArgv, cwd: process.cwd(), "
          "shim: process.env.LCU_SANDBOX_SHIM ? 'set' : 'unset', codex: process.env.CODEX_CLI_PATH}) + '\\n');\n")


@rt_scenario('rt/shim/worker', hosts=LINUX)
def _(sb):
    # Identification of the genuine Sky worker needs its parent's /proc/PID/exe to be the runtime's node_repl:
    # node_repl is replaced by a copy of /bin/sh, which then starts the shim exactly like node_repl would.
    ctx = _ctx(sb)
    node_repl = ctx.rt / 'bin/node_repl'
    node_repl.unlink()
    import shutil
    shutil.copy('/bin/sh', node_repl)
    node_repl.chmod(0o755)
    folder = sb.tmp / '.tmpWorker1'
    folder.mkdir(mode=0o700)
    (folder / 'kernel.js').write_text('')
    script = folder / 'trusted-worker.js'
    script.write_text(WORKER)
    script.chmod(0o600)
    node = str(ctx.rt / 'bin/node')
    worker = [*PREFIX, '-c', PROFILE, '--', node, '--experimental-vm-modules', str(script), str(sb.work)]
    sky = {'NODE_REPL_TRUSTED_SERVICES': json.dumps({'sky': '@oai/sky/service'})}

    def via_node_repl(label, args=worker, env=None, config=None):
        environment = {'LCU_SANDBOX_SHIM': config or _config(ctx), **(env if env is not None else sky)}
        sb.run([node_repl, '-c', '"$0" "$@"; exit $?', ctx.shim, *args], env=environment, label=label)

    via_node_repl('genuine worker, original Sky service')
    via_node_repl('genuine worker, Sky wrapper', env={'NODE_REPL_TRUSTED_SERVICES': json.dumps({'sky': str(ctx.wrapper)})})
    via_node_repl('wrapper named but configuration has none',
                  env={'NODE_REPL_TRUSTED_SERVICES': json.dumps({'sky': str(ctx.wrapper)})}, config=_config(ctx, wrapper=None))
    via_node_repl('Sky plus original browser service (package missing)',
                  env={'NODE_REPL_TRUSTED_SERVICES': json.dumps({'sky': '@oai/sky/service', 'browser': '@oai/browser-desktop/service'})})
    for label, services in (('no services variable', None), ('services not JSON', 'x'), ('no Sky', '{}'),
                            ('custom Sky', '{"sky":"custom"}'), ('extra service', '{"sky":"@oai/sky/service","x":"y"}'),
                            ('non-string value', '{"sky":1}')):
        via_node_repl(f'worker, {label}', env={} if services is None else {'NODE_REPL_TRUSTED_SERVICES': services})
    sb.run([ctx.shim, *worker], env={'LCU_SANDBOX_SHIM': _config(ctx), **sky}, label='worker started directly, not by node_repl')
    via_node_repl('kernel via node_repl stays sandboxed', [*PREFIX, '-c', PROFILE, '--', *_kernel(ctx)])
    # the script's folder and file must be node_repl's own private temporary folder
    script.chmod(0o644)
    via_node_repl('script readable by others is fine (0644)')
    script.chmod(0o666)
    via_node_repl('script writable by others')
    script.chmod(0o620)
    via_node_repl('script group-writable, own group')
    script.chmod(0o600)
    folder.chmod(0o777)
    via_node_repl('folder writable by others')
    folder.chmod(0o700)
    (folder / 'kernel.js').unlink()
    via_node_repl('no sibling kernel.js')
    (folder / 'kernel.js').write_text('')
    other = sb.tmp / 'worker2'
    other.mkdir(mode=0o700)
    (other / 'kernel.js').write_text('')
    (other / 'trusted-worker.js').write_text(WORKER)
    via_node_repl('folder not named .tmp*', [*PREFIX, '-c', PROFILE, '--', node, '--experimental-vm-modules',
                                             str(other / 'trusted-worker.js'), '/abs'])
    via_node_repl('TMPDIR elsewhere', env={**sky, 'TMPDIR': str(sb.work)})
    link_folder = sb.tmp / '.tmpLinked'
    link_folder.mkdir(mode=0o700)
    (link_folder / 'kernel.js').write_text('')
    (link_folder / 'trusted-worker.js').symlink_to(script)
    via_node_repl('script is a symlink', [*PREFIX, '-c', PROFILE, '--', node, '--experimental-vm-modules',
                                          str(link_folder / 'trusted-worker.js'), '/abs'])
    via_node_repl('script missing', [*PREFIX, '-c', PROFILE, '--', node, '--experimental-vm-modules',
                                     str(folder / 'nope/trusted-worker.js'), '/abs'])
    via_node_repl('fault unrecognized-worker', env={**sky, 'LCU_TEST_SANDBOX_SHIM_FAULT': 'unrecognized-worker'})
