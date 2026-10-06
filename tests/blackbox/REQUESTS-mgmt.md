# Framework requests from the management scenarios (mgmt_*.py)

Worked around locally; listed so the harness owner can fold them in.

1. **No URL override in `lcu update`.** github.com / raw.githubusercontent.com are hard-coded. The scenarios set
   `https_proxy=http://127.0.0.1:<port>` to a CONNECT proxy (assets/mgmt/fixture_server.py) that terminates TLS
   with a checked-in test CA, trusted through `SSL_CERT_FILE` (Python) and `NODE_EXTRA_CA_CERTS` (Node). A port that
   ignores `https_proxy` (Node's fetch does unless `NODE_USE_ENV_PROXY=1`) would reach the real GitHub from a host
   run (read-only HEAD/GET), and would DIFF. If the port adds an override variable, the fixture can use it instead.
2. **Intermediate file states.** The snapshot inlines only the final tree. `fixtures_mgmt.show()` /
   `show_scrubbed()` run `assets/mgmt/showfile.py` as a command to record a file's mode and bytes mid-scenario.
   A built-in `sb.show(path)` would be cleaner.
3. **Wall-clock values in files.** `update.json` `checked_at` and `announced.json` `at` are rewritten to a constant
   at the end of each scenario (`fixtures_mgmt.scrub_times`) and shown through `showfile.py --scrub`. A named
   normaliser (`update-times`) would make this unnecessary. Float formatting of those values is therefore NOT
   compared.
4. **Implementation-language relay.** `lcu browser install` copies `lcu/native_host.py` out as `lcu-native-host`;
   its bytes differ by design after the port. `fixtures_mgmt.neutralise_relay()` replaces it by a one-line summary
   (type, mode) at the end of each browser scenario. A normaliser keyed on that path would be better.
5. **pty with scripted answers.** `sb.run(tty=True)` cannot answer prompts. `fixtures_mgmt.pty()` runs
   `assets/mgmt/ptydrive.py`, which matches prompts on the terminal AND on stderr (Python's `input()` writes its
   prompt to stderr when stderr is not a terminal) and records the transcript.
6. **Kept temporary directories.** `lcu update` keeps `$TMPDIR/lcu-update-<random>` when the prefix is not
   writable. Several of them sort randomly; the scenario renames them in creation order (`lcu-update-keptNNNN`,
   still matched by the `tmpdir-suffix` normaliser).
7. **Release reference for update-created releases.** `fixtures_mgmt.register_new_release_reference()` appends
   to `sb._impl_dirs` (private) so releases created by the real installer, and kept extractions, are compared with
   the archive tree under `.bb/build/`. A public `sb.compare_with(glob, reference)` would avoid the private access.
8. **Baseline before huge sparse files.** `prune/sizes` calls `sb._take_baseline()` (private) before creating
   multi-GiB/TiB sparse files so the baseline scan does not hash them.
