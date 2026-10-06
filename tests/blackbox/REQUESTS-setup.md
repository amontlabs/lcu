# Framework requests from the `lcu setup` scenarios (scenarios/setup_*.py)

These need changes to run.py / sandbox.py / snapshot.py / docker.sh, which the setup scenarios must not edit.

1. **Root container mode** (`needs_root=True` scenarios run by `docker.sh` with `--user 0`, account `ubuntu`
   still present). Needed for: `Root must specify --user ACCOUNT.`, the privilege drop (initgroups/setgid/setuid,
   env reset to HOME/USER/LOGNAME/PATH/LANG, chdir to the home), `--validate-only` from root targeting another
   account (empty installer environment), and file ownership of everything setup writes for the target account.
   Today the container always runs as uid 1000, so these branches are unreachable.
2. **`traceback` normaliser** in snapshot.NORMALISERS (collapse `Traceback (most recent call last): ... TYPE: msg`
   to `[uncaught TYPE]`). The pty helper (assets/setup/ptydrive.py) already does this inside its own transcript;
   a non-tty uncaught exception in stderr cannot be scenario-covered without it.
3. **Sandbox tty mode with scripted input**: `Sandbox.run(tty=True)` never writes to the pty and keeps stderr on a
   pipe, so prompts (which CPython writes to stderr when stdin/stdout are a tty) cannot be answered. The setup
   scenarios use their own helper (`ptydrive.py`, all three fds on the pty); a framework equivalent would let other
   areas reuse it.
4. **Optional: a Codex app-server mode switch in assets/recorder.mjs** so scenarios do not need to replace the app's
   `codex` with assets/setup/appserver.mjs (they currently do, via fixtures_setup.app_server).
