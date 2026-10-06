"""Helpers for the `lcu setup` black-box scenarios (scenarios/setup_*.py).

Everything here drives the code under test only through its command line, exactly like a user: an installed
release with a fixture ChatGPT app, recorder fakes for the agent CLIs, the real add-mcp/skills packages from the
cached archive dependency set (or recorders with agent_tools='fake'), and the OS account home as the target.
"""
import json
import os
from pathlib import Path
import shlex
import shutil
import stat

import fixtures
from scenarios import scenario

HERE = Path(__file__).resolve().parent
ASSETS = HERE / 'assets/setup'
LINUX = ('linux',)


def setup_scenario(name, **options):
    """Register a Linux, disposable-container scenario (setup resolves the account home through the OS)."""
    options.setdefault('normalise', ('tmpdir-suffix', 'diagnostic-log'))
    register = scenario(name, hosts=LINUX, account_home=True, **options)

    def wrap(fn):
        def run(sb):
            fn(sb)
            # The real `skills` CLI enables Node's module compile cache under TMPDIR: content and names vary per
            # run (V8 build, timing), and it is not something LCU writes. Drop it before the snapshot.
            shutil.rmtree(sb.tmp / 'node-compile-cache', ignore_errors=True)
        register(run)
        return fn
    return wrap


# -- release -------------------------------------------------------------------------------------------------
def place(sb, **options):
    """An installed Linux release; `agent_tools` True (real add-mcp/skills, the default) or 'fake' (recorders).

    The fixture app also gets the parts of the original Chrome plugin `lcu setup --chrome` drives (see
    chrome_plugin)."""
    for helper in ('ptydrive.py', 'lockrun.py', 'spy.mjs', 'appserver.mjs'):
        shutil.copy(ASSETS / helper, sb.bb / helper)
    release = sb.place_release('linux', **options)
    chrome_plugin(sb)
    return release


def chrome_plugin(sb):
    """Original Chrome plugin scripts `lcu setup --chrome` runs: installManifest.mjs (writes the per-user native
    host manifest unless the recorder config `chrome-install` says mode 'fail' or 'none') and the two status
    diagnostics (recorders `chrome-check-extension` / `chrome-check-manifest`; configure their stdout)."""
    scripts = sb.apps / 'chatgpt/resources/plugins/openai-bundled/plugins/chrome/scripts'
    recorder = json.dumps(str(sb.recorder))
    arch = fixtures.architecture()
    fixtures.write(scripts / 'installManifest.mjs', f'''import {{ config, log }} from {recorder};
import {{ mkdirSync, writeFileSync }} from 'node:fs';
import {{ dirname, join }} from 'node:path';
import {{ fileURLToPath }} from 'node:url';
export async function install(options) {{
  log({{ tool: 'chrome-installManifest', options, script: fileURLToPath(import.meta.url), cwd: process.cwd() }});
  const mode = config('chrome-install').mode || 'ok';
  if (mode === 'fail') {{ process.stderr.write('installer exploded\\n'); process.exit(4); }}
  if (mode === 'none') return;
  const plugin = dirname(dirname(fileURLToPath(import.meta.url)));
  const directory = join(process.env.HOME, '.config/google-chrome/NativeMessagingHosts');
  mkdirSync(directory, {{ recursive: true }});
  writeFileSync(join(directory, 'com.openai.codexextension.json'), JSON.stringify({{
    name: 'com.openai.codexextension', description: 'fixture',
    path: join(plugin, 'extension-host/linux/{arch}/extension-host'), type: 'stdio',
    allowed_origins: ['chrome-extension://fixture/'] }}, null, 2) + '\\n');
}}
''')
    fixtures.write(scripts / 'extension-ids.json', json.dumps({'browserDiagnostics': [{
        'browserFamily': 'chrome', 'shortDisplayName': 'Chrome',
        'extensionManagementUrl': 'chrome://extensions/?id=fixture', 'storeUrl': 'https://chromewebstore.invalid/fixture'}]},
        indent=2) + '\n')
    for script, name in (('check-extension-installed.js', 'chrome-check-extension'),
                         ('check-native-host-manifest.js', 'chrome-check-manifest')):
        fixtures.write(scripts / script, f"import {{ run }} from {recorder};\nawait run('{name}', process.argv.slice(2));\n")


def lcu(sb):
    return sb.release / 'bin/lcu'


def setup(sb, *args, label=None, direct=True, yes=True, **options):
    """`lcu setup ARGS` (adds --session direct and --yes unless told not to). Returns the run result."""
    argv = [lcu(sb), 'setup', *args]
    if direct:
        argv += ['--session', 'direct']
    if yes:
        argv += ['--yes']
    return sb.run(argv, label=label or 'lcu setup ' + ' '.join(args), **options)


def raw(sb, *args, label=None, **options):
    """`lcu setup ARGS` exactly as given."""
    return sb.run([lcu(sb), 'setup', *args], label=label or 'lcu setup ' + ' '.join(args), **options)


def pty_setup(sb, spec, *args, label=None, **options):
    """`lcu setup ARGS` on a pty with a scripted dialogue (see assets/setup/ptydrive.py)."""
    return sb.run([sb.bb / 'tools/python3', sb.bb / 'ptydrive.py', json.dumps(spec), '--', lcu(sb), 'setup', *args],
                  label=label or 'pty lcu setup ' + ' '.join(args), **options)


def pty_run(sb, spec, argv, label=None, **options):
    return sb.run([sb.bb / 'tools/python3', sb.bb / 'ptydrive.py', json.dumps(spec), '--', *argv],
                  label=label, **options)


# -- files in the account home -------------------------------------------------------------------------------
def put(sb, relative, data, mode=None):
    """Write a file under the account home (parents created). `data` is str or bytes."""
    path = sb.home / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data.encode() if isinstance(data, str) else data)
    if mode is not None:
        path.chmod(mode)
    return path


def put_json(sb, relative, value, **dump):
    return put(sb, relative, json.dumps(value, **dump))


def state_dir(sb):
    return sb.home / '.local/state/lcu'


def put_state(sb, value=None, raw_text=None):
    """Write ~/.local/state/lcu/setup.json (from a JSON-able value, or the given raw text/bytes)."""
    return put(sb, '.local/state/lcu/setup.json', raw_text if raw_text is not None else json.dumps(value, indent=2) + '\n')


def bin_fake(sb, name, rules=None, default=None, env=None):
    """A recorder executable in ~/.local/bin (outside PATH: found through setup's extra search directories).

    The fake's behaviour is configured like any other recorder (sb.fake)."""
    node = shlex.quote(str(sb.bb / 'tools/node'))
    script = ('#!/bin/sh\n'
              f'export LCU_BB_NODE={node} LCU_BB_RECORDER={shlex.quote(str(sb.recorder))} '
              f'LCU_BB_CONFIG={shlex.quote(str(sb.config_path))} LCU_BB_LOG={shlex.quote(str(sb.log_path))}\n'
              f'exec {node} "$LCU_BB_RECORDER" {shlex.quote(name)} "$@"\n')
    path = put(sb, f'.local/bin/{name}', script, 0o755)
    config = {}
    if rules:
        config['rules'] = rules
    if default:
        config['default'] = default
    if env:
        config['env'] = env
    sb.fake(name, **config)
    return path


def chmod(path, mode):
    os.chmod(path, mode)


# -- instrumentation -----------------------------------------------------------------------------------------
def spy_node(sb):
    """Log every node child LCU starts through the app's Node (argv with the inline script masked, cwd, full env)."""
    wrapper = ('#!/bin/sh\n'
               f'"$LCU_BB_NODE" {shlex.quote(str(sb.bb / "spy.mjs"))} "$@"\n'
               'LCU_BB_ARGV0="$0" exec "$LCU_BB_NODE" "$@"\n')
    fixtures.write(sb.apps / 'chatgpt/resources/cua_node/bin/node', wrapper, 0o755)


def app_server(sb, **config):
    """Replace the app's `codex` with the configurable fake (assets/setup/appserver.mjs); config goes to `app-codex`."""
    fixtures.write(sb.apps / 'chatgpt/resources/codex',
                   f'#!/bin/sh\nexec "$LCU_BB_NODE" {shlex.quote(str(sb.bb / "appserver.mjs"))} "$@"\n', 0o755)
    sb.fake('app-codex', **config)


def skills_list(sb, entries, *, remove_exit=0, list_exit=0, raw_stdout=None, list_stderr=''):
    """Make the recorder `skills` CLI answer `list --json` with ENTRIES (needs agent_tools='fake')."""
    stdout = raw_stdout if raw_stdout is not None else json.dumps(entries)
    sb.fake('skills', rules=[
        {'argv': ['list'], 'stdout': stdout, 'stderr': list_stderr, 'exit': list_exit},
        {'argv': ['remove'], 'stdout': 'removed\n', 'exit': remove_exit, 'stderr': 'remove failed\n' if remove_exit else ''},
    ])


def show(sb, relative, label=None):
    """A command whose output lists a subtree of the account home (mode, sha256, path): intermediate state."""
    script = ('cd "$HOME/$1" 2>/dev/null || { echo "(missing)"; exit 0; }; '
              'find . -mindepth 1 | LC_ALL=C sort | while read -r f; do '
              'if [ -f "$f" ] && [ ! -L "$f" ]; then echo "$(stat -c %a "$f") $(sha256sum < "$f" | cut -c1-16) $f"; '
              'else echo "$(stat -c %a "$f") - $f"; fi; done')
    return sb.run(['/bin/sh', '-c', script, 'show', relative], env={'HOME': str(sb.home)},
                  label=label or 'show ~/' + relative)


def tree(sb, relative='', skip=()):
    """Sorted `mode type path` lines of the account home subtree (for scenario-side assertions printed via labels)."""
    base = sb.home / relative
    lines = []
    for path in sorted(base.rglob('*')):
        info = path.lstat()
        lines.append(f'{stat.S_IMODE(info.st_mode):04o} {path.relative_to(sb.home)}')
    return lines


CLAUDE_SETTINGS_BASE = {'permissions': {'allow': ['Bash(ls)']}, 'theme': 'dark'}
