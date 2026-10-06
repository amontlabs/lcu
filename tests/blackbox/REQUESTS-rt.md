# Framework requests from the rt_* scenarios (runtime / lifecycle hosts / installers)

The rt_* scenarios only use the public Sandbox API; these are things they work around today.

1. **A named normaliser for ephemeral socket directories with any suffix length.** `tmpdir-suffix` matches exactly
   8 characters (Python's `tempfile`). A Node `mkdtemp('lcu-ml-')` suffix is 6 characters, so `LCU_MAC_LIFETIME_SOCKET`
   in the child environment (rt/mac/launch, rt/mac/surfaces, rt/mac/trusted-services) will differ even when the
   behaviour is right. Suggest `lcu-ml-[A-Za-z0-9_]+` -> `lcu-ml-<RANDOM>` as its own normaliser (the probe already
   reports the directory mode and the suffix length separately, so a length change stays visible).
2. **Version-independent release ids.** `release-id` keeps the version (`0.9.4-<ID>`). Fine while BASE and the
   worktree carry the same version (BASE is now 805e7dc / 0.9.4); otherwise every installer scenario differs.
3. **Node's compile cache.** Any command that runs the real adapters/add-mcp under Node writes
   `$TMPDIR/node-compile-cache/...` with nondeterministic content. rt/install/linux-agent-setup sets
   `NODE_DISABLE_COMPILE_CACHE=1`; a global harness default (or skipping `tmp/node-compile-cache` in the tree) would
   be simpler for everyone.
4. **Host-signal scenarios are opt-in.** rt/mac/signals and rt/mac/host-killed register only with
   `LCU_BB_RT_HOST_SIGNALS=1` (see the SAFETY RULE in .port/BRIEF.md). All signalling goes through
   `assets/rt/driver.py` `send()`/`send_group()`, session-checked. Linux signal scenarios run in Docker only.
5. **Recorder fields.** `assets/rt/probe.mjs` replaces the fixture `cua-repl.mjs` because the shared recorder cannot
   log `execArgv`, open descriptors, raw (non-UTF-8) environment bytes or act on sockets. If the recorder grows
   these, the probe can shrink.
