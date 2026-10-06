"""The MCP launch path `bin/lcu`: what the child (the fake original cua-repl, `assets/rt/probe.mjs`) is given and
how the launcher behaves around it: process tree, exit status, stdin, large output, signals and what they do to
the child, inherited signal masks and descriptors, NODE_* variables, invocation forms and working directories.

Everything is observed from outside. `drive()` runs `bin/lcu` under `assets/rt/driver.py`, which prints
relationships between pids (never pids) so the same facts can be compared across implementations.
"""
import base64
import json
import os

import fixtures_rt as rt
from fixtures_rt import drive, place, rt_scenario

INITIALIZE = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n'
STATUSES = ('uuid',)


def _launch(sb, ctx, label, *args, probe=None, env=None, **spec):
    probe = {'stdin': 'none', 'env': False, **(probe or {})}
    spec = {'args': list(args), 'probe': probe, 'env': env or {}, **spec}
    return drive(sb, ctx, spec, label=label)


@rt_scenario('rt/launch/process-tree', normalise=STATUSES)
def _(sb):
    # The launcher replaces itself with the child (exec): same pid, same parent. No helper processes.
    ctx = place(sb, 'linux')
    _launch(sb, ctx, 'lcu', relations=True)
    _launch(sb, ctx, 'lcu --chrome --audio', '--chrome', '--audio', relations=True)
    _launch(sb, ctx, 'lcu --mcp-discovery-compat', '--mcp-discovery-compat', stdin=INITIALIZE.replace('initialize', 'server/discover'), relations=True)
    _launch(sb, ctx, 'lcu via prefix/current symlink', relations=True, argv=[str(sb.prefix / 'current/bin/lcu')])


@rt_scenario('rt/launch/process-tree-darwin', hosts=('darwin',), normalise=STATUSES)
def _(sb):
    # The darwin fixture without the computer surface starts no lifecycle host: the same exec.
    ctx = place(sb, 'darwin')
    _launch(sb, ctx, 'darwin lcu, browser surface only', relations=True,
            env={'CUA_REPL_ENABLED_SURFACES': 'browser'})
    _launch(sb, ctx, 'darwin lcu --chrome, empty surfaces', '--chrome', relations=True,
            env={'CUA_REPL_ENABLED_SURFACES': ''})


@rt_scenario('rt/launch/exit-status', hosts=rt.LINUX, normalise=STATUSES)  # signals: Docker only
def _(sb):
    ctx = place(sb, 'linux')
    for code in (0, 1, 2, 7, 42, 126, 127, 255):
        _launch(sb, ctx, f'child exits {code}', probe={'exit': code})
    for name in ('SIGKILL', 'SIGTERM', 'SIGHUP', 'SIGINT', 'SIGUSR2', 'SIGALRM'):
        # The driver signals the child (session-checked send()); with exec the child is the launcher process.
        _launch(sb, ctx, f'child killed by {name}', probe={'ready': True, 'readyEarly': True, 'hold': True},
                steps=[{'waitReady': True}, {'signal': name, 'to': 'probe'}], timeout=15)
    _launch(sb, ctx, 'child writes to stderr then exits 3', probe={'exit': 3, 'printErr': 'cua-repl: fatal\n'})
    # LCU's own failures keep the launcher's status
    _launch(sb, ctx, 'lcu with an unknown option', '--bogus')
    _launch(sb, ctx, 'lcu --chrome --chrome', '--chrome', '--chrome')


@rt_scenario('rt/launch/stdin', normalise=STATUSES)
def _(sb):
    # The child inherits stdin untouched: bytes written before and after the launch reach it, EOF is EOF.
    ctx = place(sb, 'linux')
    _launch(sb, ctx, 'stdin /dev/null', probe={'stdin': 'all'}, stdin=None)
    _launch(sb, ctx, 'stdin one line then EOF', probe={'stdin': 'all'}, stdin=INITIALIZE)
    _launch(sb, ctx, 'stdin no trailing newline', probe={'stdin': 'all'}, stdin='{"a":1}')
    _launch(sb, ctx, 'stdin in two writes with a pause', probe={'stdin': 'all'},
            stdin=[{'write': INITIALIZE}, {'sleep': 1.0}, {'write': INITIALIZE}, {'close': True}])
    _launch(sb, ctx, 'stdin 300000 bytes', probe={'stdin': 'all'}, stdin=[{'fill': 300000}, {'close': True}])
    _launch(sb, ctx, 'stdin redirected from a file', probe={'stdin': 'all', 'stdinKind': True},
            stdinFile=INITIALIZE)
    _launch(sb, ctx, 'stdin kind: pipe', probe={'stdinKind': True}, stdin=[{'close': True}])
    _launch(sb, ctx, 'stdin kind: /dev/null', probe={'stdinKind': True}, stdin=None)
    _launch(sb, ctx, 'child echoes stdin', probe={'stdin': 'echo'}, stdin=INITIALIZE)
    _launch(sb, ctx, 'child never reads stdin and exits', probe={}, stdin=[{'write': INITIALIZE}])
    _launch(sb, ctx, 'invalid UTF-8 on stdin', probe={'stdin': 'all'}, stdin=[{'b64': base64.b64encode(b'\xff\xfe{}\n').decode()}, {'close': True}])


@rt_scenario('rt/launch/large-output', normalise=STATUSES)
def _(sb):
    ctx = place(sb, 'linux')
    _launch(sb, ctx, 'stdout 300000 bytes', probe={'stdout': 300000}, show={'stdout': 'sha'})
    _launch(sb, ctx, 'stderr 200000 bytes', probe={'stderr': 200000}, show={'stderr': 'sha'})
    _launch(sb, ctx, 'both, slow reader', probe={'stdout': 400000, 'stderr': 300000}, slowRead=0.01,
            show={'stdout': 'sha', 'stderr': 'sha'})
    _launch(sb, ctx, 'output then non-zero exit', probe={'stdout': 70000, 'exit': 9}, show={'stdout': 'sha'})


def _signals(sb, ctx, label, signals, *, args=(), handled=True, env=None, probe=None, **spec):
    config = {'ready': True, 'readyEarly': True, 'hold': True, 'signals': list(signals) if handled else [],
              'signalExit': 40, **(probe or {})}
    steps = [{'waitReady': True}, *[{'signal': name, 'to': 'launcher'} for name in (spec.pop('send', None) or [])],
             {'waitExit': 5}]
    return _launch(sb, ctx, label, *args, probe=config, env=env, steps=steps, timeout=15, relations=True, **spec)


@rt_scenario('rt/launch/signals', hosts=rt.LINUX, normalise=STATUSES)  # signals: Docker only
def _(sb):
    # Signals sent to the launcher after the child is running. With exec the child IS the launcher process.
    ctx = place(sb, 'linux')
    for name in ('SIGTERM', 'SIGINT', 'SIGHUP', 'SIGUSR2', 'SIGQUIT'):
        _signals(sb, ctx, f'{name} to a child that handles it', [name], send=[name])
    for name in ('SIGTERM', 'SIGINT', 'SIGHUP'):
        _signals(sb, ctx, f'{name} to a child that does not handle it', [], handled=False, send=[name])
    # handled without exiting, one at a time, then ended with SIGKILL
    _launch(sb, ctx, 'SIGTERM, SIGINT, SIGHUP handled in turn, then SIGKILL',
            probe={'ready': True, 'readyEarly': True, 'hold': True, 'signals': ['SIGTERM', 'SIGINT', 'SIGHUP']},
            steps=[{'waitReady': True}, {'signal': 'SIGTERM'}, {'sleep': 0.3}, {'signal': 'SIGINT'}, {'sleep': 0.3},
                   {'signal': 'SIGHUP'}, {'sleep': 0.3}, {'alive': 'launcher', 'label': 'still running'},
                   {'signal': 'SIGKILL'}, {'waitExit': 5}], timeout=15, relations=True)
    _signals(sb, ctx, 'same with --chrome --audio', ['SIGTERM'], send=['SIGTERM'], args=('--chrome', '--audio'))


@rt_scenario('rt/launch/signal-inheritance', hosts=rt.LINUX, normalise=STATUSES)  # signals: Docker only
def _(sb):
    # Signal masks and dispositions, and open descriptors, survive the launch as they do through exec.
    ctx = place(sb, 'linux')
    config = {'ready': True, 'readyEarly': True, 'hold': True, 'signals': ['SIGUSR2', 'SIGHUP', 'SIGTERM'],
              'signalExit': 41}
    _launch(sb, ctx, 'SIGUSR2 blocked at start, SIGHUP ignored at start', probe=config, blockSignals=['SIGUSR2'],
            ignoreSignals=['SIGHUP'], relations=True,
            steps=[{'waitReady': True}, {'signal': 'SIGUSR2'}, {'sleep': 0.5}, {'signal': 'SIGHUP'},
                   {'sleep': 0.5}, {'alive': 'launcher', 'label': 'alive after SIGUSR2+SIGHUP'},
                   {'signal': 'SIGTERM'}, {'waitExit': 5}], timeout=15)
    _launch(sb, ctx, 'SIGINT ignored at start', probe={**config, 'signals': []}, ignoreSignals=['SIGINT'],
            steps=[{'waitReady': True}, {'signal': 'SIGINT'}, {'sleep': 0.5},
                   {'alive': 'launcher', 'label': 'alive after SIGINT'}, {'signal': 'SIGTERM'}, {'waitExit': 5}],
            timeout=15)
    _launch(sb, ctx, 'inherited descriptors 20 and 21', probe={'fds': [20, 21, 22]}, passFds=[20, 21])
    _launch(sb, ctx, 'no extra descriptors', probe={'fds': [20, 21, 22]})


NODE_CASES = (
    ('NODE_OPTIONS=--max-old-space-size=64', {'NODE_OPTIONS': '--max-old-space-size=64'}),
    ('NODE_OPTIONS empty', {'NODE_OPTIONS': ''}),
    ('NODE_OPTIONS unknown option (node refuses to start)', {'NODE_OPTIONS': '--not-a-node-option'}),
    ('NODE_OPTIONS=--no-warnings --enable-source-maps', {'NODE_OPTIONS': '--no-warnings --enable-source-maps'}),
    ('NODE_PATH', {'NODE_PATH': '/nonexistent/a:/nonexistent/b'}),
    ('NODE_ENV and NODE_NO_WARNINGS', {'NODE_ENV': 'production', 'NODE_NO_WARNINGS': '1'}),
    ('NODE_DISABLE_COLORS and FORCE_COLOR', {'NODE_DISABLE_COLORS': '1', 'FORCE_COLOR': '0'}),
    ('NODE_TLS_REJECT_UNAUTHORIZED=0', {'NODE_TLS_REJECT_UNAUTHORIZED': '0'}),
    ('NODE_EXTRA_CA_CERTS missing file (node warns once per process)', {'NODE_EXTRA_CA_CERTS': '/nonexistent/ca.pem'}),
    ('NODE_EXTRA_CA_CERTS missing file, warnings off', {'NODE_EXTRA_CA_CERTS': '/nonexistent/ca.pem', 'NODE_NO_WARNINGS': '1'}),
    ('NODE_REPL_* and NODE_ADAPTER style variables', {'NODE_REPL_FOO': 'x', 'NODE_FOO': 'bar baz', 'NODE_': '1'}),
    ('UV_THREADPOOL_SIZE and NODE_DEBUG_NATIVE', {'UV_THREADPOOL_SIZE': '2', 'NODE_DEBUG_NATIVE': ''}),
    ('NODE_PENDING_DEPRECATION', {'NODE_PENDING_DEPRECATION': '1', 'NODE_PRESERVE_SYMLINKS': '1'}),
)


@rt_scenario('rt/launch/node-env', normalise=STATUSES)
def _(sb):
    # NODE_* variables in the caller's environment pass through to the child exactly, and must not act on (or be
    # consumed by) the launcher itself: the child runs once, with the same variables and execArgv.
    ctx = place(sb, 'linux')
    for label, env in NODE_CASES:
        _launch(sb, ctx, label, env=env, probe={'env': True})
    preload = sb.bb / 'rt/preload.cjs'
    preload.write_text("require('node:fs').appendFileSync(process.env.LCU_BB_LOG, JSON.stringify("
                       "{tool: 'preload', argv: process.argv.slice(1), execArgv: process.execArgv}) + '\\n');\n")
    ctx.preload = preload
    _launch(sb, ctx, 'NODE_OPTIONS=--require preload (runs once, in the child)', env={'NODE_OPTIONS': f'--require {preload}'})
    _launch(sb, ctx, 'NODE_OPTIONS=--require preload, discovery compat', '--mcp-discovery-compat',
            env={'NODE_OPTIONS': f'--require {preload}'}, stdin='{"jsonrpc":"2.0","id":3,"method":"server/discover"}\n')
    coverage = sb.bb / 'rt/coverage'
    coverage.mkdir(exist_ok=True)
    _launch(sb, ctx, 'NODE_V8_COVERAGE writes one report per Node process', env={'NODE_V8_COVERAGE': str(coverage)},
            coverage=str(coverage))
