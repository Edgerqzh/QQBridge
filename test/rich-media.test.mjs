import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createMediaStore, imageInfo } from '../src/native/media.mjs';
import { buildGroupSegments, resolveGroupUid } from '../src/native/segments.mjs';
import { receivedSegments } from '../src/native/received-segments.mjs';
import { recallMessage } from '../src/native/recall.mjs';
import { createMessageMapper } from '../src/native/messages.mjs';
import { createReceivedMediaCache } from '../src/native/media-cache.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==','base64');
async function store(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'qqbridge-media-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, media: createMediaStore({ directory, ...options }) };
}
test('managed media is content addressed with hashes and does not accept server filesystem paths or URLs', async t => {
  const { media } = await store(t);
  const first = await media.prepare('base64://' + png.toString('base64'), 'image');
  assert.deepEqual(imageInfo(png), { extension: 'png', type: 1001, width: 1, height: 1 });
  const second = await media.prepare('qqbridge://' + first.sha256, 'image');
  assert.equal(first.sourcePath, second.sourcePath);
  assert.deepEqual(await readFile(first.sourcePath), png);
  for (const value of ['/etc/passwd','file:///etc/passwd','http://127.0.0.1/','https://example.com/a.png','qqbridge://../../secret','base64://bad!!!'])
    await assert.rejects(media.prepare(value, 'image'), error => error.retcode === 1400);
});
test('media validates decoded byte limits, dimensions, names and voice codec before sending', async t => {
  const { media } = await store(t, { maxBytes: 64 });
  await assert.rejects(media.prepare('base64://' + png.toString('base64'), 'image'));
  const { media: other } = await store(t);
  await assert.rejects(other.prepare('base64://eA==','image'));
  const corrupted = Buffer.from(png); corrupted[40] ^= 1;
  await assert.rejects(other.prepare('base64://' + corrupted.toString('base64'), 'image'));
  await assert.rejects(other.prepare('base64://eA==','file','../a'));
  await assert.rejects(other.prepare('base64://' + Buffer.from('RIFF wav').toString('base64'),'record'));
});
test('received media retrieval is group scoped, profile confined and bounded', async t => {
  const { directory } = await store(t);
  const source = path.join(directory, 'fixture.txt'); await writeFile(source, 'fixture');
  const cache = createReceivedMediaCache({ profile: directory, capacity: 1 });
  const record = (id, filePath = source) => ({ peerUin: '10001', elements: [{ elementType: 3, fileElement: { fileUuid: id, fileName: 'fixture.txt', filePath } }] });
  cache.remember(record('first'));
  await assert.rejects(cache.read('first', () => false), error => error.retcode === 1403);
  assert.equal(Buffer.from((await cache.read('first', () => true)).base64, 'base64').toString(), 'fixture');
  cache.remember(record('second'));
  await assert.rejects(cache.read('first', () => true), error => error.retcode === 1400);
  cache.remember(record('outside', process.execPath));
  await assert.rejects(cache.read('outside', () => true), error => error.retcode === 1403);
  cache.clear(); await assert.rejects(cache.read('outside', () => true));
});
test('a reply with an unknown local ID preserves real mention content without inventing an ID', () => {
  const value = receivedSegments([{ elementType: 7, replyElement: { replayMsgId: '7774366730634512345' } },
    { elementType: 1, textElement: { content: '@fixture', atType: 2, atUid: '10002', atNtUid: 'u_fixture' } }]);
  assert.deepEqual(value.message, [{ type: 'at', data: { qq: '10002' } }]);
});
test('image, file and voice produce separate typed native elements without parsing CQ text', async t => {
  const { media } = await store(t);
  const message = await buildGroupSegments({ groupId: '10001', mediaStore: media, message: [
    { type: 'text', data: { text: '[CQ:at,qq=all]' } },
    { type: 'image', data: { file: 'base64://' + png.toString('base64') } },
    { type: 'file', data: { file: 'base64://eA==', name: 'fixture.txt' } },
    { type: 'record', data: { file: 'base64://' + Buffer.from('#!AMR\nfixture').toString('base64'), duration: 1 } },
  ] });
  assert.deepEqual(message.elements.map(e => e.elementType), [1,2,3,4]);
  assert.equal(message.elements[0].textElement.atType, 0);
  assert.equal(message.elements[1].picElement.picWidth, 1);
  assert.equal(message.elements[2].fileElement.fileName, 'fixture.txt');
  assert.ok(message.elements[3].pttElement.otherBusinessInfo instanceof Map);
});
test('mentions use native UID mapping, distinguish everyone, and reject unresolvable identities', async () => {
  const groupService = { getUidByUins: async uins => ({ errCode: 0, uids: new Map([[uins[0], 'u_fixture_target']]) }) };
  const message = await buildGroupSegments({ groupId: '10001', resolveUid: uin => resolveGroupUid(groupService, uin), message: [
    { type: 'at', data: { qq: '10002' } }, { type: 'at', data: { qq: 'all' } },
  ] });
  assert.equal(message.elements[0].textElement.atNtUid, 'u_fixture_target');
  assert.equal(message.elements[0].textElement.atUid, '10002');
  assert.equal(message.elements[1].textElement.atType, 1);
  await assert.rejects(resolveGroupUid({ getUidByUins: () => ({ errCode: 1, uids: new Map([['10002','u_fixture']]) }) }, '10002'));
  await assert.rejects(buildGroupSegments({ groupId: '10001', resolveUid: async () => null, message: [{ type: 'at', data: { qq: '10002' } }] }));
});
test('mixed receive segments preserve order, mentions and CQ escaping without leaking native paths', () => {
  const value = receivedSegments([
    { elementType: 1, textElement: { content: '[fixture]', atType: 0 } },
    { elementType: 1, textElement: { content: '@fixture', atType: 2, atUid: '10002', atNtUid: 'u_fixture_target' } },
    { elementType: 2, picElement: { md5HexStr: 'a'.repeat(32), sourcePath: '/private/account/image.png' } },
    { elementType: 3, fileElement: { fileUuid: 'fixture-id', fileName: 'fixture.txt', fileSize: '1', filePath: '/private/file' } },
    { elementType: 4, pttElement: { md5HexStr: 'b'.repeat(32), filePath: '/private/voice' } },
  ]);
  assert.deepEqual(value.message.map(e => e.type), ['text','at','image','file','record']);
  assert.ok(value.raw.startsWith('&#91;fixture&#93;[CQ:at,qq=10002]'));
  assert.equal(JSON.stringify(value).includes('/private'), false);
  assert.equal(receivedSegments([{ elementType: 999 }]), null);
});
test('rich group mapper retains existing whitelist, self suppression and duplicate protections', () => {
  const mapper = createMessageMapper({ selfId: 10002, allowedGroups: ['10001'], richMedia: true });
  const record = { chatType: 2, peerUin: '10001', senderUin: '10003', msgId: '7774366730634512345', msgTime: '1793318400', isOnlineMsg: true, isImportMsg: false,
    elements: [{ elementType: 2, picElement: { md5HexStr: 'a'.repeat(32) } }] };
  assert.equal(mapper.fromNative({ ...record, peerUin: '10004' }), null);
  assert.equal(mapper.fromNative({ ...record, senderUin: '10002' }), null);
  assert.equal(mapper.fromNative(record).message[0].type, 'image');
  assert.equal(mapper.fromNative(record), null);
});
test('recall maps the exact native ID, rejects ACK failures and never retries ambiguous outcomes', async () => {
  const metadata = { chatType: 2, peerUin: '10001', msgId: '7774366730634512345' };
  let calls = 0;
  const service = { recallMsg(peer, ids) { calls++; assert.equal(peer.peerUid, '10001'); assert.deepEqual(ids, [metadata.msgId]); return { result: 0 }; } };
  assert.equal(await recallMessage({ msgService: service, metadata }), null);
  assert.equal(calls, 1);
  await assert.rejects(recallMessage({ msgService: { recallMsg: () => ({ result: 42 }) }, metadata }), error => error.retcode === 1502);
  await assert.rejects(recallMessage({ msgService: { recallMsg: () => new Promise(() => { calls++; }) }, metadata, timeoutMs: 5 }), error => error.delivery_unknown && error.retcode === 1504);
  assert.equal(calls, 2);
  await assert.rejects(recallMessage({ msgService: service, metadata: null }), error => error.retcode === 1400);
});
