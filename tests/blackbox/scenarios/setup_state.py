"""`lcu setup`: the saved setup state (~/.local/state/lcu/setup.json), saved opt-ins, the lock file and the
end-of-setup messages. The harness is a recorder Codex so the run is cheap; registration is covered elsewhere."""
import json

import fixtures_setup as fs
from fixtures_setup import setup_scenario


def _codex(sb, *args, label=None, **options):
    return fs.setup(sb, '--agent', 'codex', *args, label=label, **options)


@setup_scenario('setup/state-first-run-and-reuse')
def _(sb):
    fs.place(sb)
    _codex(sb, '--chrome', '--audio', label='first run opts into chrome and audio')
    _codex(sb, label='second run keeps both opt-ins')
    _codex(sb, '--no-audio', label='--no-audio drops audio, chrome kept')
    _codex(sb, '--no-chrome', label='--no-chrome drops chrome')
    _codex(sb, '--audio', '--no-chrome', label='audio back on')
    _codex(sb, '--approval', 'auto', label='approval auto saved')
    _codex(sb, label='approval auto kept')
    _codex(sb, '--approval', 'ask', label='explicit approval ask')
    _codex(sb, label='defaulted ask')


@setup_scenario('setup/state-saved-prompt-skipped')
def _(sb):
    # A saved setup.json (even with chrome false) suppresses the interactive Chrome question.
    fs.place(sb)
    fs.put_state(sb, {'chrome': False, 'audio': False})
    fs.pty_setup(sb, [{'expect': 'Apply this setup?', 'send': 'y\n'}], '--agent', 'codex', '--session', 'direct',
                 label='saved state: no chrome prompt')
    fs.put_state(sb, {'chrome': True, 'audio': True, 'approval': 'auto'})
    fs.pty_setup(sb, [{'expect': 'Apply this setup?', 'send': 'n\n'}], '--agent', 'codex', '--session', 'direct',
                 label='saved opt-ins announced, then cancelled (state untouched)')


@setup_scenario('setup/state-malformed')
def _(sb):
    fs.place(sb)
    cases = [
        ('empty file', b''),
        ('not json', b'{nope'),
        ('json list', b'[]\n'),
        ('json string', b'"x"\n'),
        ('chrome missing', b'{"audio": false}\n'),
        ('chrome as 1', b'{"chrome": 1, "audio": false}\n'),
        ('audio as 0', b'{"chrome": false, "audio": 0}\n'),
        ('audio null', b'{"chrome": false, "audio": null}\n'),
        ('approval invalid', b'{"chrome": false, "audio": false, "approval": "yolo"}\n'),
        ('approval null', b'{"chrome": false, "audio": false, "approval": null}\n'),
        ('pending not list', b'{"chrome": false, "audio": false, "pending": "pi"}\n'),
        ('pending codex', b'{"chrome": false, "audio": false, "pending": ["codex"]}\n'),
        ('context not dict', b'{"chrome": false, "audio": false, "pending": ["pi"], "pending_context": []}\n'),
        ('context bad scope', b'{"chrome": false, "audio": false, "pending": ["pi"], "pending_context": '
                              b'{"scope": "x", "session": "direct", "project": null}}\n'),
        ('context bad session', b'{"chrome": false, "audio": false, "pending": ["pi"], "pending_context": '
                                b'{"scope": "user", "session": "x", "project": null}}\n'),
        ('context project number', b'{"chrome": false, "audio": false, "pending": ["pi"], "pending_context": '
                                   b'{"scope": "user", "session": "direct", "project": 3}}\n'),
        ('invalid utf-8', b'{"chrome": false, "audio": false, "x": "\xff"}\n'),
        ('trailing garbage', b'{"chrome": false, "audio": false} x\n'),
    ]
    for label, data in cases:
        fs.put_state(sb, raw_text=data)
        _codex(sb, label='setup.json: ' + label)
    fs.put_state(sb, raw_text=b'x')
    (sb.home / '.local/state/lcu/setup.json').unlink()
    (sb.home / '.local/state/lcu/setup.json').mkdir()
    _codex(sb, label='setup.json is a directory')


@setup_scenario('setup/state-lenient-inputs')
def _(sb):
    # Accepted variants that are normalised on the next write: extra keys dropped, defaults filled, BOM/UTF-16,
    # duplicate pending, context dropped when nothing is pending, NaN elsewhere, unicode keys.
    fs.place(sb)
    cases = [
        ('minimal', b'{"chrome": false, "audio": false}'),
        ('extra keys', b'{"zeta": 1, "chrome": true, "audio": false, "alpha": [1.0, 1e16, NaN]}'),
        ('utf-8 bom', b'\xef\xbb\xbf{"chrome": false, "audio": true}'),
        ('utf-16', '{"chrome": true, "audio": true}'.encode('utf-16')),
        ('context without pending', b'{"chrome": false, "audio": false, "pending": [], "pending_context": '
                                    b'{"scope": "user", "session": "direct", "project": null}}'),
        ('duplicate keys last wins', b'{"chrome": true, "chrome": false, "audio": false}'),
        ('unicode key', '{"chrome": false, "audio": false, "été": "\U0001f600"}'.encode()),
    ]
    for label, data in cases:
        fs.put_state(sb, raw_text=data)
        _codex(sb, label='setup.json: ' + label)
        sb.run(['/bin/cat', sb.home / '.local/state/lcu/setup.json'], label='after: ' + label)


@setup_scenario('setup/state-pending-preserved')
def _(sb):
    # Pending harnesses saved by an earlier --allow-missing run survive an unrelated setup.
    fs.place(sb)
    fs.put_state(sb, {'chrome': False, 'audio': True, 'approval': 'auto', 'pending': ['pi', 'pi', 'hermes'],
                      'pending_context': {'session': 'direct', 'project': None, 'scope': 'user'}})
    _codex(sb, label='codex while pi/hermes are pending')


@setup_scenario('setup/state-file-modes')
def _(sb):
    fs.place(sb)
    fs.put_state(sb, {'chrome': False, 'audio': False})
    (sb.home / '.local/state/lcu/setup.json').chmod(0o644)
    _codex(sb, '--audio', label='existing setup.json mode 0644 is kept')
    (sb.home / '.local/state/lcu/setup.json').chmod(0o444)
    _codex(sb, '--no-audio', label='read-only setup.json is replaced, mode kept')
    (sb.home / '.local/state/lcu').chmod(0o555)
    _codex(sb, '--audio', label='read-only state directory')
    (sb.home / '.local/state/lcu').chmod(0o755)


@setup_scenario('setup/state-symlinks')
def _(sb):
    fs.place(sb)
    real = sb.home / 'elsewhere'
    real.mkdir()
    (sb.home / '.local').mkdir()
    (sb.home / '.local/state').symlink_to(real)
    _codex(sb, label='~/.local/state is a symlink')
    (sb.home / '.local/state').unlink()
    (sb.home / '.local/state/lcu').mkdir(parents=True)
    (sb.home / '.local/state/lcu/setup.json').symlink_to(real / 'setup.json')
    _codex(sb, label='setup.json is a dangling symlink')
    (sb.home / '.local/state/lcu/setup.json').unlink()
    (sb.home / '.local/state/lcu/setup.lock').unlink(missing_ok=True)
    (sb.home / '.local/state/lcu/setup.lock').symlink_to(real / 'lock')
    _codex(sb, label='setup.lock is a symlink')


@setup_scenario('setup/lock-file-blocks')
def _(sb):
    fs.place(sb)
    lock = sb.home / '.local/state/lcu/setup.lock'
    sb.run([sb.bb / 'tools/python3', sb.bb / 'lockrun.py', 'hold', '3', lock, '--', fs.lcu(sb), 'setup',
            '--agent', 'codex', '--yes', '--session', 'direct'], label='setup waits for a held setup.lock')
    sb.run([sb.bb / 'tools/python3', sb.bb / 'lockrun.py', 'hold', '3', lock, '--', fs.lcu(sb), 'setup',
            '--validate-only', '--agent', 'codex'], label='validate-only does not take the lock')
    sb.run([sb.bb / 'tools/python3', sb.bb / 'lockrun.py', 'hold', '3', lock, '--', fs.lcu(sb), 'setup',
            '--agent', 'codex', '--session', 'direct'], label='no --yes: fails before the lock')


@setup_scenario('setup/lock-parallel-setups')
def _(sb):
    fs.place(sb)
    sb.run([sb.bb / 'tools/python3', sb.bb / 'lockrun.py', 'parallel', '3', '--', fs.lcu(sb), 'setup',
            '--agent', 'codex', '--yes', '--session', 'direct', '--audio'], label='three setups at once', timeout=180)


@setup_scenario('setup/session-discover')
def _(sb):
    # Linux default session: registered commands go through lcu-session --user ACCOUNT --.
    fs.place(sb)
    fs.setup(sb, '--agent', 'codex', direct=False, label='default session (discover)')
    fs.setup(sb, '--agent', 'codex', '--session', 'discover', '--chrome', '--audio', direct=False,
             label='explicit discover with flags')
    fs.setup(sb, '--agent', 'codex', '--user', 'ubuntu', direct=False, label='--user ubuntu')


@setup_scenario('setup/tested-pair')
def _(sb):
    # The preview's tested-pair lines for a pair recorded in tested-versions.json (the fixture default is untested).
    version, runtime = '26.928.31416', '0.0.27/20260927214556-b77d38801cca'
    fs.place(sb, app_kwargs={'version': version, 'runtime_version': runtime},
             installation={'package_version': version, 'runtime': runtime})
    _codex(sb, label='tested pair')
