#!/usr/bin/env python3
"""Development check: can LCU extract the native-pipe host from an installed app.asar?

Trampoline: the check lives in scripts/check_windows_host_layout.mjs (the Python host module it used is ported to
lcu/windows_host.mjs). Same arguments and output; runs with the `node` on PATH. A development tool only (not
shipped); it never writes into the app and removes its temporary files; do not commit anything it extracts.
"""

import os
from pathlib import Path
import shutil
import sys

SCRIPT = Path(__file__).resolve().with_name('check_windows_host_layout.mjs')


def main(argv=None):
    node = shutil.which('node')
    if not node:
        raise SystemExit('check_windows_host_layout: a Node >= 22 on PATH is required')
    argv = list(sys.argv[1:] if argv is None else argv)
    os.execv(node, [node, '--disable-warning=ExperimentalWarning', str(SCRIPT), *argv])


if __name__ == '__main__':
    main()
