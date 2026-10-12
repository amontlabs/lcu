// Opt-in integration against the installed original Sky JS. Only its native
// pipe endpoint is simulated; no real app, service, socket or clipboard is used.
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';

const app = process.env.LCU_TEST_ORIGINAL_MAC_APP;
const source = app && join(app, 'Contents/Resources/cua_node/lib/node_modules/@oai/sky/dist/project/cua/sky_js/src');
const skip = process.platform !== 'darwin' || !source || !existsSync(join(source, 'service.js'))
  ? 'requires explicit LCU_TEST_ORIGINAL_MAC_APP on macOS' : false;
const endpoint = 'test-only:lcu-unicode-original';
const target = {bundleIdentifier: 'com.example.lcu.owned-fixture', displayName: 'Owned fixture',
  appPath: '/test-only/OwnedFixture.app', risk: 'normal'};

async function fixture(t, {decision = 'allowed', approval = 'accept', failPaste = false} = {}) {
  const codec = await import(pathToFileURL(join(source, 'targets/mac/native-pipe.js')).href);
  const {client} = await import(pathToFileURL(join(source, 'targets/mac/client.js')).href);
  client.transports.clear();
  const requests = [];
  const approvals = [];
  const pipes = [];
  class FakePipe extends EventEmitter {
    write(data) {
      const decoded = codec.decodeMessageFrames(Buffer.from(data));
      assert.equal(decoded.remainingData.length, 0);
      for (const frame of decoded.messages) {
        const message = JSON.parse(frame);
        let result;
        let error;
        if (message.method === 'ping') result = {serverApiVersion: message.params.clientApiVersion};
        else {
          assert.equal(message.method, 'request');
          const request = message.params;
          requests.push(request);
          if (request.requestType === 'ComputerUseIPCAppPolicyRequest') {
            result = {decision, target, allowPersistentApproval: false};
          } else {
            assert.equal(request.requestType, 'ComputerUseIPCAppPerformActionRequest');
            assert.equal(request.request.app, target.appPath);
            if (failPaste && request.request.action.paste) error = {code: -10008, message: 'fixture native paste failure'};
            else result = {};
          }
        }
        queueMicrotask(() => this.emit('data', codec.encodeMessageFrame(JSON.stringify(
          {jsonrpc: '2.0', id: message.id, ...(error ? {error} : {result})}))));
      }
      return true;
    }
    end() { this.emit('close'); }
  }
  const previous = globalThis.nodeRepl;
  const priorConfig = process.env.OAI_SKY_CONFIG_PATH;
  delete process.env.OAI_SKY_CONFIG_PATH;
  globalThis.nodeRepl = {
    env: {LCU_MAC_SKY_SERVICE_PATH: join(source, 'service.js'),
      SKY_CUA_SERVICE_NATIVE_PIPE_PATH: endpoint, NODE_REPL_DISABLE_ANALYTICS: '1'},
    nativePipe: {async createConnection(address) {
      assert.equal(address, endpoint, 'never connect to a real native service');
      const pipe = new FakePipe(); pipes.push(pipe); return pipe;
    }},
    launchServices: {openApplication() { throw Error('real application launch forbidden in integration test'); }},
    async createElicitation(request) { approvals.push(request); return {action: approval}; },
    async withSuspendedTimeout(run) { return run(); },
    addTurnEndedHandler() {},
    setResponseMeta() {},
  };
  t.after(() => {
    for (const pipe of pipes) pipe.end();
    client.transports.clear();
    if (previous === undefined) delete globalThis.nodeRepl;
    else globalThis.nodeRepl = previous;
    if (priorConfig === undefined) delete process.env.OAI_SKY_CONFIG_PATH;
    else process.env.OAI_SKY_CONFIG_PATH = priorConfig;
  });
  const patched = await import(`../../lcu/macos_sky_service.mjs?original-test=${randomUUID()}`);
  const original = await import(pathToFileURL(join(source, 'service.js')).href);
  const request = text => ({type: 'execute', method: 'type_text', args: [{app: target.bundleIdentifier, text}]});
  const actions = () => requests.filter(request => request.requestType === 'ComputerUseIPCAppPerformActionRequest')
    .map(request => request.request.action);
  return {patched, original, request, actions, approvals};
}

test('unpatched original JS forwards the complete Korean string to native type', {skip}, async t => {
  const f = await fixture(t);
  const text = 'LCU: 한글 입력 테스트 가나다 ABC 123';
  await f.original.handleRpc(f.request(text));
  assert.deepEqual(f.actions(), [{type: {_0: text}}]);
});

test('patched wrapper reaches original native paste with intact Unicode and original approval', {skip}, async t => {
  const f = await fixture(t);
  const text = '한글 😀 é 中 ABC 123';
  await f.patched.handleRpc(f.request(text));
  assert.deepEqual(f.actions(), [{paste: {text, format: 'text'}}]);
  assert.equal(f.approvals.length, 1);
  assert.equal(f.approvals[0].meta.tool_name, 'paste');
  assert.equal(f.approvals[0].meta.tool_params.app, target.bundleIdentifier);
});

test('ASCII typing retains the original native type action', {skip}, async t => {
  const f = await fixture(t);
  await f.patched.handleRpc(f.request('ASCII ABC 123'));
  assert.deepEqual(f.actions(), [{type: {_0: 'ASCII ABC 123'}}]);
});

test('newline mechanism is explicit: ASCII goes to type; mixed Unicode goes to paste', {skip}, async t => {
  const f = await fixture(t);
  await f.patched.handleRpc(f.request('ASCII\n'));
  await f.patched.handleRpc(f.request('한글\n'));
  assert.deepEqual(f.actions(), [{type: {_0: 'ASCII\n'}}, {paste: {text: '한글\n', format: 'text'}}]);
});

test('original organization policy denial prevents native input', {skip}, async t => {
  const f = await fixture(t, {decision: 'denied'});
  await assert.rejects(f.patched.handleRpc(f.request('한글')), /blocked from using/);
  assert.deepEqual(f.actions(), []);
  assert.equal(f.approvals.length, 0);
});

test('original user approval refusal prevents native input', {skip}, async t => {
  const f = await fixture(t, {approval: 'decline'});
  await assert.rejects(f.patched.handleRpc(f.request('한글')), /not approved/);
  assert.deepEqual(f.actions(), []);
});

test('original native paste error propagates without a typing retry', {skip}, async t => {
  const f = await fixture(t, {failPaste: true});
  await assert.rejects(f.patched.handleRpc(f.request('한글')), /fixture native paste failure/);
  assert.deepEqual(f.actions(), [{paste: {text: '한글', format: 'text'}}]);
});
