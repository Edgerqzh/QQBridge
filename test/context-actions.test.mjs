import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMessageMapper } from '../src/native/messages.mjs';
import { createMessageIndex } from '../src/native/message-index.mjs';
import { createContextActions, messageAlias, groupMember } from '../src/native/context-actions.mjs';
import { buildGroupSegments } from '../src/native/segments.mjs';

const OWN = '10000001', GROUP = '20000001';
const record = (seq, overrides = {}) => ({ chatType: 2, peerUin: GROUP, peerUid: GROUP,
  msgId: String(7000000000000000000n + BigInt(seq)), msgSeq: String(seq), senderUin: '30000001', senderUid: 'u_fixture_sender',
  msgTime: '1800000000', clientSeq: '42', isOnlineMsg: false, isImportMsg: false, sendNickName: 'Fixture',
  elements: [{ elementType: 1, textElement: { content: `body ${seq}`, atType: 0 } }], ...overrides });
const rawMembers = [
  { uin: OWN, uid: 'u_self', nick: 'Self', role: 2, memberLevel: 3, joinTime: 1800000000, lastSpeakTime: 1800000001 },
  { uin: '30000001', uid: 'u_owner', nick: 'Owner', role: 4, cardName: 'Card', memberSpecialTitle: 'Title', specialTitleExpireTime: '0' },
  { uin: '30000002', uid: 'u_admin', nick: 'Admin', role: 3 },
];
function fixture(t, options = {}) {
  const mapper = createMessageMapper({ selfId: OWN, richMedia: true, allowedGroups: [GROUP] });
  const calls = [], media = [];
  let online = true, flushes = 0;
  const list = options.records ?? [record(1), record(2), record(3)];
  const services = { msgService: {
    getLatestDbMsgs(peer, count) { calls.push(['latest', peer, count]); return options.latest?.() ?? { result: 0, msgList: list.slice(-count) }; },
    getMsgs(peer, id, count, older) { calls.push(['history', peer, id, count, older]); return { result: 0, msgList: list.filter(r => BigInt(r.msgId) < BigInt(id)).slice(-count) }; },
    getMsgsByMsgId(peer, ids) { calls.push(['ids', peer, ids]); return options.byId?.(ids) ?? { result: 0, msgList: list.filter(r => ids.includes(r.msgId)) }; },
    getMsgsBySeqAndCount(peer, seq, count, older, local) { calls.push(['sequence', peer, seq, count, older, local]); return { result: 0, msgList: list.filter(r => r.msgSeq === seq).slice(0, 1) }; },
  }, groupService: {
    getAllMemberList(group, refresh) { calls.push(['members', group, refresh]); return options.members?.() ?? { errCode: 0, result: { finish: true, infos: new Map(rawMembers.map(r => [r.uid, r])) } }; },
  } };
  const actions = createContextActions({ timeoutMs: options.timeoutMs ?? 50, maxConcurrent: options.maxConcurrent ?? 4,
    getContext: () => ({ mapper, services,
      check(group) { if (!online) throw Object.assign(new Error('offline'), { retcode: 1503 }); if (group !== undefined && group !== GROUP) throw Object.assign(new Error('forbidden'), { retcode: 1403 }); },
      flush: async () => { flushes++; }, rememberMedia: record => media.push(record.msgId) }),
  });
  t.after(() => actions.close());
  return { mapper, actions, calls, media, list, services, offline() { online = false; }, flushes: () => flushes };
}

test('native historical and self messages are queryable without emitting live events', async t => {
  const f = fixture(t, { records: [record(1, { senderUin: OWN })] });
  const history = await f.actions.call('get_group_msg_history', { group_id: GROUP });
  assert.equal(history.messages.length, 1);
  assert.equal(f.mapper.fromNative(f.list[0]), null);
  const id = history.messages[0].message_id;
  const queried = await f.actions.call('get_msg', { message_id: String(id) });
  assert.equal(queried.message_id, id);
  assert.equal(queried.sender.user_id, Number(OWN));
  assert.equal(queried.native_message_id, '7000000000000000001');
  assert.equal(queried.message_seq, '1');
  assert.ok(f.flushes() >= 2);
});

test('history uses an exclusive bridge cursor, stays chronological and separates unsupported messages', async t => {
  const f = fixture(t, { records: [record(1), record(2, { elements: [{ elementType: 999 }] }), record(3)] });
  const first = await f.actions.call('get_group_msg_history', { group_id: GROUP, count: '3' });
  assert.deepEqual(first.messages.map(m => m.message_seq), ['1', '3']);
  assert.equal(first.unsupported_count, 1);
  const cursor = first.messages[1].message_id;
  const previous = await f.actions.call('get_group_msg_history', { group_id: GROUP, message_id: cursor, count: 1 });
  assert.deepEqual(previous.messages, []);
  assert.equal(previous.unsupported_count, 1);
  assert.ok(previous.next_message_id > 0);
  const call = f.calls.find(c => c[0] === 'history');
  assert.equal(call[2], '7000000000000000003'); assert.equal(call[4], true);
});

test('query and history reject bad input and cross-group references before native reads', async t => {
  const f = fixture(t);
  for (const id of ['1e3', 0, -1, '9007199254740993', 2147483648, true]) assert.throws(() => messageAlias(id));
  for (const params of [{ group_id: GROUP, count: 101 }, { group_id: GROUP, count: 0 }, { group_id: GROUP, message_seq: '3' }, { group_id: GROUP, message_id: 99 }, { group_id: '20000002' }]) {
    await assert.rejects(f.actions.call('get_group_msg_history', params));
  }
  await assert.rejects(f.actions.call('get_msg', { message_id: 99 }), { retcode: 1404 });
  const id = f.mapper.rememberNative(record(1));
  await assert.rejects(f.actions.getRecord(id, '20000002'), { retcode: 1403 });
  assert.equal(f.calls.length, 0);
});

test('native failures, missing messages and wrong peers never produce query success', async t => {
  for (const response of [{ result: 7 }, { result: 0, msgList: [] }, { result: 0, msgList: [record(1, { peerUin: '20000002' })] }, { result: 0, msgList: [record(2)] }]) {
    const f = fixture(t, { byId: () => response }); const id = f.mapper.rememberNative(record(1));
    await assert.rejects(f.actions.call('get_msg', { message_id: id }));
  }
});

test('phone replies with zero replayMsgId resolve the real source by group sequence', async t => {
  const quoted = record(3, { elements: [{ elementType: 7, replyElement: { replayMsgId: '0', replayMsgSeq: '1', sourceMsgIdInRecords: '7000000000000000999' } }, { elementType: 1, textElement: { content: 'reply', atType: 0 } }] });
  const f = fixture(t, { records: [record(1), quoted] });
  const id = f.mapper.rememberNative(quoted);
  const message = await f.actions.call('get_msg', { message_id: id });
  const reply = message.message[0];
  assert.equal(reply.type, 'reply');
  const source = await f.actions.call('get_msg', { message_id: reply.data.id });
  assert.equal(source.message_seq, '1');
  assert.equal(f.calls.filter(c => c[0] === 'sequence').length, 1);
  assert.equal(f.mapper.lookup(Number(reply.data.id)).msgId, '7000000000000000001');
});

test('an unavailable reply source preserves visible content and reports unresolved reads', async t => {
  const r = record(3, { elements: [{ elementType: 7, replyElement: { replayMsgId: '0', replayMsgSeq: '99' } }, { elementType: 1, textElement: { content: 'reply' } }] });
  const f = fixture(t, { records: [r] });
  const id = f.mapper.rememberNative(r);
  const result = await f.actions.call('get_msg', { message_id: id });
  assert.deepEqual(result.message, [{ type: 'text', data: { text: 'reply' } }]);
  assert.equal(f.actions.status().unresolved_replies, 1);
});

test('member reads refresh the complete list, map roles and find one member without persisting profiles', async t => {
  const f = fixture(t);
  const list = await f.actions.call('get_group_member_list', { group_id: GROUP });
  assert.deepEqual(list.map(m => m.role), ['member', 'owner', 'admin']);
  const member = await f.actions.call('get_group_member_info', { group_id: GROUP, user_id: '30000001', no_cache: 'true' });
  assert.equal(member.card, 'Card'); assert.equal(member.title, 'Title');
  assert.equal(f.calls.every(c => c[0] !== 'members' || c[2] === true), true);
  assert.equal(JSON.stringify(f.mapper.snapshot()).includes('Owner'), false);
  await assert.rejects(f.actions.call('get_group_member_info', { group_id: GROUP, user_id: '30000009' }), { retcode: 1404 });
  await assert.rejects(f.actions.call('get_group_member_info', { group_id: GROUP, user_id: '30000001', no_cache: 'perhaps' }), { retcode: 1400 });
});

test('incomplete member lists and unknown roles fail instead of silently claiming completeness', async t => {
  const f = fixture(t, { members: () => ({ errCode: 0, result: { finish: false, infos: new Map() } }) });
  await assert.rejects(f.actions.call('get_group_member_list', { group_id: GROUP }));
  assert.throws(() => groupMember({ uin: '30000001', role: 99 }, GROUP));
  assert.equal(groupMember({ uin: '30000001', role: 2, isDelete: true }, GROUP), null);
});

test('twenty concurrent identical reads share one native request and return independent values', async t => {
  let resolve;
  const f = fixture(t, { latest: () => new Promise(yes => { resolve = yes; }) });
  const pending = Array.from({ length: 20 }, () => f.actions.call('get_group_msg_history', { group_id: GROUP }));
  resolve({ result: 0, msgList: [record(1)] });
  const results = await Promise.all(pending);
  assert.equal(f.calls.length, 1);
  results[0].messages[0].sender.nickname = 'mutated';
  assert.equal(results[1].messages[0].sender.nickname, 'Fixture');
  assert.equal(new Set(results.map(r => r.messages[0].message_id)).size, 1);
});

test('timeouts retain native concurrency slots, overload fails, and late offline results are rejected', async t => {
  let resolve;
  const f = fixture(t, { maxConcurrent: 1, timeoutMs: 10, latest: () => new Promise(yes => { resolve = yes; }) });
  await assert.rejects(f.actions.call('get_group_msg_history', { group_id: GROUP, count: 1 }), { retcode: 1504 });
  assert.equal(f.actions.status().active, 1);
  await assert.rejects(f.actions.call('get_group_msg_history', { group_id: GROUP, count: 2 }), { retcode: 1429 });
  resolve({ result: 0, msgList: [record(1)] }); await new Promise(setImmediate);
  assert.equal(f.actions.status().active, 0);
  const pending = f.actions.call('get_group_msg_history', { group_id: GROUP });
  f.offline(); resolve({ result: 0, msgList: [record(1)] });
  await assert.rejects(pending, { retcode: 1503 });
});

test('reply construction uses the actual source, validates position and rejects unavailable metadata', async () => {
  const source = record(1);
  const result = await buildGroupSegments({ groupId: GROUP, resolveReply: async id => { assert.equal(id, '7'); return source; }, message: [{ type: 'reply', data: { id: '7' } }, { type: 'text', data: { text: 'response' } }] });
  const reply = result.elements[0].replyElement;
  assert.equal(reply.replayMsgId, source.msgId); assert.equal(reply.replayMsgSeq, '1');
  assert.equal(reply.senderUid, source.senderUin); assert.equal(reply.senderUidStr, source.senderUid);
  assert.equal(reply.replyMsgTime, source.msgTime);
  assert.deepEqual(result.elements.map(e => e.elementType), [7, 1]);
  for (const message of [[{ type: 'reply', data: { id: '7' } }], [{ type: 'text', data: { text: 'x' } }, { type: 'reply', data: { id: '7' } }], [{ type: 'reply', data: { id: '7' } }, { type: 'reply', data: { id: '7' } }]]) {
    await assert.rejects(buildGroupSegments({ groupId: GROUP, resolveReply: async () => source, message }));
  }
  await assert.rejects(buildGroupSegments({ groupId: GROUP, resolveReply: async () => record(1, { peerUin: '20000002' }), message: [{ type: 'reply', data: { id: '7' } }, { type: 'text', data: { text: 'x' } }] }));
});

async function temp(t) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'qqbridge-message-index-'));
  t.after(() => rm(profile, { recursive: true, force: true }));
  return profile;
}
async function persistent(profile, accountId = OWN, capacity = 5000) {
  let mapper;
  const index = createMessageIndex({ profile, accountId, snapshot: () => mapper.snapshot() });
  mapper = createMessageMapper({ selfId: accountId, capacity, richMedia: true, initialState: await index.load(), onChange: () => index.changed() });
  return { mapper, index };
}

test('atomic account snapshots survive restart with exact int64 metadata, dedup and high-water mark', async t => {
  const profile = await temp(t), first = await persistent(profile, OWN, 2);
  const received = first.mapper.fromNative(record(1, { isOnlineMsg: true }));
  const id = received.message_id;
  first.mapper.rememberNative(record(2));
  await Promise.all(Array.from({ length: 20 }, () => first.index.flush()));
  const second = await persistent(profile, OWN, 2);
  assert.equal(second.mapper.lookup(id).msgId, '7000000000000000001');
  assert.equal(second.mapper.fromNative(record(1, { isOnlineMsg: true })), null);
  const thirdId = second.mapper.rememberNative(record(3)); await second.index.flush();
  assert.equal(second.mapper.lookup(id), null);
  const third = await persistent(profile, OWN, 2);
  assert.equal(third.mapper.lookup(thirdId).msgId, '7000000000000000003');
  assert.ok(third.mapper.rememberNative(record(1)) > thirdId);
  await third.index.flush();
  const bytes = await readFile(path.join(profile, 'message-index', OWN + '.json'), 'utf8');
  assert.equal(bytes.includes('body'), false); assert.equal(bytes.includes('Fixture'), false);
  const other = await persistent(profile, '10000002');
  assert.equal(other.mapper.lookup(thirdId), null);
  if (process.platform !== 'win32') assert.equal((await stat(path.join(profile, 'message-index', OWN + '.json'))).mode & 0o777, 0o600);
});

test('corrupt or foreign account indices never reset message IDs; invalid snapshots are rejected', async t => {
  const profile = await temp(t); await mkdir(path.join(profile, 'message-index'));
  const file = path.join(profile, 'message-index', OWN + '.json');
  for (const data of ['{broken', JSON.stringify({ account_id: '10000002', state: {} })]) {
    await writeFile(file, data); await assert.rejects(persistent(profile), { retcode: 1503 });
  }
  const duplicate = { version: 1, nextAlias: 3, entries: [{ alias: 1, metadata: record(1), emitted: false }, { alias: 1, metadata: record(2), emitted: false }] };
  assert.throws(() => createMessageMapper({ selfId: OWN, initialState: duplicate }));
  const exhausted = createMessageMapper({ selfId: OWN, initialState: { version: 1, nextAlias: 2147483648, entries: [] } });
  assert.throws(() => exhausted.rememberNative(record(1)), /exhausted/);
});

test('a persistence failure cannot claim a clean index and can recover after storage repair', async t => {
  const profile = await temp(t), { mapper, index } = await persistent(profile);
  mapper.rememberNative(record(1));
  const directory = path.join(profile, 'message-index');
  await rm(directory, { recursive: true }); await writeFile(directory, 'blocked');
  await assert.rejects(index.flush(), { retcode: 1503 }); assert.equal(index.status().failed, true);
  await rm(directory); await index.flush();
  assert.equal(index.status().failed, false); assert.equal(index.status().dirty, false);
  assert.equal((await persistent(profile)).mapper.lookup(1).msgId, '7000000000000000001');
});
