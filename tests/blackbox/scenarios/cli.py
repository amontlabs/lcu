"""Entry-point behaviour of bin/lcu that needs no desktop: help, version, usage errors, status, doctor, apps, prune."""
import json
import sys

from . import scenario

ANY = ('darwin', 'linux')
MAC = ('darwin',)


@scenario('cli/help')
def _(sb):
    sb.place_release()
    sb.lcu('--help')
    sb.lcu('-h')
    sb.lcu('--chrome', '--audio', '--help')


@scenario('cli/version')
def _(sb):
    sb.place_release()
    sb.lcu('--version')
    sb.lcu('--chrome', '--version')


@scenario('cli/version-no-installation')
def _(sb):
    sb.place_release(installation=False)
    sb.lcu('--version')


@scenario('cli/version-no-bundle')
def _(sb):
    sb.place_release(bundle=False)
    sb.lcu('--version')


@scenario('cli/version-broken-app')
def _(sb):
    # A required app file is missing: --version reports the app invalid and exits 1.
    omit = ('Contents/Resources/cua_node/bin/node_repl',) if sys.platform == 'darwin' \
        else ('resources/cua_node/bin/node_repl',)
    sb.place_release(app_omit=omit)
    sb.lcu('--version')


@scenario('cli/usage-errors')
def _(sb):
    sb.place_release()
    sb.lcu('bogus')
    sb.lcu('--chrome', '--chrome')
    sb.lcu('--audio', '--audio', '--chrome')
    sb.lcu('doctor', 'extra', 'words')
    sb.lcu('--with-browser-host')
    sb.lcu('--mcp-discovery-compat', 'x')


@scenario('cli/tty-guard')
def _(sb):
    # A bare stdio server on a real terminal explains itself and exits 2.
    sb.place_release()
    sb.lcu(tty=True)


@scenario('cli/status')
def _(sb):
    sb.place_release()
    sb.lcu('status')
    sb.lcu('status', '--json')
    sb.lcu('status', '--bogus')


@scenario('cli/status-no-installation')
def _(sb):
    sb.place_release(installation=False)
    sb.lcu('status')
    sb.lcu('status', '--json')


@scenario('cli/doctor-help')
def _(sb):
    sb.place_release()
    sb.lcu('doctor', '--help')


@scenario('cli/doctor', normalise=('tmpdir-suffix',))
def _(sb):
    # Doctor against a fake app; every program it starts is a recorder, so the log shows what it ran.
    sb.place_release()
    sb.lcu('doctor', '--non-interactive', timeout=60)


@scenario('cli/setup-help')
def _(sb):
    sb.place_release()
    sb.lcu('setup', '--help')
    sb.lcu('setup', '--bogus')
    sb.lcu('setup', '--scope', 'x')


@scenario('cli/setup-list-agents')
def _(sb):
    sb.place_release()
    sb.lcu('setup', '--list-agents')


@scenario('cli/apps-list', hosts=MAC)
def _(sb):
    sb.place_release()
    sb.lcu('apps')
    sb.lcu('apps', 'list', '--json')
    sb.lcu('apps', '--help')


@scenario('cli/apps-linux', hosts=('linux',))
def _(sb):
    sb.place_release()
    sb.lcu('apps')


@scenario('cli/prune')
def _(sb):
    # Dry cases: nothing to prune, bad arguments, and a refused prune without --yes.
    sb.place_release()
    sb.add_old_release('0.9.2-aaaaaaaaaaaa', 1_700_000_000)
    sb.add_old_release('0.9.1-cccccccccccc', 1_600_000_000)
    sb.lcu('prune')
    sb.lcu('prune', '--keep', '1')
    sb.lcu('prune', '--keep', '0')
    sb.lcu('prune', '--keep', 'x')
    sb.lcu('prune', '--bogus')


@scenario('cli/prune-foreign-entry')
def _(sb):
    sb.place_release()
    (sb.prefix / 'releases/not-a-release').mkdir()
    sb.lcu('prune')


@scenario('cli/update-help')
def _(sb):
    sb.place_release()
    sb.lcu('update', '--help')
    sb.lcu('update', '--bogus')
