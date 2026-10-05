#!/usr/bin/env python3
"""Select an existing signed macOS app and install LCU's thin adapters."""
import json
from pathlib import Path
import subprocess
import sys

SOURCE = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
sys.path.insert(0, str(SOURCE))

from lcu import setup
from lcu.platforms import resolve_installed_mac_app
from bundle import architecture, verify
from install import checked_prefix, select_release


def install(prefix, application, *, account=None):
    prefix = checked_prefix(prefix)
    arch = architecture('darwin')
    verify(SOURCE, arch, 'darwin')
    policy = json.loads((SOURCE / 'runtime.lock.json').read_text())['platforms']['darwin']
    if arch not in policy.get('architectures', {}):
        raise ValueError(f'This LCU release does not support macOS {arch}')
    if not Path(application).expanduser().is_dir():
        raise ValueError(setup.app_prerequisite_message(application, alternate_location=True))
    selected = resolve_installed_mac_app(application, arch=arch)
    # Validate before creating the prefix or changing the selected release.
    prefix.mkdir(parents=True, exist_ok=True)
    (prefix / '.lcu-install').touch(exist_ok=True)
    return select_release(prefix, arch, selected.app, {
        'platform': 'darwin', 'architecture': arch, 'package_version': selected.version,
        'runtime': selected.runtime_version,
    }, account=account, target='darwin', source=SOURCE)


def main(argv=None):
    parser = setup.parser()
    parser.description = __doc__
    parser.set_defaults(prefix=Path.home() / '.local/share/lcu', session='direct')
    parser.add_argument('--existing-app', type=Path, default=Path('/Applications/ChatGPT.app'),
                        help='Existing signed ChatGPT.app; reused in place without modification')
    parser.add_argument('--runtime-only', action='store_true')
    parser.add_argument('--offline', action='store_true', help='Accepted for consistency; macOS setup always uses local files')
    parser.add_argument('--skip-system', action='store_true', help='Accepted for consistency; no system packages are installed')
    args = parser.parse_args(argv)
    if args.list_agents:
        setup.main(['--list-agents'])
        return
    if sys.version_info < (3, 12):
        raise ValueError('Python 3.12 or later is required')
    if args.reconcile:
        raise ValueError('--reconcile runs after installation: use `lcu setup --reconcile` from the installed release.')
    account, names = setup.validate(args)
    if args.session != 'direct':
        raise ValueError('macOS uses --session direct; XFCE session discovery is Linux-only')
    if args.runtime_only:
        if (args.agent or args.export or args.project or args.scope != 'user' or args.check_desktop
                or args.chrome or args.audio or args.no_chrome or args.no_audio or args.approval or args.allow_missing):
            raise ValueError('--runtime-only cannot include agent setup options')
    elif not names and not args.export and (args.yes or not sys.stdin.isatty()):
        raise ValueError('Select --agent NAME, --export PATH, or --runtime-only')
    install(args.prefix, args.existing_app, account=account)
    runtime = args.prefix / 'current/bin/lcu'
    print(f'LCU installed: {runtime}')
    print('The signed application is reused in place. Compatible updates are detected automatically.')
    if args.runtime_only:
        # Agent setup reports this itself, before applying anything.
        from lcu.tested import report as report_tested_pair
        report_tested_pair(args.prefix / 'current')
    if not args.runtime_only:
        forwarded = ['--prefix', str(args.prefix), '--user', account.pw_name, '--scope', args.scope,
                     '--session', 'direct']
        for name in args.agent:
            forwarded += ['--agent', name]
        for option in ('project', 'export'):
            if getattr(args, option):
                forwarded += ['--' + option, str(getattr(args, option))]
        for option in ('yes', 'check_desktop', 'chrome', 'audio', 'no_chrome', 'no_audio', 'allow_missing'):
            if getattr(args, option):
                forwarded += ['--' + option.replace('_', '-')]
        if args.approval:
            forwarded += ['--approval', args.approval]
        result = subprocess.run([str(runtime), 'setup', *forwarded], check=False)
        if result.returncode:
            print(f'LCU runtime installed at {runtime}, but setup failed; see the errors above. '
                  f'After resolving the errors, retry: {runtime} setup {" ".join(forwarded)}',
                  file=sys.stderr)
            raise SystemExit(result.returncode)
    if args.runtime_only:
        print('When you configure an agent interactively, LCU guides you through macOS privacy settings.')
        print(f'You can review the guidance now with: {runtime} doctor')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as exc:
        sys.exit(f'LCU macOS installer: {exc}')
