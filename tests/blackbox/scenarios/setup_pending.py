"""`lcu setup --allow-missing` (pending harnesses saved with their context) and `lcu setup --reconcile`
(registers them once their executable appears, with the saved opt-ins), plus the failure retry command."""
import fixtures_setup as fs
from fixtures_setup import setup_scenario


def _missing(sb, *names):
    for name in names:
        sb.remove_fake(name)


@setup_scenario('setup/allow-missing-then-reconcile')
def _(sb):
    fs.place(sb)
    _missing(sb, 'pi', 'omp', 'hermes')
    fs.setup(sb, '--agent', 'all', '--allow-missing', '--audio', '--approval', 'auto', label='all, three missing')
    fs.raw(sb, '--reconcile', label='reconcile: nothing installed yet (silent)')
    fs.bin_fake(sb, 'pi')
    fs.raw(sb, '--reconcile', label='reconcile: pi appeared in ~/.local/bin')
    fs.raw(sb, '--reconcile', '--yes', '--session', 'direct', label='reconcile again: silent')
    sb.add_fake('hermes')
    fs.bin_fake(sb, 'omp', rules=[{'argv': ['config', 'get'], 'stdout': '{"value": {}}\n'}])
    fs.raw(sb, '--reconcile', label='reconcile: omp and hermes appeared')


@setup_scenario('setup/allow-missing-only-pending')
def _(sb):
    fs.place(sb)
    _missing(sb, 'pi', 'hermes')
    fs.setup(sb, '--agent', 'pi', '--agent', 'hermes', '--allow-missing', label='only missing harnesses: exit 0')
    fs.setup(sb, '--agent', 'pi', '--allow-missing', '--no-chrome', label='again: dedup of pending')
    fs.setup(sb, '--agent', 'pi', label='without --allow-missing: pi fails')


@setup_scenario('setup/allow-missing-project-context')
def _(sb):
    fs.place(sb)
    project = sb.work / 'proj'
    project.mkdir()
    _missing(sb, 'pi')
    fs.setup(sb, '--agent', 'pi', '--agent', 'claude-code', '--allow-missing', '--scope', 'project', '--project',
             str(project), direct=False, label='pi pending in project scope, discover session')
    fs.bin_fake(sb, 'pi')
    fs.raw(sb, '--reconcile', '--session', 'direct', label='reconcile uses the saved project and session')


@setup_scenario('setup/reconcile-missing-project')
def _(sb):
    fs.place(sb)
    project = sb.work / 'gone'
    project.mkdir()
    _missing(sb, 'pi')
    fs.setup(sb, '--agent', 'pi', '--allow-missing', '--scope', 'project', '--project', str(project),
             label='pi pending for a project')
    project.rmdir()
    fs.bin_fake(sb, 'pi')
    fs.raw(sb, '--reconcile', label='reconcile: saved project directory is gone')


@setup_scenario('setup/reconcile-failure')
def _(sb):
    fs.place(sb)
    _missing(sb, 'pi', 'hermes')
    fs.setup(sb, '--agent', 'pi', '--agent', 'hermes', '--allow-missing', label='both pending')
    fs.bin_fake(sb, 'pi', default={'stderr': 'pi broke\n', 'exit': 1})
    fs.bin_fake(sb, 'hermes')
    fs.raw(sb, '--reconcile', label='reconcile: pi fails, hermes registers')
    fs.bin_fake(sb, 'pi')
    fs.raw(sb, '--reconcile', label='reconcile retries pi')


@setup_scenario('setup/reconcile-state-variants')
def _(sb):
    fs.place(sb)
    fs.raw(sb, '--reconcile', label='no setup.json: silent')
    fs.put_state(sb, raw_text='{x')
    fs.raw(sb, '--reconcile', label='malformed setup.json')
    fs.put_state(sb, {'chrome': False, 'audio': False, 'approval': 'ask', 'pending': ['pi']})
    fs.raw(sb, '--reconcile', label='pending without context: user scope and --session default')
    fs.put_state(sb, {'chrome': True, 'audio': False, 'approval': 'auto', 'pending': ['hermes'],
                      'pending_context': {'project': None, 'session': 'discover', 'scope': 'user'}})
    fs.raw(sb, '--reconcile', label='saved chrome/auto/discover context')
    fs.put_state(sb, {'chrome': False, 'audio': False, 'approval': 'ask', 'pending': ['pi']})
    sb.run([fs.lcu(sb), 'setup', '--reconcile', '--prefix', str(sb.root / 'nowhere')], label='reconcile with a missing runtime')
    sb.fake('pi', default={'exit': 0})
    (sb.release / 'installation.json').rename(sb.release / 'installation.off')
    sb.run([fs.lcu(sb), 'setup', '--reconcile'], label='reconcile: version probe fails')
    (sb.release / 'installation.off').rename(sb.release / 'installation.json')


@setup_scenario('setup/reconcile-lock')
def _(sb):
    fs.place(sb)
    fs.put_state(sb, {'chrome': False, 'audio': False, 'approval': 'ask', 'pending': ['pi'],
                      'pending_context': {'scope': 'user', 'session': 'direct', 'project': None}})
    lock = sb.home / '.local/state/lcu/setup.lock'
    sb.run([sb.bb / 'tools/python3', sb.bb / 'lockrun.py', 'hold', '2', lock, '--', fs.lcu(sb), 'setup', '--reconcile'],
           label='reconcile waits for the lock when something is ready')
    sb.remove_fake('pi')
    fs.put_state(sb, {'chrome': False, 'audio': False, 'approval': 'ask', 'pending': ['pi'],
                      'pending_context': {'scope': 'user', 'session': 'direct', 'project': None}})
    sb.run([sb.bb / 'tools/python3', sb.bb / 'lockrun.py', 'hold', '2', lock, '--', fs.lcu(sb), 'setup', '--reconcile'],
           label='nothing ready: returns without the lock')


@setup_scenario('setup/failure-retry-command')
def _(sb):
    fs.place(sb)
    project = sb.work / "it's a \"proj\" $x"
    project.mkdir()
    sb.fake('pi', default={'exit': 1, 'stderr': 'boom\n'})
    sb.fake('codex', rules=[{'argv': ['mcp', 'list'], 'exit': 1}])
    fs.setup(sb, '--agent', 'pi', '--agent', 'codex', '--agent', 'claude-code', '--scope', 'project', '--project',
             str(project), '--chrome', '--audio', '--approval', 'ask', '--allow-missing', direct=False,
             label='retry command quotes the project and lists failed agents')
    fs.setup(sb, '--agent', 'pi', label='retry command with saved chrome/audio, user scope')
