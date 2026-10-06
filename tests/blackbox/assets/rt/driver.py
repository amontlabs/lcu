#!/usr/bin/env python3
"""Process driver for the rt_* scenarios: start one command, script its stdin and the signals it receives, and
print a report that is the same for every correct implementation (no pids, no times, only relationships).

    driver.py '<json spec>'

Spec keys (all optional but `argv`):
  argv [..]           command (absolute path first)
  cwd, env {k: v|null}, envBytes {k: base64}   environment edits on top of the driver's own
  probe {..}          becomes RT_PROBE for the fake cua-repl; RT_OUT is always set to a fresh private directory
  stdin               null (/dev/null), a string, or a list of steps: {"write": text} {"b64": ..} {"fill": n}
                      {"sleep": s} {"close": true} {"waitReady": true}
  stdinFile text      run with stdin redirected from a file holding this text
  passFds [n..]       open pipes at these descriptor numbers and pass them to the command
  blockSignals [..]   block these signals in the command's initial mask; ignoreSignals [..] start them ignored
  after [..]          the same kinds of steps, run once the process has exited
  steps [..]          after stdin: {"waitReady": true} {"sleep": s} {"signal": "SIGTERM", "to": "launcher|probe"}
                      {"waitExit": s} {"closeStdin": true} {"alive": "probe|launcher|host", "label": ".."}
                      {"exists": "lifetime|control|lifetime_dir", "label": ".."} {"kill": "probe|host"}
  parallel [{argv, env, label}]  run alongside the command, reported after it
  background [{argv, env}]  started first, each in its own session; stopped (send()) at the end
  timeout s           give up and kill the process group (default 30)
  show {stdout, stderr}  "text" (default) | "sha" | "none"
"""
import base64
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time

spec = json.loads(sys.argv[1])
out_root = os.environ.get('RT_OUT_ROOT') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')
os.makedirs(out_root, exist_ok=True)
out = os.path.join(out_root, f'{os.getpid()}')
os.makedirs(out, exist_ok=True)

env = dict(os.environ)
for key, value in (spec.get('env') or {}).items():
    if value is None:
        env.pop(key, None)
    else:
        env[key] = value
for key, value in (spec.get('envBytes') or {}).items():
    env[os.fsdecode(key.encode())] = os.fsdecode(base64.b64decode(value))
if 'probe' in spec:
    env['RT_PROBE'] = json.dumps(spec['probe'])
env['RT_OUT'] = out

report = []


def say(line=''):
    report.append(line)


def pattern(count, seed=0):
    return bytes(10 if i % 61 == 60 else 97 + ((i * 7 + seed) % 26) for i in range(count))


def describe(returncode):
    if returncode is None:
        return 'still running'
    if returncode < 0:
        return 'signal ' + signal.Signals(-returncode).name
    return f'exit {returncode}'


def mask_traceback(text):
    pattern_ = re.compile(r'Traceback \(most recent call last\):\n(?:[ \t].*\n)+([^\n]*)\n?')
    return pattern_.sub(lambda m: f'<python traceback ending: {m.group(1)}>\n', text)


def show(name, data, mode):
    if mode == 'none':
        return
    if mode == 'frames':
        say(f'{name}: {len(data)} bytes as native-messaging frames:')
        rest = data
        while len(rest) >= 4 and len(rest) >= 4 + int.from_bytes(rest[:4], 'little'):
            size = int.from_bytes(rest[:4], 'little')
            payload, rest = rest[4:4 + size], rest[4 + size:]
            if size > 2048:
                say(f'  frame {size} bytes sha256:{hashlib.sha256(payload).hexdigest()}')
            else:
                try:
                    say(f'  frame {size} bytes: {payload.decode("utf-8")}')
                except UnicodeDecodeError:
                    say(f'  frame {size} bytes hex: {payload.hex()}')
        if rest:
            say(f'  trailing {len(rest)} bytes hex: {rest[:64].hex()}')
        return
    if mode == 'sha':
        say(f'{name}: {len(data)} bytes sha256:{hashlib.sha256(data).hexdigest()}')
        return
    text = mask_traceback(data.decode('utf-8', errors='backslashreplace'))
    # Interpreter crash dumps carry memory addresses (thread ids, states): not behaviour.
    text = re.sub(r'0x[0-9a-f]{8,16}', '0x<address>', text)
    real_node = os.environ.get('LCU_BB_NODE')
    if real_node:
        text = text.replace(real_node, '<real-node>')
    say(f'{name}: {len(data)} bytes' if spec.get('showLength') else f'{name}:')
    say(text.rstrip('\n') if text else '(empty)')


def read_json(name):
    try:
        with open(os.path.join(out, name)) as stream:
            return json.load(stream)
    except (OSError, ValueError):
        return None


def read_text(name):
    try:
        with open(os.path.join(out, name)) as stream:
            return stream.read()
    except OSError:
        return None


def send(pid, sig, session=None):
    """Signal a process only if it belongs to the launcher's session (the launcher starts one with
    start_new_session, and the probe and host inherit it). Pids read from probe.json/host.json are never trusted
    blindly: a wrong one (pid 1, or launchd's children after an orphaned probe listed them) would hit the whole
    login session. `session` names another session this driver created itself (a background process it started
    with start_new_session, whose pid is that session's id)."""
    if not isinstance(pid, int) or pid <= 1 or pid == os.getpid():
        raise ProcessLookupError(pid)
    if session is not None and session not in background_sessions:
        raise ProcessLookupError(pid)
    try:
        if os.getsid(pid) != (process.pid if session is None else session):
            raise ProcessLookupError(pid)
    except PermissionError:
        raise ProcessLookupError(pid)
    os.kill(pid, sig)


def send_group(sig):
    """Signal the launcher's own process group (it leads a new session, so the group is ours alone)."""
    pid = process.pid
    if pid <= 1 or pid == os.getpid() or os.getsid(pid) != pid or os.getpgid(pid) != pid:
        raise ProcessLookupError(pid)
    os.killpg(pid, sig)


def host_pids():
    pids = read_json('host.json') or []
    # There is one lifecycle host; anything longer is a bad listing, not a list of hosts.
    return pids if isinstance(pids, list) and len(pids) <= 1 else []


def alive(pid):
    # No signal, not even 0: a process counts only if it is in the launcher's session.
    try:
        if not isinstance(pid, int) or pid <= 1 or os.getsid(pid) != process.pid:
            return False
    except (ProcessLookupError, PermissionError):
        return False
    # a zombie still answers kill(0)
    try:
        state = subprocess.run(['/bin/ps', '-o', 'stat=', '-p', str(pid)], capture_output=True, text=True).stdout.strip()
    except OSError:
        return True
    return bool(state) and not state.startswith('Z')


# ---- launch ---------------------------------------------------------------------------------------------------
pass_fds = []
for number in spec.get('passFds') or []:
    read_end, write_end = os.pipe()
    os.dup2(read_end, number, inheritable=True)
    os.close(read_end)
    os.set_inheritable(write_end, False)
    pass_fds.append(number)


def child_setup():
    for name in spec.get('ignoreSignals') or []:
        signal.signal(getattr(signal, name), signal.SIG_IGN)
    if spec.get('blockSignals'):
        signal.pthread_sigmask(signal.SIG_BLOCK, [getattr(signal, name) for name in spec['blockSignals']])


stdin_spec = spec.get('stdin')
stdin_arg = subprocess.PIPE if isinstance(stdin_spec, (list, str)) else subprocess.DEVNULL
stdin_file = None
if 'stdinFile' in spec:
    stdin_file = open(os.path.join(out, 'stdin.txt'), 'w+b')
    stdin_file.write(spec['stdinFile'].encode())
    stdin_file.seek(0)
    stdin_arg = stdin_file
# Background processes (e.g. stand-in desktop sessions) run before the command, each in its own new session that
# this driver created; they are stopped through send() with that session id once the command has finished.
background = []
background_sessions = set()
for item in spec.get('background') or []:
    child = subprocess.Popen([str(a) for a in item['argv']], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True,
                             env={k: os.fsdecode(base64.b64decode(v[4:])) if v.startswith('b64:') else v
                                  for k, v in item.get('env', {}).items()})
    background.append(child)
    background_sessions.add(child.pid)
if background:
    time.sleep(0.3)
# Parallel commands start together with the main command (each in its own session created here); their output is
# reported after the main command's, in spec order, so completion order does not matter.
parallel = []
for item in spec.get('parallel') or []:
    child = subprocess.Popen([str(a) for a in item['argv']], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, env={**env, **item.get('env', {})}, start_new_session=True)
    parallel.append((item.get('label', 'parallel'), child))
    background_sessions.add(child.pid)
process = subprocess.Popen([str(a) for a in spec['argv']], stdin=stdin_arg, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, env=env, cwd=spec.get('cwd'), start_new_session=True,
                           pass_fds=pass_fds, preexec_fn=child_setup)
for number in pass_fds:
    os.close(number)

captured = {'stdout': bytearray(), 'stderr': bytearray()}
parallel_results = []


def drain(name, stream):
    while True:
        chunk = stream.read1(65536) if hasattr(stream, 'read1') else stream.read(65536)
        if not chunk:
            break
        captured[name].extend(chunk)
        if spec.get('slowRead'):
            time.sleep(spec['slowRead'])


threads = [threading.Thread(target=drain, args=(n, getattr(process, n)), daemon=True) for n in captured]
for thread in threads:
    thread.start()


def wait_ready(limit=20):
    deadline = time.monotonic() + limit
    while time.monotonic() < deadline:
        if os.path.exists(os.path.join(out, 'ready')):
            return True
        if process.poll() is not None:
            return False
        time.sleep(0.02)
    return False


def discover_bytes(options):
    """A server/discover line of exactly `total` bytes (newline included unless newline is false)."""
    request = {'jsonrpc': '2.0', 'id': options.get('id', 1), 'method': 'server/discover', 'pad': ''}
    tail = b'\n' if options.get('newline', True) else b''
    base = len(json.dumps(request, separators=(',', ':')).encode()) + len(tail)
    request['pad'] = 'x' * (options['total'] - base)
    return json.dumps(request, separators=(',', ':')).encode() + tail


def write_stdin(step):
    if 'write' in step:
        data = step['write'].encode('utf-8', 'surrogateescape')
    elif 'b64' in step:
        data = base64.b64decode(step['b64'])
    elif 'discover' in step:
        data = discover_bytes(step['discover'])
    elif 'frame' in step:
        payload = base64.b64decode(step['frame'])
        data = len(payload).to_bytes(4, 'little') + payload
    elif 'frameFill' in step:
        data = step['frameFill'].to_bytes(4, 'little') + b'a' * step['frameFill']
    elif 'header' in step:
        data = step['header'].to_bytes(4, 'little')
    else:
        data = pattern(step['fill'])
    try:
        process.stdin.write(data)
        process.stdin.flush()
    except OSError as exc:
        say(f'stdin write failed: {exc.__class__.__name__}')


def close_stdin():
    try:
        process.stdin.close()
    except OSError:
        pass


try:
    if isinstance(stdin_spec, str):
        write_stdin({'write': stdin_spec})
        close_stdin()
    elif isinstance(stdin_spec, list):
        for step in stdin_spec:
            if step.get('sleep'):
                time.sleep(step['sleep'])
            if step.get('close'):
                close_stdin()
            if step.get('waitReady'):
                say(f'ready: {wait_ready()}')
            if any(k in step for k in ('write', 'b64', 'fill', 'discover', 'frame', 'frameFill', 'header')):
                write_stdin(step)

    def target(name):
        if name == 'launcher':
            return process.pid
        if name == 'probe':
            info = read_json('probe.json')
            return info['pid'] if info else None
        if name == 'host':
            pids = host_pids()
            return pids[0] if pids else None
        raise SystemExit(f'unknown target {name}')

    def perform(step):
        if step.get('waitReady'):
            say(f'ready: {wait_ready()}')
        if 'sleep' in step:
            time.sleep(step['sleep'])
        if 'signal' in step:
            pid = target(step.get('to', 'launcher'))
            label = f"signal {step['signal']} to {step.get('to', 'launcher')}"
            if pid is None:
                say(f'{label}: no such process')
            else:
                try:
                    send(pid, getattr(signal, step['signal']))
                    say(label)
                except ProcessLookupError:
                    say(f'{label}: no such process')
        if 'closeStdin' in step:
            close_stdin()
        if any(k in step for k in ('write', 'b64', 'fill', 'discover', 'frame', 'frameFill', 'header')):
            write_stdin(step)
        if 'waitExit' in step:
            try:
                process.wait(timeout=step['waitExit'])
                say(f'exited within {step["waitExit"]}s: True')
            except subprocess.TimeoutExpired:
                say(f'exited within {step["waitExit"]}s: False')
        if 'alive' in step:
            pid = target(step['alive'])
            say(f'{step.get("label", step["alive"] + " alive")}: {alive(pid) if pid else "unknown"}')
        if 'kill' in step:
            pid = target(step['kill'])
            if pid:
                try:
                    send(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        if 'mark' in step:
            with open(os.path.join(out, step['mark']), 'w'):
                pass
        if 'exists' in step:
            what = step['exists']
            address = (read_text('lifetime.txt') if what.startswith('lifetime') else read_text('control.txt')) or ''
            path = os.path.dirname(address) if what == 'lifetime_dir' else address
            say(f'{step.get("label", what + " exists")}: {os.path.exists(path) if path else "unknown"}')

    for step in spec.get('steps') or []:
        perform(step)
    try:
        process.wait(timeout=spec.get('timeout', 30))
        timed_out = False
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            send_group(signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            try:
                send(process.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        process.wait()
    for thread in threads:
        thread.join(timeout=5)
    for step in spec.get('after') or []:
        perform(step)
    for label, child in parallel:
        try:
            out_, err_ = child.communicate(timeout=spec.get('timeout', 30))
        except subprocess.TimeoutExpired:
            try:
                send(child.pid, signal.SIGKILL, session=child.pid)
            except (ProcessLookupError, PermissionError):
                pass
            out_, err_ = child.communicate()
        parallel_results.append((label, child.returncode, out_, err_))
finally:
    for child in background:
        try:
            send(child.pid, signal.SIGKILL, session=child.pid)
        except (ProcessLookupError, PermissionError):
            pass
        child.wait()
    for name in ('probe', 'host'):
        try:
            pids = [target(name)] if name == 'probe' else host_pids()
        except Exception:
            pids = []
        for pid in pids:
            if pid and pid != process.pid:
                try:
                    send(pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass

say(f'result: {"TIMEOUT (killed)" if timed_out else describe(process.returncode)}')
show('stdout', bytes(captured['stdout']), (spec.get('show') or {}).get('stdout', 'text'))
show('stderr', bytes(captured['stderr']), (spec.get('show') or {}).get('stderr', 'text'))
for label, code, out_, err_ in parallel_results:
    say(f'== parallel {label}: {describe(code)}')
    show('stdout', out_, (spec.get('show') or {}).get('stdout', 'text'))
    show('stderr', err_, (spec.get('show') or {}).get('stderr', 'text'))
info = read_json('probe.json')
if info and spec.get('relations'):
    say('relations:')
    say(f'  probe.pid == launcher.pid: {info["pid"] == process.pid}')
    say(f'  probe.ppid == launcher.pid: {info["ppid"] == process.pid}')
    say(f'  probe.ppid == driver.pid: {info["ppid"] == os.getpid()}')
    say(f'  probe.pid != driver.pid: {info["pid"] != os.getpid()}')
if 'coverage' in spec:
    count = len([n for n in os.listdir(spec['coverage']) if n.startswith('coverage-')]) if os.path.isdir(spec['coverage']) else -1
    say(f'coverage files written: {count}')
sys.stdout.write('\n'.join(report) + '\n')
