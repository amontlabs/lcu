"""`lcu setup` cleanup of earlier LCU skills (generated skill dir, the `skills` CLI old-skill removal with its
frontmatter check), the portable --export plugin, and apply_changes rollback across several files."""
import json

import fixtures_setup as fs
from fixtures_setup import setup_scenario

MARKED = '---\nname: lcu\ndescription: Use the LCU MCP computer-use tools to drive apps\n---\nbody\n'


def _skill(sb, relative, text):
    return fs.put(sb, relative + '/SKILL.md', text).parent


@setup_scenario('setup/old-skill-cleanup')
def _(sb):
    # `pi` exercises the cleanup phase without the add-mcp phase, so the recorder `skills` CLI can be scripted.
    fs.place(sb, agent_tools='fake')
    ours = _skill(sb, 'skills/ours', MARKED)
    theirs = _skill(sb, 'skills/theirs', '---\nname: lcu\ndescription: my own\n---\n')
    odd = _skill(sb, 'skills/odd', '---\nname :lcu\n name: lcu \ndescription: x original Codex computer-use runtime\n---\n')
    unterminated = _skill(sb, 'skills/unterminated', '---\nname: lcu\ndescription: LCU MCP computer-use tools\n')
    cases = [
        ('no lcu skill', [{'name': 'other', 'path': '/x'}]),
        ('lcu skill created by LCU', [{'name': 'x'}, {'name': 'lcu', 'path': str(ours)}, {'name': 'lcu', 'path': '/'}]),
        ("someone else's lcu skill", [{'name': 'lcu', 'path': str(theirs)}]),
        ('odd frontmatter spacing', [{'name': 'lcu', 'path': str(odd)}]),
        ('unterminated frontmatter', [{'name': 'lcu', 'path': str(unterminated)}]),
        ('path without SKILL.md', [{'name': 'lcu', 'path': str(sb.home / 'nowhere')}]),
        ('entry without a path', [{'name': 'lcu'}]),
        ('non-dict entries', ['lcu', 3, None]),
    ]
    for label, entries in cases:
        fs.skills_list(sb, entries)
        fs.setup(sb, '--agent', 'pi', label='skills list: ' + label)
    fs.skills_list(sb, [], raw_stdout='{"not": "a list"}', list_stderr='warn\n')
    fs.setup(sb, '--agent', 'pi', label='skills list: not a list')
    fs.skills_list(sb, [], raw_stdout='', list_stderr='')
    fs.setup(sb, '--agent', 'pi', label='skills list: empty output means none')
    fs.skills_list(sb, [], raw_stdout='garbage', list_stderr='x' * 600)
    fs.setup(sb, '--agent', 'pi', label='skills list: invalid JSON, long stderr tail')
    fs.skills_list(sb, [], list_exit=3, list_stderr='list exploded\n')
    fs.setup(sb, '--agent', 'pi', label='skills list exits non-zero')
    fs.skills_list(sb, [{'name': 'lcu', 'path': str(ours)}], remove_exit=1)
    fs.setup(sb, '--agent', 'pi', label='skills remove fails (warning only)')


@setup_scenario('setup/old-skill-cleanup-project')
def _(sb):
    fs.place(sb, agent_tools='fake')
    project = sb.work / 'proj'
    project.mkdir()
    ours = _skill(sb, 'skills/ours', MARKED)
    fs.skills_list(sb, [{'name': 'lcu', 'path': str(ours)}])
    fs.setup(sb, '--agent', 'pi', '--scope', 'project', '--project', str(project), label='project scope: no --global')


@setup_scenario('setup/generated-skill-removed')
def _(sb):
    fs.place(sb)
    fs.put(sb, '.local/share/lcu/skills/lcu/SKILL.md', 'generated\n')
    fs.put(sb, '.local/share/lcu/skills/other/SKILL.md', 'kept\n')
    fs.setup(sb, '--agent', 'pi', label='generated lcu skill removed, other kept')
    fs.put(sb, '.local/share/lcu/skills/other/SKILL.md', '')
    sb.run(['/bin/rm', '-rf', sb.home / '.local/share/lcu/skills/other'], label='remove other')
    fs.put(sb, '.local/share/lcu/skills/lcu/SKILL.md', 'generated\n')
    fs.setup(sb, '--agent', 'pi', label='skills root removed when empty')
    (sb.home / 'target').mkdir()
    (sb.home / '.local/share/lcu/skills').mkdir(parents=True, exist_ok=True)
    (sb.home / '.local/share/lcu/skills/lcu').symlink_to(sb.home / 'target')
    fs.setup(sb, '--agent', 'pi', label='a symlinked generated skill is left alone')
    fs.setup(sb, '--export', str(sb.work / 'exp'), label='export also runs the cleanup')


@setup_scenario('setup/export-variants')
def _(sb):
    fs.place(sb)
    fs.setup(sb, '--export', str(sb.work / 'plain'), label='plain export')
    fs.setup(sb, '--export', str(sb.work / 'flags'), '--chrome', '--audio', label='export with chrome and audio')
    fs.setup(sb, '--export', str(sb.work / 'deep/new/dir'), '--no-chrome', '--no-audio', label='export to a new nested dir')
    fs.setup(sb, '--export', str(sb.work / 'plain'), label='export onto an existing export')
    fs.setup(sb, '--export', str(sb.work / 'tty'), yes=False, label='export needs --yes without a tty')

@setup_scenario('setup/export-launchers')
def _(sb):
    # Run the exported portable launchers: they resolve the prefix and session, then exec the runtime.
    fs.place(sb)
    fs.setup(sb, '--export', str(sb.work / 'exp'), '--chrome', label='export')
    for name in ('mcp.json', 'codex.mcp.json'):
        data = json.loads((sb.work / 'exp' / name).read_text())
        server = data['mcpServers']['lcu']
        for env in ({}, {'LCU_PREFIX': str(sb.prefix)}, {'LCU_PREFIX': str(sb.prefix), 'LCU_SESSION_MODE': 'direct'},
                    {'LCU_PREFIX': 'relative'}, {'LCU_SESSION_MODE': 'bogus', 'LCU_PREFIX': str(sb.prefix)}):
            sb.run([server['command'], *server['args'], '--version'], stdin=None, env=env,
                   label=f'{name} launcher --version with {sorted(env.items())}')


@setup_scenario('setup/export-darwin-descriptor')
def _(sb):
    fs.place(sb)
    descriptor = json.loads((sb.release / 'installation.json').read_text())
    sb.run(['/bin/true'], label='baseline')
    descriptor['platform'] = 'darwin'
    (sb.release / 'installation.json').write_text(json.dumps(descriptor, indent=2) + '\n')
    fs.setup(sb, '--export', str(sb.work / 'exp'), label='export with a darwin descriptor on Linux')


@setup_scenario('setup/claude-mod-rollback')
def _(sb):
    # The mod's files are written one by one; a write failing midway restores every file already written.
    fs.place(sb)
    fs.put(sb, '.claude/skills/lcu-approve/.claude-plugin/plugin.json', '{"name": "lcu-approve", "version": "old"}\n')
    fs.put(sb, '.claude/skills/lcu-approve/hooks/data.ts', 'old data\n')
    fs.put(sb, '.claude/skills/lcu-approve/types/index.d.ts', 'old types\n')
    (sb.home / '.claude/skills/lcu-approve/types').chmod(0o555)
    fs.show(sb, '.claude/skills/lcu-approve', label='before')
    fs.setup(sb, '--agent', 'claude-code', label='types/ is read-only: earlier mod files rolled back')
    fs.show(sb, '.claude/skills/lcu-approve', label='after the failed install: same as before')
    (sb.home / '.claude/skills/lcu-approve/types').chmod(0o755)
    fs.setup(sb, '--agent', 'claude-code', label='writable again: installed')
