#!/usr/bin/env python3
"""Lock-contention helpers for `lcu setup`.

    lockrun.py hold SECONDS LOCKFILE -- ARGV...      hold an flock on LOCKFILE while ARGV runs; report whether
                                                      ARGV finished while the lock was still held
    lockrun.py parallel N -- ARGV...                  run N copies of ARGV at once; report every exit code and
                                                      output (sorted, so the report does not depend on who won)
"""
import fcntl
import os
from pathlib import Path
import subprocess
import sys
import time


def hold(seconds, lockfile, argv):
    path = Path(lockfile)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX)
    process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    time.sleep(seconds)
    early = process.poll() is not None
    fcntl.flock(fd, fcntl.LOCK_UN)
    os.close(fd)
    out, err = process.communicate(timeout=60)
    print(f'finished while the lock was still held: {early}')
    print(f'exit: {process.returncode}')
    print('--- stdout ---')
    sys.stdout.write(out.decode('utf-8', 'backslashreplace'))
    print('--- stderr ---')
    sys.stdout.write(err.decode('utf-8', 'backslashreplace'))


def parallel(count, argv):
    processes = [subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                 for _ in range(count)]
    reports = []
    for process in processes:
        out, err = process.communicate(timeout=120)
        reports.append(f'exit: {process.returncode}\n--- stdout ---\n{out.decode("utf-8", "backslashreplace")}'
                       f'--- stderr ---\n{err.decode("utf-8", "backslashreplace")}')
    for number, report in enumerate(sorted(reports), 1):
        print(f'### copy {number} (sorted)')
        sys.stdout.write(report)


def main():
    split = sys.argv.index('--')
    head, argv = sys.argv[1:split], sys.argv[split + 1:]
    if head[0] == 'hold':
        hold(float(head[1]), head[2], argv)
    else:
        parallel(int(head[1]), argv)


if __name__ == '__main__':
    main()
