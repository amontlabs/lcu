#!/usr/bin/env python3
"""Print a file's mode, size and exact bytes (so a scenario can record intermediate states of a file)."""
import os
import re
import stat
import sys

# --scrub: wall-clock numbers LCU writes into the update cache (checked_at, announced "at") become a constant.
scrub = sys.argv[1] == '--scrub'
path = sys.argv[2] if scrub else sys.argv[1]
try:
    info = os.lstat(path)
except OSError as exc:
    print(f'{path}: {exc.strerror}')
    sys.exit(0)
kind = 'symlink -> ' + os.readlink(path) if stat.S_ISLNK(info.st_mode) else ''
size = '' if scrub else f' size {info.st_size}'   # a float's repr length varies
print(f'mode {stat.S_IMODE(info.st_mode):04o}{size} {kind}'.rstrip())
sys.stdout.flush()
if stat.S_ISREG(info.st_mode):
    try:
        data = open(path, 'rb').read()
        if scrub:
            data = re.sub(rb'("(?:checked_at|at)": )-?[0-9][-+0-9.eE]*', rb'\1<TIME>', data)
        sys.stdout.buffer.write(data + b'<EOF>\n')
    except OSError as exc:
        print(f'cannot read: {exc.strerror}')
