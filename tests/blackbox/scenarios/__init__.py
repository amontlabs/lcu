"""Scenario registry. A scenario is a function `fn(sb)` that drives a Sandbox; the harness snapshots the result.

    @scenario('cli/help', hosts=('darwin', 'linux'))
    def _(sb):
        sb.place_release()
        sb.lcu('--help')

Options: `hosts` (OS names the scenario can run on: it is skipped elsewhere), `normalise` (names from
snapshot.NORMALISERS applied to this scenario's rendered text), `account_home` (the scenario writes to the
OS account's real home, so it only runs in the disposable container; True = the account running the harness, a
string = that account, e.g. 'ubuntu' from a root scenario), `needs_root` (runs only when the harness runs as root,
i.e. `docker.sh --root`; a root run runs only these).
"""
from dataclasses import dataclass
import importlib
import pkgutil
from typing import Callable

REGISTRY = {}


@dataclass
class Scenario:
    name: str
    fn: Callable
    hosts: tuple
    normalise: tuple
    account_home: object
    needs_root: bool = False


def scenario(name, *, hosts=('darwin', 'linux'), normalise=(), account_home=False, needs_root=False):
    def register(fn):
        if name in REGISTRY:
            raise ValueError(f'duplicate scenario {name}')
        REGISTRY[name] = Scenario(name, fn, tuple(hosts), tuple(normalise), account_home, needs_root)
        return fn
    return register


def load():
    for module in pkgutil.iter_modules(__path__):
        importlib.import_module(f'{__name__}.{module.name}')
    return REGISTRY
