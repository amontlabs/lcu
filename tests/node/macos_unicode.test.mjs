import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
import {temporary, write} from './fixtures.mjs';

// A hand-made original-service stand-in, not copied OpenAI code: its keyboard
// backend drops unmapped Unicode, while its existing paste backend retains it.
async function fixture(t, {denied = false, pasteFailure = false} = {}) {
  const path = write(join(temporary(t), 'original-sky.mjs'), `
export const requests = [];
export let value = '';
export async function handleRpc(request) {
  requests.push(request);
  if (request.type !== 'execute') return {target: 'mac', methods: ['type_text', 'paste']};
  if (${denied}) throw new Error('Computer Use was not approved');
  const input = request.args[0];
  if (Object.values(Object.getOwnPropertyDescriptors(input)).some(property => !('value' in property))) {
    throw new Error('app approval requires plain data properties');
  }
  if (request.method === 'type_text') {
    value += Array.from(input.text).filter(character => character.codePointAt(0) < 128).join('');
  } else if (request.method === 'paste') {
    if (${pasteFailure}) throw new Error('original paste failed');
    value += input.text;
  }
  return 'original action result';
}
`);
  const previous = globalThis.nodeRepl;
  globalThis.nodeRepl = {
    env: {LCU_MAC_SKY_SERVICE_PATH: path},
    addTurnEndedHandler() {},
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.nodeRepl;
    else globalThis.nodeRepl = previous;
  });
  const service = await import(`../../lcu/macos_sky_service.mjs?test=${randomUUID()}`);
  const original = await import(pathToFileURL(path).href);
  const type = text => service.handleRpc({type: 'execute', method: 'type_text',
    args: [{app: 'fixture.app', text}]});
  return {service, original, type};
}

test('mixed Korean text reaches the original Unicode-safe backend intact', async t => {
  const f = await fixture(t);
  const text = 'LCU: 한글 입력 테스트 가나다 ABC 123';
  assert.equal(await f.type(text), 'original action result');
  assert.equal(f.original.value, text);
  assert.equal(f.original.requests.length, 1, 'never type first then paste the same payload');
  assert.equal(f.original.requests[0].method, 'paste');
  assert.equal(f.original.requests[0].args[0].format, 'text');
});

test('Unicode fallback preserves emoji, combining marks, CJK, newlines and the target', async t => {
  const f = await fixture(t);
  const text = '한글 😀 é 中\nABC 123';
  await f.type(text);
  assert.equal(f.original.value, text);
  assert.equal(f.original.requests[0].args[0].app, 'fixture.app');
});

test('ASCII and empty input retain the original typing path', async t => {
  const f = await fixture(t);
  await f.type('ABC 123\t\n');
  await f.type('');
  assert.equal(f.original.value, 'ABC 123\t\n');
  assert.deepEqual(f.original.requests.map(request => request.method), ['type_text', 'type_text']);
});

test('original app approval denial propagates without sending text', async t => {
  const f = await fixture(t, {denied: true});
  await assert.rejects(f.type('한글'), /Computer Use was not approved/);
  assert.equal(f.original.value, '');
  assert.equal(f.original.requests.length, 1);
});

test('paste failure is not retried through the lossy typing path', async t => {
  const f = await fixture(t, {pasteFailure: true});
  await assert.rejects(f.type('한글'), /original paste failed/);
  assert.equal(f.original.value, '');
  assert.equal(f.original.requests.length, 1);
});

test('setup and explicit paste pass through unchanged', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.service.handleRpc({type: 'setup'}),
    {target: 'mac', methods: ['type_text', 'paste']});
  const request = {type: 'execute', method: 'paste', args: [{app: 'fixture.app', text: '한글', format: 'md'}]};
  await f.service.handleRpc(request);
  assert.deepEqual(f.original.requests[1], request);
});

test('Unicode routing does not mutate a frozen caller request or treat text as HTML', async t => {
  const f = await fixture(t);
  const input = Object.freeze({app: 'fixture.app', text: '<b>한글</b>', format: 'html'});
  const request = Object.freeze({type: 'execute', method: 'type_text', args: Object.freeze([input])});
  await f.service.handleRpc(request);
  assert.equal(f.original.value, '<b>한글</b>');
  assert.equal(f.original.requests[0].args[0].format, 'text');
  assert.equal(input.format, 'html');
  assert.equal(request.method, 'type_text');
});

test('invalid accessor input reaches original validation without invoking the getter', async t => {
  const f = await fixture(t);
  let called = false;
  const input = {app: 'fixture.app', text: '한글'};
  Object.defineProperty(input, 'extra', {enumerable: true, get() { called = true; return 'value'; }});
  await assert.rejects(f.service.handleRpc({type: 'execute', method: 'type_text', args: [input]}),
    /plain data properties/);
  assert.equal(called, false);
  assert.equal(f.original.requests[0].method, 'type_text');
});

test('Unicode routing retains non-enumerable app and text accepted by original policy', async t => {
  const f = await fixture(t);
  const input = Object.defineProperties({}, {
    app: {value: 'fixture.app'},
    text: {value: '한글'},
  });
  await f.service.handleRpc({type: 'execute', method: 'type_text', args: [input]});
  assert.equal(f.original.value, '한글');
  const passed = f.original.requests[0].args[0];
  assert.equal(passed.app, 'fixture.app');
  assert.equal(Object.getOwnPropertyDescriptor(passed, 'text').enumerable, false);
  assert.equal(passed.format, 'text');
});
