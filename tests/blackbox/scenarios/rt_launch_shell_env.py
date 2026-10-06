"""bin/lcu: what the /bin/sh launcher does to the caller's environment before the app Node starts.

The oracle's Python launcher handed its environment to the app Node unchanged. An sh launcher cannot be fully
transparent: dash (Linux /bin/sh) drops variables whose names are not shell identifiers and resets IFS and PWD,
bash (macOS /bin/sh) adds or rewrites PWD, OLDPWD, SHLVL and `_`. probe.mjs and recorder.mjs hide PWD, OLDPWD,
SHLVL and `_` for both sides, and the usual shell wrapper of the fake app would apply a shell's rewrite a second
time, so this scenario records the environment the Node process is exec'd with, raw: the fake app's `node` is a
Node script started through a `#!<absolute node>` line (no shell in between) that logs its environment and then
execve()s the real Node with it unchanged. The differences are pinned by exact `launcher-shell-env` entries in
deviations.json.
"""
import fixtures
import sandbox
from fixtures_rt import place, rt_scenario
from scenarios.rt_launch import STATUSES, _launch

RAW_ENV_NODE = r'''#!{node}
const fs = require('node:fs');
const env = process.env;
if (process.argv.slice(2).some((arg) => arg.endsWith('/cua-repl.mjs'))) {
  const shown = Object.fromEntries(Object.entries(env)
    .filter(([key]) => !/^(LCU_BB_|RT_|__LCU_)/.test(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  fs.appendFileSync(env.LCU_BB_LOG, JSON.stringify({ tool: 'raw-launcher-environ', env: shown }) + '\n');
}
process.execve(env.LCU_BB_NODE, [env.LCU_BB_NODE, ...process.argv.slice(2)], env);
'''


@rt_scenario('rt/launch/shell-env', normalise=STATUSES)
def _(sb):
    ctx = place(sb, 'linux')
    # The interpreter is named by absolute path: LCU puts the runtime's bin first in PATH, where `env node` would
    # find this very file again.
    fixtures.write(ctx.runtime / 'bin/node', RAW_ENV_NODE.replace('#!{node}', f'#!{sandbox._real_node()}', 1), 0o755)
    cwd = sb.work / 'real-cwd'
    cwd.mkdir()
    odd = {'A.B': 'dot', 'FOO-BAR': 'dash', 'SPACE KEY': 'space', '1STARTS': 'digit', 'lower': 'plain',
           'IFS': 'xyz', 'PWD': '/caller/logical/pwd', 'OLDPWD': '/caller/previous', 'SHLVL': '7',
           '_': '/caller/tool', 'PS4': '+caller ', 'ENV': '/nonexistent/env-file'}
    _launch(sb, ctx, 'odd names and shell-managed variables', env=odd, cwd=str(cwd), probe={'env': False})
    _launch(sb, ctx, 'ordinary environment', env={'lower': 'plain', 'UPPER': 'x'}, cwd=str(cwd), probe={'env': False})
