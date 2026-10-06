#!/usr/bin/env python3
"""Compatibility trampoline for updaters of releases from before the Node port.

They run `<python> -B <new archive>/scripts/install.py` (Linux) or `install_macos.py` (macOS). The installer is
now Node, started by scripts/install.sh after its pre-Node gate, so hand over to that script with the same
arguments (any Python 3; stdlib only).
"""
import os
import sys

script = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'install.sh')
# '-p': an explicitly named shell ignores the script's '#!/bin/sh -p' line (inherited SHELLOPTS, ENV...).
os.execv('/bin/sh', ['/bin/sh', '-p', script, *sys.argv[1:]])
