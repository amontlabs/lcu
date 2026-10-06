"""`lcu setup --agent codex`: real add-mcp registration (TOML bytes), the Codex CLI hook-support probe, the
original lifecycle hooks and update-notice hooks through the bundled Codex `app-server` (JSON-RPC exchange
recorded), trust hashes, and every failure branch of the hook installer."""
import fixtures_setup as fs
from fixtures_setup import setup_scenario

EXISTING_TOML = '''# my settings
model = "gpt-5"

[mcp_servers.other]
command = "other"
args = ["--x"]

[mcp_servers.lcu]
command = "old"
tool_timeout_sec = 5
'''


@setup_scenario('setup/codex-user-real-add-mcp')
def _(sb):
    fs.place(sb)
    fs.spy_node(sb)
    sb.fake('codex', env='*', rules=[{'argv': ['--version'], 'stdout': 'codex-cli 9.9.9\n'}])
    fs.setup(sb, '--agent', 'codex', label='first registration')
    fs.setup(sb, '--agent', 'codex', label='second registration (idempotent)')


@setup_scenario('setup/codex-existing-config')
def _(sb):
    fs.place(sb)
    fs.put(sb, '.codex/config.toml', EXISTING_TOML)
    fs.setup(sb, '--agent', 'codex', '--chrome', '--audio', label='existing config with an old lcu entry')


@setup_scenario('setup/codex-existing-hooks')
def _(sb):
    fs.place(sb)
    fs.put(sb, '.codex/config.toml', '''[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "echo mine"

[[hooks.SessionStart]]
matcher = "startup|resume"
[[hooks.SessionStart.hooks]]
type = "command"
command = "/old/prefix/current/bin/lcu update --notice --hook SessionStart"

[[hooks.SessionStart]]
[[hooks.SessionStart.hooks]]
type = "command"
command = "'unbalanced"

[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "/x/lcu.cmd update --notice --hook UserPromptSubmit"
''')
    fs.setup(sb, '--agent', 'codex', label='unrelated hooks kept, old notice hooks replaced')


@setup_scenario('setup/codex-hook-conflicts')
def _(sb):
    fs.place(sb)
    fs.put(sb, '.codex/config.toml', '''[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "mcp_tool"
server = "lcu"
tool = "turn_ended"
input = { session_id = "${session_id}" }
''')
    fs.setup(sb, '--agent', 'codex', label='an LCU Stop hook that differs from upstream')
    fs.put(sb, '.codex/config.toml', 'hooks = { Stop = "nope" }\n')
    fs.setup(sb, '--agent', 'codex', label='hooks.Stop is not a list')
    fs.put(sb, '.codex/config.toml', 'hooks = { SessionStart = 3 }\n')
    fs.setup(sb, '--agent', 'codex', label='hooks.SessionStart is not a list')
    fs.put(sb, '.codex/config.toml', 'hooks = { Stop = [1] }\n')
    fs.setup(sb, '--agent', 'codex', label='hooks.Stop holds a non-table')


@setup_scenario('setup/codex-malformed-config')
def _(sb):
    fs.place(sb)
    for label, data in (('not toml', b'[mcp_servers\n'), ('invalid utf-8', b'model = "\xff"\n'),
                        ('mcp_servers not a table', b'mcp_servers = 3\n'), ('duplicate table', b'[a]\n[a]\n'),
                        ('empty', b'')):
        fs.put(sb, '.codex/config.toml', data)
        fs.setup(sb, '--agent', 'codex', label='config.toml: ' + label)


@setup_scenario('setup/codex-project-scope')
def _(sb):
    fs.place(sb)
    project = sb.work / 'my proj'
    project.mkdir()
    fs.put(sb, '.codex/config.toml', 'model = "x"\n')
    fs.setup(sb, '--agent', 'codex', '--scope', 'project', '--project', str(project),
             label='project scope: hooks in the project, trust in the user config')
    fs.setup(sb, '--agent', 'codex', '--scope', 'project', '--project', str(project), label='project scope again')


@setup_scenario('setup/codex-home-variable')
def _(sb):
    fs.place(sb)
    codex_home = sb.home / 'alt-codex'
    fs.setup(sb, '--agent', 'codex', env={'CODEX_HOME': str(codex_home)}, label='CODEX_HOME (not created yet)')
    codex_home.mkdir(exist_ok=True)
    fs.setup(sb, '--agent', 'codex', env={'CODEX_HOME': str(codex_home)}, label='CODEX_HOME existing')
    fs.setup(sb, '--agent', 'codex', env={'CODEX_HOME': ''}, label='CODEX_HOME empty')


@setup_scenario('setup/codex-cli-probe')
def _(sb):
    fs.place(sb)
    sb.fake('codex', env='*', rules=[
        {'argv': ['--version'], 'stdout': 'codex-cli 0.1.0\n'},
        {'argv': ['mcp', 'list'], 'stderr': 'Error: unknown variant `mcp_tool`\n  in `hooks.Stop`\n', 'exit': 1}])
    fs.setup(sb, '--agent', 'codex', label='standalone Codex CLI without MCP tool hooks')
    sb.fake('codex', rules=[{'argv': ['--version'], 'exit': 1},
                            {'argv': ['mcp', 'list'], 'stdout': 'only stdout detail\n', 'exit': 2}])
    fs.setup(sb, '--agent', 'codex', label='version fails, stdout detail')
    sb.fake('codex', rules=[{'argv': ['mcp', 'list'], 'exit': 1}])
    fs.setup(sb, '--agent', 'codex', label='no detail at all')
    sb.fake('codex', rules=[{'argv': ['mcp', 'list'], 'exit': 1, 'stderr': 'x' * 1500 + ' end'}])
    fs.setup(sb, '--agent', 'codex', label='long detail is cut to its last 1000 characters')
    (sb.bb / 'fakes/codex').chmod(0o644)
    fs.setup(sb, '--agent', 'codex', label='codex on PATH is not executable')


@setup_scenario('setup/codex-cli-probe-timeout')
def _(sb):
    fs.place(sb)
    sb.fake('codex', rules=[{'argv': ['--version'], 'sleep': 12000, 'stdout': 'late\n'}])
    fs.setup(sb, '--agent', 'codex', label='codex --version hangs past 10 s', timeout=120)


@setup_scenario('setup/codex-cli-in-local-bin')
def _(sb):
    # The probe looks up `codex` on the target PATH extended with ~/.local/bin and friends.
    fs.place(sb)
    sb.remove_fake('codex')
    fs.bin_fake(sb, 'codex', rules=[{'argv': ['mcp', 'list'], 'exit': 1, 'stderr': 'old\n'}])
    fs.setup(sb, '--agent', 'codex', label='old codex only in ~/.local/bin (not on PATH)')
    fs.setup(sb, '--agent', 'codex', '--allow-missing', label='same with --allow-missing (extended PATH)')


@setup_scenario('setup/codex-adapter-missing')
def _(sb):
    fs.place(sb)
    (sb.release / 'adapters/audio-files.mjs').rename(sb.release / 'adapters/audio-files.mjs.off')
    fs.setup(sb, '--agent', 'codex', '--agent', 'claude-code', label='audio relay missing: codex fails, claude continues')
    sb.fake('codex', rules=[{'argv': ['mcp', 'list'], 'exit': 1}])
    fs.setup(sb, '--agent', 'codex', label='relay missing and CLI unsupported: host failure wins')


@setup_scenario('setup/codex-host-policy-missing')
def _(sb):
    fs.place(sb)
    (sb.apps / 'chatgpt/resources/plugins/openai-bundled/plugins/unified-computer-use/.mcp.json').unlink()
    fs.setup(sb, '--agent', 'claude-code', '--agent', 'codex', label='host .mcp.json missing aborts setup')


@setup_scenario('setup/codex-upstream-hooks-changed')
def _(sb):
    fs.place(sb)
    manifest = sb.apps / 'chatgpt/resources/plugins/openai-bundled/plugins/unified-computer-use/.codex-plugin/plugin.json'
    original = manifest.read_text()
    manifest.write_text(original.replace('"Interrupt"', '"Halt"'))
    fs.setup(sb, '--agent', 'codex', label='upstream lifecycle events changed')
    manifest.write_text(original.replace('"turn_ended"', '"turn_over"', 1))
    fs.setup(sb, '--agent', 'codex', label='upstream lifecycle contract changed')
    manifest.write_text(original)
    fs.setup(sb, '--agent', 'codex', label='restored upstream')


@setup_scenario('setup/codex-app-server-modes')
def _(sb):
    fs.place(sb)
    for mode in ('server-request', 'notification', 'hooks-errors', 'count-mismatch', 'no-hooks', 'extra-notice',
                 'bad-key', 'rpc-error', 'rpc-error-trust', 'exit-early', 'blank-line', 'nonjson'):
        fs.app_server(sb, mode=mode, env=['HOME', 'CODEX_HOME'])
        fs.setup(sb, '--agent', 'codex', label='app-server: ' + mode)
        (sb.home / '.codex').exists() and sb.run(['/bin/rm', '-rf', sb.home / '.codex'], label='reset ~/.codex')


@setup_scenario('setup/codex-app-server-project-trust')
def _(sb):
    fs.place(sb)
    project = sb.work / 'proj'
    project.mkdir()
    fs.app_server(sb, mode='rpc-error-trust', env=['HOME', 'CODEX_HOME'])
    fs.setup(sb, '--agent', 'codex', '--scope', 'project', '--project', str(project),
             label='project scope: trust write refused')
