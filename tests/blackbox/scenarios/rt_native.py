"""The Chrome native-messaging relay (`lcu-native-host`, installed by `lcu browser install` beside a private copy
of the original host). Chrome starts it with the extension origin; it relays length-prefixed frames both ways, turns
on the agent request header in the extension's `result` message, and refuses frames over 64 MiB.

The relay is located through the manifest the installer rewrites, so the scenario does not depend on the relay's
implementation language. The original host behind it is `assets/rt/exthost.mjs`. No signals are sent.
"""
import base64
import json
import shutil

import fixtures
import fixtures_mgmt as fm
from fixtures_rt import drive, place, rt_scenario

ORIGIN = 'chrome-extension://fakeextensionid/'


def _relay(sb):
    """Install the relay with the real `lcu browser install` and swap the private original host for the fake."""
    ctx = place(sb)
    fm.chrome_plugin(sb)
    shutil.copy(fm.ASSETS.parent / 'rt/exthost.mjs', ctx.tools / 'exthost.mjs')
    sb.run([ctx.lcu, 'browser', 'install'], label='lcu browser install')
    destination = fm.browser_destination(sb)
    manifests = sorted(sb.home.rglob('com.openai.codexextension.json'))
    relay = json.loads(manifests[0].read_text())['path']
    arch = fixtures.architecture()
    name = f'macos/{arch}/ChatGPT for Chrome' if fm.host() == 'darwin' else f'linux/{arch}/extension-host'
    host = destination / 'chrome/extension-host' / name
    host.unlink()
    fixtures.write(host, f'#!/bin/sh\nexec "$LCU_BB_NODE" {json.dumps(str(ctx.tools / "exthost.mjs"))} "$@"\n', 0o755)
    ctx.relay, ctx.host, ctx.destination = relay, host, destination
    return ctx


def _frames(*payloads):
    steps = []
    for payload in payloads:
        data = payload if isinstance(payload, bytes) else (
            payload.encode() if isinstance(payload, str) else json.dumps(payload).encode())
        steps.append({'frame': base64.b64encode(data).decode()})
    return steps


def _run(sb, ctx, label, stdin, host=None, args=(ORIGIN,), **spec):
    spec = {'argv': [ctx.relay, *args], 'stdin': stdin, 'env': {'RT_HOST': json.dumps(host or {'echo': True})},
            'show': {'stdout': 'frames'}, **spec}
    return drive(sb, ctx, spec, label=label)


@rt_scenario('rt/native/relay', normalise=('tmpdir-suffix',))
def _(sb):
    ctx = _relay(sb)
    _run(sb, ctx, 'no input', [{'close': True}])
    _run(sb, ctx, 'stdin /dev/null', None)
    _run(sb, ctx, 'two frames echoed', [*_frames({'id': 1, 'method': 'ping'}, 'plain text'), {'close': True}])
    _run(sb, ctx, 'arguments are passed through', [{'close': True}], args=(ORIGIN, '--parent-window=7', 'x y'))
    _run(sb, ctx, 'no arguments', [{'close': True}], args=())
    _run(sb, ctx, 'empty frame', [*_frames(b''), {'close': True}])
    _run(sb, ctx, 'binary and invalid UTF-8 frames', [*_frames(b'\x00\xff\xfe', b'{"a":"\xff"}'), {'close': True}])
    _run(sb, ctx, 'frame split across writes', [{'b64': base64.b64encode(b'\x05\x00').decode()}, {'sleep': 0.3},
                                                {'b64': base64.b64encode(b'\x00\x00hel').decode()}, {'sleep': 0.3},
                                                {'b64': base64.b64encode(b'lo').decode()}, {'close': True}])
    _run(sb, ctx, 'host replies after EOF', [{'close': True}],
         host={'replies': [{'json': {'result': {'type': 'extension', 'agentRequestHeaderEnabled': False}}},
                           {'text': 'second'}]})
    _run(sb, ctx, 'host replies first, never reads', [{'close': True}], host={'early': True, 'noRead': True,
                                                                         'replies': [{'text': 'hello'}]})
    _run(sb, ctx, 'host exit status 3', [{'close': True}], host={'exit': 3})
    _run(sb, ctx, 'host exit status 255', [{'close': True}], host={'exit': 255})
    _run(sb, ctx, 'large frames both ways (1 MiB, 16 MiB)', [{'frameFill': 1 << 20}, {'frameFill': 16 << 20},
                                                             {'close': True}], timeout=120, show={'stdout': 'frames'})
    fm.neutralise_relay(sb, ctx.destination)  # the relay itself is code under test


@rt_scenario('rt/native/agent-header', normalise=('tmpdir-suffix',))
def _(sb):
    # Only {"result": {"type": "extension", "agentRequestHeaderEnabled": false, ...}} objects are rewritten,
    # re-serialised the Python way (compact separators, non-ASCII kept, key order kept). Everything else is
    # passed byte for byte.
    ctx = _relay(sb)
    payloads = [
        '{"result":{"type":"extension","agentRequestHeaderEnabled":false}}',
        '{ "id" : 7 , "result" : { "agentRequestHeaderEnabled" : false , "type" : "extension", "x": [1.0, 1e2, -0, 12345678901234567890, "é☃😀", "\\u00e9", null, true] } }',
        '{"result":{"type":"extension","agentRequestHeaderEnabled":true}}',
        '{"result":{"type":"extension","agentRequestHeaderEnabled":0}}',
        '{"result":{"type":"extension","agentRequestHeaderEnabled":null}}',
        '{"result":{"type":"extension"}}',
        '{"result":{"type":"other","agentRequestHeaderEnabled":false}}',
        '{"result":[{"type":"extension","agentRequestHeaderEnabled":false}]}',
        '[{"result":{"type":"extension","agentRequestHeaderEnabled":false}}]',
        '{"result":{"type":"extension","agentRequestHeaderEnabled":false,"agentRequestHeaderEnabled":false}}',
        '{"result":{"type":"extension","agentRequestHeaderEnabled":false},"result":{"type":"x"}}',
        '{"result":{"type":"extension","agentRequestHeaderEnabled":false,"n":NaN,"i":Infinity}}',
        '{"result":{"type":"extension","agentRequestHeaderEnabled":false,"f":0.1,"g":1E400,"h":5e-324}}',
        '{"result":{"type":"extension","agentRequestHeaderEnabled":false,"s":"\\/ \\" \\\\ \\n \\u0000 \\u007f \\u2028"}}',
        '{"result":{"type":"extension","agentRequestHeaderEnabled":false}} ',
        '﻿{"result":{"type":"extension","agentRequestHeaderEnabled":false}}',
        '{"result":{"type":"extension","agentRequestHeaderEnabled":false}',
        'not json', '', '1', '"x"', 'null',
    ]
    _run(sb, ctx, 'messages from the extension', [*_frames(*payloads), {'close': True}])
    _run(sb, ctx, 'lone surrogate escape in an extension message',
         [*_frames('{"result":{"type":"extension","agentRequestHeaderEnabled":false,"s":"\\ud800"}}'), {'close': True}])
    _run(sb, ctx, 'lone surrogate escape elsewhere (passed through)', [*_frames('{"s":"\\ud800"}'), {'close': True}])
    _run(sb, ctx, 'invalid UTF-8 inside an extension message',
         [*_frames(b'{"result":{"type":"extension","agentRequestHeaderEnabled":false,"b":"\xff"}}'), {'close': True}])
    _run(sb, ctx, 'replies from the host are never rewritten', [{'close': True}],
         host={'replies': [{'text': payloads[0]}, {'text': payloads[1]}]})
    fm.neutralise_relay(sb, ctx.destination)  # the relay itself is code under test


@rt_scenario('rt/native/limits', normalise=('tmpdir-suffix',))
def _(sb):
    ctx = _relay(sb)
    limit = 64 * 1024 * 1024
    _run(sb, ctx, 'frame of exactly 64 MiB', [{'frameFill': limit}, {'close': True}], timeout=180)
    _run(sb, ctx, 'header announcing 64 MiB + 1', [{'header': limit + 1}, {'close': True}])
    _run(sb, ctx, 'header 0xffffffff', [{'header': 0xffffffff}, {'close': True}])
    _run(sb, ctx, 'short length prefix', [{'b64': base64.b64encode(b'\x05\x00').decode()}, {'close': True}])
    _run(sb, ctx, 'short body', [{'b64': base64.b64encode(b'\x05\x00\x00\x00ab').decode()}, {'close': True}])
    _run(sb, ctx, 'good frame then short body', [*_frames('ok'), {'b64': base64.b64encode(b'\x09\x00\x00\x00ab').decode()},
                                                 {'close': True}])
    _run(sb, ctx, 'host sends a header over 64 MiB', [{'close': True}], host={'header': limit + 1})
    _run(sb, ctx, 'host sends a short body', [{'close': True}], host={'partial': 10})
    _run(sb, ctx, 'host sends a short length prefix', [{'close': True}], host={'rawHex': '0500'})
    _run(sb, ctx, 'host exits at once, relay keeps writing', [{'sleep': 0.5}, *_frames('late'), {'close': True}],
         host={'noRead': True})
    _run(sb, ctx, 'host exits at once, stdin left open', [{'sleep': 2.0}, {'close': True}], host={'noRead': True})
    fm.neutralise_relay(sb, ctx.destination)  # the relay itself is code under test


@rt_scenario('rt/native/missing-host', normalise=('tmpdir-suffix',))
def _(sb):
    ctx = _relay(sb)
    ctx.host.chmod(0o644)
    _run(sb, ctx, 'original host not executable', [{'close': True}])
    ctx.host.unlink()
    _run(sb, ctx, 'original host missing', [{'close': True}])
    ctx.host.mkdir()
    _run(sb, ctx, 'original host is a directory', [{'close': True}])
    fm.neutralise_relay(sb, ctx.destination)  # the relay itself is code under test
