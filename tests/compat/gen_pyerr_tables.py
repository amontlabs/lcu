"""Print Python's errno/strerror/signal tables for the running platform as JSON.

Input for lcu/compat/pyerr_tables.mjs (regenerate on darwin and in a glibc Linux container).
"""
import errno
import json
import os
import signal
import sys

names = {n: getattr(errno, n) for n in sorted(dir(errno)) if n.startswith('E') and isinstance(getattr(errno, n), int)}
strerror = {str(i): os.strerror(i) for i in range(0, 200)}
signals = {}
for s in signal.Signals:
    signals.setdefault(str(int(s)), s.name)
print(json.dumps({'platform': sys.platform, 'errno': names, 'strerror': strerror, 'signals': signals}, sort_keys=True))
