import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessageMapper } from '../src/native/messages.mjs';

const OWN = '10000001';
const GROUP = '20000001';
const SENDER = '30000001';
function record(overrides = {}) {
  return {
    chatType: 2, peerUin: GROUP, peerUid: GROUP, senderUin: SENDER,
    msgId: '7000000000000000001', msgSeq: '17', msgTime: '1800000000',
    isOnlineMsg: true, isImportMsg: false, sendNickName: 'Fixture nickname',
    elements: [{ elementType: 1, textElement: { content: 'Fixture message', atType: 0 } }],
    ...overrides,
  };
}

test('native group text becomes a OneBot event while native IDs remain exact strings', () => {
  const mapper = createMessageMapper({ selfId: OWN });
  const source = record();
  const event = mapper.fromNative(source);
  assert.deepEqual(event, {
    time: 1800000000, self_id: Number(OWN), post_type: 'message', message_type: 'group', sub_type: 'normal',
    message_id: 1, group_id: Number(GROUP), user_id: Number(SENDER), anonymous: null,
    message: [{ type: 'text', data: { text: 'Fixture message' } }], raw_message: 'Fixture message', font: 0,
    sender: { user_id: Number(SENDER), nickname: 'Fixture nickname' },
  });
  assert.deepEqual(mapper.lookup(event.message_id), { chatType: 2, peerUin: GROUP, peerUid: GROUP, msgId: source.msgId, msgSeq: '17' });
  assert.ok(event.message_id > 0 && event.message_id <= 0x7fffffff);
});

test('adjacent 19-digit native IDs never collide and groups scope deduplication', () => {
  const mapper = createMessageMapper({ selfId: OWN });
  const first = mapper.fromNative(record());
  const second = mapper.fromNative(record({ msgId: '7000000000000000002' }));
  const otherGroup = mapper.fromNative(record({ peerUin: '20000002' }));
  assert.equal(new Set([first.message_id, second.message_id, otherGroup.message_id]).size, 3);
  assert.equal(mapper.lookup(first.message_id).msgId, '7000000000000000001');
  assert.equal(mapper.lookup(second.message_id).msgId, '7000000000000000002');
  assert.equal(mapper.fromNative(record()), null);
  assert.equal(mapper.rememberNative(record()), first.message_id);
});

test('remembering a receipt allocates an alias without swallowing a later incoming event', () => {
  const mapper = createMessageMapper({ selfId: OWN });
  const id = mapper.rememberNative({ chatType: 2, peerUin: GROUP, msgId: '7000000000000000001' });
  assert.equal(mapper.fromNative(record()).message_id, id);
  assert.equal(mapper.fromNative(record()), null);
  const copy = mapper.lookup(id);
  copy.msgId = '1';
  assert.equal(mapper.lookup(id).msgId, '7000000000000000001');
});

test('history, imported records, own messages and invalid identities never emit events', () => {
  const mapper = createMessageMapper({ selfId: OWN });
  for (const change of [
    { chatType: 1 }, { chatType: '2' }, { isOnlineMsg: false }, { isOnlineMsg: undefined },
    { isImportMsg: true }, { isImportMsg: undefined }, { senderUin: OWN },
    { senderUin: 'not-an-id' }, { senderUin: '0' }, { senderUin: '9007199254740993' },
    { peerUin: '1e7' }, { peerUin: '-1' }, { msgId: 7000000000000000001 }, { msgId: 'invalid' },
  ]) assert.equal(mapper.fromNative(record(change)), null);
  assert.notEqual(mapper.fromNative(record()), null);
});

test('only strict integer seconds are accepted and a malformed native time is not overridden', () => {
  for (const time of ['1800000000.5', 1.5, -1, 0, '1800000000000', '1e9', null]) {
    assert.equal(createMessageMapper({ selfId: OWN }).fromNative(record({ msgTime: time, time: 1800000000 })), null);
  }
  const event = createMessageMapper({ selfId: OWN }).fromNative(record({ msgTime: undefined, time: 1800000000 }));
  assert.equal(event.time, 1800000000);
});

test('unverified mentions stay literal text and CQ-looking text cannot forge rich segments', () => {
  const mapper = createMessageMapper({ selfId: OWN });
  const event = mapper.fromNative(record({ elements: [
    { elementType: 1, textElement: { content: '@Fixture ', atType: 1 } },
    { elementType: 1, textElement: { content: '[CQ:image,file=x]&', atType: 0 } },
  ] }));
  assert.deepEqual(event.message, [{ type: 'text', data: { text: '@Fixture [CQ:image,file=x]&' } }]);
  assert.equal(event.raw_message, '@Fixture &#91;CQ:image,file=x&#93;&amp;');
});

test('unknown or mixed non-text elements are rejected without pretending to support images', () => {
  const mapper = createMessageMapper({ selfId: OWN });
  for (const elements of [
    [], null, [{ elementType: 2, picElement: { file: 'fixture' } }],
    [{ elementType: 1, textElement: { content: 'text' } }, { elementType: 2, picElement: {} }],
    [{ elementType: 2, textElement: { content: 'mismatched' } }],
    [{ textElement: { content: 'text' }, picElement: {} }],
    [{ elementType: 1, textElement: { content: 12 } }],
    [{ elementType: 1, textElement: { content: 'text', atType: '1' } }],
    [{ elementType: 1, textElement: { content: 'text', atType: 0x80000000 } }],
    [{ elementType: 1, textElement: { content: '' } }],
  ]) assert.equal(mapper.fromNative(record({ elements })), null);
  assert.notEqual(mapper.fromNative(record()), null);
});

test('an explicit group whitelist also constrains alias allocation; an empty whitelist allows none', () => {
  const mapper = createMessageMapper({ selfId: OWN, allowedGroups: new Set([GROUP]) });
  assert.notEqual(mapper.fromNative(record()), null);
  assert.equal(mapper.fromNative(record({ peerUin: '20000002' })), null);
  assert.equal(mapper.rememberNative(record({ peerUin: '20000002' })), null);
  assert.equal(createMessageMapper({ selfId: OWN, allowedGroups: [] }).fromNative(record()), null);
});

test('capacity evicts both native and alias entries and retains no message body or nickname', () => {
  const mapper = createMessageMapper({ selfId: OWN, capacity: 2 });
  const first = mapper.fromNative(record());
  mapper.fromNative(record({ msgId: '7000000000000000002' }));
  const latest = mapper.fromNative(record({ msgId: '7000000000000000003' }));
  assert.equal(mapper.lookup(first.message_id), null);
  assert.equal(mapper.lookup(latest.message_id).msgId, '7000000000000000003');
  const serialized = JSON.stringify(mapper.lookup(latest.message_id));
  assert.ok(!serialized.includes('Fixture message'));
  assert.ok(!serialized.includes('Fixture nickname'));
  assert.ok(!serialized.includes('elements'));
  const replay = mapper.fromNative(record());
  assert.notEqual(replay.message_id, first.message_id);
});

test('a dynamic self identity suppresses pre-login and self events without consuming incoming deduplication', () => {
  let own = 0;
  const mapper = createMessageMapper({ selfId: () => own });
  assert.equal(mapper.fromNative(record()), null);
  own = Number(SENDER);
  assert.equal(mapper.fromNative(record()), null);
  own = Number(OWN);
  assert.notEqual(mapper.fromNative(record()), null);
  own = () => { throw new Error('fixture'); };
  assert.equal(createMessageMapper({ selfId: own }).fromNative(record()), null);
});

test('nicknames use observed fields and invalid configuration or aliases fail predictably', () => {
  const event = createMessageMapper({ selfId: OWN }).fromNative(record({ sendNickName: '', sendMemberName: 'Fixture member' }));
  assert.equal(event.sender.nickname, 'Fixture member');
  for (const capacity of [0, -1, 1.5, 0x80000000]) assert.throws(() => createMessageMapper({ selfId: OWN, capacity }), RangeError);
  assert.throws(() => createMessageMapper({ selfId: 'not-an-id' }), TypeError);
  assert.throws(() => createMessageMapper({ selfId: OWN, allowedGroups: null }), TypeError);
  assert.throws(() => createMessageMapper({ selfId: OWN, allowedGroups: ['not-an-id'] }), TypeError);
  const mapper = createMessageMapper({ selfId: OWN });
  for (const id of [0, -1, 1.5, '1', 0x80000000]) assert.equal(mapper.lookup(id), null);
});
