import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createConnection, createServer} from 'node:net';
import {pathToFileURL} from 'node:url';

const root = await mkdtemp(join(tmpdir(), 'lcu-macos-control-'));
const controlPath = join(root, 'control.sock');
const lifetimePath = join(root, 'lifetime.sock');
const servicePath = join(root, 'original-service.mjs');
const clientPath = join(root, 'original-client.mjs');
const wrapperPath = new URL('../lcu/macos_sky_service.mjs', import.meta.url);
const metadata = {session_id: 'session-fixture', turn_id: 'turn-fixture', call_id: 'call-fixture'};
const originalMetadata = {...metadata};
const sessionId = metadata.session_id;
const turnId = metadata.turn_id;
const calls = [];
const policyCalls = [];
let completeAction;
let turnEnded;
let serviceSocket;
let failTurnEndedOnce = false;
const pending = new Map();
const observedContexts = [];
const lifetimeMessages = [];
let lifetimeReplies = 0;
// Decides how the private lifetime host answers: {notified, error?, hold?}, where
// hold is a promise the reply waits for.
let lifetimeBehavior = () => ({notified: true});

await writeFile(servicePath, `export async function handleRpc(request) {
  globalThis.originalRpcCount = (globalThis.originalRpcCount || 0) + 1;
  if (request.wait) return new Promise(resolve => { globalThis.completeAction = resolve; });
  return {ok: true};
}\n`);
await writeFile(clientPath, `export class MacComputerUseClient {
  async getAppPolicy(selector, options) {
    globalThis.policyCalls.push({selector, metadata: options.codexMetadata,
      timeoutSeconds: options.timeoutSeconds});
    const bundleIdentifier = ({
      'com.fixture.A': 'com.fixture.A',
      'Fixture A': 'com.fixture.A',
      '/Applications/Fixture A.app': 'com.fixture.A',
      'Fixture Denied': 'com.fixture.B',
      'Fixture B': 'com.fixture.B',
    })[selector];
    if (!bundleIdentifier) throw new Error('unknown app selector');
    return {decision:selector === 'Fixture Denied' ? 'denied' : 'allowed',
      target:{bundleIdentifier, appPath:'/Applications/Fixture.app',
      displayName:selector, risk:'low'}};
  }
  async request(requestType, payload, options) {
    globalThis.calls.push({requestType, payload, metadata: options.codexMetadata,
      timeoutSeconds: options.timeoutSeconds});
    if (requestType === 'ComputerUseIPCCodexTurnEndedRequest' && globalThis.turnEndedGate) {
      await globalThis.turnEndedGate;
    }
    if (requestType === 'ComputerUseIPCCodexTurnEndedRequest' && globalThis.failTurnEndedOnce) {
      globalThis.failTurnEndedOnce = false;
      throw new Error('fixture native turn-ended failure');
    }
    if (requestType === 'ComputerUseIPCCodexStatusItemMenuStateRequest') {
      if (globalThis.statusGate) await globalThis.statusGate;
      return {
      computerUse: {activeApplications: [
        {id:'/Applications/Fixture A.app', name:'Fixture A', bundleIdentifier:'com.fixture.A', bundleURL:'file:///Applications/Fixture%20A.app'},
        {id:'/Applications/Fixture B.app', name:'Fixture B', bundleIdentifier:'com.fixture.B', bundleURL:'file:///Applications/Fixture%20B.app'},
      ]}, computerHistory: {state:'stopped'},
      };
    }
  }
}\n`);

function consumeLines(socket, callback) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      callback(JSON.parse(line));
    }
  });
}

const controlServer = createServer(socket => consumeLines(socket, message => {
  if (message.type === 'service') {
    serviceSocket = socket;
    return;
  }
  if (socket === serviceSocket) {
    if (message.type === 'context') observedContexts.push(message);
    if (message.type !== 'result') return;
    pending.get(message.request_id)?.end(`${JSON.stringify(message.response)}\n`);
    pending.delete(message.request_id);
    return;
  }
  pending.set(message.request_id, socket);
  serviceSocket?.write(`${JSON.stringify(message)}\n`);
}));
const lifetimeServer = createServer(socket => consumeLines(socket, message => {
  lifetimeMessages.push(message);
  const {hold, ...reply} = lifetimeBehavior(message);
  Promise.resolve(hold).then(() => {
    lifetimeReplies += 1;
    socket.end(`${JSON.stringify(reply)}\n`);
  });
}));

function listen(server, path) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
}

function connect(path) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path, () => resolve(socket));
    socket.once('error', reject);
  });
}

function control(request) {
  return new Promise(async (resolve, reject) => {
    const socket = await connect(controlPath);
    consumeLines(socket, resolve);
    socket.once('error', reject);
    socket.write(`${JSON.stringify({deadline_unix_ms: Date.now() + 40000, ...request})}\n`);
  });
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

try {
  await Promise.all([listen(controlServer, controlPath), listen(lifetimeServer, lifetimePath)]);
  globalThis.calls = calls;
  globalThis.policyCalls = policyCalls;
  globalThis.failTurnEndedOnce = false;
  globalThis.originalRpcCount = 0;
  globalThis.nodeRepl = {
    env: {LCU_MAC_CONTROL_SOCKET: controlPath,
      LCU_MAC_LIFETIME_SOCKET: lifetimePath,
      LCU_MAC_SKY_SERVICE_PATH: servicePath, LCU_MAC_SKY_CLIENT_PATH: clientPath},
    requestMeta: {'x-codex-turn-metadata': metadata},
    nativePipe: {createConnection: connect},
    addTurnEndedHandler: handler => { turnEnded = handler; },
  };
  const {handleRpc, LIFETIME_SIGNAL_TIMEOUT_MS} = await import(
    pathToFileURL(new URL(wrapperPath).pathname).href);
  const action = handleRpc({type: 'execute', method: 'click',
    args: [{app: 'com.fixture.A'}], wait: true});
  await waitFor(() => Boolean(turnEnded), 'original turn-ended hook was not registered');
  // The original host gives all turn-ended handlers 5 s, so ours must return sooner;
  // slower cleanup stays pending and is retried before the next Sky request.
  assert.ok(turnEnded.timeoutMs > 0 && turnEnded.timeoutMs <= 4_000);
  assert.ok(turnEnded.timeoutMs < 5_000);
  // The JS wait for the private lifetime host must outlast the host's own limit.
  const hostSource = await readFile(new URL('../lcu/macos_host.mjs', import.meta.url), 'utf8');
  const hostTimeoutSeconds = Number(
    hostSource.match(/^export const TURN_ENDED_CLI_TIMEOUT_SECONDS = (\d+);$/m)?.[1]);
  assert.ok(hostTimeoutSeconds >= 6, 'the host must outlast the helper\'s ~5.2 s run');
  assert.equal(LIFETIME_SIGNAL_TIMEOUT_MS, hostTimeoutSeconds * 1000 + 2000);
  await waitFor(() => observedContexts.some(context => context.app === 'com.fixture.A'),
    'trusted service did not publish the current app context');
  metadata.turn_id = 'mutated-after-dispatch';

  const status = await control({type: 'status', session_id: sessionId, turn_id: turnId});
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.deepEqual(status.result.computerUse.activeApplications.map(app => app.bundleIdentifier),
    ['com.fixture.A']);
  const foreign = await control({type: 'stop', session_id: 'other-session',
    turn_id: turnId, app: 'com.fixture.A'});
  assert.equal(foreign.ok, false);
  const unobserved = await control({type: 'stop', session_id: sessionId,
    turn_id: turnId, app: 'com.fixture.B'});
  assert.equal(unobserved.ok, false);
  assert.equal(calls.some(call => call.requestType === 'ComputerUseIPCAppStopRequest'), false);

  // Original Mac policy resolves aliases and app paths to its canonical ID.
  // Keep three selector forms active in one turn and require status to expose
  // only the original resolved bundle ID.
  const aliases = [
    ['Fixture A', 'alias-call'],
    ['/Applications/Fixture A.app', 'path-call'],
  ];
  for (const [selector, callId] of aliases) {
    globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': {
      ...originalMetadata, call_id: callId,
    }};
    await handleRpc({type: 'execute', method: 'click', args: [{app: selector}]});
  }
  const aliasStatus = await control({type: 'status', session_id: sessionId, turn_id: turnId});
  assert.equal(aliasStatus.ok, true, JSON.stringify(aliasStatus));
  assert.deepEqual(aliasStatus.result.computerUse.activeApplications.map(app => app.bundleIdentifier),
    ['com.fixture.A']);
  assert.deepEqual(policyCalls.map(call => call.selector), [
    'Fixture A', '/Applications/Fixture A.app',
  ]);
  assert.ok(policyCalls.every(call => call.timeoutSeconds > 0 && call.timeoutSeconds <= 5));
  assert.equal(calls.find(call =>
    call.requestType === 'ComputerUseIPCCodexStatusItemMenuStateRequest').timeoutSeconds, 15);

  const stop = await control({type: 'stop', session_id: sessionId,
    turn_id: turnId, app: 'com.fixture.A'});
  assert.deepEqual(stop, {ok: true, result: {accepted: true, applicationId: 'com.fixture.A'}});
  const stopCall = calls.find(call => call.requestType === 'ComputerUseIPCAppStopRequest');
  assert.deepEqual(stopCall, {requestType: 'ComputerUseIPCAppStopRequest',
    payload: {app: '/Applications/Fixture A.app'}, metadata: originalMetadata, timeoutSeconds: 15});

  globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': {
    session_id: sessionId, turn_id: turnId, call_id: 'denied-call',
  }};
  await handleRpc({type: 'execute', method: 'click', args: [{app: 'Fixture Denied'}]});
  const deniedStop = await control({type: 'stop', session_id: sessionId,
    turn_id: turnId, app: 'com.fixture.B'});
  assert.equal(deniedStop.ok, false);
  assert.match(deniedStop.error, /not targeted/);
  assert.equal(calls.filter(call => call.requestType === 'ComputerUseIPCAppStopRequest').length, 1);

  // The app selected for Stop determines the metadata sent with AppStop even
  // when this turn has several active app contexts.
  globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': {
    session_id: sessionId, turn_id: turnId, call_id: 'call-fixture-B',
  }};
  await handleRpc({type: 'execute', method: 'click', args: [{app: 'Fixture B'}]});
  const stopB = await control({type: 'stop', session_id: sessionId,
    turn_id: turnId, app: 'com.fixture.B'});
  assert.equal(stopB.ok, true, JSON.stringify(stopB));
  const stopBCall = calls.filter(call => call.requestType === 'ComputerUseIPCAppStopRequest').at(-1);
  assert.equal(stopBCall.payload.app, '/Applications/Fixture B.app');
  assert.equal(stopBCall.metadata.call_id, 'call-fixture-B');

  completeAction = globalThis.completeAction;
  completeAction({ok: true});
  await action;
  const betweenCalls = await control({type: 'stop', session_id: sessionId,
    turn_id: turnId, app: 'com.fixture.A'});
  assert.equal(betweenCalls.ok, true, JSON.stringify(betweenCalls));

  const priorStopCount = calls.filter(call => call.requestType === 'ComputerUseIPCAppStopRequest').length;
  globalThis.statusGate = new Promise(resolve => { globalThis.releaseStatus = resolve; });
  const deferredStop = control({type: 'stop', session_id: sessionId,
    turn_id: turnId, app: 'com.fixture.A'});
  await waitFor(() => calls.filter(call =>
    call.requestType === 'ComputerUseIPCCodexStatusItemMenuStateRequest').length >= 4,
  'deferred original status request did not start');
  await turnEnded.run({session_id: sessionId, turn_id: turnId});
  globalThis.releaseStatus();
  globalThis.statusGate = undefined;
  const stoppedAfterEnd = await deferredStop;
  assert.equal(stoppedAfterEnd.ok, false);
  assert.equal(calls.filter(call => call.requestType === 'ComputerUseIPCAppStopRequest').length,
    priorStopCount);
  const ended = await control({type: 'status', session_id: sessionId, turn_id: turnId});
  assert.equal(ended.ok, false);
  const nativeEnded = calls.find(call =>
    call.requestType === 'ComputerUseIPCCodexTurnEndedRequest');
  assert.deepEqual(nativeEnded, {requestType: 'ComputerUseIPCCodexTurnEndedRequest',
    payload: {threadID: sessionId, turnID: turnId},
    metadata: {session_id: sessionId, turn_id: turnId, call_id: 'call-fixture-B'},
    timeoutSeconds: 15});
  assert.deepEqual(lifetimeMessages, [{session_id: sessionId, turn_id: turnId}]);

  const oldServiceSocket = serviceSocket;
  let oldServiceClosed = false;
  oldServiceSocket.once('close', () => { oldServiceClosed = true; });
  await new Promise(resolve => oldServiceSocket.write('{"type":"status"', resolve));
  await new Promise(resolve => setTimeout(resolve, 10));
  oldServiceSocket.destroy();
  await waitFor(() => oldServiceClosed, 'old trusted service connection did not close');
  const nextMetadata = {session_id: 'next-session', turn_id: 'next-turn'};
  globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': nextMetadata};
  await handleRpc({type: 'execute', method: 'click', args: [{app: 'com.fixture.B'}]});
  await waitFor(() => serviceSocket && serviceSocket !== oldServiceSocket &&
    observedContexts.some(context => context.app === 'com.fixture.B'),
  'trusted control connection did not reconnect with a new app context');
  const reconnected = await control({type: 'status', session_id: 'next-session', turn_id: 'next-turn'});
  assert.equal(reconnected.ok, true, JSON.stringify(reconnected));
  assert.deepEqual(reconnected.result.computerUse.activeApplications.map(app => app.bundleIdentifier),
    ['com.fixture.B']);

  globalThis.failTurnEndedOnce = true;
  const lifetimeCountBeforeFailure = lifetimeMessages.length;
  await assert.rejects(turnEnded.run({session_id: 'next-session', turn_id: 'next-turn'}),
    /fixture native turn-ended failure/);
  assert.equal(lifetimeMessages.length, lifetimeCountBeforeFailure,
    'CLI cleanup must wait for the native turn-ended acknowledgement');
  globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': {
    session_id: 'after-cleanup', turn_id: 'after-cleanup-turn', call_id: 'fresh-call',
  }};
  assert.deepEqual(await handleRpc({type: 'execute', method: 'list_apps', args: []}), {ok: true});
  const retryNativeEnded = calls.filter(call =>
    call.requestType === 'ComputerUseIPCCodexTurnEndedRequest').slice(-2);
  assert.deepEqual(retryNativeEnded.map(call => call.payload), [
    {threadID: 'next-session', turnID: 'next-turn'},
    {threadID: 'next-session', turnID: 'next-turn'},
  ]);
  assert.deepEqual(retryNativeEnded.map(call => call.metadata), [nextMetadata, nextMetadata]);
  assert.deepEqual(lifetimeMessages.at(-1), {session_id: 'next-session', turn_id: 'next-turn'});

  // The original host stops waiting for the hook after its own limit (here:
  // we simply do not await it). Slow native cleanup must keep running, finish
  // both steps, and hold back the next Sky request until it does.
  const slowMetadata = {session_id: 'slow-session', turn_id: 'slow-turn', call_id: 'slow-call'};
  globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': slowMetadata};
  await handleRpc({type: 'execute', method: 'list_apps', args: []});
  globalThis.turnEndedGate = new Promise(resolve => { globalThis.releaseTurnEnded = resolve; });
  const slowLifetimeCount = lifetimeMessages.length;
  const abandoned = turnEnded.run({session_id: slowMetadata.session_id, turn_id: slowMetadata.turn_id});
  globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': {
    session_id: 'after-slow', turn_id: 'after-slow-turn', call_id: 'after-slow-call'}};
  const rpcCountBeforeSlow = globalThis.originalRpcCount;
  let nextDispatched = false;
  // Emulate the original worker's lifecycle race: the hook gets its registered
  // timeoutMs, after which the host moves on while cleanup keeps running.
  const outcome = await Promise.race([
    abandoned.then(() => 'finished'),
    new Promise(resolve => setTimeout(() => resolve('expired'), turnEnded.timeoutMs)),
  ]);
  assert.equal(outcome, 'expired', 'the gated native cleanup must outlast the hook budget');
  const next = handleRpc({type: 'execute', method: 'list_apps', args: []}).then(() => { nextDispatched = true; });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(nextDispatched, false, 'a Sky request must wait for pending turn cleanup');
  assert.equal(globalThis.originalRpcCount, rpcCountBeforeSlow);
  assert.equal(lifetimeMessages.length, slowLifetimeCount, 'CLI cleanup must wait for native cleanup');
  globalThis.releaseTurnEnded();
  globalThis.turnEndedGate = undefined;
  await abandoned;
  await next;
  assert.deepEqual(lifetimeMessages.at(-1), {session_id: 'slow-session', turn_id: 'slow-turn'});
  assert.equal(globalThis.originalRpcCount, rpcCountBeforeSlow + 1);
  await turnEnded.run({session_id: 'after-slow', turn_id: 'after-slow-turn'});

  // The original CLI command is not the gate for native cleanup: a failing or
  // slow one must never fail a Sky request or stop another turn's cleanup.
  const originalConsoleError = console.error;
  const stderr = [];
  console.error = (...args) => { stderr.push(args.join(' ')); };
  try {
    const withoutMetadata = () => { globalThis.nodeRepl.requestMeta = {}; };
    const countFor = session => lifetimeMessages.filter(message => message.session_id === session).length;
    const startTurn = async name => {
      const turn = {session_id: `${name}-session`, turn_id: `${name}-turn`, call_id: `${name}-call`};
      globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': turn};
      await handleRpc({type: 'execute', method: 'list_apps', args: []});
      return turn;
    };
    const endTurn = turn => turnEnded.run({session_id: turn.session_id, turn_id: turn.turn_id});
    lifetimeBehavior = message => message.session_id === 'cli-fail-session'
      ? {notified: false, error: 'fixture CLI failure'} : {notified: true};
    const failTurn = await startTurn('cli-fail');
    const okTurn = await startTurn('cli-ok');
    const thirdTurn = await startTurn('cli-third');
    const cliLifetimeStart = lifetimeMessages.length;
    globalThis.turnEndedGate = new Promise(resolve => { globalThis.releaseTurnEnded = resolve; });
    const cliHooks = [endTurn(failTurn), endTurn(okTurn)];
    globalThis.releaseTurnEnded();
    globalThis.turnEndedGate = undefined;
    // A CLI failure is not a hook failure: the native step was acknowledged.
    await Promise.all(cliHooks);
    await waitFor(() => lifetimeMessages.length >= cliLifetimeStart + 2,
      'the failing turn must not stop cleanup of the next one');
    await waitFor(() => stderr.some(line => /failed for cli-fail-session\/cli-fail-turn after \d+ ms.*retrying once/.test(line)),
      'the first CLI failure was not recorded');
    assert.equal(countFor('cli-fail-session'), 1);
    assert.equal(countFor('cli-ok-session'), 1);
    // Another turn ending runs its own background cleanup but must not spend the
    // failed command's retry, which belongs to the next Sky request.
    await endTurn(thirdTurn);
    await waitFor(() => countFor('cli-third-session') === 1, 'the next turn was not cleaned up');
    assert.equal(countFor('cli-fail-session'), 1);
    // The next Sky request retries once; the failure drops the item without failing it.
    withoutMetadata();
    const rpcBeforeRetry = globalThis.originalRpcCount;
    assert.deepEqual(await handleRpc({type: 'execute', method: 'list_apps', args: []}), {ok: true});
    assert.equal(globalThis.originalRpcCount, rpcBeforeRetry + 1);
    assert.equal(countFor('cli-fail-session'), 2);
    assert.equal(countFor('cli-ok-session'), 1);
    assert.equal(stderr.filter(line => /failed for cli-fail-session\/cli-fail-turn after \d+ ms; native turn-ended was acknowledged; continuing$/.test(line)).length, 1);
    // The following request dispatches without retrying again.
    const lifetimeAfterDrop = lifetimeMessages.length;
    assert.deepEqual(await handleRpc({type: 'execute', method: 'list_apps', args: []}), {ok: true});
    assert.equal(lifetimeMessages.length, lifetimeAfterDrop);
    assert.equal(globalThis.originalRpcCount, rpcBeforeRetry + 2);

    // The hook only waits for native cleanup. A slow CLI command finishes in the
    // background and holds back the next Sky request until it is done.
    let releaseLifetime;
    lifetimeBehavior = () => ({notified: true,
      hold: new Promise(resolve => { releaseLifetime = resolve; })});
    const lateTurn = await startTurn('cli-late');
    const repliesBeforeLate = lifetimeReplies;
    await endTurn(lateTurn);
    await waitFor(() => countFor('cli-late-session') === 1, 'the CLI command was not started in the background');
    assert.equal(lifetimeReplies, repliesBeforeLate, 'the hook must not wait for the CLI command');
    withoutMetadata();
    const rpcBeforeLate = globalThis.originalRpcCount;
    let lateDispatched = false;
    const afterLate = handleRpc({type: 'execute', method: 'list_apps', args: []})
      .then(() => { lateDispatched = true; });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(lateDispatched, false, 'a Sky request must wait for the running CLI command');
    assert.equal(globalThis.originalRpcCount, rpcBeforeLate);
    releaseLifetime();
    await afterLate;
    assert.equal(lifetimeReplies, repliesBeforeLate + 1);
    assert.equal(globalThis.originalRpcCount, rpcBeforeLate + 1);
    assert.equal(countFor('cli-late-session'), 1);
    lifetimeBehavior = () => ({notified: true});
  } finally {
    console.error = originalConsoleError;
  }

  globalThis.nodeRepl.env.LCU_MAC_CONTROL_SOCKET = undefined;
  const noControlMetadata = {session_id: 'no-control-session', turn_id: 'no-control-turn',
    call_id: 'no-control-call'};
  globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': noControlMetadata};
  await handleRpc({type: 'execute', method: 'list_apps', args: []});
  await turnEnded.run({session_id: noControlMetadata.session_id,
    turn_id: noControlMetadata.turn_id});
  const noControlEnded = calls.at(-1);
  assert.equal(noControlEnded.requestType, 'ComputerUseIPCCodexTurnEndedRequest');
  assert.deepEqual(noControlEnded.payload, {threadID: noControlMetadata.session_id,
    turnID: noControlMetadata.turn_id});
  assert.deepEqual(noControlEnded.metadata, noControlMetadata);

  const boundaryTurns = [];
  for (let index = 0; index < 127; index++) {
    const context = {session_id: `bounded-session-${index}`,
      turn_id: `bounded-turn-${index}`, call_id: `bounded-call-${index}`};
    boundaryTurns.push(context);
    globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': context};
    await handleRpc({type: 'execute', method: 'list_apps', args: []});
  }
  const rpcCountAtCapacity = globalThis.originalRpcCount;
  const overflow = {session_id: 'bounded-overflow-session',
    turn_id: 'bounded-overflow-turn', call_id: 'bounded-overflow-call'};
  globalThis.nodeRepl.requestMeta = {'x-codex-turn-metadata': overflow};
  await assert.rejects(handleRpc({type: 'execute', method: 'list_apps', args: []}),
    /Too many active macOS turn metadata contexts/);
  assert.equal(globalThis.originalRpcCount, rpcCountAtCapacity,
    'a new Sky request must not dispatch if its cleanup metadata cannot be retained');
  await turnEnded.run({session_id: boundaryTurns[0].session_id,
    turn_id: boundaryTurns[0].turn_id});
  await handleRpc({type: 'execute', method: 'list_apps', args: []});
  assert.equal(globalThis.originalRpcCount, rpcCountAtCapacity + 1,
    'a new Sky request should dispatch after turn cleanup frees a metadata slot');

  for (const raw of [undefined, '{bad metadata']) {
    globalThis.nodeRepl.requestMeta = raw === undefined ? {} : {'x-codex-turn-metadata': raw};
    assert.deepEqual(await handleRpc({type: 'execute', method: 'list_apps', args: []}), {ok: true});
  }
  console.log('macOS trusted control dispatch checks passed');
} finally {
  serviceSocket?.destroy();
  await new Promise(resolve => controlServer.close(resolve));
  await new Promise(resolve => lifetimeServer.close(resolve));
  await rm(root, {recursive: true, force: true});
}
