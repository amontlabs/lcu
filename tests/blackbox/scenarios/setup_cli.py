"""`lcu setup`: argument parsing, every validate() message, agent selection, prompts and exit codes."""
import os

import fixtures_setup as fs
from fixtures_setup import setup_scenario


def _lcu(sb):
    return fs.lcu(sb)


@setup_scenario('setup/argparse-help')
def _(sb):
    fs.place(sb)
    for columns in ('80', '60', '120'):
        fs.raw(sb, '--help', env={'COLUMNS': columns}, label=f'--help COLUMNS={columns}')
    fs.raw(sb, '-h', label='-h')
    fs.raw(sb, '--list-agents', '--help', label='--list-agents --help')
    fs.raw(sb, '--help', '--bogus', label='--help before the unknown option')


@setup_scenario('setup/argparse-errors')
def _(sb):
    fs.place(sb)
    for args in (
        ['--bogus'], ['--scope', 'x'], ['--scope'], ['--approval', 'yolo'], ['--session', 'both'],
        ['--user'], ['--user', '-x'], ['--agent'], ['--prefix'], ['--no'], ['--ch'],
        ['--chrome=1'], ['positional'], ['--agent', 'codex', 'extra'], ['--export'], ['--project'],
        ['--list-agent', '--bogus'], ['--yes=1'],
    ):
        fs.raw(sb, *args, label='lcu setup ' + ' '.join(args))


@setup_scenario('setup/argparse-forms')
def _(sb):
    # Accepted spellings: unambiguous prefixes, --opt=value, `--` terminator, repeated scalar (last wins).
    fs.place(sb)
    fs.raw(sb, '--list-ag', label='abbreviated --list-agents')
    fs.raw(sb, '--validate-only', '--ag', 'codex', label='abbreviated --agent')
    fs.raw(sb, '--validate-only', '--agent=codex', '--scope=user', label='--opt=value')
    fs.raw(sb, '--validate-only', '--sess', 'discover', '--session', 'direct', '--agent', 'claude',
           label='repeated --session, alias claude')
    fs.raw(sb, '--validate-only', '--agent', 'codex', '--', label='-- terminator')
    fs.raw(sb, '--validate-only', '--agent', 'codex', '--', '--yes', label='-- then positional')
    fs.raw(sb, '--validate-only', '--agent', 'codex', '--approval=auto', label='--approval=auto')


@setup_scenario('setup/list-agents')
def _(sb):
    fs.place(sb)
    fs.raw(sb, '--list-agents')
    fs.raw(sb, '--list-agents', '--agent', 'nope', '--scope', 'project', label='--list-agents runs before validation')
    fs.raw(sb, '--list-agents', '--browser-host', label='--list-agents with a removed option')
    fs.raw(sb, '--list-agents', '--prefix', 'rel', label='--list-agents with a bad prefix')
    sb.run([_lcu(sb), 'setup', '--list-agents'], env={'COLUMNS': '20'}, label='narrow terminal')


@setup_scenario('setup/validate-flags')
def _(sb):
    fs.place(sb)
    fs.raw(sb, '--browser-host', label='removed --browser-host')
    fs.raw(sb, '--browser-host', '--reconcile', label='browser-host wins over reconcile')
    for combo in (
        ['--agent', 'codex'], ['--export', '/tmp/x'], ['--approval', 'auto'], ['--chrome'], ['--no-chrome'],
        ['--audio'], ['--no-audio'], ['--project', '/tmp'], ['--check-desktop'], ['--allow-missing'],
        ['--scope', 'project'],
        ['--agent', 'codex', '--chrome', '--audio', '--approval', 'ask', '--allow-missing'],
        ['--scope', 'project', '--project', '/tmp', '--agent', 'pi', '--export', '/tmp/y', '--check-desktop'],
    ):
        fs.raw(sb, '--reconcile', *combo, label='--reconcile ' + ' '.join(combo))
    fs.raw(sb, '--reconcile', '--validate-only', '--yes', '--session', 'direct', '--user', 'ubuntu',
           label='--reconcile with its allowed companions (validate only)')
    fs.raw(sb, '--allow-missing', '--export', '/tmp/x', label='allow-missing with export')
    fs.raw(sb, '--chrome', '--no-chrome', '--agent', 'codex', label='chrome conflict')
    fs.raw(sb, '--audio', '--no-audio', '--agent', 'codex', label='audio conflict')
    fs.raw(sb, '--chrome', '--no-chrome', '--audio', '--no-audio', '--agent', 'codex', label='both conflicts: chrome first')
    fs.raw(sb, '--validate-only', '--agent', 'codex', '--chrome', '--audio', label='valid chrome+audio (validate only)')


@setup_scenario('setup/validate-prefix')
def _(sb):
    fs.place(sb)
    # `lcu` injects --prefix only when no exact `--prefix` token is present; --prefix=VALUE gets a second one.
    for prefix in ('rel', 'rel/ative', '/', '/opt', '/a/b', '/a/../b/c', '/a/b/..', '/a//b', '/a/./b', '/a/b/',
                   '/a/b\x01c', '/a/b\nc', '/tmp/lcu-bb/does not exist/x'):
        fs.raw(sb, '--validate-only', '--agent', 'codex', '--prefix', prefix, label='--prefix ' + repr(prefix))
    fs.raw(sb, '--validate-only', '--agent', 'codex', '--prefix=rel', label='--prefix=rel (second prefix appended)')
    fs.raw(sb, '--validate-only', '--agent', 'codex', '--prefix', 'rel', '--prefix', '/x/y/z',
           label='last --prefix wins')


@setup_scenario('setup/validate-account')
def _(sb):
    fs.place(sb)
    base = ['--validate-only', '--agent', 'codex']
    fs.raw(sb, *base, '--user', 'ubuntu', label='--user is the current account')
    fs.raw(sb, *base, '--user', 'root', label='--user root as an unprivileged account')
    fs.raw(sb, *base, '--user', 'nobody', label='--user another existing account')
    fs.raw(sb, *base, '--user', 'no-such-user-lcu', label='--user does not exist')
    fs.raw(sb, *base, '--user', '', label='--user empty')
    fs.raw(sb, *base, '--user', '0', label='--user numeric name')
    fs.raw(sb, *base, '--user', 'UBUNTU', label='--user wrong case')


@setup_scenario('setup/validate-scope')
def _(sb):
    fs.place(sb)
    project = sb.work / 'proj'
    project.mkdir()
    (sb.work / 'file').write_text('x')
    (sb.work / 'link').symlink_to(project)
    base = ['--validate-only', '--agent', 'codex']
    fs.raw(sb, *base, '--scope', 'project', label='project scope without --project')
    fs.raw(sb, *base, '--scope', 'project', '--project', 'proj', label='relative --project')
    fs.raw(sb, *base, '--scope', 'project', '--project', str(sb.work / 'nope'), label='missing --project')
    fs.raw(sb, *base, '--scope', 'project', '--project', str(sb.work / 'file'), label='--project is a file')
    fs.raw(sb, *base, '--scope', 'project', '--project', str(project), label='valid project')
    fs.raw(sb, *base, '--scope', 'project', '--project', str(project) + '/', label='valid project, trailing slash')
    fs.raw(sb, *base, '--scope', 'project', '--project', str(sb.work / 'link'), label='project through a symlink')
    fs.raw(sb, *base, '--project', str(project), label='--project with user scope')
    fs.raw(sb, *base, '--scope', 'user', '--project', str(project), label='--project with explicit user scope')
    fs.raw(sb, '--validate-only', '--agent', 'omp', '--scope', 'project', '--project', str(project),
           label='omp project scope')
    fs.raw(sb, '--validate-only', '--agent', 'hermes', '--scope', 'project', '--project', str(project),
           label='hermes project scope')
    fs.raw(sb, '--validate-only', '--agent', 'all', '--scope', 'project', '--project', str(project),
           label='all agents project scope')
    fs.raw(sb, '--validate-only', '--agent', 'pi', '--agent', 'claude-code', '--scope', 'project',
           '--project', str(project), label='pi + claude-code project scope')


@setup_scenario('setup/validate-export')
def _(sb):
    fs.place(sb)
    existing = sb.work / 'existing'
    existing.mkdir()
    real = sb.work / 'real'
    real.mkdir()
    (sb.work / 'viaLink').symlink_to(real)
    (sb.work / 'dangling').symlink_to(sb.work / 'missing')
    base = ['--validate-only']
    fs.raw(sb, *base, '--export', 'relative/dir', label='relative export')
    fs.raw(sb, *base, '--export', str(existing), label='existing export directory')
    fs.raw(sb, *base, '--export', str(sb.work / 'viaLink/new'), label='export below a symlinked directory')
    fs.raw(sb, *base, '--export', str(sb.work / 'dangling'), label='export is a dangling symlink')
    fs.raw(sb, *base, '--export', str(sb.work / 'a/../b'), label='export with ..')
    fs.raw(sb, *base, '--export', str(sb.work / 'ctl\x01'), label='export with a control character')
    fs.raw(sb, *base, '--export', str(sb.work / 'new'), label='export valid (validate only)')
    fs.raw(sb, *base, '--export', str(sb.work / 'new'), '--agent', 'codex', label='export with --agent')
    fs.raw(sb, *base, '--export', str(sb.work / 'new'), '--approval', 'ask', label='export with --approval')
    fs.raw(sb, *base, '--export', str(sb.work / 'new'), '--agent', 'codex', '--approval', 'auto',
           label='export with --agent and --approval')
    fs.raw(sb, *base, '--export', str(sb.work / 'new'), '--scope', 'project', label='export with project scope')
    fs.raw(sb, *base, '--export', str(sb.work / 'new'), '--chrome', '--audio', label='export with chrome+audio')
    fs.raw(sb, *base, '--export', '/tmp/lcu-bb/x/../y', label='export under a missing parent')
    fs.raw(sb, *base, '--export', str(sb.home), label='export onto the account home')


@setup_scenario('setup/validate-agents')
def _(sb):
    fs.place(sb)
    base = ['--validate-only']
    cases = [
        ['nope'], ['nope', 'zzz', 'aaa'], ['codex', 'nope'], ['auto,codex'], ['codex,pi'], [' codex'], ['CODEX'],
        ['claude'], ['oh-my-pi'], ['hermes-agent'], ['claude', 'claude-code'], ['codex', 'codex'],
        ['all'], ['all', 'all'], ['all', 'codex'], ['auto'], ['auto', 'auto'], ['auto', 'all'], ['auto', 'codex'],
        ['codex', 'all'], ['pi', 'omp', 'hermes', 'claude-code', 'codex'], [''],
    ]
    for names in cases:
        argv = [item for name in names for item in ('--agent', name)]
        fs.raw(sb, *base, *argv, label='--agent ' + ' --agent '.join(repr(n) for n in names))
    fs.raw(sb, *base, '--agent', 'omp', '--agent', 'nope', label='unknown beats nothing else')


@setup_scenario('setup/validate-installer-environment')
def _(sb):
    fs.place(sb)
    base = ['--validate-only']

    def check(agent, label, **env):
        fs.raw(sb, *base, '--agent', agent, label=label, env=env)

    check('claude-code', 'CLAUDE_CONFIG_DIR is rejected for claude-code', CLAUDE_CONFIG_DIR='/x/y')
    check('claude-code', 'empty CLAUDE_CONFIG_DIR passes', CLAUDE_CONFIG_DIR='')
    check('codex', 'CLAUDE_CONFIG_DIR is irrelevant to codex', CLAUDE_CONFIG_DIR='/x/y')
    check('codex', 'relative CODEX_HOME', CODEX_HOME='rel')
    check('codex', 'absolute CODEX_HOME', CODEX_HOME='/x/codex')
    check('codex', 'empty CODEX_HOME', CODEX_HOME='')
    check('pi', 'relative CODEX_HOME is irrelevant to pi', CODEX_HOME='rel')
    check('hermes', 'relative HERMES_HOME', HERMES_HOME='rel')
    check('hermes', 'absolute HERMES_HOME', HERMES_HOME='/x/h')
    check('omp', 'relative PI_CODING_AGENT_DIR', PI_CODING_AGENT_DIR='rel')
    check('omp', 'absolute PI_CODING_AGENT_DIR', PI_CODING_AGENT_DIR='/x/p')
    check('pi', 'PI_CODING_AGENT_DIR is not checked for pi', PI_CODING_AGENT_DIR='rel')
    fs.raw(sb, *base, '--agent', 'claude-code', '--agent', 'codex', label='first failing variable wins',
           env={'CLAUDE_CONFIG_DIR': '/a', 'CODEX_HOME': 'rel'})
    fs.raw(sb, *base, '--agent', 'codex', '--agent', 'claude-code', label='order of agents does not matter',
           env={'CLAUDE_CONFIG_DIR': '/a', 'CODEX_HOME': 'rel'})
    fs.raw(sb, *base, '--agent', 'all', label='all agents, bad CODEX_HOME', env={'CODEX_HOME': 'rel'})
    fs.raw(sb, *base, '--export', str(sb.work / 'out'), label='export skips the environment checks',
           env={'CLAUDE_CONFIG_DIR': '/a', 'CODEX_HOME': 'rel'})


@setup_scenario('setup/noninteractive-selection')
def _(sb):
    fs.place(sb)
    for name in ('codex', 'claude', 'pi', 'omp', 'hermes'):
        sb.remove_fake(name)
    fs.setup(sb, label='no agent, no tty')
    fs.setup(sb, '--agent', 'auto', label='auto with nothing detected')
    fs.setup(sb, '--agent', 'auto', '--allow-missing', label='auto + allow-missing with nothing detected')
    fs.put(sb, '.pi/agent/settings.json', '{}')
    fs.put(sb, '.omp/x', '')
    fs.setup(sb, '--agent', 'auto', '--validate-only', label='auto detects ~/.pi/agent and ~/.omp')
    fs.put(sb, '.hermes/x', '')
    fs.put(sb, '.codex/x', '')
    fs.put(sb, '.claude.json', '{}')
    fs.setup(sb, '--agent', 'auto', '--validate-only', label='auto detects every home marker')


@setup_scenario('setup/detect-by-path')
def _(sb):
    # detect(): a harness executable on the CURRENT PATH counts; ~/.local/bin is not searched by detect().
    fs.place(sb)
    for name in ('codex', 'claude', 'pi', 'omp', 'hermes'):
        sb.remove_fake(name)
    fs.bin_fake(sb, 'pi')
    fs.setup(sb, '--agent', 'auto', label='pi only in ~/.local/bin is not detected')
    sb.add_fake('hermes')
    fs.setup(sb, '--agent', 'auto', '--allow-missing', label='hermes on PATH is detected')


@setup_scenario('setup/runtime-missing')
def _(sb):
    fs.place(sb)
    release = sb.release
    fs.setup(sb, '--agent', 'codex', '--prefix', str(sb.root / 'elsewhere'), label='explicit prefix without a runtime')
    launcher = release / 'bin/lcu-session'
    launcher.chmod(0o644)
    fs.setup(sb, '--agent', 'codex', label='lcu-session not executable')
    launcher.chmod(0o755)
    launcher.unlink()
    fs.setup(sb, '--agent', 'codex', label='lcu-session missing')
    launcher.mkdir()
    fs.setup(sb, '--agent', 'codex', label='lcu-session is a directory')


@setup_scenario('setup/version-probe-failure')
def _(sb):
    fs.place(sb)
    (sb.release / 'installation.json').write_text('{}\n')
    fs.setup(sb, '--agent', 'codex', label='lcu --version fails')
    fs.setup(sb, '--agent', 'codex', '--session', 'discover', label='discover session version probe')


@setup_scenario('setup/confirmation')
def _(sb):
    fs.place(sb)
    fs.setup(sb, '--agent', 'codex', yes=False, label='no --yes without a tty')
    fs.setup(sb, '--agent', 'codex', yes=False, stdin=b'y\n', label='no --yes, y on a pipe is ignored')
    for index, answer in enumerate(('y\n', 'yes\n', 'YES\n', ' y \n', 'n\n', '\n', 'sure\n')):
        fs.pty_setup(sb, [{'expect': 'Apply this setup?', 'send': answer}], '--agent', 'codex', '--session', 'direct',
                     '--no-chrome', label=f'tty confirmation answer {answer!r}')
    fs.pty_setup(sb, [{'expect': 'Apply this setup?', 'ctrl': 'd'}], '--agent', 'codex', '--session', 'direct',
                 '--no-chrome', label='tty confirmation: Ctrl-D')
    fs.pty_setup(sb, [{'expect': 'Apply this setup?', 'ctrl': 'c'}], '--agent', 'codex', '--session', 'direct',
                 '--no-chrome', label='tty confirmation: Ctrl-C')


@setup_scenario('setup/confirmation-cancel-keeps-state')
def _(sb):
    fs.place(sb)
    fs.pty_setup(sb, [{'expect': 'Enable Chrome', 'send': 'y\n'}, {'expect': 'Apply this setup?', 'send': 'n\n'}],
                 '--agent', 'codex', '--session', 'direct', label='chrome yes then cancel')


@setup_scenario('setup/agent-chooser')
def _(sb):
    fs.place(sb)
    for name in ('claude', 'pi', 'omp', 'hermes'):
        sb.remove_fake(name)
    fs.put(sb, '.pi/agent/x', '')
    fs.put(sb, '.hermes/x', '')

    def choose(answer, label):
        fs.pty_setup(sb, [{'expect': 'Agents:', 'send': answer}, {'expect': 'Enable Chrome', 'send': 'n\n'},
                          {'expect': 'Apply this setup?', 'send': 'n\n'}],
                     '--session', 'direct', '--allow-missing', label=label)

    choose('codex\n', 'codex')
    choose('codex, pi\n', 'codex, pi')
    choose('claude,claude-code,oh-my-pi\n', 'aliases and dedupe')
    choose('all\n', 'all')
    choose('auto\n', 'auto (detected)')
    choose(',,codex,,\n', 'empty items')
    choose('\n', 'empty answer')
    choose('nope\n', 'unknown id')
    choose('all,codex\n', 'all plus another')
    choose('auto,codex\n', 'auto plus another')
    fs.pty_setup(sb, [{'expect': 'Agents:', 'ctrl': 'd'}], '--session', 'direct', label='chooser: Ctrl-D')
    fs.pty_setup(sb, [{'expect': 'Agents:', 'ctrl': 'c'}], '--session', 'direct', label='chooser: Ctrl-C')
    fs.pty_setup(sb, [{'expect': 'Agents:', 'send': 'omp\n'}], '--session', 'direct', '--scope', 'project',
                 '--project', str(sb.work), '--no-chrome', label='chooser picks omp with project scope')


@setup_scenario('setup/chooser-without-detection')
def _(sb):
    fs.place(sb)
    for name in ('codex', 'claude', 'pi', 'omp', 'hermes'):
        sb.remove_fake(name)
    fs.pty_setup(sb, [{'expect': 'Agents:', 'send': 'auto\n'}], '--session', 'direct', label='auto detects nothing')


@setup_scenario('setup/chrome-prompt')
def _(sb):
    fs.place(sb)
    for answer in ('y\n', 'YES\n', 'n\n', '\n', 'maybe\n'):
        fs.pty_setup(sb, [{'expect': 'Enable Chrome', 'send': answer}, {'expect': 'Apply this setup?', 'send': 'n\n'}],
                     '--agent', 'codex', '--session', 'direct', label=f'chrome prompt answer {answer!r}')
    fs.pty_setup(sb, [{'expect': 'Enable Chrome', 'ctrl': 'd'}], '--agent', 'codex', '--session', 'direct',
                 label='chrome prompt: Ctrl-D')
    fs.pty_setup(sb, [{'expect': 'Enable Chrome', 'ctrl': 'c'}], '--agent', 'codex', '--session', 'direct',
                 label='chrome prompt: Ctrl-C')
    fs.pty_setup(sb, [], '--agent', 'codex', '--session', 'direct', '--yes', '--validate-only',
                 label='no prompts when validating only')
    fs.pty_setup(sb, [{'expect': 'Apply this setup?', 'send': 'n\n'}], '--agent', 'codex', '--session', 'direct',
                 '--chrome', label='--chrome skips the prompt')
    fs.pty_setup(sb, [{'expect': 'Apply this setup?', 'send': 'n\n'}], '--agent', 'codex', '--session', 'direct',
                 '--no-chrome', label='--no-chrome skips the prompt')


@setup_scenario('setup/validate-only-no-writes')
def _(sb):
    fs.place(sb)
    fs.raw(sb, '--validate-only', '--agent', 'codex', '--yes', label='validate only')
    fs.raw(sb, '--validate-only', '--agent', 'all', '--yes', '--approval', 'auto', label='validate only, all, approval')
    fs.raw(sb, '--validate-only', '--export', str(sb.work / 'out'), label='validate only, export')
    fs.raw(sb, '--validate-only', label='validate only, nothing selected')
    fs.raw(sb, '--validate-only', '--agent', 'auto', label='validate only, auto')
    fs.raw(sb, '--validate-only', '--reconcile', label='validate only, reconcile')
    fs.raw(sb, '--validate-only', '--check-desktop', '--agent', 'codex', label='validate only, check-desktop')
