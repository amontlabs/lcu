"""`lcu setup --approval auto|ask`: LCU's own harness approval entries (Claude permissions.allow, Codex
tool approval_mode via the add-mcp policy, OMP tools.approval via `omp config`), the approval.json record and
removal of exactly what was added."""
import json

import fixtures_setup as fs
from fixtures_setup import setup_scenario


@setup_scenario('setup/approval-claude')
def _(sb):
    fs.place(sb)
    fs.setup(sb, '--agent', 'claude-code', '--approval', 'ask', label='ask with no settings file')
    fs.setup(sb, '--agent', 'claude-code', '--approval', 'auto', label='auto adds the two rules')
    fs.setup(sb, '--agent', 'claude-code', label='auto kept from the previous setup (unchanged)')
    fs.setup(sb, '--agent', 'claude-code', '--approval', 'ask', label='ask removes exactly what auto added')
    fs.setup(sb, '--agent', 'claude-code', '--approval', 'ask', label='ask again: nothing recorded')


@setup_scenario('setup/approval-claude-user-rules')
def _(sb):
    fs.place(sb)
    fs.put(sb, '.claude/settings.json', json.dumps({'permissions': {'allow': ['mcp__lcu__js', 'Bash(ls)', 'mcp__lcu']}}))
    fs.setup(sb, '--agent', 'claude-code', '--approval', 'auto', label='user already allows js; legacy mcp__lcu present')
    fs.setup(sb, '--agent', 'claude-code', '--approval', 'ask', label='ask keeps the rule the user wrote')
    fs.put(sb, '.claude/settings.json', json.dumps({'permissions': {'allow': 'x'}}))
    fs.setup(sb, '--agent', 'claude-code', '--approval', 'auto', label='allow is not a list')


@setup_scenario('setup/approval-claude-project')
def _(sb):
    fs.place(sb)
    project = sb.work / 'p'
    project.mkdir()
    fs.setup(sb, '--agent', 'claude-code', '--approval', 'auto', label='user scope auto')
    fs.setup(sb, '--agent', 'claude-code', '--approval', 'auto', '--scope', 'project', '--project', str(project),
             label='project scope auto: separate record key')
    fs.setup(sb, '--agent', 'claude-code', '--approval', 'ask', '--scope', 'project', '--project', str(project),
             label='project scope ask')


@setup_scenario('setup/approval-record-malformed')
def _(sb):
    fs.place(sb)
    for label, data in (('not json', '{x'), ('a list', '[]'), ('values not objects', '{"a": 1}'), ('empty', ''),
                        ('unrelated entries kept', '{"z|x": {"added": []}, "a|b": {"tools": ["js"]}}')):
        fs.put(sb, '.local/state/lcu/approval.json', data)
        fs.setup(sb, '--agent', 'claude-code', '--approval', 'auto', label='approval.json: ' + label)


@setup_scenario('setup/approval-codex')
def _(sb):
    fs.place(sb)
    fs.setup(sb, '--agent', 'codex', '--approval', 'auto', label='codex auto')
    fs.setup(sb, '--agent', 'codex', label='codex auto kept')
    fs.setup(sb, '--agent', 'codex', '--approval', 'ask', label='codex ask')


@setup_scenario('setup/approval-codex-existing')
def _(sb):
    fs.place(sb)
    fs.put(sb, '.codex/config.toml', '[mcp_servers.lcu]\ncommand = "x"\ndefault_tools_approval_mode = "prompt"\n'
                                     '[mcp_servers.lcu.tools.js_reset]\napproval_mode = "prompt"\n')
    fs.setup(sb, '--agent', 'codex', '--approval', 'auto', label='user-set js_reset mode is kept')
    fs.setup(sb, '--agent', 'codex', '--approval', 'ask', label='ask removes only js')


@setup_scenario('setup/approval-codex-legacy-record')
def _(sb):
    fs.place(sb)
    fs.put(sb, '.codex/config.toml', '[mcp_servers.lcu]\ncommand = "x"\ndefault_tools_approval_mode = "approve"\n')
    fs.put(sb, '.local/state/lcu/approval.json',
           json.dumps({'codex|/home/ubuntu/.codex/config.toml': {'prior': 'prompt'}}, indent=2, sort_keys=True) + '\n')
    fs.setup(sb, '--agent', 'codex', '--approval', 'auto', label='legacy server-wide default migrated')
    fs.put(sb, '.local/state/lcu/approval.json',
           json.dumps({'codex|/home/ubuntu/.codex/config.toml': {'prior': 'prompt'}}, indent=2, sort_keys=True) + '\n')
    fs.setup(sb, '--agent', 'codex', '--approval', 'ask', label='legacy record restored on ask')
    fs.put(sb, '.codex/config.toml', '[mcp_servers\n')
    fs.setup(sb, '--agent', 'codex', '--approval', 'auto', label='unreadable codex config with an approval mode')


@setup_scenario('setup/approval-omp')
def _(sb):
    fs.place(sb)
    sb.fake('omp', rules=[{'argv': ['config', 'get'], 'stdout': json.dumps({'value': {'bash': 'ask', 'js': 'deny'}}) + '\n'}])
    fs.setup(sb, '--agent', 'omp', '--approval', 'auto', label='omp auto: js kept as user-set, js_reset added')
    sb.fake('omp', rules=[{'argv': ['config', 'get'], 'stdout': json.dumps({'value': {'js_reset': 'allow', 'js': 'deny'}}) + '\n'}])
    fs.setup(sb, '--agent', 'omp', '--approval', 'ask', label='omp ask removes js_reset')
    sb.fake('omp', rules=[{'argv': ['config', 'get'], 'stdout': json.dumps({'value': {'js_reset': 'allow', 'js': 'allow'}}) + '\n'}])
    fs.setup(sb, '--agent', 'omp', '--approval', 'auto', env={'OMP_PROFILE': 'w'}, label='omp auto in a profile')
    sb.fake('omp', rules=[{'argv': ['config', 'get'], 'stdout': json.dumps({'value': {'js': 'allow', 'js_reset': 'allow'}}) + '\n'}])
    fs.setup(sb, '--agent', 'omp', '--approval', 'ask', env={'OMP_PROFILE': 'w'}, label='omp ask in the profile: reset')


@setup_scenario('setup/approval-omp-errors')
def _(sb):
    fs.place(sb)
    for label, rule in (('not json', {'stdout': 'nope\n'}), ('no value key', {'stdout': '{}\n'}),
                        ('value is a list', {'stdout': '{"value": []}\n'}),
                        ('config get fails', {'stderr': 'no config\n', 'exit': 5})):
        sb.fake('omp', rules=[{'argv': ['config', 'get'], **rule}])
        fs.setup(sb, '--agent', 'omp', '--approval', 'auto', label='omp config: ' + label)
    sb.fake('omp', rules=[{'argv': ['config', 'get'], 'stdout': '{"value": {}}\n'},
                          {'argv': ['config', 'set'], 'stderr': 'readonly\n', 'exit': 1}])
    fs.setup(sb, '--agent', 'omp', '--approval', 'auto', label='omp config set fails')


@setup_scenario('setup/approval-pi-hermes')
def _(sb):
    fs.place(sb)
    fs.setup(sb, '--agent', 'pi', '--agent', 'hermes', '--approval', 'auto', label='nothing to configure for pi/hermes')
    fs.setup(sb, '--agent', 'pi', '--agent', 'hermes', '--approval', 'ask', label='ask for pi/hermes')
