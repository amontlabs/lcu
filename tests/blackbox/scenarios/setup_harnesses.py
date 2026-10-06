"""`lcu setup` for Pi (extension.mjs wrapper + commands.json + `pi install`), Oh My Pi (generated package dir
`user-<sha256[:16]>` + `omp plugin link`) and Hermes (plugin tree + `hermes plugins enable`), including the
generated-tree ownership checks and rollback."""
import json

import fixtures_setup as fs
from fixtures_setup import setup_scenario


@setup_scenario('setup/pi-user')
def _(sb):
    fs.place(sb)
    sb.fake('pi', env='*')
    fs.setup(sb, '--agent', 'pi', label='pi user scope')
    fs.setup(sb, '--agent', 'pi', '--chrome', '--audio', label='pi again with chrome+audio (command updated)')


@setup_scenario('setup/pi-project-scope')
def _(sb):
    fs.place(sb)
    sb.fake('pi', env=['PI_OFFLINE', 'HOME', 'CI', 'NO_COLOR', 'DO_NOT_TRACK', 'DISABLE_TELEMETRY'])
    first = sb.work / 'proj one'
    first.mkdir()
    second = sb.work / 'ünï@code+x'
    second.mkdir()
    (sb.work / 'link').symlink_to(second)
    fs.setup(sb, '--agent', 'pi', '--scope', 'project', '--project', str(first), label='first project')
    fs.setup(sb, '--agent', 'pi', '--scope', 'project', '--project', str(sb.work / 'link'),
             label='second project through a symlink (key is the resolved path)')
    fs.setup(sb, '--agent', 'pi', label='user scope keeps project keys')


@setup_scenario('setup/pi-odd-prefix')
def _(sb):
    # The wrapper imports the adapter by file URL: Python's Path.as_uri() percent-encoding of the prefix path.
    fs.place(sb)
    odd = sb.root / "odd pre@fix+é,=!$&'()*~"
    odd.mkdir()
    (odd / 'current').symlink_to(sb.release)
    fs.setup(sb, '--agent', 'pi', '--prefix', str(odd), label='prefix with characters as_uri escapes')


@setup_scenario('setup/pi-commands-json')
def _(sb):
    fs.place(sb)
    for label, data in (('empty file', ''), ('not json', '{x'), ('a list', '[]'), ('projects not an object', '{"projects": []}'),
                        ('no projects key', '{"user": ["old"]}'),
                        ('other projects and unicode', json.dumps({'projects': {'/é': ['x']}, 'user': ['old'], 'z': 1.0}))):
        fs.put(sb, '.local/share/lcu/pi/commands.json', data)
        fs.setup(sb, '--agent', 'pi', label='commands.json: ' + label)


@setup_scenario('setup/pi-failures')
def _(sb):
    fs.place(sb)
    sb.fake('pi', default={'stderr': 'npm ERR! offline\n', 'exit': 3})
    fs.setup(sb, '--agent', 'pi', '--agent', 'claude-code', label='pi install fails, claude still runs')
    sb.fake('pi', default={'stdout': 'only stdout\n', 'exit': 1})
    fs.setup(sb, '--agent', 'pi', label='pi install fails with stdout only')
    sb.remove_fake('pi')
    fs.setup(sb, '--agent', 'pi', label='pi not on PATH')
    sb.add_fake('pi')
    sb.fake('pi')
    adapter = sb.release / 'adapters/pi/index.ts'
    adapter.rename(adapter.with_suffix('.off'))
    fs.setup(sb, '--agent', 'pi', label='pi adapter missing')
    adapter.with_suffix('.off').rename(adapter)
    (sb.home / '.local/share/lcu/pi').mkdir(parents=True, exist_ok=True)
    (sb.home / '.local/share/lcu/pi/extension.mjs').unlink(missing_ok=True)
    (sb.home / '.local/share/lcu/pi/extension.mjs').mkdir()
    fs.setup(sb, '--agent', 'pi', label='extension.mjs is a directory')


@setup_scenario('setup/pi-rollback')
def _(sb):
    # extension.mjs is written first; a failure writing commands.json restores the previous extension.mjs.
    fs.place(sb)
    fs.put(sb, '.local/share/lcu/pi/extension.mjs', 'previous wrapper\n')
    fs.put(sb, '.local/share/lcu/pi/commands.json', '{"projects": {}, "user": ["old"]}\n', 0o444)
    (sb.home / '.local/share/lcu/pi').chmod(0o555)
    fs.setup(sb, '--agent', 'pi', label='read-only pi directory: nothing written')
    (sb.home / '.local/share/lcu/pi').chmod(0o755)


@setup_scenario('setup/omp')
def _(sb):
    fs.place(sb)
    sb.fake('omp', env=['HOME', 'CI', 'PI_CODING_AGENT_DIR', 'OMP_PROFILE'],
            rules=[{'argv': ['config', 'get'], 'stdout': '{"value": {}}\n'}])
    fs.setup(sb, '--agent', 'omp', label='omp default profile')
    fs.setup(sb, '--agent', 'oh-my-pi', '--chrome', label='omp again (same directory, replaced)')
    fs.setup(sb, '--agent', 'omp', env={'OMP_PROFILE': 'work', 'PI_PROFILE': 'p', 'PI_CODING_AGENT_DIR': str(sb.home / 'pi-x')},
             label='omp profile variables change the package directory')


@setup_scenario('setup/omp-failures')
def _(sb):
    fs.place(sb)
    sb.fake('omp', rules=[{'argv': ['plugin', 'link'], 'stderr': 'link failed\n', 'exit': 2}])
    fs.setup(sb, '--agent', 'omp', label='omp plugin link fails: new tree removed')
    sb.fake('omp')
    fs.setup(sb, '--agent', 'omp', label='omp ok')
    sb.fake('omp', rules=[{'argv': ['plugin', 'link'], 'stderr': 'relink failed\n', 'exit': 2}])
    fs.show(sb, '.local/share/lcu/omp', label='omp tree before the failed relink')
    fs.setup(sb, '--agent', 'omp', '--audio', label='relink fails: previous tree restored')
    fs.show(sb, '.local/share/lcu/omp', label='omp tree after the failed relink')
    sb.fake('omp')
    sb.run(['/bin/sh', '-c', 'f=$(ls -d "$HOME"/.local/share/lcu/omp/user-*); echo "{}" > "$f/.lcu-generated.json"'],
           label='tamper with the ownership marker')
    fs.setup(sb, '--agent', 'omp', label='unowned package directory is refused')
    sb.run(['/bin/sh', '-c', 'f=$(ls -d "$HOME"/.local/share/lcu/omp/user-*); echo \'{"harness": "omp"}\' > "$f/.lcu-generated.json"; '
            'ln -s /etc "$f/link"'], label='restore marker, add a symlink inside')
    fs.setup(sb, '--agent', 'omp', label='symlink inside the package directory is refused')
    sb.remove_fake('omp')
    fs.setup(sb, '--agent', 'omp', label='omp not on PATH')
    fs.bin_fake(sb, 'omp')
    fs.setup(sb, '--agent', 'omp', label='omp only in ~/.local/bin: not on the target PATH without --allow-missing')
    fs.setup(sb, '--agent', 'omp', '--allow-missing', label='with --allow-missing the extended PATH finds it')


@setup_scenario('setup/hermes')
def _(sb):
    fs.place(sb)
    sb.fake('hermes', env=['HOME', 'HERMES_HOME', 'CI'])
    fs.setup(sb, '--agent', 'hermes', label='hermes default HERMES_HOME')
    fs.setup(sb, '--agent', 'hermes-agent', '--audio', label='hermes again (replaced)')
    fs.setup(sb, '--agent', 'hermes', env={'HERMES_HOME': str(sb.home / 'h2')}, label='explicit HERMES_HOME')


@setup_scenario('setup/hermes-failures')
def _(sb):
    fs.place(sb)
    fs.put(sb, '.hermes/plugins/lcu-cua/mine.txt', 'not ours\n')
    fs.setup(sb, '--agent', 'hermes', label='unowned plugin directory is refused')
    sb.run(['/bin/rm', '-rf', sb.home / '.hermes/plugins/lcu-cua'], label='remove it')
    sb.fake('hermes', rules=[{'argv': ['plugins', 'enable'], 'stderr': 'enable failed\n', 'exit': 1}])
    fs.setup(sb, '--agent', 'hermes', label='enable fails: tree removed')
    fs.show(sb, '.hermes/plugins', label='hermes plugins after the failed enable')
    sb.fake('hermes')
    for name in ('bridge.mjs', 'plugin.yaml'):
        path = sb.release / 'adapters/hermes' / name
        path.rename(path.with_suffix('.off'))
        fs.setup(sb, '--agent', 'hermes', label=f'release {name} missing')
        path.with_suffix('.off').rename(path)
    sb.remove_fake('hermes')
    fs.setup(sb, '--agent', 'hermes', label='hermes not on PATH')


@setup_scenario('setup/all-agents')
def _(sb):
    fs.place(sb)
    sb.fake('omp', rules=[{'argv': ['config', 'get'], 'stdout': '{"value": {}}\n'}])
    fs.setup(sb, '--agent', 'all', '--chrome', '--audio', '--approval', 'auto', label='every agent at once')
