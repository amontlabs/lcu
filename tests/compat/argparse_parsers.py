"""The real LCU ArgumentParsers, rebuilt for the argparse differential test (Python side).

Where the real code factors the parser out (`lcu.setup.parser()`, `lcu.apps.parser()`) the real function is
called; everywhere else the construction is copied verbatim from the source file named in each builder. Module
docstrings (used as descriptions) are read from the real files with `ast`, so help text follows the sources.
The JS twin is argparse_parsers.mjs; keep them in step with the sources when parsers change.
"""
import argparse
import ast
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import oracle_tree  # noqa: E402  (the Python oracle first on sys.path)
ORACLE = oracle_tree.ORACLE
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from lcu import apps as lcu_apps  # noqa: E402
from lcu import setup  # noqa: E402

SOURCES = {
    'setup': 'lcu/setup.py', 'apps': 'lcu/apps.py', 'browser': 'lcu/browser.py', 'doctor': 'lcu/doctor.py',
    'session': 'lcu/session.py', 'prune': 'lcu/maintenance.py', 'status': 'lcu/status.py',
    'update': 'lcu/update.py', 'install': 'scripts/install.py', 'install_macos': 'scripts/install_macos.py',
    'install_windows': 'scripts/install_windows.py', 'provision': 'scripts/provision_agent_tools.py',
}


def docstring(name):
    return ast.get_docstring(ast.parse((ORACLE / SOURCES[name]).read_text(encoding='utf-8')), clean=False)


def shared_data():
    """Facts the JS twin cannot compute itself: docstrings and values imported from lcu.setup."""
    return {
        'docs': {name: docstring(name) for name in SOURCES},
        'clients': list(setup.CLIENTS),
        'aliases': list(setup.ALIASES),
        'scripts_dir': str((ROOT / 'scripts').resolve()),
    }


class Hooks:
    """pre(parser, argv) -> argv and post(parser, args) around parse_args, for the parts of each main() that
    sit next to argparse (leading-argument rewrites and parser.error() calls)."""

    @staticmethod
    def pre(parser, argv):
        return argv

    @staticmethod
    def post(parser, args):
        return None


class AppsHooks(Hooks):  # lcu/apps.py main()
    @staticmethod
    def pre(parser, argv):
        arguments = list(argv)
        if not arguments or arguments[0].startswith('-') and arguments[0] not in ('-h', '--help'):
            arguments.insert(0, 'list')
        return arguments

    @staticmethod
    def post(parser, args):
        if args.action is None:
            args.json = False


class BrowserHooks(Hooks):  # lcu/browser.py main()
    @staticmethod
    def pre(parser, argv):
        if argv[:1] in (['serve'], ['protocol']):
            parser.error('the in-app browser host and codex:// protocol commands were removed; use the installed app browser. For external Chrome, run `lcu browser install` and enable the official ChatGPT extension.')
        return argv


class SessionHooks(Hooks):  # lcu/session.py main()
    @staticmethod
    def post(parser, args):
        command = args.command[1:] if args.command[:1] == ['--'] else args.command
        if not command:
            parser.error('Provide a command after --')
        args.command = command


class InstallHooks(Hooks):  # scripts/install.py main()
    @staticmethod
    def pre(parser, argv):
        argv = list(argv)
        legacy = bool(argv and not argv[0].startswith('-'))
        if legacy:
            argv = ['--prefix', argv[0], *argv[1:]]
        return argv


class InstallWindowsHooks(Hooks):  # scripts/install_windows.py main()
    @staticmethod
    def post(parser, args):
        if args.runtime_only and (args.agent or args.chrome or args.audio or args.no_chrome
                                  or args.no_audio or args.project or args.scope != 'user'):
            parser.error('--runtime-only cannot include agent setup options')
        if not args.runtime_only and not args.agent:
            parser.error('Choose --agent NAME or --runtime-only. Agents: ' + ', '.join(setup.CLIENTS))


def build_browser():  # lcu/browser.py main()
    parser = argparse.ArgumentParser(description=docstring('browser'))
    subparsers = parser.add_subparsers(dest='action', required=True)
    setup_parser = subparsers.add_parser('install', help='Install the original native host for the current desktop account')
    setup_parser.add_argument('--directory', type=Path, help='Private writable host directory')
    check = subparsers.add_parser('status', help='Check extension and connector setup without changing the browser')
    check.add_argument('--browser', choices=('chrome', 'edge'), default='chrome')
    return parser


def build_doctor():  # lcu/doctor.py main()
    parser = argparse.ArgumentParser(description='Check the original desktop provider and guide first-use permissions.')
    parser.add_argument('--non-interactive', action='store_true',
                        help='Check without prompts or opening System Settings')
    parser.add_argument('--require-ready', action='store_true',
                        help='Exit nonzero unless this platform can verify desktop readiness')
    return parser


def build_session():  # lcu/session.py main()
    parser = argparse.ArgumentParser(description=docstring('session'))
    parser.add_argument('--user', required=True)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    return parser


def build_prune():  # lcu/maintenance.py main()
    parser = argparse.ArgumentParser(prog='lcu prune',
                                     description='Remove superseded LCU release and app generations.')
    parser.add_argument('--keep', type=int, default=2,
                        help='Number of releases to keep, including current (minimum 1).')
    parser.add_argument('--yes', action='store_true', help='Delete instead of a dry run.')
    return parser


def build_status():  # lcu/status.py main()
    parser = argparse.ArgumentParser(prog='lcu status', description=docstring('status'))
    parser.add_argument('--json', action='store_true', help='Print one JSON object instead of text')
    return parser


def build_update():  # lcu/update.py main()
    parser = argparse.ArgumentParser(prog='lcu update', description=docstring('update'))
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--check', action='store_true', help='Check now without installing')
    mode.add_argument('--notice', action='store_true', help='Print the cached update notice for an agent (never uses the network)')
    mode.add_argument('--refresh', action='store_true', help=argparse.SUPPRESS)
    mode.add_argument('--post-install', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--json', action='store_true', help='Print JSON (with --check or --notice)')
    parser.add_argument('--hook', choices=('SessionStart', 'UserPromptSubmit'), help=argparse.SUPPRESS)
    parser.add_argument('--yes', action='store_true', help='Do not ask before installing')
    return parser


def build_install():  # scripts/install.py main()
    parser = setup.parser()
    parser.description = docstring('install') + ' Requires Linux, X11 and D-Bus; apt system provisioning requires root.'
    parser.add_argument('--runtime-only', action='store_true', help='Install without registering an agent')
    parser.add_argument('--skip-system', action='store_true', help='Skip apt; system libraries must already exist')
    parser.add_argument('--app-package', type=Path,
                        help='Removed: install the app yourself; this option now fails')
    parser.add_argument('--existing-app', type=Path,
                        help='Use an already installed app outside the default /usr/lib/chatgpt location')
    parser.add_argument('--offline', action='store_true', help='Never use the network; requires --skip-system and preinstalled system libraries')
    return parser


def build_install_macos():  # scripts/install_macos.py main()
    parser = setup.parser()
    parser.description = docstring('install_macos')
    parser.set_defaults(prefix=Path.home() / '.local/share/lcu', session='direct')
    parser.add_argument('--existing-app', type=Path, default=Path('/Applications/ChatGPT.app'),
                        help='Existing signed ChatGPT.app; reused in place without modification')
    parser.add_argument('--runtime-only', action='store_true')
    parser.add_argument('--offline', action='store_true', help='Accepted for consistency; macOS setup always uses local files')
    parser.add_argument('--skip-system', action='store_true', help='Accepted for consistency; no system packages are installed')
    return parser


def build_install_windows():  # scripts/install_windows.py main()
    parser = argparse.ArgumentParser(description=docstring('install_windows'))
    default = Path(os.environ.get('LOCALAPPDATA', str(Path.home() / 'AppData/Local'))) / 'LCU'
    parser.add_argument('--prefix', type=Path, default=default)
    parser.add_argument('--runtime-only', action='store_true')
    parser.add_argument('--agent', action='append', choices=tuple(setup.CLIENTS) + tuple(setup.ALIASES))
    parser.add_argument('--chrome', action='store_true')
    parser.add_argument('--no-chrome', action='store_true')
    parser.add_argument('--audio', action='store_true')
    parser.add_argument('--no-audio', action='store_true')
    parser.add_argument('--yes', action='store_true')
    parser.add_argument('--scope', choices=('user', 'project'), default='user')
    parser.add_argument('--project', type=Path)
    return parser


def build_provision():  # scripts/provision_agent_tools.py main()
    parser = argparse.ArgumentParser(description=docstring('provision'))
    parser.add_argument('--release', type=Path, required=True)
    parser.add_argument('--source', type=Path, default=Path(ROOT / 'scripts' / 'provision_agent_tools.py').resolve().parent / 'agent-tools')
    parser.add_argument('--target', choices=('linux', 'darwin', 'windows'), default='linux')
    parser.add_argument('--mac-node', type=Path)
    parser.add_argument('--adapters-source', type=Path)
    return parser


# Not an LCU parser: exercises argparse features LCU does not use today (nargs variants, metavar tuples, parents,
# groups, formatter classes, prefix_chars, argument_default) so the port stays faithful beyond the current parsers.
def build_kitchen():
    parent = argparse.ArgumentParser(add_help=False)
    parent.add_argument('--common', action='store_true', help='from the parent')
    p = argparse.ArgumentParser(prog='kitchen', parents=[parent], formatter_class=argparse.ArgumentDefaultsHelpFormatter,
                                description='Kitchen sink   with   odd spacing, long enough to need wrapping at a narrow terminal.',
                                epilog='Epilog for %(prog)s.')
    p.add_argument('pos', nargs='?', default='dflt', help='optional positional')
    p.add_argument('rest', nargs='*', metavar='REST')
    p.add_argument('-n', '--num', type=int, nargs=2, metavar=('A', 'B'), help='two ints')
    p.add_argument('-c', action='count')
    p.add_argument('--const', action='store_const', const=7, dest='seven')
    p.add_argument('--ac', action='append_const', const='z', dest='zs')
    p.add_argument('--ext', action='extend', nargs='+')
    p.add_argument('--flag', action=argparse.BooleanOptionalAction, default=True)
    p.add_argument('--opt', nargs='?', const='C', default='D', choices=['C', 'D', 'E'])
    group = p.add_mutually_exclusive_group(required=True)
    group.add_argument('--ga')
    group.add_argument('--gb', action='store_true')
    extra = p.add_argument_group('extra', 'extra description')
    extra.add_argument('--long-option-name-that-is-quite-long', metavar='VALUE_WITH_LONG_NAME', help='a ' + 'long help ' * 20)
    sub = p.add_subparsers(title='cmds', description='sub desc', metavar='CMD', dest='cmd')
    one = sub.add_parser('one', aliases=['uno'], help='the first')
    one.add_argument('--inner', action='store_true')
    sub.add_parser('two', help='the second')
    return p


def build_kitchen2():
    p = argparse.ArgumentParser(prog='k2', allow_abbrev=False, formatter_class=argparse.RawTextHelpFormatter,
                                prefix_chars='-+', argument_default=argparse.SUPPRESS,
                                description='Line one\n  indented line two', usage='%(prog)s [options] <things...>')
    p.add_argument('+x', '++extra', action='store_true', help='plus option\n  second line')
    p.add_argument('-y', type=int, help='y value')
    p.add_argument('things', nargs='+', help='things to do')
    p.add_argument('--opt', action='append', dest='opts', help='repeatable')
    p.add_argument('-v', action='store_false', dest='quiet')
    p.add_argument('--n3', nargs=3, type=int)
    p.add_argument('--star', nargs='*')
    p.add_argument('--rem', nargs=argparse.REMAINDER)
    return p


# Review regressions (findings 1, 2, 5, 7): int parsing of Unicode digits, negative-number classification, numeric
# choices across int types, and int defaults vs parsed ints.
def build_numeric():
    p = argparse.ArgumentParser(prog='numeric')
    p.add_argument('--n', type=int, choices=[1, 2, 2 ** 53 + 1, -3], default=2)
    p.add_argument('--keep', type=int, default=2)
    p.add_argument('--big', type=int, default=2 ** 60)
    p.add_argument('--e', type=int, choices=[True, 0], default=0)
    p.add_argument('pos', nargs='*', type=int)
    return p


def build_negopt():
    p = argparse.ArgumentParser(prog='negopt')
    p.add_argument('-1', dest='one', action='store_true')
    p.add_argument('--val')
    p.add_argument('pos', nargs='*')
    return p


BUILDERS = {
    'setup': (setup.parser, Hooks),
    'apps': (lcu_apps.parser, AppsHooks),
    'browser': (build_browser, BrowserHooks),
    'doctor': (build_doctor, Hooks),
    'session': (build_session, SessionHooks),
    'prune': (build_prune, Hooks),
    'status': (build_status, Hooks),
    'update': (build_update, Hooks),
    'install': (build_install, InstallHooks),
    'install_macos': (build_install_macos, Hooks),
    'install_windows': (build_install_windows, InstallWindowsHooks),
    'provision': (build_provision, Hooks),
    'kitchen': (build_kitchen, Hooks),
    'kitchen2': (build_kitchen2, Hooks),
    'numeric': (build_numeric, Hooks),
    'negopt': (build_negopt, Hooks),
}
