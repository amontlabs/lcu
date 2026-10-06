"""`lcu setup --agent claude-code`: real add-mcp registration (~/.claude.json / .mcp.json bytes), the add-mcp
preflight guard, Claude settings.json round trip (host-only deny rules + lifecycle hooks) and the lcu-approve mod."""
import fixtures_setup as fs
from fixtures_setup import setup_scenario

ROUND_TRIP = (
    '{\n'
    '    "zeta": {"b": 1, "a": 2, "10": "ten", "2": "two"},\n'
    '    "1": "integer-like key first in JS, kept in place here",\n'
    '    "numbers": [1.0, 1e16, 1E+16, 12345678901234567890, -0, -0.0, 0.1, 1e-7, 3.14159265358979323846],\n'
    '    "text": "café \U0001f600 \\u00e9 \\ud83d\\ude00   tab\\t",\n'
    '    "empty": {}, "list": [], "nested": [[{}]],\n'
    '    "bools": [true, false, null],\n'
    '    "permissions": {"allow": ["Bash(ls)"], "deny": ["Read(/etc)"], "defaultMode": "plan"},\n'
    '    "theme": "dark"\n'
    '}\n')


@setup_scenario('setup/claude-user')
def _(sb):
    fs.place(sb)
    fs.spy_node(sb)
    fs.setup(sb, '--agent', 'claude-code', label='first registration')
    fs.setup(sb, '--agent', 'claude', label='second registration through the alias (byte-stable)')


@setup_scenario('setup/claude-settings-round-trip')
def _(sb):
    fs.place(sb)
    fs.put(sb, '.claude/settings.json', ROUND_TRIP)
    fs.setup(sb, '--agent', 'claude-code', label='rewrite preserves order, numbers and escapes ASCII')
    fs.put(sb, '.claude/settings.json', '{"permissions": {"deny": ["mcp__lcu__turn_ended", "mcp__lcu__js_add_node_module_dir",'
           ' "mcp__lcu__set_turn_context"]}, "hooks": {}}')
    fs.setup(sb, '--agent', 'claude-code', label='deny rules already present, hooks added')
    fs.setup(sb, '--agent', 'claude-code', label='nothing to change: file untouched')
    fs.put(sb, '.claude/settings.json', '{"a": NaN, "b": Infinity, "c": -Infinity}')
    fs.setup(sb, '--agent', 'claude-code', label='NaN and Infinity')
    fs.put(sb, '.claude/settings.json', '{"dup": 1, "dup": 2}')
    fs.setup(sb, '--agent', 'claude-code', label='duplicate keys: last wins')
    fs.put(sb, '.claude/settings.json', '\t{\n\t"tabs": true\n}')
    fs.setup(sb, '--agent', 'claude-code', label='tab indentation reformatted')


@setup_scenario('setup/claude-settings-existing-hooks')
def _(sb):
    fs.place(sb)
    fs.put(sb, '.claude/settings.json', '''{
  "hooks": {
    "Stop": [{"hooks": [{"type": "command", "command": "echo stop"}]}],
    "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "guard"}]},
                   {"matcher": "mcp__lcu__js|mcp__lcu__js_reset", "hooks": [{"type": "mcp_tool", "server": "lcu",
                    "tool": "set_turn_context", "input": {"agent_id": "${agent_id}", "tool_use_id": "${tool_use_id}",
                    "turn_id": "${prompt_id}", "session_id": "${session_id}"}}]}],
    "Notification": "kept as is"
  }
}''')
    fs.setup(sb, '--agent', 'claude-code', label='existing hook groups kept; an equal LCU group is not duplicated')


@setup_scenario('setup/claude-settings-malformed')
def _(sb):
    fs.place(sb)
    cases = [
        ('empty file', ''),
        ('not json', '{nope'),
        ('json list', '[]'),
        ('json comment', '{// c\n}'),
        ('permissions not an object', '{"permissions": []}'),
        ('deny not a list', '{"permissions": {"deny": "x"}}'),
        ('deny holds a number', '{"permissions": {"deny": [1]}}'),
        ('hooks not an object', '{"hooks": []}'),
        ('Stop not a list', '{"hooks": {"Stop": {}}}'),
        ('Stop holds a string', '{"hooks": {"Stop": ["x"]}}'),
        ('matcher not a string', '{"hooks": {"Stop": [{"matcher": 1, "hooks": []}]}}'),
        ('entries not a list', '{"hooks": {"Stop": [{"hooks": {}}]}}'),
        ('entry not an object', '{"hooks": {"SubagentStop": [{"hooks": [1]}]}}'),
        ('invalid utf-8', b'{"a": "\xff"}'),
    ]
    for label, data in cases:
        fs.put(sb, '.claude/settings.json', data)
        fs.setup(sb, '--agent', 'claude-code', label='settings.json: ' + label)


@setup_scenario('setup/claude-project-scope')
def _(sb):
    fs.place(sb)
    project = sb.work / 'proj é'
    project.mkdir()
    (project / '.claude').mkdir()
    (project / '.claude/settings.local.json').write_text('{"permissions": {"allow": ["Read"]}}\n')
    (project / '.mcp.json').write_text('{\n  // comment\n  "mcpServers": {"other": {"command": "x"},},\n}\n')
    fs.setup(sb, '--agent', 'claude-code', '--scope', 'project', '--project', str(project),
             label='project scope: .mcp.json, settings.local.json, project mod')


@setup_scenario('setup/claude-json-preflight')
def _(sb):
    fs.place(sb)
    cases = [
        ('not json', '{nope'),
        ('duplicate key', '{"mcpServers": {}, "mcpServers": {}}'),
        ('nested duplicate key', '{"mcpServers": {"a": {}, "a": {}}}'),
        ('array', '[]'),
        ('mcpServers is a list', '{"mcpServers": []}'),
        ('mcpServers null', '{"mcpServers": null}'),
        ('jsonc with comments and trailing commas', '{\n  // mine\n  "numStartups": 3,\n  "mcpServers": {"x": {"command": "y"},},\n}\n'),
        ('empty file', ''),
        ('other servers and unicode', '{"mcpServers": {"ä": {"command": "é"}}, "projects": {"/a": {"x": 1.0}}}\n'),
    ]
    for label, data in cases:
        fs.put(sb, '.claude.json', data)
        fs.setup(sb, '--agent', 'claude-code', label='~/.claude.json: ' + label)


@setup_scenario('setup/claude-mod')
def _(sb):
    fs.place(sb)
    mod = sb.home / '.claude/skills/lcu-approve'
    fs.put(sb, '.claude/skills/lcu-approve/README', 'mine\n')
    fs.setup(sb, '--agent', 'claude-code', label='foreign lcu-approve directory is refused')
    fs.put(sb, '.claude/skills/lcu-approve/.claude-plugin/plugin.json', '{"name": "other"}')
    fs.setup(sb, '--agent', 'claude-code', label='foreign plugin with another name is refused')
    fs.put(sb, '.claude/skills/lcu-approve/.claude-plugin/plugin.json', '{"name": "lcu-approve", "version": "0.0.1"}')
    fs.put(sb, '.claude/skills/lcu-approve/stale/old.ts', 'old\n')
    fs.put(sb, '.claude/skills/lcu-approve/hooks/data.ts', 'outdated\n', 0o755)
    fs.setup(sb, '--agent', 'claude-code', label='own older mod: replaced, stale files pruned, modes kept')
    (mod / 'lcu.json').chmod(0o644)
    fs.setup(sb, '--agent', 'claude-code', label='second install is a no-op')


@setup_scenario('setup/claude-symlinks')
def _(sb):
    fs.place(sb)
    real = sb.home / 'real-claude'
    real.mkdir()
    (sb.home / '.claude').symlink_to(real)
    fs.setup(sb, '--agent', 'claude-code', label='~/.claude is a symlink')
    (sb.home / '.claude').unlink()
    (sb.home / '.claude').mkdir()
    (sb.home / '.claude/settings.json').symlink_to(real / 'settings.json')
    fs.setup(sb, '--agent', 'claude-code', label='settings.json is a symlink')
    (sb.home / '.claude/settings.json').unlink()
    (sb.home / '.claude/settings.json').mkdir()
    fs.setup(sb, '--agent', 'claude-code', label='settings.json is a directory')


@setup_scenario('setup/claude-file-modes')
def _(sb):
    fs.place(sb)
    fs.put(sb, '.claude/settings.json', '{"a": 1}\n', 0o640)
    fs.put(sb, '.claude.json', '{"numStartups": 1}\n', 0o644)
    fs.setup(sb, '--agent', 'claude-code', label='existing modes kept on rewrite')
    (sb.home / '.claude').chmod(0o555)
    fs.put(sb, 'x', '')
    fs.setup(sb, '--agent', 'claude-code', '--approval', 'auto', label='read-only ~/.claude')
    (sb.home / '.claude').chmod(0o755)


@setup_scenario('setup/claude-relay-missing')
def _(sb):
    fs.place(sb)
    relay = sb.release / 'adapters/claude.mjs'
    relay.rename(relay.with_suffix('.off'))
    fs.setup(sb, '--agent', 'claude-code', '--agent', 'codex', label='claude relay missing: claude fails, codex runs')
    relay.with_suffix('.off').rename(relay)
    manifest = sb.release / 'adapters/claude-mod/lcu-approve/.claude-plugin/plugin.json'
    manifest.rename(manifest.with_suffix('.off'))
    fs.setup(sb, '--agent', 'claude-code', label='approval mod missing from the release')
