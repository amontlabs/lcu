"""Upstream 0.9.7 (#26): recovery from a stale Computer Use service after a ChatGPT update, as far as it is
observable without a live app update.

* `rt/mac/service-lock-env`: which `LCU_MAC_SERVICE_LOCK` the supervised child (and so the lifecycle host) gets,
  decided from the socket override and `$HOME` against the account home.
* `rt/mac/recover-requests`: the `{"type":"recover"}` request of the lifetime socket. The wrapper
  (lcu/macos_sky_service.mjs) sends it after a native-pipe startup failure. The fixture bundle is the only bundle
  the host knows, so no real service can ever be a candidate: whatever the machine runs (`ps` is read, nothing
  else), the answer is a refusal and nothing is signaled. The host does create its per-account recovery lock file
  in the account's private temporary directory, as it would in real use.

No signals are sent anywhere in this module.
"""
import os
import pwd

from fixtures_rt import DARWIN, place, rt_scenario
from scenarios.rt_mac import STATUSES, _mac, lifetime

ACCOUNT_HOME = pwd.getpwuid(os.getuid()).pw_dir
NORMALISE = STATUSES + ('account',)
PIPE = 'SKY_CUA_SERVICE_NATIVE_PIPE_PATH'
INHERITED = '/inherited/computeruse.sock.lock'


@rt_scenario('rt/mac/service-lock-env', hosts=DARWIN, normalise=NORMALISE)
def _(sb):
    ctx = place(sb, 'darwin')
    link = sb.work / 'home-link'
    link.symlink_to(ACCOUNT_HOME)
    elsewhere = sb.work / 'elsewhere'
    elsewhere.mkdir()
    cases = (
        ('account home', {'HOME': ACCOUNT_HOME}),
        ('account home, inherited lock replaced', {'HOME': ACCOUNT_HOME, 'LCU_MAC_SERVICE_LOCK': INHERITED}),
        ('HOME unset (the client falls back to the account home)', {'HOME': None}),
        ('HOME is a link to the account home', {'HOME': str(link)}),
        ('account home with a trailing slash', {'HOME': ACCOUNT_HOME + '/'}),
        ('HOME elsewhere', {'HOME': str(elsewhere)}),
        ('HOME elsewhere, inherited lock removed', {'HOME': str(elsewhere), 'LCU_MAC_SERVICE_LOCK': INHERITED}),
        ('HOME does not exist', {'HOME': str(sb.work / 'missing')}),
        ('HOME empty', {'HOME': '', 'LCU_MAC_SERVICE_LOCK': INHERITED}),
        ('socket override', {'HOME': ACCOUNT_HOME, PIPE: '/tmp/custom.sock'}),
        ('socket override, inherited lock removed',
         {'HOME': ACCOUNT_HOME, PIPE: '/tmp/custom.sock', 'LCU_MAC_SERVICE_LOCK': INHERITED}),
        ('empty socket override', {'HOME': ACCOUNT_HOME, PIPE: '', 'LCU_MAC_SERVICE_LOCK': INHERITED}),
    )
    for label, env in cases:
        _mac(sb, ctx, label, [], probe={'env': True}, env=env)
    # Without the computer surface there is no host, so nothing sets or removes the variable.
    _mac(sb, ctx, 'no computer surface keeps the inherited value', [], probe={'env': True},
         env={'HOME': ACCOUNT_HOME, 'CUA_REPL_ENABLED_SURFACES': 'browser', 'LCU_MAC_SERVICE_LOCK': INHERITED})


def _recover(name, request=None, **options):
    return lifetime(name, request or {'json': {'type': 'recover'}}, **options)


@rt_scenario('rt/mac/recover-requests', hosts=DARWIN, normalise=NORMALISE)
def _(sb):
    ctx = place(sb, 'darwin')
    elsewhere = sb.work / 'elsewhere'
    elsewhere.mkdir()
    script = []
    script += _recover('plain')
    script += _recover('extra keys', {'json': {'type': 'recover', 'x': [1, {'y': None}], 'session_id': 's1', 'turn_id': 't1'}})
    script += _recover('spaced JSON', {'text': '{ "type" : "recover" }'})
    script += _recover('requester half-closed', {'json': {'type': 'recover'}, 'end': True})
    for index, request in enumerate((
        {'type': 'Recover'}, {'type': 'recover '}, {'type': ['recover']}, {'type': None}, {'type': 'diagnose'},
        {'type': 'recover', 'session_id': 's1'},
    )):
        script += lifetime(f'other{index}', {'json': request})
    for index, text in enumerate(('[]', '"recover"', '{"type":"recover"', '{"type":"recover"}{"x":1}')):
        script += lifetime(f'shape{index}', {'text': text})
    # Recoveries never delay turn cleanup, and concurrent requests share one run (same answer for both).
    script += [{'op': 'connect', 'name': 'a', 'to': 'lifetime'}, {'op': 'connect', 'name': 'b', 'to': 'lifetime'},
               {'op': 'send', 'name': 'a', 'json': {'type': 'recover'}}, {'op': 'send', 'name': 'b', 'json': {'type': 'recover'}},
               {'op': 'recv', 'name': 'a', 'timeoutMs': 20000}, {'op': 'recv', 'name': 'b', 'timeoutMs': 20000}]
    script += lifetime('cleanup', {'json': {'session_id': 's1', 'turn_id': 't1'}})
    script += _recover('after cleanup')
    _mac(sb, ctx, 'recover requests (HOME elsewhere: no lock path)', script, env={'HOME': str(elsewhere)})
    _mac(sb, ctx, 'recover requests (lock path set)', _recover('plain') + _recover('again'), env={'HOME': ACCOUNT_HOME})
    _mac(sb, ctx, 'recover requests (socket override)', _recover('plain'),
         env={'HOME': ACCOUNT_HOME, PIPE: '/tmp/custom.sock'})
