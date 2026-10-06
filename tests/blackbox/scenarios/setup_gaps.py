"""`lcu setup` branches found unexercised by `run.py --coverage`: bundled-installer checks, unexpected add-mcp
output, browser status unavailable, OMP adapter missing, legacy Claude approval rule, OMP approval reset, the
app-server teardown escalation."""
import json

import fixtures
import fixtures_setup as fs
from fixtures_setup import setup_scenario


@setup_scenario('setup/installer-paths')
def _(sb):
    fs.place(sb)
    index = sb.release / 'agent-tools/node_modules/add-mcp/dist/index.js'
    index.rename(index.with_suffix('.off'))
    fs.setup(sb, '--agent', 'codex', label='add-mcp entry missing')
    fs.setup(sb, '--export', str(sb.work / 'exp'), label='export does not need the installers')
    index.with_suffix('.off').rename(index)
    cli = sb.release / 'agent-tools/node_modules/skills/bin/cli.mjs'
    cli.rename(cli.with_suffix('.off'))
    fs.setup(sb, '--agent', 'pi', label='skills CLI missing')
    cli.with_suffix('.off').rename(cli)
    node = sb.apps / 'chatgpt/resources/cua_node/bin/node'
    node.chmod(0o644)
    fs.setup(sb, '--agent', 'pi', label='bundled node not executable')
    node.chmod(0o755)


@setup_scenario('setup/codex-register-unexpected-output')
def _(sb):
    fs.place(sb, agent_tools='fake')
    lib = sb.release / 'agent-tools/node_modules/add-mcp/dist/lib.js'
    for label, result in (('no path', '{ success: true }'), ('path is a number', '{ success: true, path: 3 }'),
                          ('not successful', '{ success: false, error: "nope" }')):
        fixtures.write(lib, "export const agents = { codex: { format: 'toml', configKey: 'mcp_servers', "
                            "configPath: '/nonexistent/config.toml', transformConfig: (c) => c } };\n"
                            f'export function upsertServer() {{ return {result}; }}\n')
        fs.setup(sb, '--agent', 'codex', label='add-mcp result: ' + label)
    # The preflight refuses a configuration format it does not know.
    fs.put(sb, 'agent.yaml', 'x: 1\n')
    fixtures.write(lib, "export const agents = { codex: { format: 'yaml', configKey: 'mcp', "
                        "configPath: '/home/ubuntu/agent.yaml', transformConfig: (c) => c } };\n"
                        'export function upsertServer() { return { success: true, path: "/x" }; }\n')
    fs.setup(sb, '--agent', 'codex', label='add-mcp agent with an unsupported format')


@setup_scenario('setup/chrome-status-unavailable')
def _(sb):
    fs.place(sb)
    (sb.apps / 'chatgpt/resources/plugins/openai-bundled/plugins/chrome/scripts/extension-ids.json').write_text('{')
    fs.setup(sb, '--agent', 'pi', '--chrome', label='lcu browser status fails without stdout')


@setup_scenario('setup/omp-adapter-missing')
def _(sb):
    fs.place(sb)
    adapter = sb.release / 'adapters/pi/index.ts'
    adapter.rename(adapter.with_suffix('.off'))
    fs.setup(sb, '--agent', 'omp', '--agent', 'pi', label='pi/omp adapter missing')


@setup_scenario('setup/approval-claude-legacy-rule')
def _(sb):
    fs.place(sb)
    fs.put(sb, '.claude/settings.json', json.dumps({'permissions': {'allow': ['mcp__lcu', 'Read']}}))
    fs.put(sb, '.local/state/lcu/approval.json',
           json.dumps({'claude-code|/home/ubuntu/.claude/settings.json': {'added': ['mcp__lcu']}}, indent=2) + '\n')
    fs.setup(sb, '--agent', 'claude-code', '--approval', 'auto', label='legacy mcp__lcu rule LCU added is replaced')


@setup_scenario('setup/approval-omp-reset')
def _(sb):
    fs.place(sb)
    sb.fake('omp', rules=[{'argv': ['config', 'get'], 'stdout': '{"value": {}}\n'}])
    fs.setup(sb, '--agent', 'omp', '--approval', 'auto', label='auto adds both')
    sb.fake('omp', rules=[{'argv': ['config', 'get'], 'stdout': '{"value": {"js": "allow", "js_reset": "allow"}}\n'}])
    fs.setup(sb, '--agent', 'omp', '--approval', 'ask', label='ask removes both: tools.approval reset')


@setup_scenario('setup/codex-app-server-teardown')
def _(sb):
    # The app-server keeps running after stdin closes and ignores SIGTERM: setup waits 10 s, then kills it.
    fs.place(sb)
    fs.app_server(sb, mode='ignore-term', env=['HOME', 'CODEX_HOME'])
    fs.setup(sb, '--agent', 'codex', label='app-server ignores SIGTERM', timeout=180)


@setup_scenario('setup/codex-notice-unbalanced-quote')
def _(sb):
    fs.place(sb)
    fs.put(sb, '.codex/config.toml', '''[[hooks.SessionStart]]
[[hooks.SessionStart.hooks]]
type = "command"
command = "'unbalanced update --notice --hook SessionStart"
''')
    fs.setup(sb, '--agent', 'codex', label="someone else's hook with unbalanced quotes is kept")
