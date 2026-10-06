"""Fake ChatGPT apps and fake bundled agent tools, built as real files.

Nothing here imports the implementation under test. The layouts mirror what the official app ships and what
scripts/install*.py produce (see .port/inventory/install.md); executables are tiny shell wrappers that exec
the real Node (`$LCU_BB_NODE`) or the shared recorder, so after a Node port the fake runtime is still runnable.
"""
import json
import os
from pathlib import Path
import platform
import plistlib
import struct

VERSION = '26.924.22138'
RUNTIME = '0.0.24/20260924074400-f52ea85e2a98'
BUNDLE_VERSION = '0.0.0'      # replaced per sandbox by use_version(), read from the tree under test
RELEASE_NAME = BUNDLE_VERSION + '-bb0bb0bb0001'


def read_version(root):
    """The release version of an implementation tree: `VERSION = '...'` in scripts/bundle.py."""
    import re
    text = (Path(root) / 'scripts/bundle.py').read_text()
    return re.search(r"^VERSION = '([^']+)'", text, re.M).group(1)


def use_version(version):
    """Set BUNDLE_VERSION / RELEASE_NAME (read these as `fixtures.X` at call time, never import-copy them)."""
    global BUNDLE_VERSION, RELEASE_NAME
    BUNDLE_VERSION = version
    RELEASE_NAME = version + '-bb0bb0bb0001'


def architecture():
    machine = platform.machine().lower()
    return {'aarch64': 'arm64', 'arm64': 'arm64', 'x86_64': 'x64', 'amd64': 'x64'}[machine]


def write(path, data, mode=None):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, str):
        data = data.encode()
    path.write_bytes(data)
    if mode is not None:
        path.chmod(mode)
    return path


def recorder_script(name):
    return f'#!/bin/sh\nexec "$LCU_BB_NODE" "$LCU_BB_RECORDER" {name} "$@"\n'


# $$ is the pid node keeps after exec: the recorder reports argv0 only in that exact process, so the harness
# variables inherited by anything that Node process starts (LCU itself after the port) never add fields.
NODE_WRAPPER = '#!/bin/sh\nLCU_BB_ARGV0="$0" LCU_BB_ARGV0_PID=$$ exec "$LCU_BB_NODE" "$@"\n'


def cua_repl(recorder):
    return (f"import {{ run }} from {json.dumps(str(recorder))};\n"
            "await run('cua-repl', process.argv.slice(2), { script: process.argv[1] });\n")


def write_asar(path, members):
    files = {}
    payload = bytearray()
    for name, content in members.items():
        node = files
        parts = name.split('/')
        for part in parts[:-1]:
            node = node.setdefault(part, {'files': {}})['files']
        node[parts[-1]] = {'offset': str(len(payload)), 'size': len(content)}
        payload.extend(content)
    header = json.dumps({'files': files}, separators=(',', ':')).encode()
    write(path, struct.pack('<4I', 4, 8 + len(header), 4 + len(header), len(header)) + header + payload)


def _plugins(resources, arch, linux):
    base = resources / 'plugins/openai-bundled/plugins'
    (base / 'browser').mkdir(parents=True, exist_ok=True)
    write(base / 'chrome/.codex-plugin/plugin.json', json.dumps({
        'name': 'chrome', 'hooks': {'hooks': {}}}, indent=2) + '\n')
    write(base / 'browser/install.js', '{}\n')
    hook = {'type': 'mcp_tool', 'server': 'cua_repl', 'tool': 'turn_ended',
            'input': {'session_id': '${session_id}', 'turn_id': '${turn_id}'}}
    write(base / 'unified-computer-use/.codex-plugin/plugin.json', json.dumps({
        'name': 'unified-computer-use',
        'hooks': {'hooks': {event: [{'hooks': [dict(hook)]}] for event in ('Stop', 'Interrupt', 'SubagentStop')}}},
        indent=2) + '\n')
    write(base / 'unified-computer-use/.mcp.json', json.dumps({'mcpServers': {'cua_repl': {
        'command': 'cua-repl', 'args': [], 'enabled': True, 'tool_timeout_sec': 600,
        'tools': {'js': {'approval_mode': 'approve'}}}}}, indent=2) + '\n')
    if linux:
        write(base / f'chrome/extension-host/linux/{arch}/extension-host', recorder_script('extension-host'), 0o755)


def _runtime(runtime, recorder, *, platform_name, arch, runtime_version):
    write(runtime / 'bin/node', NODE_WRAPPER, 0o755)
    write(runtime / 'bin/node_repl', recorder_script('node_repl'), 0o755)
    write(runtime / 'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs', cua_repl(recorder))
    write(runtime / 'manifest.json', json.dumps({
        'platform': platform_name, 'arch': arch, 'runtime_archive_version': runtime_version}))
    sky = runtime / 'lib/node_modules/@oai/sky'
    write(sky / 'package.json', json.dumps({
        'name': '@oai/sky', 'version': '0.0.0-fake', 'type': 'module',
        'exports': {'./service': './dist/project/cua/sky_js/src/service.js'}}))
    target = 'mac' if platform_name == 'darwin' else 'linux'
    write(sky / 'dist/project/cua/sky_js/src/service.js', f'''import {{ log }} from {json.dumps(str(recorder))};
export async function handleRpc(request) {{
  log({{ tool: 'sky-service', request }});
  if (request.type === 'setup') return {{ target: {json.dumps(target)}, methods: ['list_apps', 'get_app_state'] }};
  if (request.method === 'list_windows') return [{{ id: 1 }}];
  if (request.method === 'get_screenshot') return [{{ data_url: 'data:image/png;base64,AA' }}];
  return null;
}}
''')


def linux_app(app, recorder, *, version=VERSION, runtime_version=RUNTIME, arch=None, omit=()):
    """An installed ChatGPT Linux app (the /usr/lib/chatgpt layout). `omit` lists app-relative files to drop."""
    app = Path(app)
    arch = arch or architecture()
    resources = app / 'resources'
    write(app / 'ChatGPT', recorder_script('ChatGPT'), 0o755)
    _runtime(resources / 'cua_node', recorder, platform_name='linux', arch=arch, runtime_version=runtime_version)
    for name in ('codex', 'codex-code-mode-host'):
        write(resources / name, recorder_script('app-' + name), 0o755)
    write_asar(resources / 'app.asar', {
        'package.json': json.dumps({'name': 'chatgpt', 'version': version}).encode()})
    _plugins(resources, arch, linux=True)
    for relative in omit:
        (app / relative).unlink()
    return app


def mac_app(app, recorder, *, version=VERSION, runtime_version=RUNTIME, arch=None, omit=()):
    """A signed-looking ChatGPT.app bundle; the fake `codesign` on PATH decides what verifies."""
    app = Path(app)
    arch = arch or architecture()
    contents = app / 'Contents'
    resources = contents / 'Resources'
    write(contents / 'Info.plist', plistlib.dumps({
        'CFBundleIdentifier': 'com.openai.codex', 'CFBundleShortVersionString': version}))
    helper = contents / 'Resources/cua_node/lib/node_modules/@oai/sky/Codex Computer Use.app'
    write(helper / 'Contents/Info.plist', plistlib.dumps({
        'CFBundleIdentifier': 'com.openai.sky.CUAService', 'CFBundleShortVersionString': '1'}))
    _runtime(resources / 'cua_node', recorder, platform_name='darwin', arch=arch, runtime_version=runtime_version)
    for name in ('codex', 'codex-code-mode-host'):
        write(resources / name, recorder_script('app-' + name), 0o755)
    _plugins(resources, arch, linux=False)
    for relative in omit:
        (app / relative).unlink()
    return app


def agent_tools(release, recorder):
    """The provisioned installers `lcu setup` shells out to (add-mcp, skills): recorders, not the real packages."""
    tools = Path(release) / 'agent-tools'
    write(tools / 'node_modules/skills/bin/cli.mjs',
          f"import {{ run }} from {json.dumps(str(recorder))};\n"
          "await run('skills', process.argv.slice(2));\n")
    write(tools / 'node_modules/add-mcp/dist/index.js', 'export {};\n')
    write(tools / 'node_modules/add-mcp/dist/lib.js', f"""
import {{ log }} from {json.dumps(str(recorder))};
import {{ mkdirSync, writeFileSync, appendFileSync }} from 'node:fs';
import {{ dirname, join }} from 'node:path';
const home = process.env.HOME;
const toml = (key, value) => typeof value === 'object' && value !== null && !Array.isArray(value)
  ? `# ${{key}} = ${{JSON.stringify(value)}}\\n` : `${{key}} = ${{JSON.stringify(value)}}\\n`;
export const agents = {{
  codex: {{ format: 'toml', configKey: 'mcp_servers', localConfigKey: 'mcp_servers',
    configPath: join(home, '.codex/config.toml'), localConfigPath: '.codex/config.toml',
    transformConfig: (config) => ({{ ...config }}) }},
  'claude-code': {{ format: 'json', configKey: 'mcpServers', localConfigKey: 'mcpServers',
    configPath: join(home, '.claude.json'), localConfigPath: '.mcp.json',
    transformConfig: (config) => ({{ type: 'stdio', ...config }}) }},
}};
export function upsertServer(agentName, name, config, {{ local, cwd }}) {{
  log({{ tool: 'add-mcp:upsertServer', agent: agentName, name, config, local, cwd }});
  const agent = agents[agentName];
  const path = local ? join(cwd, agent.localConfigPath) : agent.configPath;
  const body = agent.transformConfig(config);
  mkdirSync(dirname(path), {{ recursive: true }});
  if (agent.format === 'toml') {{
    appendFileSync(path, `[${{agent.configKey}}.${{name}}]\\n` + Object.entries(body).map(([k, v]) => toml(k, v)).join(''));
  }} else {{
    writeFileSync(path, JSON.stringify({{ [agent.configKey]: {{ [name]: body }} }}, null, 2) + '\\n');
  }}
  return {{ success: true, path }};
}}
""")


def agent_tools_node_link(root, target):
    """`agent-tools/node/bin/node`: in a built archive a relative symlink through <release>/app (dangling until
    an installer adds `app`), exactly as scripts/provision_agent_tools.py creates it."""
    resources = 'app/Contents/Resources' if target == 'darwin' else 'app/resources'
    link = Path(root) / 'agent-tools/node/bin/node'
    link.parent.mkdir(parents=True, exist_ok=True)
    if link.is_symlink():
        link.unlink()
    link.symlink_to(f'../../../{resources}/cua_node/bin/node')


def seal(root, target):
    """Write the bundle.json an official release archive carries (mirrors the documented bundle format)."""
    import hashlib
    root = Path(root).resolve()
    files = {}
    for path in sorted(root.rglob('*')):
        relative = path.relative_to(root).as_posix()
        if relative == 'bundle.json':
            continue
        if path.is_symlink():
            files[relative] = {'type': 'symlink', 'target': os.readlink(path)}
        elif path.is_file():
            files[relative] = {'type': 'file', 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                               'mode': path.stat().st_mode & 0o777}
    write(root / 'bundle.json', json.dumps({
        'format': 1, 'version': BUNDLE_VERSION, 'platform': target, 'architecture': architecture(),
        'files': files}, indent=2, sort_keys=True) + '\n')
