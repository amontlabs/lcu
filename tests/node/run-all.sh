#!/bin/sh
# Run the whole tests/node suite with every Node LCU supports: the Node on PATH and the ChatGPT app's own
# (cua_node, execute only).  Usage: tests/node/run-all.sh [extra node --test arguments]
#
#   LCU_TEST_NODES            space-separated Node binaries to use instead of the defaults
#   LCU_TEST_TIMEOUT_MS       per test (default 120000): a stuck test fails instead of waiting forever
#   LCU_TEST_CONCURRENCY      test files run at once (default 4; see below)
#   LCU_TEST_OVERALL_SECONDS  watchdog for one whole run (default 900): the runner we started is terminated, nothing else
#
# Why these settings (the whole-directory hang, 2026-10-05):
#   * `node --test tests/node/` only works on some Node versions (24 treats the directory as a file): the files are
#     passed as a glob expanded here.
#   * A test that fails while it still owns a live child or an open pipe used to keep its test FILE's process alive
#     forever (setup.test.mjs "a held lock blocks reconcile": the assertions ran before the lock holder's stdin was
#     closed; any failure there, e.g. the waiter failing to start when the machine is out of processes or file
#     descriptors under the default 15-way file concurrency, hung the run). Tests now clean up in `finally`, and
#     --test-force-exit makes the runner end a file's process once its tests are done even if a handle leaked.
#   * Every wait in a test is bounded (--test-timeout, plus explicit timeouts on child waits).
#   * Heavy parallelism only costs: macOS launches of fresh scripts/binaries slow down under load and a few timing
#     tests (3 s lifecycle-host client windows) become flaky, so the default concurrency is 4 (about 40 s here).
# Nothing in this script (or the suite) signals a process it did not start.
set -u

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
per_test=${LCU_TEST_TIMEOUT_MS:-120000}
concurrency=${LCU_TEST_CONCURRENCY:-4}
overall=${LCU_TEST_OVERALL_SECONDS:-900}

if [ -n "${LCU_TEST_NODES:-}" ]; then
  nodes=$LCU_TEST_NODES
else
  nodes=
  if path_node=$(command -v node 2>/dev/null); then nodes=$path_node; fi
  for candidate in \
    /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node \
    /usr/lib/chatgpt/resources/cua_node/bin/node \
    /opt/chatgpt/resources/cua_node/bin/node; do
    if [ -x "$candidate" ]; then nodes="$nodes $candidate"; fi
  done
fi
if [ -z "$nodes" ]; then
  echo "run-all.sh: no Node found (set LCU_TEST_NODES)" >&2
  exit 2
fi

status=0
for node in $nodes; do
  echo "=== $node ($("$node" --version)) ===" >&2
  # shellcheck disable=SC2086
  "$node" --test --test-timeout="$per_test" --test-concurrency="$concurrency" --test-force-exit \
    "$root"/tests/node/*.test.mjs "$@" &
  runner=$!
  # The watchdog only ever signals the runner started just above, and only while it is still running.
  (
    waited=0
    while [ "$waited" -lt "$overall" ] && kill -0 "$runner" 2>/dev/null; do sleep 1; waited=$((waited + 1)); done
    if [ "$waited" -ge "$overall" ] && kill -0 "$runner" 2>/dev/null; then
      echo "run-all.sh: $node exceeded ${overall}s: terminating the test runner" >&2
      kill -TERM "$runner" 2>/dev/null
    fi
  ) &
  watchdog=$!
  wait "$runner"
  result=$?
  kill "$watchdog" 2>/dev/null
  wait "$watchdog" 2>/dev/null
  if [ "$result" -ne 0 ]; then
    echo "run-all.sh: $node: FAILED (exit $result)" >&2
    status=1
  else
    echo "run-all.sh: $node: ok" >&2
  fi
done
exit $status
