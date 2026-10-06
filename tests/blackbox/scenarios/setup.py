"""`lcu setup` with recorder fakes for the agent CLIs and the bundled installers.

Setup resolves the target account through the OS account database and writes inside that account's real home,
so these scenarios run only in the disposable container (docker.sh), where the unprivileged account home is
wiped per scenario.
"""
from . import scenario

LINUX = ('linux',)


@scenario('setup/codex', hosts=LINUX, account_home=True, normalise=('tmpdir-suffix',))
def _(sb):
    sb.place_release('linux', agent_tools='fake')
    sb.run([sb.release / 'bin/lcu', 'setup', '--agent', 'codex', '--yes', '--session', 'direct'],
           label='lcu setup --agent codex')


@scenario('setup/codex-missing-cli', hosts=LINUX, account_home=True, normalise=('tmpdir-suffix',))
def _(sb):
    # With no `codex` on PATH, registration still happens (hooks need only the app's bundled Codex).
    sb.place_release('linux', agent_tools='fake')
    sb.remove_fake('codex')
    sb.run([sb.release / 'bin/lcu', 'setup', '--agent', 'codex', '--yes', '--session', 'direct'],
           label='lcu setup --agent codex (no codex on PATH)')


@scenario('setup/export', hosts=LINUX, account_home=True)
def _(sb):
    sb.place_release('linux', agent_tools='fake')
    sb.run([sb.release / 'bin/lcu', 'setup', '--export', sb.work / 'exported', '--yes', '--session', 'direct'],
           label='lcu setup --export')


@scenario('setup/validation-errors')
def _(sb):
    # Argument validation happens before any account write, so this is safe on any host.
    sb.place_release()
    lcu = sb.release / 'bin/lcu'
    sb.run([lcu, 'setup', '--agent', 'nope'], label='unknown agent')
    sb.run([lcu, 'setup', '--chrome', '--no-chrome', '--agent', 'codex'], label='chrome conflict')
    sb.run([lcu, 'setup', '--scope', 'project', '--agent', 'codex'], label='project scope without --project')
    sb.run([lcu, 'setup', '--agent', 'all', '--agent', 'codex'], label='all with others')
    sb.run([lcu, 'setup', '--reconcile', '--agent', 'codex'], label='reconcile with agent')
    sb.run([lcu, 'setup', '--export', 'relative/dir', '--agent', 'codex'], label='export with agent')
    sb.run([lcu, 'setup', '--prefix', 'rel'], label='relative prefix')
    sb.run([lcu, 'setup', '--browser-host'], label='removed option')
