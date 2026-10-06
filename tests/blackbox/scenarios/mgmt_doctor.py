"""`lcu doctor`: argument handling, the readiness probe results, Linux sandbox status, interactive guidance.

The probe runs the real doctor JavaScript against a fake Sky service module that the scenario rewrites to produce
each result (permission errors, invalid screenshots, import failures, garbage output). Interactive paths run on a
pty (stdin is a terminal) with scripted answers.
"""
import json

import fixtures
import fixtures_mgmt as fm

from . import scenario

ANY = ('darwin', 'linux')
# Doctor's Linux sandbox probe runs in $TMPDIR/lcu-sandbox-probe-<random>.
TMP = ('tmpdir-suffix',)
MAC = ('darwin',)
DESKTOP = {'DISPLAY': ':99', 'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/nonexistent/bus'}


def _note(sb, text):
    sb.run(['echo', text], label=text)


def _linux(sb):
    sb.place_release('linux')


def _sandbox_probe(sb, exit_code=12, stderr=''):
    rule = {'argv': ['sandbox'], 'exit': exit_code}
    if stderr:
        rule['stderr'] = stderr
    sb.fake('app-codex', env=['HOME', 'CODEX_HOME'], appServer=True,
            rules=[rule, {'argv': ['--version'], 'stdout': 'codex-cli 0.0.0-fake\n'}])


@scenario('doctor/arguments', hosts=ANY, normalise=TMP)
def _(sb):
    sb.place_release()
    for args in (['--help'], ['-h'], ['--bogus'], ['extra'], ['--non'], ['--require'], ['--non-interactive', '--help'],
                 ['--non-interactive=1']):
        sb.lcu('doctor', *args)
    # --help never resolves the app; every other form does, so a broken app fails them (usage errors come later).
    (sb.release / 'installation.json').write_text('{}')
    sb.lcu('doctor', '--help')
    sb.lcu('doctor', '--bogus')
    sb.lcu('doctor', '--non-interactive')
    sb.lcu('--chrome', 'doctor', '--non-interactive')
    sb.lcu('--audio', '--chrome', 'doctor', '--help')
    sb.lcu('doctor', '--chrome')


@scenario('doctor/linux-environment', hosts=ANY, normalise=TMP)
def _(sb):
    _linux(sb)
    _sandbox_probe(sb)
    for label, env in (('no display, no bus', {}), ('display only', {'DISPLAY': ':99'}),
                       ('bus only', {'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/x'}),
                       ('empty values', {'DISPLAY': '', 'DBUS_SESSION_BUS_ADDRESS': ''}),
                       ('both', DESKTOP)):
        _note(sb, f'--- {label}')
        sb.lcu('doctor', '--non-interactive', env=env)
    _note(sb, '--- --require-ready, both set')
    sb.lcu('doctor', '--non-interactive', '--require-ready', env=DESKTOP)
    _note(sb, '--- --require-ready, no display')
    sb.lcu('doctor', '--require-ready', env={})
    _note(sb, '--- stdin is not a terminal (piped answers are ignored)')
    sb.lcu('doctor', env=DESKTOP, stdin=b'r\n\n')


@scenario('doctor/linux-sandbox', hosts=ANY, normalise=TMP)
def _(sb):
    _linux(sb)
    for label, code, stderr, env in (
            ('sandbox works', 12, '', {}),
            ('sandbox works, shim variable present', 12, '', {'LCU_SANDBOX_SHIM': '1'}),
            ('read probe fails (exit 10)', 10, '', {}),
            ('write unexpectedly allowed (exit 11)', 11, 'bwrap: something\n', {}),
            ('detail whitespace collapsed', 1, 'bwrap:   No permissions\n\tto create new namespace\n', {}),
            ('detail truncated at 200', 1, 'x' * 300 + '\n', {}),
            ('exit 0', 0, '', {}),
            ('mode host', 12, '', {'LCU_NODE_REPL_SANDBOX': 'host'}),
            ('mode OFF with spaces', 12, '', {'LCU_NODE_REPL_SANDBOX': ' OFF '}),
            ('mode HOST upper case', 12, '', {'LCU_NODE_REPL_SANDBOX': 'HOST'}),
            ('mode unknown value', 12, '', {'LCU_NODE_REPL_SANDBOX': 'maybe'}),
            ('mode off, sandbox broken', 1, '', {'LCU_NODE_REPL_SANDBOX': 'off'})):
        _sandbox_probe(sb, code, stderr)
        _note(sb, f'--- {label}')
        sb.lcu('doctor', '--non-interactive', env={**DESKTOP, **env})
    # The sandbox probe is run with the unshimmed Codex path; record how.
    sb.fake('app-codex', env=['CODEX_CLI_PATH', 'HOME'], appServer=True,
            rules=[{'argv': ['sandbox'], 'exit': 12}])
    _note(sb, '--- environment seen by the sandbox probe')
    sb.lcu('doctor', '--non-interactive', env={**DESKTOP, 'LCU_SANDBOX_SHIM': '1', 'EXTRA_FOR_PROBE': 'kept'})


def _flaky_service(sb, first='fail'):
    """Fails the first probe process, succeeds afterwards (the flag file lives in the harness directory)."""
    flag = sb.bb / 'probe-flag'
    fm.sky_service(sb, f'''import fs from 'node:fs';
const flag = {json.dumps(str(flag))};
const first = !fs.existsSync(flag);
fs.writeFileSync(flag, 'x');
export async function handleRpc(request) {{
  if (request.type === 'setup') return {{ target: 'linux', methods: [] }};
  if (first) {{ const e = new Error('first run failure'); e.code = -10009; throw e; }}
  if (request.method === 'list_windows') return [{{ id: 1 }}, {{ id: 2 }}];
  if (request.method === 'get_screenshot') return [{{ data_url: 'data:image/png;base64,AA' }}];
  return null;
}}
''')


LINUX_SERVICES = [
    ('ready (default fixture)', None),
    ('window count 0', fm.service_returning('linux', list_windows={'value': []},
                                            get_screenshot={'value': [{'data_url': 'data:image/png;base64,AA'}]})),
    ('two screenshots', fm.service_returning('linux', list_windows={'value': [1, 2, 3]},
                                             get_screenshot={'value': [{'data_url': 'data:image/png;base64,A'},
                                                                       {'data_url': 'data:image/jpeg;base64,B'}]})),
    ('permissions not granted (code)', fm.service_returning('linux', list_windows={'throw': {'code': -10009}})),
    ('permissions not granted (name)', fm.service_returning('linux', list_windows={'throw': {'name': 'permissionsNotGranted'}})),
    ('permissions pending (code)', fm.service_returning('linux', list_windows={'throw': {'code': -10014}})),
    ('permissions pending (name)', fm.service_returning('linux', list_windows={'throw': {'name': 'permissionsPending'}})),
    ('error message, whitespace collapsed', fm.service_returning('linux', list_windows={'throw': {'message': 'bad\n  thing\thappened'}})),
    ('error message over 240 chars', fm.service_returning('linux', list_windows={'throw': {'message': 'm' * 300}})),
    ('error without message', fm.service_returning('linux', list_windows={'throw': {}})),
    ('window list invalid', fm.service_returning('linux', list_windows={'value': {'not': 'a list'}})),
    ('window list null', fm.service_returning('linux', list_windows={'value': None})),
    ('screenshot throws', fm.service_returning('linux', list_windows={'value': [1]},
                                               get_screenshot={'throw': {'message': 'no capture'}})),
    ('screenshot empty list', fm.service_returning('linux', list_windows={'value': [1]}, get_screenshot={'value': []})),
    ('screenshot data_url missing', fm.service_returning('linux', list_windows={'value': [1]},
                                                         get_screenshot={'value': [{}]})),
    ('screenshot data_url not an image', fm.service_returning('linux', list_windows={'value': [1]},
                                                              get_screenshot={'value': [{'data_url': 'text/plain,x'}]})),
    ('screenshot not a list', fm.service_returning('linux', list_windows={'value': [1]}, get_screenshot={'value': 'x'})),
    ('target mismatch (mac)', fm.service_returning('mac', methods=['list_apps', 'get_app_state'])),
    ('target mismatch (windows)', fm.service_returning('windows', list_windows={'value': []})),
    ('target missing', 'export async function handleRpc(request) { return request.type === "setup" ? {} : null; }\n'),
    ('setup throws', 'export async function handleRpc(request) { throw Object.assign(new Error("setup broke"), {code: 7}); }\n'),
    ('module has a syntax error', 'export async function handleRpc( {\n'),
    ('module exits 0 silently', 'process.exit(0);\nexport async function handleRpc() {}\n'),
    ('module exits 5 silently', 'process.exit(5);\nexport async function handleRpc() {}\n'),
    ('module exits 3 with stdout', 'console.log("only stdout\\nsecond line");\nprocess.exit(3);\nexport async function handleRpc() {}\n'),
    ('module exits 3 with stderr', 'console.error("only   stderr\\nsecond line");\nprocess.exit(3);\nexport async function handleRpc() {}\n'),
    ('trailing garbage line', 'process.on("exit", () => console.log("zzz not json"));\n'
                              'export async function handleRpc(r) { return r.type === "setup" ? {target: "linux"} : []; }\n'),
    ('trailing JSON array', 'process.on("exit", () => console.log("[1]"));\n'
                            'export async function handleRpc(r) { return r.type === "setup" ? {target: "linux"} : []; }\n'),
    ('extra output before the result', 'console.log("noise\\n\\n");\n'
                                       'export async function handleRpc(r) { return r.type === "setup" ? {target: "linux"} : [{id: 1}]; }\n'),
    ('non-UTF-8 output', 'process.stderr.write(Buffer.from([0xff, 0xfe, 0x41]));\nprocess.exit(2);\nexport async function handleRpc() {}\n'),
]


@scenario('doctor/linux-probe', hosts=ANY, normalise=TMP)
def _(sb):
    _linux(sb)
    _sandbox_probe(sb)
    for label, source in LINUX_SERVICES:
        if source is not None:
            fm.sky_service(sb, source)
        _note(sb, f'--- {label}')
        sb.lcu('doctor', '--non-interactive', env=DESKTOP)
    _note(sb, '--- --require-ready after a failure')
    sb.lcu('doctor', '--non-interactive', '--require-ready', env=DESKTOP)


@scenario('doctor/linux-interactive', hosts=ANY, normalise=TMP)
def _(sb):
    _linux(sb)
    _sandbox_probe(sb)
    prompt = 'Choice [r/Enter]:'
    runs = (('ready: no prompt at all', None, []),
            ('failing, Enter', 'fail', [(prompt, '\n')]),
            ('failing, r then Enter', 'fail', [(prompt, 'r\n'), (prompt, '\n')]),
            ('failing, R (upper case) then Enter', 'fail', [(prompt, 'R\n'), (prompt, '\n')]),
            ('failing, " r " with spaces', 'fail', [(prompt, ' r \n'), (prompt, '\n')]),
            ('failing, other text finishes', 'fail', [(prompt, 'x\n')]),
            ('failing, EOF', 'fail', [(prompt, '<EOF>')]),
            ('failing, retry twice', 'fail', [(prompt, 'r\n'), (prompt, 'r\n'), (prompt, '\n')]),
            ('flaky: first fails, retry succeeds', 'flaky', [(prompt, 'r\n')]))
    for label, kind, steps in runs:
        if kind == 'fail':
            fm.sky_service(sb, fm.service_returning('linux', list_windows={'throw': {'code': -10009}}))
        elif kind == 'flaky':
            (sb.bb / 'probe-flag').unlink(missing_ok=True)
            _flaky_service(sb)
        elif kind is None:
            fm.sky_service(sb, fm.service_returning(
                'linux', list_windows={'value': [1]}, get_screenshot={'value': [{'data_url': 'data:image/png;base64,A'}]}))
        _note(sb, f'--- {label}')
        fm.pty(sb, steps, [sb.release / 'bin/lcu', 'doctor'], label=f'doctor on a terminal: {label}', env=DESKTOP)
    _note(sb, '--- terminal but --non-interactive')
    fm.pty(sb, [], [sb.release / 'bin/lcu', 'doctor', '--non-interactive'], env=DESKTOP, label='doctor --non-interactive on a terminal')
    _note(sb, '--- strict, failing, terminal, Enter')
    fm.sky_service(sb, fm.service_returning('linux', list_windows={'throw': {'code': -10009}}))
    fm.pty(sb, [(prompt, '\n')], [sb.release / 'bin/lcu', 'doctor', '--require-ready'], env=DESKTOP,
           label='doctor --require-ready on a terminal')
    _note(sb, '--- probe fails to run, terminal: no guidance prompt')
    fm.sky_service(sb, 'process.exit(5);\nexport async function handleRpc() {}\n')
    fm.pty(sb, [], [sb.release / 'bin/lcu', 'doctor'], env=DESKTOP, label='doctor on a terminal, probe broken')


MAC_SERVICES = [
    ('provider loaded (default fixture)', None),
    ('only list_apps', fm.service_returning('mac', methods=['list_apps'])),
    ('no methods', fm.service_returning('mac', methods=[])),
    ('extra methods ignored', fm.service_returning('mac', methods=['list_apps', 'get_app_state', 'other'])),
    ('target mismatch (linux)', fm.service_returning('linux', list_windows={'value': []})),
    ('target mismatch (windows)', fm.service_returning('windows', list_windows={'value': []})),
    ('setup throws', 'export async function handleRpc(request) { throw Object.assign(new Error("no helper"), {code: -10009}); }\n'),
    ('module exits 5 silently', 'process.exit(5);\nexport async function handleRpc() {}\n'),
    ('syntax error', 'export async function handleRpc( {\n'),
    ('methods not a list', 'export async function handleRpc(r) { return r.type === "setup" ? {target: "mac", methods: "list_apps"} : null; }\n'),
]


@scenario('doctor/mac-probe', hosts=MAC, normalise=TMP)
def _(sb):
    sb.place_release()
    for label, source in MAC_SERVICES:
        if source is not None:
            fm.sky_service(sb, source)
        _note(sb, f'--- {label}')
        sb.lcu('doctor', '--non-interactive')
    fm.sky_service(sb, MAC_SERVICES[0][1] or fm.service_returning('mac', methods=['list_apps', 'get_app_state']))
    _note(sb, '--- --require-ready with the provider loaded')
    sb.lcu('doctor', '--non-interactive', '--require-ready')
    sb.lcu('doctor', '--require-ready', stdin=b'a\n')
    _note(sb, '--- piped stdin is not a terminal')
    sb.lcu('doctor', stdin=b'a\ns\nr\n\n')


@scenario('doctor/mac-interactive', hosts=MAC, normalise=TMP)
def _(sb):
    sb.place_release()
    fm.sky_service(sb, fm.service_returning('mac', methods=['list_apps', 'get_app_state']))
    prompt = 'Choice [a/s/r/Enter]:'
    runs = (('Enter', [(prompt, '\n')]),
            ('a then Enter', [(prompt, 'a\n'), (prompt, '\n')]),
            ('s then Enter', [(prompt, 's\n'), (prompt, '\n')]),
            ('1 and 2', [(prompt, '1\n'), (prompt, '2\n'), (prompt, '\n')]),
            ('upper case A, padded s', [(prompt, 'A\n'), (prompt, '  s  \n'), (prompt, '\n')]),
            ('r (recheck) then Enter', [(prompt, 'r\n'), (prompt, '\n')]),
            ('q', [(prompt, 'q\n')]),
            ('done', [(prompt, 'done\n')]),
            ('Q upper case is not accepted', [(prompt, 'Q\n'), (prompt, '\n')]),
            ('junk then Enter', [(prompt, 'zzz\n'), (prompt, '\n')]),
            ('EOF', [(prompt, '<EOF>')]),
            ('a, EOF', [(prompt, 'a\n'), (prompt, '<EOF>')]))
    for label, steps in runs:
        _note(sb, f'--- {label}')
        fm.pty(sb, steps, [sb.release / 'bin/lcu', 'doctor'], label=f'doctor on a terminal: {label}')
    _note(sb, '--- opening Settings fails')
    sb.fake('open', default={'exit': 1, 'stderr': 'open: cannot open\n'})
    fm.pty(sb, [(prompt, 'a\n'), (prompt, 's\n'), (prompt, '\n')], [sb.release / 'bin/lcu', 'doctor'],
           label='doctor on a terminal: open fails')
    sb.fake('open', default={})
    _note(sb, '--- strict mode on a terminal')
    fm.pty(sb, [(prompt, '\n')], [sb.release / 'bin/lcu', 'doctor', '--require-ready'], label='doctor --require-ready on a terminal')
    _note(sb, '--- provider failing, terminal: guidance, then exit 2')
    fm.sky_service(sb, fm.service_returning('mac', methods=[]))
    fm.pty(sb, [(prompt, '\n')], [sb.release / 'bin/lcu', 'doctor'], label='doctor on a terminal, provider incomplete')
    _note(sb, '--- probe cannot run, terminal')
    fm.sky_service(sb, 'process.exit(5);\nexport async function handleRpc() {}\n')
    fm.pty(sb, [(prompt, 'r\n'), (prompt, '\n')], [sb.release / 'bin/lcu', 'doctor'], label='doctor on a terminal, probe broken')


@scenario('doctor/notices', hosts=ANY, normalise=TMP)
def _(sb):
    # The update line (cache only) and the tested-pair/changed-install lines in doctor's header.
    sb.place_release()
    fm.write_update_cache(sb, fm.latest_info('0.9.9', severity='breaking'), None)
    sb.lcu('doctor', '--non-interactive', env=DESKTOP)
    sb.lcu('doctor', '--non-interactive', env={**DESKTOP, 'LCU_NO_UPDATE_CHECK': '1'})
    fm.scrub_times(sb)
