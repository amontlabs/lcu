#!/usr/bin/env python3
"""Run a command with its stdin and stdout on a pseudo-terminal and answer its prompts.

    ptydrive.py STEPS_JSON -- COMMAND [ARG...]

STEPS_JSON is a list of [expect, send] pairs. Each `send` is written to the terminal once `expect` (a substring,
"" for "immediately") has appeared in the terminal output or on stderr since the previous step. `send` is literal text; the
token "<EOF>" sends Ctrl-D, "<INT>" sends Ctrl-C. stderr is a separate pipe (as in a real shell with 2>captured).
Prints what the harness would otherwise not see: the terminal transcript (echo included, CRLF folded to LF), the
stderr text and the exit status. The harness records this script's own output as the command's stdout.
"""
import fcntl
import json
import os
import select
import struct
import subprocess
import sys
import termios
import time

TOKENS = {'<EOF>': '\x04', '<INT>': '\x03'}


def main():
    split = sys.argv.index('--')
    steps = [(expect, TOKENS.get(send, send)) for expect, send in json.loads(sys.argv[1])]
    command = sys.argv[split + 1:]
    master, slave = os.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
    process = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=subprocess.PIPE, start_new_session=True)
    os.close(slave)
    transcript, stderr, pending = b'', b'', b''
    fds = {master: 'pty', process.stderr.fileno(): 'stderr'}
    deadline = time.monotonic() + float(os.environ.get("LCU_BB_PTY_DEADLINE", "45"))
    index = 0
    while fds and time.monotonic() < deadline:
        ready, _, _ = select.select(list(fds), [], [], 0.05)
        for fd in ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                data = b''
            if not data:
                del fds[fd]
            elif fds[fd] == 'pty':
                transcript += data
                pending += data
            else:
                stderr += data
                pending += data      # Python's input() writes its prompt to stderr when stderr is not a terminal
        while index < len(steps) and steps[index][0].encode() in pending:
            expect, send = steps[index]
            pending = pending[pending.index(expect.encode()) + len(expect.encode()):] if expect else pending
            if not expect:
                pending = b''
            os.write(master, send.encode())
            index += 1
        if process.poll() is not None and not ready:
            break
    try:
        status = process.wait(timeout=max(1, deadline - time.monotonic()))
    except subprocess.TimeoutExpired:
        # Only our own unreaped child, verified to lead the session it was started in (never anything else).
        try:
            if process.poll() is None and process.pid > 1 and os.getsid(process.pid) == process.pid:
                os.kill(process.pid, 9)
        except (ProcessLookupError, PermissionError):
            pass
        status = 'TIMEOUT'
    os.close(master)
    sys.stdout.write('--- terminal ---\n' + transcript.decode('utf-8', 'backslashreplace').replace('\r\n', '\n'))
    sys.stdout.write('\n--- stderr ---\n' + stderr.decode('utf-8', 'backslashreplace'))
    sys.stdout.write(f'\n--- exit {status}; steps answered {index} of {len(steps)} ---\n')


main()
