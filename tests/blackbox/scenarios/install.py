"""scripts/install.sh from an extracted archive (the source tree stands in for it): help, refusals, a full install."""
import sys

from fixtures import linux_app, mac_app

from . import scenario


def _installer(sb):
    return ['bash', sb.src / 'scripts/install.sh']


def _target():
    return 'darwin' if sys.platform == 'darwin' else 'linux'


def _app(sb):
    if _target() == 'darwin':
        return mac_app(sb.apps / 'ChatGPT.app', sb.recorder)
    return linux_app(sb.apps / 'chatgpt', sb.recorder)


def _flags(sb, app):
    # Linux needs --skip-system (no apt) and --offline; both are accepted on macOS.
    return ['--existing-app', app, '--prefix', sb.prefix, '--skip-system', '--offline']


@scenario('install/help')
def _(sb):
    sb.place_src()
    sb.run([*_installer(sb), '--help'])
    sb.run([*_installer(sb), '-h'])


@scenario('install/list-agents')
def _(sb):
    sb.place_src()
    sb.run([*_installer(sb), '--list-agents'])


@scenario('install/usage-errors')
def _(sb):
    sb.place_src()
    sb.run([*_installer(sb), '--bogus'], label='install.sh --bogus')
    sb.run([*_installer(sb), '--agent', 'nope', '--existing-app', sb.apps / 'missing', '--prefix', sb.prefix],
           label='install.sh unknown agent')


@scenario('install/missing-app')
def _(sb):
    # No app at the selected location: refuse before any prefix write, pointing at the official download.
    sb.place_src(sealed=_target())
    sb.run([*_installer(sb), '--runtime-only', *_flags(sb, sb.apps / 'missing')])


@scenario('install/needs-bundle')
def _(sb):
    # A source checkout carries no sealed bundle.json; the installer refuses before touching the prefix.
    sb.place_src()
    sb.run([*_installer(sb), '--runtime-only', *_flags(sb, _app(sb))])


# The installer validates the new release as the OS account (cwd and HOME become the account home), so this
# scenario only runs in the disposable container where that home is wiped per scenario.
@scenario('install/runtime-only', hosts=('linux',), account_home=True, normalise=('release-id',))
def _(sb):
    # The full installer on a sealed archive: validate the fake app in place, publish a release, select it.
    sb.place_src(sealed=_target())
    app = _app(sb)
    sb.run([*_installer(sb), '--runtime-only', *_flags(sb, app)], label='install.sh --runtime-only')
    sb.run([sb.prefix / 'current/bin/lcu', '--version'], label='installed lcu --version')


@scenario('install/option-conflicts', normalise=('release-id',))
def _(sb):
    sb.place_src(sealed=_target())
    sb.run([*_installer(sb), '--runtime-only', '--agent', 'codex', *_flags(sb, _app(sb))],
           label='--runtime-only with --agent')
    sb.run([*_installer(sb), '--offline', '--existing-app', sb.apps / 'x', '--prefix', sb.prefix],
           label='--offline without --skip-system')
