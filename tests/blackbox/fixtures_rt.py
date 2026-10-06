"""Helpers for the rt_* scenarios: the launch path (bin/lcu), lifecycle hosts, the native-messaging relay,
bin/lcu-session, the sandbox shim and the installers.

Everything drives the code under test through its command line only. The fake original runtime's `cua-repl.mjs`
is replaced by `assets/rt/probe.mjs`, which records what the launcher handed it and can misbehave on request;
processes are started, signalled and observed by `assets/rt/driver.py`, which prints only facts that are the same
for every correct implementation (relationships between pids, never the pids; no timings).
"""
import json
import os
from pathlib import Path
import shutil
import stat
import sys
from types import SimpleNamespace

import fixtures
from scenarios import scenario

HERE = Path(__file__).resolve().parent
ASSETS = HERE / 'assets/rt'
BOTH = ('darwin', 'linux')
DARWIN = ('darwin',)
LINUX = ('linux',)

NODE_WRAPPER = r'''#!/bin/sh
if [ -n "$RT_ENVDUMP" ]; then /usr/bin/env > "$RT_ENVDUMP"; fi
LCU_BB_ARGV0="$0" exec "$LCU_BB_NODE" "$@"
'''


def rt_scenario(name, **options):
    options.setdefault('hosts', BOTH)
    return scenario(name, **options)


def host_target():
    return 'darwin' if sys.platform == 'darwin' else 'linux'


# -- placing ------------------------------------------------------------------------------------------------------
def install_tools(sb):
    """Copy the probe, client and driver where the fake runtime and the scenarios find them."""
    target = sb.bb / 'rt'
    target.mkdir(exist_ok=True)
    for name in ('probe.mjs', 'client.mjs', 'sky_client.js', 'driver.py'):
        shutil.copy(ASSETS / name, target / name)
    (target / 'out').mkdir(exist_ok=True)
    return target


def runtime_dir(sb, target):
    app = sb.apps / ('ChatGPT.app/Contents/Resources' if target == 'darwin' else 'chatgpt/resources')
    return app / 'cua_node'


def place(sb, target=None, *, probe=True, **options):
    """An installed release with a fixture app whose `cua-repl` is the probe. Returns a namespace."""
    target = target or host_target()
    # The launch path needs only `agent-tools/node` (the relative link a built archive carries), not the
    # cached node_modules, which would make every sandbox slow to build.
    options.setdefault('agent_tools', False)
    release = sb.place_release(target, **options)
    if not options['agent_tools'] and hasattr(fixtures, 'agent_tools_node_link'):
        fixtures.agent_tools_node_link(release, target)
    tools = install_tools(sb)
    runtime = runtime_dir(sb, target)
    if (runtime / 'lib').is_dir():
        if probe:
            fixtures.write(runtime / 'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs',
                           f"import {json.dumps(str(tools / 'probe.mjs'))};\n")
        fixtures.write(runtime / 'bin/node', NODE_WRAPPER, 0o755)
        if target == 'darwin':
            sky = runtime / 'lib/node_modules/@oai/sky'
            client = (sky / 'Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app'
                      '/Contents/MacOS/SkyComputerUseClient')
            fixtures.write(client, f'#!/bin/sh\nexec "$LCU_BB_NODE" {json.dumps(str(tools / "client.mjs"))} "$@"\n',
                           0o755)
            shutil.copy(tools / 'sky_client.js', _ensure(sky / 'dist/project/cua/sky_js/src/targets/mac/client.js'))
    return SimpleNamespace(release=release, target=target, runtime=runtime, tools=tools,
                           lcu=release / 'bin/lcu', out=tools / 'out',
                           app_client=(runtime / 'lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/'
                                       'SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient'))


def _ensure(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


# -- running ------------------------------------------------------------------------------------------------------
def drive(sb, rt, spec, *, label=None, timeout=None):
    """Run the process driver with a spec (see assets/rt/driver.py). The spec's `argv` defaults to bin/lcu."""
    spec = dict(spec)
    args = spec.pop('args', [])
    spec.setdefault('argv', [str(rt.lcu), *args])
    return sb.run([sb.bb / 'tools/python3', rt.tools / 'driver.py', json.dumps(spec, separators=(',', ':'))],
                  label=label, timeout=timeout or spec.get('timeout', 30) + 60)


def make_exec(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return path


def write_json(path, value):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(value, indent=2) + '\n')
