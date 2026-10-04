"""Report the installed LCU release, the selected app and whether the pair is tested."""
import argparse
import json
from pathlib import Path
import sys

from . import tested, update


def saved_setup():
    """The signed-in account's remembered opt-ins, or None when none are saved or readable."""
    from .setup import load_setup_state, setup_state_path
    try:
        if not setup_state_path(Path.home()).is_file():
            return None
        return load_setup_state(Path.home())
    except (ValueError, OSError, RuntimeError):
        return None


def collect(root):
    """Machine-readable status for one release; raises ValueError if the app cannot be read."""
    root = Path(root)
    descriptor_path = root / 'installation.json'
    if not descriptor_path.is_file():
        raise ValueError(f'No application is selected for this release: {descriptor_path} is missing.')
    descriptor = json.loads(descriptor_path.read_text())
    bundle = root / 'bundle.json'
    version = json.loads(bundle.read_text())['version'] if bundle.is_file() else 'source-checkout'
    from .runtime import paths
    resolved = paths(root, descriptor)
    observed = tested.observe(root, descriptor, resolved[3])
    changed = tested.changed_since_install(descriptor, {'version': observed['app_version'],
                                                         'runtime': observed['runtime']})
    saved = saved_setup()
    return {
        'lcu_version': version,
        'release': str(root),
        'platform': observed['platform'],
        'architecture': observed['architecture'],
        'app': {'path': str(resolved[0]), 'version': observed['app_version'], 'runtime': observed['runtime']},
        'compatibility': tested.assess(root, **observed),
        'changed_since_install': changed,
        'setup': saved,
        'pending': saved['pending'] if saved else [],
        'update': update.cached_notice(root),
    }


def main(root, argv=None):
    parser = argparse.ArgumentParser(prog='lcu status', description=__doc__)
    parser.add_argument('--json', action='store_true', help='Print one JSON object instead of text')
    args = parser.parse_args(argv)
    try:
        status = collect(root)
    except (ValueError, OSError, KeyError, json.JSONDecodeError) as exc:
        if args.json:
            print(json.dumps({'error': str(exc)}))
        else:
            print(f'lcu status: {exc}', file=sys.stderr)
        raise SystemExit(1) from None
    if args.json:
        print(json.dumps(status, indent=2))
        return
    app = status['app']
    print(f"LCU {status['lcu_version']} ({status['platform']} {status['architecture']}).")
    print(f"Original app: ChatGPT {app['version']} (CUA {app['runtime']}) at {app['path']}.")
    print('\n'.join(tested.status_lines(status['compatibility'])))
    if status['changed_since_install']:
        print(f"Warning: {status['changed_since_install']}")
    saved = status['setup']
    if saved:
        print(f"Saved setup: chrome {'on' if saved['chrome'] else 'off'}, audio {'on' if saved['audio'] else 'off'}, "
              f"approval {saved['approval']}.")
        if saved['pending']:
            print('Pending harnesses (not installed yet; `lcu setup --reconcile` registers them): '
                  + ', '.join(saved['pending']) + '.')
    if status.get('update'):
        print(update.status_line(root))
