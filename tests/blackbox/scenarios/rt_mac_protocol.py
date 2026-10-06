"""macOS lifecycle host protocol, driven through the real launch path by the fake node_repl (probe `mac` steps).

Lifetime socket: one newline-terminated JSON request per connection ({session_id, turn_id}), answered with
{"notified": true} after the signed client ran `turn-ended PAYLOAD`, or {"notified": false, "error": ...} (also
printed on stderr). Control socket (LCU_MAC_CONTROL_SOCKET): a trusted service connection routes user status/stop
requests. Also the unchanged macos_sky_service.mjs wrapper end to end against the host.

No signals are sent anywhere in this module.
"""
import json

from fixtures_rt import DARWIN, place, rt_scenario
from scenarios.rt_mac import STATUSES, _mac, lifetime


def _req(**values):
    return {'json': values}


def _ok(name='a', session='s1', turn='t1'):
    return lifetime(name, _req(session_id=session, turn_id=turn))


@rt_scenario('rt/mac/lifetime-requests', hosts=DARWIN, normalise=STATUSES)
def _(sb):
    ctx = place(sb, 'darwin')
    script = []
    cases = [
        ('valid', {'session_id': 's1', 'turn_id': 't1'}),
        ('extra keys ignored', {'session_id': 's1', 'turn_id': 't1', 'x': [1, {'y': None}]}),
        ('blank session', {'session_id': '  ', 'turn_id': 't1'}),
        ('blank turn', {'session_id': 's1', 'turn_id': ''}),
        ('missing turn', {'session_id': 's1'}),
        ('numeric ids', {'session_id': 1, 'turn_id': 2}),
        ('null ids', {'session_id': None, 'turn_id': None}),
        ('unicode ids', {'session_id': 'sé☃😀', 'turn_id': 'tü'}),
        ('quotes and backslashes', {'session_id': "it's \"q\"", 'turn_id': 'a\\b'}),
        ('control characters', {'session_id': 'a\nb\tc\u0001\u007f', 'turn_id': ' '}),
        ('long ids', {'session_id': 'S' * 1500, 'turn_id': 'T' * 1500}),
    ]
    for index, (_, request) in enumerate(cases):
        script += lifetime(f'c{index}', {'json': request})
    for index, text in enumerate(('[]', '1', '"s"', 'null', 'true', '{}')):
        script += lifetime(f'j{index}', {'text': text})
    _mac(sb, ctx, 'request shapes', script)


@rt_scenario('rt/mac/lifetime-malformed', hosts=DARWIN, normalise=STATUSES)
def _(sb):
    # Python json error messages (with code-point positions), framing limits, and decoding failures.
    ctx = place(sb, 'darwin')
    script = []
    for index, text in enumerate((
        '', 'not json', '{', '{"a":}', '[1,', '{"session_id":"s1","turn_id":"t1"} x', '{"a":"\t"}',
        "{'a':1}", '{"a":1,}', '{"a":"x', '{"😀":"😀"} x', '{"é": nope}', 'NaN', '{"a":NaN}', ' ', ' {}',
        '{"session_id":"s1","turn_id":"t1"}{"x":1}', '{"a":"\\ud800"}', '{"a":"\\q"}', '1e400',
    )):
        script += lifetime(f'm{index}', {'text': text})
    for index, raw in enumerate(('ff0a', 'efbbbf7b7d0a', '7b2261223a22c3' + '220a', '000a',
                                 'fffe7b00220061002200', 'c0af0a')):
        script += lifetime(f'b{index}', {'hex': raw})
    _mac(sb, ctx, 'malformed requests', script)


@rt_scenario('rt/mac/lifetime-framing', hosts=DARWIN, normalise=STATUSES)
def _(sb):
    ctx = place(sb, 'darwin')
    script = []
    for size in (4095, 4096, 4097, 5000):
        script += lifetime(f'p{size}', {'json': {'session_id': 's1', 'turn_id': 't1'}, 'padTo': size})
    script += lifetime('fill', {'fill': 70000}, timeout=8000)
    script += lifetime('bytes', {'json': {'session_id': 's1', 'turn_id': 't1'}, 'byByte': 5})
    script += lifetime('chunks', {'chunks': [{'text': '{"session_id":"s1",', 'newline': False},
                                             {'text': '"turn_id":"t1"}'}], 'delayMs': 300})
    script += lifetime('two', {'text': '{"session_id":"s1","turn_id":"t1"}\n{"session_id":"s2","turn_id":"t2"}'})
    script += lifetime('trailing', {'text': '{"session_id":"s1","turn_id":"t1"}\ngarbage', 'newline': False})
    script += lifetime('crlf', {'text': '{"session_id":"s1","turn_id":"t1"}\r'})
    script += lifetime('halfclose', {'json': {'session_id': 's1', 'turn_id': 't1'}, 'end': True})
    script += lifetime('eof', {'text': '{"session_id":"s1"', 'newline': False, 'end': True})
    script += lifetime('empty-eof', {'text': '', 'newline': False, 'end': True})
    _mac(sb, ctx, 'framing', script, timeout=60)


@rt_scenario('rt/mac/lifetime-connections', hosts=DARWIN, normalise=STATUSES)
def _(sb):
    # The host handles one connection at a time: a silent client delays the next until its 3 s read timeout.
    ctx = place(sb, 'darwin')
    script = [{'op': 'connect', 'name': 'silent', 'to': 'lifetime'},
              *lifetime('next', {'json': {'session_id': 's1', 'turn_id': 't1'}}, timeout=8000),
              {'op': 'recv', 'name': 'silent', 'timeoutMs': 8000}]
    script += [{'op': 'connect', 'name': 'gone', 'to': 'lifetime'},
               {'op': 'send', 'name': 'gone', 'json': {'session_id': 's1', 'turn_id': 'slow'}},
               {'op': 'close', 'name': 'gone', 'destroy': True}, {'op': 'sleep', 'ms': 1500},
               *_ok('after-disconnect')]
    script += [{'op': 'connect', 'name': 'k1', 'to': 'lifetime'}, {'op': 'close', 'name': 'k1'},
               *_ok('after-empty-close')]
    script += [{'op': 'stat', 'what': 'lifetime'}]
    client = {'rules': [{'match': 'slow', 'sleepMs': 800}], 'quietEnv': True}
    _mac(sb, ctx, 'connections', script, client=client, timeout=60)


@rt_scenario('rt/mac/lifetime-client', hosts=DARWIN, normalise=STATUSES)
def _(sb):
    # What the signed client is given (argv, cwd, env, stdin) and how its failures are reported.
    ctx = place(sb, 'darwin')
    client = {'rules': [
        {'match': '"turn-id":"fail3"', 'exit': 3, 'say': 'client: failing\n'},
        {'match': '"turn-id":"fail255"', 'exit': 255},
        {'match': '"turn-id":"noisy"', 'stdout': 200000, 'stderr': 200000},
        {'match': '"turn-id":"slow"', 'sleepMs': 4500},
        {'match': '"turn-id":"almost"', 'sleepMs': 2000},
    ]}
    script = []
    for turn in ('t1', 'fail3', 'fail255', 'noisy', 'almost', 'slow'):
        script += lifetime(turn, {'json': {'session_id': 's1', 'turn_id': turn}}, timeout=9000)
    script += lifetime('quote', {'json': {'session_id': "it's", 'turn_id': 'slow'}}, timeout=9000)
    script += lifetime('long', {'json': {'session_id': 'L' * 600, 'turn_id': 'slow'}}, timeout=9000)
    _mac(sb, ctx, 'client behaviours', script, client=client, timeout=90)
    _mac(sb, ctx, 'client env with caller variables', _ok(), client={},
         env={'NODE_OPTIONS': '--no-warnings', 'EXTRA_VAR': 'x'})
    client_path = ctx.app_client
    for label, ops in (
        ('client made non-executable after start', [{'op': 'chmod', 'what': 'client', 'mode': '0644'}]),
        ('client removed after start', [{'op': 'rename', 'what': 'client'}]),
    ):
        _mac(sb, ctx, label, ops + _ok())
        moved = client_path.with_name(client_path.name + '.moved')
        if moved.exists():
            moved.rename(client_path)
        client_path.chmod(0o755)


def _control(sb, name='control.sock'):
    return {'LCU_MAC_CONTROL_SOCKET': str(sb.tmp / name)}


def _service(name='svc', contexts=()):
    steps = [{'op': 'connect', 'name': name, 'to': 'control'}, {'op': 'send', 'name': name, 'json': {'type': 'service'}},
             {'op': 'sleep', 'ms': 200}]
    for ctx in contexts:
        steps.append({'op': 'send', 'name': name, 'json': {'type': 'context', **ctx}})
    steps.append({'op': 'sleep', 'ms': 200})
    return steps


def _user(name, request, *, recv=True, timeout=6000, raw=None):
    steps = [{'op': 'connect', 'name': name, 'to': 'control'},
             {'op': 'send', 'name': name, **({'text': raw} if raw is not None else {'json': request})}]
    if recv:
        steps.append({'op': 'recv', 'name': name, 'timeoutMs': timeout})
    return steps


CTX = {'token': 'tok1', 'session_id': 's1', 'turn_id': 't1', 'app': 'com.apple.TextEdit'}


@rt_scenario('rt/mac/control-routing', hosts=DARWIN, normalise=STATUSES)
def _(sb):
    # User requests are forwarded to the trusted service (with a request id and a ~40 s deadline); its response is
    # returned to the user verbatim, or turned into an error when it is not an object or the service goes away.
    ctx = place(sb, 'darwin')
    script = _service(contexts=[CTX, {'token': 'tok2', 'session_id': 's1', 'turn_id': 't1'}])

    def roundtrip(name, request, result=None, raw=None):
        steps = _user(name, request, recv=False)
        steps.append({'op': 'recv', 'name': 'svc', 'timeoutMs': 5000})
        if raw is not None:
            steps.append({'op': 'send', 'name': 'svc', 'text': raw})
        else:
            steps.append({'op': 'send', 'name': 'svc', 'replyTo': 'svc', 'result': result})
        steps.append({'op': 'recv', 'name': name, 'timeoutMs': 5000})
        return steps

    script += roundtrip('status', {'type': 'status', 'session_id': 's1', 'turn_id': 't1'},
                        {'ok': True, 'result': {'computerUse': {'activeApplications': []}, 'x': 'é😀'}})
    script += roundtrip('status-extra', {'type': 'status', 'session_id': 's1', 'turn_id': 't1', 'app': 'com.x', 'y': 1},
                        {'ok': True})
    script += roundtrip('stop', {'type': 'stop', 'session_id': 's1', 'turn_id': 't1', 'app': 'com.apple.TextEdit'},
                        {'ok': True, 'result': {'accepted': True}})
    script += roundtrip('list-response', {'type': 'status', 'session_id': 's1', 'turn_id': 't1'}, [1, 2])
    script += roundtrip('null-response', {'type': 'status', 'session_id': 's1', 'turn_id': 't1'}, None)
    script += roundtrip('error-response', {'type': 'status', 'session_id': 's1', 'turn_id': 't1'},
                        {'ok': False, 'error': 'x' * 600})
    script += roundtrip('unknown-id', {'type': 'status', 'session_id': 's1', 'turn_id': 't1'},
                        raw='{"type":"result","request_id":"someone-else","response":{"ok":true}}')
    # the user gave up waiting for 'unknown-id'; the service now disconnects with a request pending
    script += _user('pending', {'type': 'status', 'session_id': 's1', 'turn_id': 't1'}, recv=False)
    script += [{'op': 'recv', 'name': 'svc', 'timeoutMs': 5000}, {'op': 'close', 'name': 'svc', 'destroy': True},
               {'op': 'recv', 'name': 'pending', 'timeoutMs': 5000}]
    _mac(sb, ctx, 'routing', script, env=_control(sb), timeout=90)


@rt_scenario('rt/mac/control-errors', hosts=DARWIN, normalise=STATUSES)
def _(sb):
    ctx = place(sb, 'darwin')
    script = _service(contexts=[CTX])
    for index, (request, raw) in enumerate((
        ({'type': 'bogus'}, None), ([1], None), ('x', None), ({'type': 'status'}, None),
        ({'type': 'status', 'session_id': ' ', 'turn_id': 't1'}, None),
        ({'type': 'status', 'session_id': 's1', 'turn_id': 1}, None),
        ({'type': 'stop', 'session_id': 's1', 'turn_id': 't1'}, None),
        ({'type': 'stop', 'session_id': 's1', 'turn_id': 't1', 'app': '  '}, None),
        ({'type': 'status', 'session_id': 'other', 'turn_id': 't1'}, None),
        ({'type': 'stop', 'session_id': 'other', 'turn_id': 't9', 'app': 'com.x'}, None),
        (None, 'not json'), (None, ''), (None, '{"type":"status"'),
    )):
        script += _user(f'e{index}', request, raw=raw)
    script += [{'op': 'connect', 'name': 'svc2', 'to': 'control'},
               {'op': 'send', 'name': 'svc2', 'json': {'type': 'service'}},
               {'op': 'recv', 'name': 'svc2', 'timeoutMs': 3000}]
    script += [{'op': 'connect', 'name': 'big', 'to': 'control'}, {'op': 'send', 'name': 'big', 'fill': 5000},
               {'op': 'recv', 'name': 'big', 'timeoutMs': 3000}]
    script += [{'op': 'connect', 'name': 'idle', 'to': 'control'}, {'op': 'recv', 'name': 'idle', 'timeoutMs': 6000}]
    _mac(sb, ctx, 'user request errors', script, env=_control(sb), timeout=90)


@rt_scenario('rt/mac/control-service-messages', hosts=DARWIN, normalise=STATUSES)
def _(sb):
    # A bad service message drops the service (its contexts too); a new service may then connect.
    ctx = place(sb, 'darwin')
    script = []
    for index, message in enumerate((
        '[1]', '{"type":"bogus"}', '{"type":"context","token":"","session_id":"s1","turn_id":"t1"}',
        '{"type":"context","token":"t","session_id":" ","turn_id":"t1"}',
        '{"type":"context","token":"t","session_id":"s1","turn_id":"t1","app":" "}',
        '{"type":"context","token":"t","session_id":"s1","turn_id":"t1","app":5}', 'nope',
    )):
        name = f'svc{index}'
        script += [{'op': 'connect', 'name': name, 'to': 'control'},
                   {'op': 'send', 'name': name, 'json': {'type': 'service'}}, {'op': 'sleep', 'ms': 150},
                   {'op': 'send', 'name': name, 'text': message}, {'op': 'wait_closed', 'name': name, 'timeoutMs': 3000}]
    script += _service('good', contexts=[CTX])
    script += [{'op': 'send', 'name': 'good', 'json': {'type': 'context-ended', 'token': 'unknown'}},
               {'op': 'send', 'name': 'good', 'json': {'type': 'result', 'request_id': 'nobody', 'response': {}}},
               {'op': 'sleep', 'ms': 200}]
    script += _user('u', {'type': 'status', 'session_id': 's1', 'turn_id': 't1'}, recv=False)
    script += [{'op': 'recv', 'name': 'good', 'timeoutMs': 5000}, {'op': 'close', 'name': 'good', 'destroy': True},
               {'op': 'recv', 'name': 'u', 'timeoutMs': 5000}]
    script += _service('again', contexts=[CTX])
    script += [{'op': 'send', 'name': 'again', 'json': {'type': 'context-ended', 'token': 'tok1'}}, {'op': 'sleep', 'ms': 200}]
    script += _user('u2', {'type': 'status', 'session_id': 's1', 'turn_id': 't1'})
    _mac(sb, ctx, 'service messages', script, env=_control(sb), timeout=90)


@rt_scenario('rt/mac/control-unavailable', hosts=DARWIN, normalise=STATUSES)
def _(sb):
    # The control socket cannot be bound: a warning, and the lifetime socket still works.
    ctx = place(sb, 'darwin')
    (sb.tmp / 'occupied').write_text('foreign file\n')
    for label, path in (
        ('parent directory missing', str(sb.tmp / 'missing/control.sock')),
        ('path already a regular file', str(sb.tmp / 'occupied')),
        ('path too long', str(sb.tmp / ('x' * 120))),
        ('path is a directory', str(sb.tmp)),
    ):
        _mac(sb, ctx, label, _ok(), env={'LCU_MAC_CONTROL_SOCKET': path})


@rt_scenario('rt/mac/control-wait-no-service', hosts=DARWIN, normalise=STATUSES)
def _(sb):
    # Slow (40 s): a user request while no trusted service is connected waits for one, then fails.
    ctx = place(sb, 'darwin')
    script = _user('u', {'type': 'status', 'session_id': 's1', 'turn_id': 't1'}, timeout=50000)
    _mac(sb, ctx, 'no service connected', script, env=_control(sb), timeout=90)


@rt_scenario('rt/mac/wrapper-e2e', hosts=DARWIN, normalise=STATUSES)
def _(sb):
    # The unchanged macos_sky_service.mjs wrapper, loaded as node_repl would, against the real host and fake client.
    ctx = place(sb, 'darwin')
    meta = {'x-codex-turn-metadata': {'session_id': 's1', 'turn_id': 't1'}}
    script = [
        {'op': 'wrapper_rpc', 'request': {'type': 'setup'}, 'meta': meta},
        {'op': 'wrapper_rpc', 'request': {'type': 'execute', 'method': 'get_app_state', 'args': ['com.apple.TextEdit']},
         'meta': meta},
        *_user('status', {'type': 'status', 'session_id': 's1', 'turn_id': 't1'}, timeout=20000),
        *_user('stop', {'type': 'stop', 'session_id': 's1', 'turn_id': 't1', 'app': 'com.apple.TextEdit'}, timeout=30000),
        *_user('stop-other', {'type': 'stop', 'session_id': 's1', 'turn_id': 't1', 'app': 'com.apple.Notes'}, timeout=30000),
        {'op': 'wrapper_turn_ended', 'session_id': 's1', 'turn_id': 't1'},
        *_user('after-end', {'type': 'status', 'session_id': 's1', 'turn_id': 't1'}, timeout=20000),
        {'op': 'wrapper_turn_ended', 'session_id': ' ', 'turn_id': 't1'},
    ]
    _mac(sb, ctx, 'wrapper with control socket', script, env=_control(sb), timeout=120)
    _mac(sb, ctx, 'wrapper without control socket', [
        {'op': 'wrapper_rpc', 'request': {'type': 'execute', 'method': 'list_windows', 'args': []}, 'meta': meta},
        {'op': 'wrapper_turn_ended', 'session_id': 's2', 'turn_id': 't2'}], timeout=60)
    _mac(sb, ctx, 'wrapper turn cleanup when the client fails', [
        {'op': 'wrapper_rpc', 'request': {'type': 'setup'}, 'meta': meta},
        {'op': 'wrapper_turn_ended', 'session_id': 's1', 'turn_id': 't1'}],
        client={'default': {'exit': 4}}, timeout=60)
