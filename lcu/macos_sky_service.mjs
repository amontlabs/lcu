// Forward the original Sky service unchanged and relay its original lifecycle
// hook to the signed macOS client through an LCU-owned, short-lived socket.
import {pathToFileURL} from 'node:url';
import {Buffer} from 'node:buffer';

let original;
let controlClient;
let registered = false;
const pendingCleanup = new Map();
let cleanupInFlight;
let controlConnection;
let controlConnecting;
let controlUnavailable = false;
let controlBuffer = Buffer.alloc(0);
const activeContexts = new Map();
const CONTROL_DEADLINE_MS = 40_000;
// The original worker uses its 15s native-control default for status and Stop.
const CONTROL_STATUS_TIMEOUT_SECONDS = 15;
const CONTROL_STOP_TIMEOUT_SECONDS = 15;
// Bound extra original-policy lookups while preserving the full Stop timeout.
const CONTROL_SELECTOR_RESOLUTION_BUDGET_MS = 5_000;
const TURN_METADATA_LIMIT = 128;
// The original node_repl host waits only 5 s for turn-ended handlers and then
// fails the turn. Return before that; slower cleanup continues in the
// background and finishPendingCleanup() gates the next Sky request on it.
const TURN_CLEANUP_HOOK_TIMEOUT_MS = 4_000;
const TURN_ENDED_TIMEOUT_SECONDS = 15;
const turnMetadata = new Map();

function lifetimeSignal(runtime, session_id, turn_id) {
  const address = runtime.env.LCU_MAC_LIFETIME_SOCKET;
  if (!address || typeof runtime.nativePipe?.createConnection !== 'function') {
    throw Error('Original macOS native-pipe lifetime channel is unavailable');
  }
  return runtime.nativePipe.createConnection(address).then(socket => new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    let finished = false;
    const timer = setTimeout(() => finish(Error('macOS native turn cleanup timed out')), 4000);
    function finish(error, result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.end();
      if (error) reject(error); else resolve(result);
    }
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      if (data.length > 4096) return finish(Error('macOS native cleanup response is too large'));
      const newline = data.indexOf(10);
      if (newline < 0) return;
      try {
        const result = JSON.parse(data.subarray(0, newline).toString('utf8'));
        if (!result || result.notified !== true) {
          throw Error(result?.error || 'Original macOS turn-ended command failed');
        }
        finish(null, true);
      } catch (error) { finish(error); }
    });
    socket.on('error', error => finish(error));
    socket.on('close', () => finish(Error('macOS native cleanup channel closed')));
    socket.write(Buffer.from(JSON.stringify({session_id, turn_id}) + '\n'));
  }));
}

const NATIVE_PIPE_FAILURE = /native pipe startup failed/i;
// Upper bound on what a failed request waits for the host's recovery attempt: the host
// bounds its own checks and the service's exit to under this.
const RECOVER_TIMEOUT_MS = 15_000;
let recovering;

// Ask the private host to recover from a stale Computer Use service. It stops one only
// when it proves that service is stale, holds the connection and is ours to stop; it
// answers `recovered: true` once that service has exited. Resolves to true only then.
// Never rejects, and never waits longer than RECOVER_TIMEOUT_MS.
function askHostToRecover(runtime) {
  const address = runtime?.env?.LCU_MAC_LIFETIME_SOCKET;
  if (!address || typeof runtime.nativePipe?.createConnection !== 'function') {
    return Promise.resolve(false);
  }
  // A shorter bound may be configured (tests); the wait never exceeds RECOVER_TIMEOUT_MS.
  const configured = Number(runtime.env.LCU_MAC_RECOVER_TIMEOUT_MS);
  const timeoutMs = configured > 0 ? Math.min(configured, RECOVER_TIMEOUT_MS) : RECOVER_TIMEOUT_MS;
  return new Promise(resolve => {
    let socket;
    let finished = false;
    let data = Buffer.alloc(0);
    const timer = setTimeout(() => finish(false), timeoutMs);
    function finish(recovered) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { socket?.end(); } catch {}
      resolve(recovered === true);
    }
    Promise.resolve().then(() => runtime.nativePipe.createConnection(address)).then(connection => {
      if (finished) {
        try { connection.end(); } catch {}
        return;
      }
      socket = connection;
      socket.on('data', chunk => {
        data = Buffer.concat([data, Buffer.from(chunk)]);
        if (data.length > 65536) return finish(false);
        const newline = data.indexOf(10);
        if (newline < 0) return;
        try {
          const result = JSON.parse(data.subarray(0, newline).toString('utf8'));
          finish(result?.ok === true && result.recovered === true);
        } catch { finish(false); }
      });
      socket.on('error', () => finish(false));
      socket.on('close', () => finish(false));
      socket.write(Buffer.from(JSON.stringify({type: 'recover'}) + '\n'));
    }).catch(() => finish(false));
  });
}

// One recovery at a time: concurrent failures share it.
function recoverOnce(runtime) {
  recovering ??= askHostToRecover(runtime).finally(() => { recovering = undefined; });
  return recovering;
}

// Run `attempt`. When it fails with a native pipe startup failure and the host recovered
// from a provably stale service, run it once more. In every other case the original error
// is thrown unchanged, and a failure of the single retry is the retry's own error.
async function withStaleServiceRecovery(runtime, attempt) {
  try {
    return await attempt();
  } catch (error) {
    let recovered = false;
    try {
      recovered = typeof error?.message === 'string' && NATIVE_PIPE_FAILURE.test(error.message) &&
        await recoverOnce(runtime);
    } catch {}
    if (!recovered) throw error;
  }
  return attempt();
}

function register() {
  if (registered) return;
  const runtime = globalThis.nodeRepl;
  if (typeof runtime?.addTurnEndedHandler !== 'function') {
    throw Error('Original node_repl turn-ended hook is unavailable');
  }
  runtime.addTurnEndedHandler({timeoutMs: TURN_CLEANUP_HOOK_TIMEOUT_MS, run: async ({session_id, turn_id}) => {
    if (typeof session_id !== 'string' || !session_id.trim() ||
        typeof turn_id !== 'string' || !turn_id.trim()) {
      throw Error('Original node_repl turn IDs are missing');
    }
    endControlTurn(session_id, turn_id);
    const key = JSON.stringify([session_id, turn_id]);
    const prior = pendingCleanup.get(key);
    pendingCleanup.set(key, prior ?? {
      session_id, turn_id,
      metadata: turnMetadata.get(key),
      nativeNotified: false,
      cliNotified: false,
    });
    turnMetadata.delete(key);
    await finishPendingCleanup();
  }});
  registered = true;
}

function readTurnMetadata(runtime) {
  try {
    const raw = runtime.requestMeta?.['x-codex-turn-metadata'];
    let metadata = raw;
    if (raw instanceof Uint8Array) metadata = JSON.parse(Buffer.from(raw).toString('utf8'));
    if (typeof raw === 'string') metadata = JSON.parse(raw);
    if (!metadata || typeof metadata !== 'object' ||
        typeof metadata.session_id !== 'string' || !metadata.session_id.trim() ||
        typeof metadata.turn_id !== 'string' || !metadata.turn_id.trim()) return undefined;
    return JSON.parse(JSON.stringify(metadata));
  } catch { return undefined; }
}

function writeControl(message) {
  if (!controlConnection) return;
  controlConnection.write(Buffer.from(JSON.stringify(message) + '\n'));
}

function controlContext(runtime, request) {
  try {
    const metadata = readTurnMetadata(runtime);
    if (!metadata) return undefined;
    let app;
    if (request?.type === 'execute' && Array.isArray(request.args)) {
      const argument = request.args[0];
      if (typeof argument === 'string' && request.method === 'get_app_state') app = argument;
      else if (argument && typeof argument.app === 'string') app = argument.app;
    }
    return {metadata, session_id: metadata.session_id, turn_id: metadata.turn_id, app};
  } catch { return undefined; }
}

function endControlTurn(session_id, turn_id) {
  for (const [token, item] of activeContexts) {
    if (item.session_id === session_id && item.turn_id === turn_id) {
      activeContexts.delete(token);
      writeControl({type: 'context-ended', token});
    }
  }
}

async function invokeOriginalControl(request, context) {
  const matches = [...activeContexts.values()].filter(item =>
    item.session_id === request.session_id && item.turn_id === request.turn_id);
  if (!context || !matches.length || !matches.some(item => item.metadata === context.metadata)) {
    throw Error('The requested session and turn are not active in the trusted Sky runtime');
  }
  if (request.type !== 'status' && request.type !== 'stop') {
    throw Error('Unsupported original macOS control request');
  }
  const deadline = request.deadline_unix_ms;
  if (!Number.isSafeInteger(deadline) || deadline <= Date.now() ||
      deadline > Date.now() + CONTROL_DEADLINE_MS) {
    throw Error('The macOS control request has an invalid or expired deadline');
  }
  const reserveAfterStatusMs = CONTROL_SELECTOR_RESOLUTION_BUDGET_MS +
    (request.type === 'stop' ? CONTROL_STOP_TIMEOUT_SECONDS * 1000 : 0);
  const initialBudgetMs = deadline - Date.now();
  if (initialBudgetMs <= reserveAfterStatusMs) {
    throw Error('The macOS control request expired before its status check could begin');
  }
  const {MacComputerUseClient} = await import(pathToFileURL(
    globalThis.nodeRepl.env.LCU_MAC_SKY_CLIENT_PATH).href);
  controlClient ??= new MacComputerUseClient();
  const metadata = context.metadata;
  const options = {codexMetadata: metadata,
    timeoutSeconds: Math.min(CONTROL_STATUS_TIMEOUT_SECONDS,
      Math.floor((initialBudgetMs - reserveAfterStatusMs) / 1000))};
  const status = await controlClient.request(
    'ComputerUseIPCCodexStatusItemMenuStateRequest', {}, options);
  const activeApplications = status?.computerUse?.activeApplications;
  if (!Array.isArray(activeApplications) || activeApplications.some(app =>
      !app || typeof app.bundleIdentifier !== 'string')) {
    throw Error('Original macOS status returned an invalid active application list');
  }
  const targetedApps = new Map();
  const resolutionDeadline = Math.min(deadline -
    (request.type === 'stop' ? CONTROL_STOP_TIMEOUT_SECONDS * 1000 : 0),
  Date.now() + CONTROL_SELECTOR_RESOLUTION_BUDGET_MS);
  for (const item of matches) {
    if (!item.app) continue;
    if (activeApplications.some(app => app.bundleIdentifier === item.app)) {
      targetedApps.set(item, item.app);
      continue;
    }
    const remainingSeconds = Math.floor((resolutionDeadline - Date.now()) / 1000);
    if (remainingSeconds <= 0) break;
    try {
      const policy = await controlClient.getAppPolicy(item.app, {
        codexMetadata: item.metadata,
        timeoutSeconds: Math.min(CONTROL_STATUS_TIMEOUT_SECONDS, remainingSeconds),
      });
      const bundleIdentifier = policy?.target?.bundleIdentifier;
      if (policy?.decision === 'allowed' &&
          typeof bundleIdentifier === 'string' && bundleIdentifier.trim()) {
        targetedApps.set(item, bundleIdentifier);
      }
    } catch {}
  }
  const targetBundleIdentifiers = new Set(targetedApps.values());
  const visibleApplications = activeApplications.filter(app =>
    targetBundleIdentifiers.has(app.bundleIdentifier));
  if (request.type === 'status') return {computerUse: {
    ...status.computerUse, activeApplications: visibleApplications},
    computerHistory: status.computerHistory};
  if (typeof request.app !== 'string' ||
      !targetBundleIdentifiers.has(request.app) ||
      !visibleApplications.some(app => app.bundleIdentifier === request.app)) {
    throw Error('The selected application is not targeted by an active original computer-use call');
  }
  const selectedApp = visibleApplications.find(app => app.bundleIdentifier === request.app);
  if (typeof selectedApp?.id !== 'string' || !selectedApp.id.trim()) {
    throw Error('Original macOS status did not provide the selected application ID');
  }
  const selectedContext = matches.find(item => targetedApps.get(item) === request.app &&
    activeContexts.get(JSON.stringify([item.session_id, item.turn_id, item.app])) === item);
  if (!selectedContext) {
    throw Error('The original LCU turn ended before Stop could be sent');
  }
  const remainingSeconds = Math.floor((deadline - Date.now()) / 1000);
  if (remainingSeconds < 1) {
    throw Error('The macOS Stop request expired before the original Stop could be sent');
  }
  await controlClient.request('ComputerUseIPCAppStopRequest', {app: selectedApp.id}, {
    codexMetadata: selectedContext.metadata,
    timeoutSeconds: Math.min(CONTROL_STOP_TIMEOUT_SECONDS, remainingSeconds),
  });
  return {accepted: true, applicationId: request.app};
}

async function processControlRequest(request) {
  let response;
  try {
    response = {ok: true, result: await invokeOriginalControl(request,
      [...activeContexts.values()].find(item => item.session_id === request.session_id &&
        item.turn_id === request.turn_id))};
  } catch (error) {
    response = {ok: false, error: String(error?.message ?? error).slice(0, 512)};
  }
  writeControl({type: 'result', request_id: request.request_id, response});
}

function startControlChannel(runtime) {
  const address = runtime.env.LCU_MAC_CONTROL_SOCKET;
  if (!address || typeof runtime.nativePipe?.createConnection !== 'function') {
    return Promise.resolve(false);
  }
  if (controlUnavailable) return Promise.resolve(false);
  if (controlConnection) return Promise.resolve(true);
  if (controlConnecting) return controlConnecting;
  const connecting = Promise.resolve().then(() => runtime.nativePipe.createConnection(address));
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('macOS control connection timed out')), 2000);
  });
  controlConnecting = Promise.race([connecting, deadline]).then(connection => {
    clearTimeout(timer);
    controlConnection = connection;
    controlBuffer = Buffer.alloc(0);
    connection.on('data', chunk => {
      controlBuffer = Buffer.concat([controlBuffer, Buffer.from(chunk)]);
      if (controlBuffer.length > 65536) {
        connection.end();
        controlConnection = undefined;
        return;
      }
      for (;;) {
        const newline = controlBuffer.indexOf(10);
        if (newline < 0) break;
        const line = controlBuffer.subarray(0, newline);
        controlBuffer = controlBuffer.subarray(newline + 1);
        try { void processControlRequest(JSON.parse(line.toString('utf8'))); }
        catch (error) { console.error(`LCU macOS control request failed: ${error}`); }
      }
    });
    connection.on('error', () => {
      if (controlConnection === connection) {
        controlConnection = undefined;
        activeContexts.clear();
        controlBuffer = Buffer.alloc(0);
      }
    });
    connection.on('close', () => {
      if (controlConnection === connection) {
        controlConnection = undefined;
        activeContexts.clear();
        controlBuffer = Buffer.alloc(0);
      }
    });
    writeControl({type: 'service'});
    return true;
  }).catch(error => {
    clearTimeout(timer);
    controlUnavailable = true;
    connecting.then(connection => connection.end(), () => {});
    console.error(`LCU macOS control channel unavailable: ${error}`);
    return false;
  }).finally(() => { controlConnecting = undefined; });
  return controlConnecting;
}

const SLOW_CLEANUP_STEP_MS = 1_000;

// Report which cleanup step is slow so a host "turn-ended handlers timed out"
// can be attributed to native IPC or the CLI helper.
async function timedCleanupStep(step, run) {
  const started = Date.now();
  // The host gives up on the hook at about 5 s, so name a step still running then.
  const watchdog = setTimeout(() => {
    console.error(`LCU macOS turn cleanup step "${step}" is still running after ${Date.now() - started} ms`);
  }, TURN_CLEANUP_HOOK_TIMEOUT_MS);
  try {
    return await run();
  } finally {
    clearTimeout(watchdog);
    const ms = Date.now() - started;
    if (ms >= SLOW_CLEANUP_STEP_MS) {
      console.error(`LCU macOS turn cleanup step "${step}" took ${ms} ms`);
    }
  }
}

function finishPendingCleanup() {
  // The original runtime can report MCP success after a hook fails. Retain
  // native cleanup until its host acknowledges it and retry before more actions.
  if (!cleanupInFlight) {
    cleanupInFlight = (async () => {
      for (const [key, item] of pendingCleanup) {
        if (item.metadata && !item.nativeNotified) {
          await timedCleanupStep('native IPC turn-ended', async () => {
            // Include the first, cold import of the client in the step's timing.
            const {MacComputerUseClient} = await import(pathToFileURL(
              globalThis.nodeRepl.env.LCU_MAC_SKY_CLIENT_PATH).href);
            controlClient ??= new MacComputerUseClient();
            return controlClient.request('ComputerUseIPCCodexTurnEndedRequest', {
              threadID: item.session_id,
              turnID: item.turn_id,
            }, {codexMetadata: item.metadata, timeoutSeconds: TURN_ENDED_TIMEOUT_SECONDS});
          });
          item.nativeNotified = true;
        }
        if (!item.cliNotified) {
          await timedCleanupStep('CLI turn-ended', () =>
            lifetimeSignal(globalThis.nodeRepl, item.session_id, item.turn_id));
          item.cliNotified = true;
        }
        pendingCleanup.delete(key);
      }
    })().finally(() => { cleanupInFlight = undefined; });
  }
  return cleanupInFlight;
}

export async function handleRpc(request) {
  register();
  // Retried turn cleanup talks to the same native pipe and fails the same way.
  await withStaleServiceRecovery(globalThis.nodeRepl, finishPendingCleanup);
  original ??= import(pathToFileURL(globalThis.nodeRepl.env.LCU_MAC_SKY_SERVICE_PATH).href);
  const runtime = globalThis.nodeRepl;
  const metadata = readTurnMetadata(runtime);
  if (metadata) {
    const key = JSON.stringify([metadata.session_id, metadata.turn_id]);
    if (!turnMetadata.has(key) && turnMetadata.size >= TURN_METADATA_LIMIT) {
      throw Error('Too many active macOS turn metadata contexts; refusing a new Sky request until turn cleanup completes');
    }
    turnMetadata.set(key, metadata);
  }
  const context = controlContext(runtime, request);
  const controlReady = await startControlChannel(runtime);
  if (context && controlReady) {
    const token = JSON.stringify([context.session_id, context.turn_id, context.app]);
    if (context.app && (activeContexts.has(token) || activeContexts.size < 128)) {
      activeContexts.set(token, context);
      writeControl({type: 'context', token, session_id: context.session_id,
        turn_id: context.turn_id, app: context.app});
    }
  }
  const service = await original;
  return withStaleServiceRecovery(runtime, () => service.handleRpc(request));
}
