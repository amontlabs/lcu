"""The MCP launch path: bin/lcu with no command line starts the original cua-repl under the app's Node.

The fake `cua-repl.mjs` records argv, cwd, the complete environment it was given (minus harness variables)
and stdin, so the snapshot pins down exactly what the original runtime would have received.
"""
import json
import os

from . import scenario

SERVER_DISCOVER = b'{"jsonrpc":"2.0","id":7,"method":"server/discover"}\n'
INITIALIZE = b'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n'
LINUX = ('linux', 'darwin')   # the Linux fixture is host-agnostic for the launch path


def _repl(sb, **config):
    sb.fake('cua-repl', **{'env': '*', 'stdin': True, **config})


@scenario('mcp/launch-linux', hosts=LINUX, normalise=('uuid',))
def _(sb):
    sb.place_release('linux')
    _repl(sb)
    sb.lcu(stdin=INITIALIZE)


@scenario('mcp/launch-linux-flags', hosts=LINUX, normalise=('uuid',))
def _(sb):
    sb.place_release('linux')
    _repl(sb)
    sb.lcu('--chrome', '--audio', stdin=INITIALIZE, label='lcu --chrome --audio')
    sb.lcu('--audio', '--chrome', stdin=b'', label='lcu --audio --chrome')


@scenario('mcp/launch-linux-env', hosts=LINUX, normalise=('uuid',))
def _(sb):
    # Caller-supplied variables keep precedence; defaults are filled in only where absent.
    sb.place_release('linux')
    _repl(sb)
    sb.lcu(stdin=b'', env={'CODEX_HOME': '/custom/codex-home', 'BUILD_FLAVOR': 'dev',
                           'NODE_REPL_NODE_MODULE_DIRS': '/extra/modules',
                           'NODE_REPL_REQUEST_META': json.dumps({'x-codex-turn-metadata': {'session_id': 's'}})},
           label='lcu with caller env')
    sb.lcu(stdin=b'', env={'CODEX_HOME': '', 'CUA_REPL_BROWSER_ENV': 'other'}, label='lcu with empty CODEX_HOME')
    sb.lcu(stdin=b'', env={'LCU_NODE_REPL_SANDBOX': 'off'}, label='lcu sandbox off')
    sb.lcu(stdin=b'', env={'LCU_NODE_REPL_SANDBOX': 'host', 'LCU_LINUX_INPUT_TRANSLATION': 'off'},
           label='lcu sandbox host, input translation off')
    sb.lcu(stdin=b'', env={'NODE_REPL_TRUSTED_SERVICES': json.dumps({'sky': '@oai/sky/service', 'x': 'y'})},
           label='lcu with trusted services map')
    sb.lcu(stdin=b'', env={'NODE_REPL_TRUSTED_SERVICES': '{"sky": "custom"}'}, label='lcu with custom sky')


@scenario('mcp/launch-linux-exit-status', hosts=LINUX, normalise=('uuid',))
def _(sb):
    # The child's exit status is the launcher's (it execs, it does not wrap).
    sb.place_release('linux')
    _repl(sb, default={'exit': 7, 'stderr': 'cua-repl failed\n'})
    sb.lcu(stdin=b'')


@scenario('mcp/discovery-compat', hosts=LINUX, normalise=('uuid',))
def _(sb):
    # The legacy server/discover probe is answered by the launcher; the rest of stdin goes to cua-repl.
    sb.place_release('linux')
    _repl(sb)
    sb.lcu('--mcp-discovery-compat', stdin=SERVER_DISCOVER + INITIALIZE)
    sb.lcu('--mcp-discovery-compat', stdin=b'not json\n', label='lcu --mcp-discovery-compat bad probe')
    sb.lcu('--mcp-discovery-compat', stdin=b'', label='lcu --mcp-discovery-compat empty stdin')


@scenario('mcp/unusable-cwd', hosts=LINUX, normalise=('uuid',))
def _(sb):
    # On Linux the launcher leaves a working directory the account cannot enter (as root the check passes).
    sb.place_release('linux')
    _repl(sb)
    blocked = sb.work / 'blocked'
    blocked.mkdir()
    os.chmod(blocked, 0o311)
    try:
        sb.lcu(stdin=b'', cwd=blocked)
    finally:
        os.chmod(blocked, 0o755)


@scenario('mcp/launch-darwin-codesign-failure', hosts=('darwin',))
def _(sb):
    # The darwin app is verified with codesign before anything starts; a failing verify stops the launch.
    sb.place_release('darwin')
    sb.fake('codesign', default={'exit': 1, 'stderr': 'a sealed resource is missing or invalid\n'})
    sb.lcu(stdin=b'')


@scenario('mcp/launch-no-installation', hosts=LINUX)
def _(sb):
    sb.place_release('linux', installation=False)
    sb.lcu(stdin=b'')


@scenario('sandbox-shim/cases', hosts=LINUX)
def _(sb):
    """bin/lcu-codex-sandbox: passthrough, availability probe, kernel, and a refused unrecognised invocation."""
    sb.place_release('linux')
    app = sb.apps / 'chatgpt'
    runtime = app / 'resources/cua_node'
    shim = sb.release / 'bin/lcu-codex-sandbox'
    config = json.dumps({'codex': str(app / 'resources/codex'), 'runtime': str(runtime), 'wrapper': None})
    env = {'LCU_SANDBOX_SHIM': config}
    prefix = ['sandbox', '-c', 'shell_environment_policy.inherit="all"', '-c', 'default_permissions="node_repl"']
    profile = 'permissions.node_repl={filesystem={}, network={}}'
    sb.run([shim, '--version'], env=env, label='shim --version')
    sb.run([shim, 'sandbox', '--', '/bin/sh', '-c', 'true'], env=env, label='shim sandbox probe')
    sb.run([shim, *prefix, '-c', profile, '--', runtime / 'bin/node', '--experimental-vm-modules',
            '/tmp/kernel.js', '--session-id', 's', '--working-dir', '/w'], env=env, label='shim sandbox kernel')
    sb.run([shim, 'sandbox', '--bogus'], env=env, label='shim sandbox refused')
    sb.run([shim, '--version'], label='shim without configuration')
