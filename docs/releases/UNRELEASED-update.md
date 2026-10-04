# LCU (unreleased): update command and update notices

**Update LCU with `lcu update`, and learn about new releases.**

## Changes

- **`lcu update`.** Downloads this platform's archive and its `.sha256` for the latest release, verifies it, extracts it and runs its installer with `--runtime-only`, the same prefix and the recorded app (Linux adds `--skip-system`). Falls back to the system `curl` when Python has no CA certificates. It asks on a terminal; without one it requires `--yes` and otherwise exits 2 with instructions. It never downloads or installs the ChatGPT app. If this account cannot write the prefix it prints the `sudo` command instead. The new release then refreshes the user-scope `lcu-approve` mod, so mod fixes arrive with the update. Restart agents afterwards; `lcu prune` reclaims the old release.
- **`lcu update --check [--json]`.** Checks now whether a newer release exists, by following the redirect of `https://github.com/amontlabs/lcu/releases/latest` (no GitHub API; nothing is sent beyond that request) and reading the optional severity marker in that tag's `docs/releases/<version>.md`. Exits 1 on a network error.
- **Update notices.** `lcu update --notice [--json]` is cache-only and never blocks; it refreshes the per-account cache in the background at most every 24 hours (about 1 hour after a failed check). `lcu status` (text and the `update` JSON key) and `lcu doctor` show the cached notice; it never fails `doctor`. For Claude Code, the `lcu-approve` mod runs it at session start: the agent is told to tell the user and offer `lcu update`, and the user sees a toast. For Codex CLI, setup adds an LCU-owned `SessionStart` hook that gives the agent the same notice (not yet observed in a live Codex turn). Pi, Oh My Pi and Hermes have no session hook.
- **Severity markers.** A release's notes may carry `<!-- lcu-severity: security -->` or `<!-- lcu-severity: breaking -->`, which prefixes the notice with "Security update:" or "Breaking update:".
- **Opt out.** `LCU_NO_UPDATE_CHECK=1` disables the background check and notices. Source checkouts never report updates. Offline installs are not recorded; set the variable on machines without network access.

No runtime, tool schema or input behavior changed, and no new tested app pairs are claimed.
