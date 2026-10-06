// The only signal seam for the node tests (SAFETY RULE in .port/BRIEF.md, modelled on
// tests/blackbox/assets/rt/driver.py:send). A process may be signalled only when
//   * this test spawned it itself (we hold its ChildProcess handle, registered with own() right after spawn),
//   * it was started in its own session (detached: true => setsid, so it leads its session and process group),
//   * it still has the identity recorded at spawn time (pid, start time, process group / session),
// and it is signalled only through that handle. Pids are never read from files or listings.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const owned = new Map(); // pid -> identity string recorded at spawn

function identity(pid) {
  const fields = process.platform === 'linux' ? 'pgid=,sid=,lstart=' : 'pgid=,lstart=';
  const done = spawnSync('/bin/ps', ['-o', fields, '-p', String(pid)], { encoding: 'utf8' });
  const text = (done.stdout ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return null;
  const [pgid, ...rest] = text.split(' ');
  if (process.platform === 'linux') assert.equal(rest[0], String(pid), `pid ${pid} does not lead its own session`);
  assert.equal(pgid, String(pid), `pid ${pid} does not lead its own process group/session`);
  return text;
}

const running = (child) => child.exitCode === null && child.signalCode === null;

/** Register a child this test just spawned with {detached: true} (or a HostProcess wrapping one). */
export function own(handle) {
  const child = handle.child ?? handle;
  assert.ok(Number.isInteger(child.pid) && child.pid > 1 && child.pid !== process.pid);
  const recorded = identity(child.pid);
  assert.ok(recorded, `pid ${child.pid} vanished before it could be registered`);
  owned.set(child.pid, recorded);
  return handle;
}

/** Assert the handle still refers to the registered, session-leading process (call before anything may signal it). */
export function verify(handle) {
  const child = handle.child ?? handle;
  if (!running(child)) return false;
  assert.ok(owned.has(child.pid), `pid ${child.pid} was not registered with own()`);
  const now = identity(child.pid);
  if (now === null) return false;
  assert.equal(now, owned.get(child.pid), `pid ${child.pid} changed identity`);
  return true;
}

/** Signal a registered child through its own handle, after verifying it. */
export function send(handle, signal = 'SIGTERM') {
  const child = handle.child ?? handle;
  if (!verify(handle)) return false;
  return child.kill(signal);
}
