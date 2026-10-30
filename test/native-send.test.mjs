import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGroupText, sendText, NativeSendError } from '../src/native/send-text.mjs';

const NOW = 1793318400123;
const NATIVE_ID = '7774366730634512345';
function service(overrides = {}) {
  const calls = [];
  return {
    calls,
    generateMsgUniqueId(chatType, time) { calls.push({ operation: 'generate', chatType, time }); return NATIVE_ID; },
    async sendMsg(...args) { calls.push({ operation: 'send', args }); return { result: 0, errMsg: '' }; },
    ...overrides,
  };
}

test('constructs one plain-text element without invented mention targets', () => {
  const message = buildGroupText({ groupId: '10001', text: '文本\nplain text' });
  assert.deepEqual(message.peer, { chatType: 2, peerUid: '10001', guildId: '' });
  assert.deepEqual(message.elements, [{ elementType: 1, elementId: '0', textElement: { content: '文本\nplain text', atType: 0 } }]);
  assert.ok(message.attributes instanceof Map);
  assert.equal(message.attributes.size, 0);
  assert.equal(Object.hasOwn(message.elements[0].textElement, 'atUid'), false);
});

test('invalid input cannot generate an ID or call native send', async () => {
  const native = service();
  for (const params of [
    { groupId: 9007199254740992, text: 'text' },
    { groupId: '9223372036854775808', text: 'text' },
    { groupId: '0', text: 'text' },
    { groupId: '0012345', text: 'text' },
    { groupId: '12345', text: '' },
    { groupId: '12345', text: '中文', maxTextBytes: 5 },
  ]) {
    await assert.rejects(sendText({ msgService: native, ...params }), error => error instanceof NativeSendError && error.retcode === 1400 && error.delivery_unknown === false);
  }
  assert.equal(native.calls.length, 0);
});

test('official ID generator receives group type and Unix milliseconds, keeping 19 digits as text', async () => {
  const native = service();
  const result = await sendText({ msgService: native, groupId: 10001, text: 'test', now: () => NOW });
  assert.deepEqual(native.calls[0], { operation: 'generate', chatType: 2, time: String(NOW) });
  assert.equal(native.calls.length, 2);
  const [id, peer, elements, attributes] = native.calls[1].args;
  assert.equal(id, NATIVE_ID);
  assert.equal(typeof id, 'string');
  assert.equal(peer.peerUid, '10001');
  assert.equal(elements[0].textElement.content, 'test');
  assert.ok(attributes instanceof Map);
  assert.deepEqual(result, { native_id: NATIVE_ID, accepted: true });
  assert.equal(Object.hasOwn(result, 'delivered'), false);
});

test('missing service, bad clocks, and invalid native IDs fail before native send', async () => {
  await assert.rejects(sendText({ groupId: '12345', text: 'test' }), error => error.code === 'NATIVE_SEND_UNAVAILABLE');
  const native = service();
  await assert.rejects(sendText({ msgService: native, groupId: '12345', text: 'test', now: () => NaN }), error => error.code === 'INVALID_CLOCK');
  assert.equal(native.calls.length, 0);
  for (const id of [0, 7774366730634512345, '0', '9223372036854775808', '12e3', Promise.resolve(NATIVE_ID)]) {
    let sends = 0;
    await assert.rejects(sendText({ msgService: service({ generateMsgUniqueId: () => id, sendMsg: () => { sends += 1; } }), groupId: '12345', text: 'test' }), error => error.code === 'NATIVE_ID_INVALID' && error.delivery_unknown === false);
    assert.equal(sends, 0);
  }
});

test('nonzero native result is rejection and is never retried', async () => {
  const native = service({ async sendMsg(...args) { this.calls.push({ operation: 'send', args }); return { result: 42, errMsg: 'internal detail' }; } });
  await assert.rejects(sendText({ msgService: native, groupId: '12345', text: 'test' }), error => error.code === 'NATIVE_SEND_REJECTED' && error.native_result === 42 && error.delivery_unknown === false);
  assert.equal(native.calls.filter(call => call.operation === 'send').length, 1);
});

test('timeout is explicitly uncertain, is not retried, and late acknowledgement stays on the original call', async () => {
  let sends = 0;
  let acknowledge;
  const native = service({ sendMsg() { sends += 1; return new Promise(resolve => { acknowledge = resolve; }); } });
  await assert.rejects(sendText({ msgService: native, groupId: '12345', text: 'test', timeoutMs: 15 }), error => error.code === 'NATIVE_SEND_TIMEOUT' && error.retcode === 1504 && error.delivery_unknown === true);
  acknowledge({ result: 0, errMsg: '' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sends, 1);
});

test('native exceptions and malformed acknowledgements do not leak details or claim delivery', async () => {
  for (const sendMsg of [
    () => { throw new Error('PRIVATE ACCOUNT OR TICKET DETAIL'); },
    async () => { throw new Error('PRIVATE ACCOUNT OR TICKET DETAIL'); },
    async () => null,
    async () => ({ result: '0' }),
  ]) {
    await assert.rejects(sendText({ msgService: service({ sendMsg }), groupId: '12345', text: 'test' }), error => error.delivery_unknown === true && !error.message.includes('PRIVATE'));
  }
});
