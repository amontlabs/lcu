#!/usr/bin/env python3
"""Run a command with stdin/stdout on a pty, feeding scripted input. Harness helper for `lcu setup` prompts.

    ptydrive.py SPEC_JSON -- ARGV...

SPEC is a JSON list of steps. {"expect": TEXT, "send": TEXT} waits until TEXT appears in the output produced
since the previous step, then writes `send` to the terminal. {"expect": TEXT, "ctrl": "c"|"d"} sends Ctrl-C /
Ctrl-D instead. {"expect": TEXT, "signal": "INT"|"TERM"} signals the child's process group. A step with no
"expect" fires at once. stdin, stdout and stderr are all the pty (a user's terminal; CPython's input() writes its
prompt to stderr there). Output: the terminal transcript on stdout (CRLF normalised; an uncaught-exception
traceback collapsed to `[uncaught TYPE]`) and a final `[exit N]` / `[signal NAME]` line.
"""
import json
import os
import pty
import re
import select
import signal
import sys
import time

# An uncaught exception's traceback names implementation files and lines; only the exception type is behaviour.
# (The Node port prints the same header and `Type: message`, then its stack frames `    at ...`, which go too.)
TRACEBACK = re.compile(r'Traceback \(most recent call last\):\n(?:[ \t].*\n)*([A-Za-z_.]+)(?::[^\n]*)?(?:\n[ \t]+at [^\n]*)*')

CTRL = {'c': b'\x03', 'd': b'\x04', 'z': b'\x1a'}


def send(child, sig):
    """Signal the process group of the child this helper forked, and nothing else (.port/BRIEF.md SAFETY RULE):
    pty.fork() makes the child a session and group leader, so its session id, group id and pid are equal. Any
    other state (reaped, re-parented, a reused pid in another session) is refused."""
    if not isinstance(child, int) or child <= 1 or child == os.getpid():
        raise ProcessLookupError(child)
    try:
        if os.getsid(child) != child or os.getpgid(child) != child:
            raise ProcessLookupError(child)
    except PermissionError:
        raise ProcessLookupError(child)
    os.killpg(child, sig)


def main():
    spec = json.loads(sys.argv[1])
    argv = sys.argv[sys.argv.index('--') + 1:]
    pid, master = pty.fork()
    if pid == 0:
        os.execvp(argv[0], argv)
    transcript = b''
    pending = b''
    steps = list(spec)
    deadline = time.monotonic() + 90
    master_open = True
    while master_open:
        while steps and (not steps[0].get('expect') or steps[0]['expect'].encode() in pending):
            step = steps.pop(0)
            pending = b''
            if 'send' in step:
                os.write(master, step['send'].encode())
            elif 'ctrl' in step:
                os.write(master, CTRL[step['ctrl']])
            elif 'signal' in step:
                send(pid, getattr(signal, 'SIG' + step['signal']))
            elif 'sleep' in step:
                time.sleep(step['sleep'])
        ready, _, _ = select.select([master], [], [], 0.1)
        for fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b''
            if data:
                transcript += data
                pending += data
            else:
                master_open = False
        if time.monotonic() > deadline:
            try:
                send(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            transcript += b'\n[harness timeout]\n'
            break
    _, status = os.waitpid(pid, 0)
    if os.WIFSIGNALED(status):
        tail = f'[signal {signal.Signals(os.WTERMSIG(status)).name}]'
    else:
        tail = f'[exit {os.WEXITSTATUS(status)}]'
    text = transcript.decode('utf-8', 'backslashreplace').replace('\r\n', '\n')
    text = TRACEBACK.sub(lambda match: f'[uncaught {match.group(1)}]', text)
    sys.stdout.write(text + '\n' + tail + '\n')
    sys.stdout.flush()
    return 0


if __name__ == '__main__':
    sys.exit(main())
