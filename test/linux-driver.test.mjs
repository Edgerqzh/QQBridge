import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDriverCore, parseAllowedGroups } from '../src/native/driver-core.mjs';
import { createMessageIndex } from '../src/native/message-index.mjs';

async function waitFor(predicate) {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Fixture condition timed out.');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

const account = { uin: '123456789', uid: 'u_fixture_account', nickName: 'Fixture' };
const groups = [{ groupCode: '10001', groupName: 'Fixture group', memberCount: 3, maxMember: 200 }];
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');
const nativeId = '7645907418560602113';
const record = (overrides = {}) => ({
  chatType: 2, peerUin: '10001', peerUid: '10001', senderUin: '987654321',
  msgId: '7645907418560602112', msgTime: '1780000000', isOnlineMsg: true, isImportMsg: false,
  elements: [{ elementType: 1, textElement: { content: 'Fixture received text' } }], ...overrides,
});

async function fixture(t, options = {}) {
  const calls = [], timeline = [], sessions = [];
  let listener, sessionOptions;
  const login = {
    initConfig() { calls.push(['login-config']); },
    addKernelLoginListener(value) { listener = value; calls.push(['login-listener']); },
    removeKernelLoginListener(value) { assert.equal(value, listener); calls.push(['remove-login']); },
    setRemerberPwd(value) { calls.push(['remember',value]); },
    setAutoLogin(value) { calls.push(['auto-login',value]); },
    startPolling() { calls.push(['start-polling']); listener.onQRCodeLoginPollingStarted(); },
    abortPolling() { calls.push(['abort-polling']); if(options.qrCancelEvent)listener.onQRCodeSessionFailed(7,4); },
    connect() { calls.push(['connect']); if (options.autoConnect !== false) listener.onLoginConnected(); return true; },
    quickLoginWithUin(uin) {
      calls.push(['quick-login', uin]);
      if (options.quickQrCallback) queueMicrotask(() => listener.onQRCodeLoginSucceed(options.quickQrCallback));
      if (options.autoUser !== false) queueMicrotask(() => listener.onUserLoggedIn(uin));
      return options.quickResult === undefined ? new Promise(() => {}) : options.quickResult;
    },
    getLoginList() {
      calls.push(['login-list']);
      return typeof options.loginList === 'function' ? options.loginList() : options.loginList ?? { result: 0, LocalLoginInfoList: [{ ...account, isQuickLogin: true }] };
    },
    getQRCodePicture() {
      calls.push(['qr']);
      listener.onQRCodeLoginPollingStarted(120,2);
      if (options.autoQr !== false) listener.onQRCodeGetPicture({ pngBase64QrcodeData: png, expireTime: 120, pollTimeInterval: 2 });
      return options.qrResult ?? true;
    },
    logout() { assert.fail('Driver must never invoke native logout'); },
  };
  const msgService = {
    recallMsg(...args) { calls.push(['recall', ...args]); return { result: 0 }; },
    generateMsgUniqueId(...args) { calls.push(['generate-id', ...args]); return nativeId; },
    sendMsg(...args) { calls.push(['send', ...args]); return options.sendResult ?? { result: 0 }; },
    ...options.msgService,
  };
  const groupService = {
    getUidByUins(uins) { return { errCode: 0, uids: new Map(uins.map(uin => [uin, 'u_fixture_target'])) }; },
    getGroupList(force) {
      assert.equal(force, false); calls.push(['group-list']);
      if (options.autoGroups !== false) queueMicrotask(() => sessionOptions.onGroupList(options.groups ?? groups));
      return { result: 0 };
    },
    ...options.groupService,
  };
  const driver = createDriverCore({
    native: {
      NodeIQQNTWrapperEngine: { get: () => ({ initWithDeskTopConfig() { calls.push(['engine-init']); } }) },
      NodeIKernelLoginService: { get: () => login },
    },
    metadata: { version: '3.2.34-53644', appid: { linux: '537391511' } }, profile: options.profile ?? '/fixture/profile',
    prepareProfile: async () => 'fixture-machine-id',
    emitStatus(value) { timeline.push(['status', value]); },
    emitEvent(value) { timeline.push(['event', value]); },
    experimentalRichMedia: options.experimentalRichMedia, allowedGroups: options.allowedGroups, allowedUsers: options.allowedUsers, loginUin: options.loginUin ?? '',
    createIndex: options.createIndex ?? (() => ({ load: async () => undefined, changed() {}, flush: async () => {}, status: () => ({ dirty: false, failed: false }) })),
    connectionTimeoutMs: 80, qrTimeoutMs: 80, accountTimeoutMs: 80, sendTimeoutMs: options.sendTimeoutMs ?? 80,
    requestRestart: options.requestRestart, recoveryGraceMs: options.recoveryGraceMs, forceQr: options.forceQr,
    createSession(value) {
      calls.push(['create-session', value.account]); sessionOptions = value;
      const state = { session_ready: false, online: false, good: false };
      const session = {
        start() {
          calls.push(['session-start']);
          if (options.earlyGroups) value.onGroupList(groups);
          state.session_ready = true; value.onState({ ...state }); return Promise.resolve();
        },
        stop() { calls.push(['session-stop']); state.online = false; state.session_ready = false; value.onState({ ...state }); },
        status() {
          const online = state.online || (options.authenticatedReady === true && state.session_ready && value.getAuthenticationEvidence());
          return { ...state, online: state.forcedOffline ? false : online, good: state.forcedOffline ? false : online };
        },
        authenticationEvidence: () => value.getAuthenticationEvidence(),
        getServices: () => ({ msgService, groupService, buddyService: options.friendList ? {getBuddyList(){value.onFriendList(options.friendList);return {result:0};}} : undefined }),
        online() { Object.assign(state, { forcedOffline: false, session_ready: true, online: true, good: true, online_message_observed: true, msf_status: 1, msf_error: 0 }); value.onState({ ...state }); },
        offline() { Object.assign(state, { forcedOffline: true, online: false, good: false, msf_status: 0 }); value.onState({ ...state }); },
        updates(raw) { value.onMessageUpdate(raw); },
        authenticationRequired() { value.onAuthenticationRequired('kicked_offline'); },
        receive(raw) { value.onMessage(raw); },
        groups(raw) { value.onGroupList(raw); },
      };
      sessions.push(session); return session;
    },
  });
  t.after(() => driver.stop());
  await driver.start(); await nextTurn(); await nextTurn();
  return {
    driver, calls, timeline, sessions, listener: () => listener,
    async select(info = account) { listener.onQRCodeLoginSucceed(info); await nextTurn(); await nextTurn(); if (options.createIndex === createMessageIndex) await waitFor(() => driver.status().session_ready); },
    async online() { sessions[0].online(); await nextTurn(); },
  };
}

test('QR confirmation starts quick login and the exact account session once without waiting for its pending Promise', async t => {
  const f = await fixture(t);
  assert.equal(f.driver.status().online, false);
  await f.select();
  await f.select(); f.listener().onUserLoggedIn(account.uin); await nextTurn();
  assert.equal(f.calls.filter(item => item[0] === 'quick-login').length, 1);
  assert.equal(f.calls.filter(item => item[0] === 'session-start').length, 1);
  assert.deepEqual(f.calls.find(item => item[0] === 'create-session')[1], account);
  assert.equal(f.driver.status().session_ready, true);
  assert.equal(f.driver.status().online, false);
  await f.online();
  const state = await f.driver.call('get_login_state');
  assert.equal(state.online, true); assert.equal(state.authenticated, true);
  assert.equal(state.authenticated_evidence, 'native_online_message');
  assert.deepEqual(await f.driver.call('get_login_info'), { user_id: Number(account.uin), nickname: account.nickName });
  await assert.rejects(f.driver.call('get_login_qrcode'), { retcode: 1409 });
});

test('missing QR uid is read from the exact same account in the verified login-list wrapper', async t => {
  const f = await fixture(t, { loginList: { result: 0, LocalLoginInfoList: [{ uin: '555555555', uid: 'u_other' }, account] } });
  await f.select({ uin: account.uin, nickName: account.nickName });
  assert.equal(f.calls.find(item => item[0] === 'create-session')[1].uid, account.uid);
  assert.equal(f.calls.filter(item => item[0] === 'login-list').length, 1);
});

test('unexpected account events and invalid login-list acknowledgements cannot initialize a session', async t => {
  const f = await fixture(t, { autoUser: false });
  await f.select(); f.listener().onUserLoggedIn('555555555'); await nextTurn();
  assert.equal(f.sessions.length, 0); assert.equal(f.driver.status().online, false);
  const bad = await fixture(t, { loginList: { result: 9, LocalLoginInfoList: [account] } });
  await bad.select({ uin: account.uin });
  assert.equal(bad.sessions.length, 0); assert.equal((await bad.driver.call('get_login_state')).stage, 'session_init_failed');
});

test('session evidence is published before mapped group text events and duplicates are suppressed', async t => {
  const f = await fixture(t); await f.select(); await f.online();
  f.timeline.length = 0;
  f.sessions[0].receive([record(), record(), record({ chatType: 1 }), record({ isImportMsg: true })]);
  await waitFor(() => f.timeline.some(item => item[0] === 'event'));
  const events = f.timeline.filter(item => item[0] === 'event');
  assert.equal(events.length, 1); assert.equal(events[0][1].message_type, 'group');
  assert.deepEqual(events[0][1].message, [{ type: 'text', data: { text: 'Fixture received text' } }]);
  assert.equal(f.timeline[0][0], 'status'); assert.equal(f.timeline[0][1].online, true);
  f.listener().onLoginDisConnected();
  f.sessions[0].receive([record({ msgId: '7645907418560602114' })]);
  assert.equal(f.timeline.filter(item => item[0] === 'event').length, 1);
  assert.equal(f.driver.status().online, false);
});

test('group-list callbacks gate sends; plain text is sent once and keeps a local int32 alias for a 19-digit native ID', async t => {
  const f = await fixture(t); await f.select();
  await assert.rejects(f.driver.call('send_group_msg', { group_id: 10001, message: 'test' }), { retcode: 1503 });
  await f.online();
  await assert.rejects(f.driver.call('send_group_msg', { group_id: 10001, message: 'test' }), { retcode: 1503 });
  assert.deepEqual(await f.driver.call('get_group_list'), [{ group_id: 10001, group_name: 'Fixture group', member_count: 3, max_member_count: 200 }]);
  await assert.rejects(f.driver.call('send_group_msg', { group_id: 99999, message: 'test' }), { retcode: 1403 });
  await assert.rejects(f.driver.call('send_group_msg', { group_id: 10001, message: [{ type: 'image', data: {} }] }), { retcode: 1404 });
  await assert.rejects(f.driver.call('send_group_msg', { group_id: 10001, message: '[CQ:at,qq=1]' }), { retcode: 1404 });
  assert.equal(f.calls.filter(item => item[0] === 'send').length, 0);
  const result = await f.driver.call('send_group_msg', { group_id: '10001', message: [{ type: 'text', data: { text: 'first' } }, { type: 'text', data: { text: 'second' } }] });
  assert.ok(Number.isInteger(result.message_id) && result.message_id > 0 && result.message_id <= 0x7fffffff);
  const sent = f.calls.filter(item => item[0] === 'send');
  assert.equal(sent.length, 1); assert.equal(sent[0][1], nativeId); assert.equal(typeof sent[0][1], 'string');
  assert.deepEqual(sent[0][2], { chatType: 2, peerUid: '10001', guildId: '' });
  assert.equal(sent[0][3][0].textElement.content, 'firstsecond');
});

test('allowlist restricts returned groups, received messages, and sends', async t => {
  const f = await fixture(t, { allowedGroups: new Set(['10001']), groups: [...groups, { groupCode: '10002' }] });
  await f.select(); await f.online();
  assert.equal((await f.driver.call('get_group_list')).length, 1);
  await assert.rejects(f.driver.call('send_group_msg', { group_id: 10002, message: 'test' }), { retcode: 1403 });
  f.sessions[0].receive([record({ peerUin: '10002' })]);
  assert.equal(f.timeline.filter(item => item[0] === 'event').length, 0);
  await f.driver.call('send_group_msg', { group_id: 10001, message: '[CQ:literal]', auto_escape: true });
  assert.equal(f.calls.filter(item => item[0] === 'send').length, 1);
});

test('a synchronous group notification during listener registration is retained until session readiness', async t => {
  const f = await fixture(t, { earlyGroups: true }); await f.select(); await f.online();
  assert.equal((await f.driver.call('get_group_list'))[0].group_id, 10001);
  assert.equal(f.calls.filter(item => item[0] === 'group-list').length, 0);
  await f.driver.call('send_group_msg', { group_id: 10001, message: 'Fixture only' });
  assert.equal(f.calls.filter(item => item[0] === 'send').length, 1);
});

test('send timeout is bounded and never retries the native operation', async t => {
  const f = await fixture(t, { sendTimeoutMs: 15, sendResult: new Promise(() => {}) });
  await f.select(); await f.online(); await f.driver.call('get_group_list');
  await assert.rejects(f.driver.call('send_group_msg', { group_id: 10001, message: 'test' }), error => error.retcode === 1504 && error.delivery_unknown === true);
  assert.equal(f.calls.filter(item => item[0] === 'send').length, 1);
});

test('synchronous QR delivery is captured, concurrent requests share one call, and disconnect invalidates cached QR', async t => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([f.driver.call('get_login_qrcode'), f.driver.call('get_login_qrcode')]);
  assert.equal(first.image_base64, png); assert.equal(second.image_base64, png);
  assert.equal(f.calls.filter(item => item[0] === 'qr').length, 1);
  await f.driver.call('get_login_qrcode');
  assert.equal(f.calls.filter(item => item[0] === 'qr').length, 1);
  await Promise.all([f.driver.call('get_login_qrcode', { refresh: true }), f.driver.call('get_login_qrcode', { refresh: true })]);
  assert.equal(f.calls.filter(item => item[0] === 'qr').length, 2);
  f.listener().onLoginDisConnected();
  await assert.rejects(f.driver.call('get_login_qrcode'), /connection timed out/);
});

test('stop rejects pending QR and group waiters, stops session before removing login listener, and ignores late callbacks', async t => {
  const qr = await fixture(t, { autoQr: false });
  const pendingQr = qr.driver.call('get_login_qrcode');
  const qrRejected = assert.rejects(pendingQr, /stopped/); await nextTurn(); await qr.driver.stop(); await qrRejected;
  const f = await fixture(t, { autoGroups: false }); await f.select();
  const pendingGroups = f.driver.call('get_group_list');
  const groupsRejected = assert.rejects(pendingGroups, /closed/);
  await f.driver.stop(); await groupsRejected;
  const order = f.calls.map(item => item[0]);
  assert.ok(order.indexOf('session-stop') < order.indexOf('remove-login'));
  f.listener().onUserLoggedIn(account.uin); f.sessions[0].online(); f.sessions[0].receive([record()]);
  assert.equal(f.driver.status().online, false); assert.equal(f.timeline.filter(item => item[0] === 'event').length, 0);
  assert.equal(f.calls.filter(item => item[0] === 'session-start').length, 1);
});

test('remembered login uses only the explicitly requested eligible account and does not claim a QR scan', async t => {
  const f = await fixture(t, {
    loginUin: account.uin,
    loginList: { result: 0, LocalLoginInfoList: [{ uin: '555555555', uid: 'u_other', isQuickLogin: true }, { ...account, isQuickLogin: true }] },
  });
  assert.equal(f.calls.find(item => item[0] === 'quick-login')[1], account.uin);
  assert.equal(f.sessions.length, 1);
  const state = await f.driver.call('get_login_state');
  assert.equal(state.scan_confirmed, false); assert.equal(state.account_selected, true);
  const missing = await fixture(t, { loginUin: '555555555' });
  assert.equal(missing.calls.filter(item => item[0] === 'quick-login').length, 0);
  assert.equal((await missing.driver.call('get_login_state')).stage, 'remembered_account_waiting');
  const defaultLogin = await fixture(t);
  assert.equal(defaultLogin.calls.filter(item => item[0] === 'login-list').length, 0);
});

test('remembered login waits for late account-cache records and coalesces repeated record notifications', async t => {
  let records = [];
  const f = await fixture(t, { loginUin: account.uin, loginList: () => ({ result: 0, LocalLoginInfoList: records }) });
  assert.equal((await f.driver.call('get_login_state')).stage, 'remembered_account_waiting');
  assert.equal(f.calls.filter(item => item[0] === 'quick-login').length, 0);
  records = [{ ...account, isQuickLogin: true }];
  for (let index = 0; index < 20; index++) f.listener().onLoginRecordUpdate();
  await nextTurn(); await nextTurn();
  assert.equal(f.calls.filter(item => item[0] === 'login-list').length, 2);
  assert.equal(f.calls.filter(item => item[0] === 'quick-login').length, 1);
  assert.equal(f.sessions.length, 1);
  f.listener().onLoginConnected(); f.listener().onLoginRecordUpdate(); await nextTurn();
  assert.equal(f.calls.filter(item => item[0] === 'login-list').length, 2);
  assert.equal(f.calls.filter(item => item[0] === 'quick-login').length, 1);
});

test('a fulfilled remembered login with the real string result code retains identity for the later account callback', async t => {
  const f = await fixture(t, { loginUin: account.uin, autoUser: false, quickResult: { result: '0' } });
  const selected = await f.driver.call('get_login_state');
  assert.equal(selected.self_id, Number(account.uin));
  assert.equal(selected.account_selected, true); assert.equal(selected.online, false);
  assert.equal(selected.login_result_code, 0);
  f.listener().onUserLoggedIn(account.uin); await nextTurn();
  assert.equal(f.sessions.length, 1);
  await f.online(); assert.equal(f.driver.status().online, true);
  assert.equal(f.calls.filter(item => item[0] === 'quick-login').length, 1);
});

test('remembered success initializes once from string zero and a QR-named callback without inventing a scan or waiting for onUserLoggedIn', async t => {
  const f = await fixture(t, {
    loginUin: account.uin, autoUser: false, quickResult: { result: '0' }, quickQrCallback: account,
  });
  const selected = await f.driver.call('get_login_state');
  assert.equal(selected.scan_confirmed, false); assert.equal(selected.account_selected, true);
  assert.equal(selected.remembered_login.selected_via_cache, true);
  assert.equal(selected.authenticated, true); assert.equal(selected.online, false);
  assert.equal(selected.session_ready, true); assert.equal(f.sessions.length, 1);
  assert.equal(f.calls.filter(item => item[0] === 'quick-login').length, 1);
  assert.equal(f.calls.filter(item => item[0] === 'session-start').length, 1);
  assert.equal(f.calls.filter(item => item[0] === 'qr').length, 0);
  f.listener().onQRCodeLoginSucceed(account); f.listener().onUserLoggedIn(account.uin);
  f.listener().onLoginRecordUpdate(); await nextTurn(); await nextTurn();
  assert.equal((await f.driver.call('get_login_state')).scan_confirmed, false);
  assert.equal(f.calls.filter(item => item[0] === 'session-start').length, 1);
  assert.equal(f.calls.filter(item => item[0] === 'quick-login').length, 1);
  await f.online(); assert.equal(f.driver.status().online, true);
});

test('a QR-named remembered callback cannot replace the verified cached UID', async t => {
  const f = await fixture(t, {
    loginUin: account.uin, autoUser: false, quickResult: { result: '0' },
    quickQrCallback: { ...account, uid: 'u_different_identity' },
  });
  assert.equal(f.sessions.length, 0); assert.equal(f.driver.status().online, false);
  assert.equal(f.driver.status().stage, 'callback_error');
  assert.equal(f.calls.filter(item => item[0] === 'quick-login').length, 1);
});

test('a quiet group can send after verified native login success and a ready session without any inbound message', async t => {
  const f = await fixture(t, {
    loginUin: account.uin, autoUser: false, quickResult: { result: '0' }, quickQrCallback: account, authenticatedReady: true,
  });
  assert.equal(f.sessions.length, 1); assert.equal(f.sessions[0].authenticationEvidence(), true);
  assert.equal(f.driver.status().online, true);
  assert.equal(f.timeline.filter(item => item[0] === 'event').length, 0);
  await f.driver.call('get_group_list');
  const result = await f.driver.call('send_group_msg', { group_id: 10001, message: 'Fixture only; quiet fake group' });
  assert.ok(result.message_id > 0); assert.equal(f.calls.filter(item => item[0] === 'send').length, 1);
  await f.driver.stop(); assert.equal(f.sessions[0].authenticationEvidence(), false);
});

test('the authentication getter rejects pending native login, mismatched accounts, and previous connection generations', async t => {
  const pending = await fixture(t, { loginUin: account.uin, authenticatedReady: true });
  assert.equal(pending.sessions[0].authenticationEvidence(), false);
  assert.equal(pending.driver.status().online, false);
  pending.sessions[0].online();
  assert.equal(pending.sessions[0].authenticationEvidence(), false);
  assert.equal(pending.driver.status().online, true);
  const wrong = await fixture(t, { loginUin: account.uin, quickResult: { result: '0' }, authenticatedReady: true });
  assert.equal(wrong.sessions[0].authenticationEvidence(), true);
  wrong.listener().onUserLoggedIn('555555555');
  assert.equal(wrong.sessions[0].authenticationEvidence(), false);
  const wrongUid = await fixture(t, { loginUin: account.uin, quickResult: { result: '0' }, authenticatedReady: true });
  assert.equal(wrongUid.sessions[0].authenticationEvidence(), true);
  wrongUid.listener().onQRCodeLoginSucceed({ ...account, uid: 'u_different_identity' });
  assert.equal(wrongUid.sessions[0].authenticationEvidence(), false);
  const stale = await fixture(t, { loginUin: account.uin, quickResult: { result: '0' }, authenticatedReady: true });
  const oldSession = stale.sessions[0]; assert.equal(oldSession.authenticationEvidence(), true);
  stale.listener().onLoginDisConnected(); stale.listener().onLoginConnected();
  assert.equal(oldSession.authenticationEvidence(), false);
});

test('stopping before the shared startup immediate prevents a queued native session initialization', async t => {
  const f = await fixture(t, { autoUser: false }); await f.select();
  f.listener().onUserLoggedIn(account.uin);
  await f.driver.stop(); await nextTurn();
  assert.equal(f.sessions.length, 0);
  assert.equal(f.calls.filter(item => item[0] === 'session-start').length, 0);
  assert.equal(f.driver.status().online, false);
});

test('an unknown native login result is visible while preserving selected identity for real session evidence', async t => {
  const f = await fixture(t, { loginUin: account.uin, autoUser: false, quickResult: { result: 'unknown' } });
  const selected = await f.driver.call('get_login_state');
  assert.equal(selected.stage, 'login_result_unrecognized');
  assert.equal(selected.self_id, Number(account.uin)); assert.equal(selected.account_selected, true);
  assert.equal(selected.authenticated, false); assert.equal(selected.online, false);
  f.listener().onUserLoggedIn(account.uin); await nextTurn();
  assert.equal(f.sessions.length, 1); assert.equal(f.driver.status().online, false);
  await f.online(); assert.equal(f.driver.status().online, true);
});

test('a record revision during an in-flight read schedules one serial refresh rather than dropping the notification', async t => {
  let finishFirst, reads = 0;
  const first = new Promise(resolve => { finishFirst = resolve; });
  const f = await fixture(t, {
    loginUin: account.uin,
    loginList: () => ++reads === 1 ? first : { result: 0, LocalLoginInfoList: [{ ...account, isQuickLogin: true }] },
  });
  for (let index = 0; index < 20; index++) f.listener().onLoginRecordUpdate();
  await nextTurn(); assert.equal(reads, 1);
  finishFirst({ result: 0, LocalLoginInfoList: [] }); await nextTurn(); await nextTurn();
  assert.equal(reads, 2); assert.equal(f.sessions.length, 1);
  assert.equal(f.calls.filter(item => item[0] === 'quick-login').length, 1);
});

test('a transient disconnect cancels stale pre-session lookup and resumes only the new connection generation', async t => {
  let finishStale, reads = 0;
  const stale = new Promise(resolve => { finishStale = resolve; });
  const f = await fixture(t, {
    loginUin: account.uin,
    loginList: () => ++reads === 1 ? stale : { result: 0, LocalLoginInfoList: [{ ...account, isQuickLogin: true }] },
  });
  f.listener().onLoginDisConnected(); f.listener().onLoginConnected();
  await nextTurn(); await nextTurn();
  assert.equal(reads, 2); assert.equal(f.sessions.length, 1);
  finishStale({ result: 0, LocalLoginInfoList: [{ ...account, uid: 'u_stale', isQuickLogin: true }] }); await nextTurn();
  assert.equal(f.calls.find(item => item[0] === 'create-session')[1].uid, account.uid);
  assert.equal(f.calls.filter(item => item[0] === 'quick-login').length, 1);
});

test('transport changes before session creation reuse the already-issued remembered native login operation', async t => {
  const f = await fixture(t, { loginUin: account.uin, autoUser: false });
  assert.equal(f.calls.filter(item => item[0] === 'quick-login').length, 1);
  f.listener().onLoginDisConnected(); f.listener().onLoginConnected(); await nextTurn();
  assert.equal(f.calls.filter(item => item[0] === 'quick-login').length, 1);
  f.listener().onUserLoggedIn(account.uin); await nextTurn();
  assert.equal(f.sessions.length, 1);
});

test('cache refresh has a finite read budget per connection, resets before selection, and preserves real login failures', async t => {
  let records = [];
  const f = await fixture(t, { loginUin: account.uin, loginList: () => ({ result: 0, LocalLoginInfoList: records }) });
  for (let index = 0; index < 20; index++) { f.listener().onLoginRecordUpdate(); await nextTurn(); }
  assert.equal(f.calls.filter(item => item[0] === 'login-list').length, 8);
  assert.equal((await f.driver.call('get_login_state')).stage, 'remembered_account_lookup_exhausted');
  f.listener().onLoginDisConnected();
  records = [{ ...account, isQuickLogin: true }]; f.listener().onLoginConnected(); await nextTurn(); await nextTurn();
  assert.equal(f.calls.filter(item => item[0] === 'login-list').length, 9);
  assert.equal(f.sessions.length, 1);
  f.listener().onLoginFailed();
  const failedStage = f.driver.status().stage;
  f.listener().onLoginConnecting(); f.listener().onLoginConnected(); await nextTurn();
  assert.equal(f.driver.status().stage, failedStage); assert.equal(f.driver.status().online, false);
  assert.equal(f.calls.filter(item => item[0] === 'quick-login').length, 1);
});

test('group allowlist configuration validates decimal IDs without broadening malformed lists', () => {
  assert.equal(parseAllowedGroups(undefined), undefined);
  assert.equal(parseAllowedGroups(''), undefined);
  assert.deepEqual([...parseAllowedGroups('10001, 10002,10001')], ['10001', '10002']);
  for (const invalid of [' ', '10001,', '0', '-1', '10001,nope', '9007199254740992']) assert.throws(() => parseAllowedGroups(invalid));
});

test('the real session component joins login, dispatcher, native listeners, account reads, and text send end to end', async t => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'qqbridge-driver-test-'));
  const refs = {}, events = [], sends = [];
  let readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const engine = { initWithDeskTopConfig() {}, getDeviceInfo: () => ({ guid: 'fixture-device' }), readyToShow() {} };
  const login = {
    initConfig() {}, addKernelLoginListener(value) { refs.login = value; }, removeKernelLoginListener() {}, abortPolling() {},
    connect() { refs.login.onLoginConnected(); return true; },
    quickLoginWithUin(uin) { queueMicrotask(() => refs.login.onUserLoggedIn(uin)); return new Promise(() => {}); },
  };
  const msgService = {
    recallMsg(...args) { calls.push(['recall', ...args]); return { result: 0 }; },
    addKernelMsgListener(value) { refs.msg = value; }, removeKernelMsgListener() {},
    generateMsgUniqueId: () => nativeId,
    sendMsg(...args) { sends.push(args); return { result: 0 }; },
  };
  const groupService = {
    getUidByUins(uins) { return { errCode: 0, uids: new Map(uins.map(uin => [uin, 'u_fixture_target'])) }; },
    addKernelGroupListener(value) { refs.group = value; }, removeKernelGroupListener() {},
    getGroupList(force) { assert.equal(force, false); refs.group.onGroupListUpdate(1, groups); return { result: 0 }; },
  };
  const nativeSession = {
    init(config, depends, dispatcher, listener) {
      assert.equal(config.selfUin, account.uin); assert.equal(config.selfUid, account.uid);
      Object.assign(refs, { depends, dispatcher, sessionListener: listener });
    },
    getMsgService: () => msgService, getGroupService: () => groupService,
    onDispatchPush() { refs.msg.onRecvMsg([record()]); },
    onDispatchPushWithJson() {}, onDispatchRequestReply() {},
  };
  const startup = {
    getSessionIdList: () => new Map([['nt', 'nt_fixture']]),
    start() { queueMicrotask(() => { refs.sessionListener.onNTSessionCreate(0, 'nt_fixture'); refs.sessionListener.onSessionInitComplete(0, '', account.uid); }); return 0; },
  };
  const driver = createDriverCore({
    native: {
      NodeIQQNTWrapperEngine: { get: () => engine }, NodeIKernelLoginService: { get: () => login },
      NodeIQQNTStartupSessionWrapper: { create: () => startup },
      NodeIQQNTWrapperSession: { getNTWrapperSession(id) { assert.equal(id, 'nt_fixture'); return nativeSession; } },
    },
    profile, metadata: { version: '3.2.34-53644', appid: { linux: '537391511' } }, prepareProfile: async () => 'fixture-machine-id',
    emitEvent: event => events.push(event), emitStatus: state => { if (state.session_ready) readyResolve(); },
  });
  t.after(async () => {
    await driver.stop();
    const absolute = path.resolve(profile), tempRoot = path.resolve(os.tmpdir()) + path.sep;
    if (!absolute.startsWith(tempRoot) || !path.basename(absolute).startsWith('qqbridge-driver-test-')) throw new Error('Unexpected cleanup target.');
    await rm(absolute, { recursive: true, force: true });
  });
  await driver.start(); refs.login.onQRCodeLoginSucceed(account);
  let timer;
  try { await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Session readiness timed out')), 1500); })]); }
  finally { clearTimeout(timer); }
  assert.equal(driver.status().online, false);
  refs.depends.onMSFStatusChange(1, 0);
  refs.dispatcher.dispatchCall(42, new Uint8Array([1, 2, 3]));
  await waitFor(() => events.length === 1);
  assert.equal(driver.status().online, true); assert.equal(events.length, 1);
  assert.equal((await driver.call('get_group_list'))[0].group_id, 10001);
  const result = await driver.call('send_group_msg', { group_id: 10001, message: 'Fixture only; fake native service' });
  assert.equal(sends.length, 1); assert.equal(sends[0][0], nativeId);
  assert.ok(result.message_id > events[0].message_id);
});


test('experimental mentions resolve real-format UIDs and recall preserves native string IDs', async t => {
  const f = await fixture(t, { experimentalRichMedia: true });
  await f.select(); await f.online(); await f.driver.call('get_group_list');
  const receipt = await f.driver.call('send_group_msg', { group_id: 10001, message: [{ type: 'at', data: { qq: '987654321' } }, { type: 'text', data: { text: 'fixture' } }] });
  const sent = f.calls.find(call => call[0] === 'send');
  assert.equal(sent[3][0].textElement.atNtUid, 'u_fixture_target');
  await f.driver.call('delete_msg', { message_id: receipt.message_id });
  assert.deepEqual(f.calls.find(call => call[0] === 'recall').slice(1), [{ chatType: 2, peerUid: '10001', guildId: '' }, [nativeId]]);
});

test('experimental mutation policy rejects unavailable groups, expired IDs and disabled opt-in before native operations', async t => {
  const f = await fixture(t);
  await f.select(); await f.online(); await f.driver.call('get_group_list');
  await assert.rejects(f.driver.call('send_group_msg', { group_id: 10001, message: [{ type: 'at', data: { qq: 'all' } }] }), error => error.retcode === 1404);
  await assert.rejects(f.driver.call('delete_msg', { message_id: 1 }), error => error.retcode === 1404);
  assert.equal(f.calls.some(call => ['send', 'recall'].includes(call[0])), false);
});

test('persistent context APIs, reply send and recall survive a complete driver recreation', async t => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'qqbridge-driver-context-'));
  const source = record({ msgSeq: '17', senderUid: 'u_fixture_sender' });
  const nativeRecords = [source];
  const options = { profile, createIndex: createMessageIndex, experimentalRichMedia: true,
    msgService: {
      getLatestDbMsgs() { return { result: 0, msgList: nativeRecords }; },
      getMsgsByMsgId(peer, ids) { return { result: 0, msgList: nativeRecords.filter(m => ids.includes(m.msgId)) }; },
      sendMsg(id, peer, elements) { nativeRecords.push(record({ msgId: id, msgSeq: '18', senderUin: account.uin, senderUid: account.uid, elements })); return { result: 0 }; },
    },
    groupService: { getAllMemberList(group, refresh) { assert.equal(refresh, true); return { errCode: 0, result: { finish: true, infos: new Map([['u_fixture_sender', { uin: source.senderUin, nick: 'Fixture', role: 4 }]]) } }; } },
  };
  const f = await fixture(t, options); await f.select(); await f.online(); await f.driver.call('get_group_list');
  const history = await f.driver.call('get_group_msg_history', { group_id: 10001 });
  const originalId = history.messages[0].message_id;
  const receipt = await f.driver.call('send_group_msg', { group_id: 10001, message: [{ type: 'reply', data: { id: String(originalId) } }, { type: 'text', data: { text: 'Fixture reply' } }] });
  assert.equal(nativeRecords[1].elements[0].replyElement.replayMsgId, source.msgId);
  assert.equal((await f.driver.call('get_group_member_info', { group_id: 10001, user_id: source.senderUin })).role, 'owner');
  await f.driver.stop();
  const second = await fixture(t, options); await second.select(); await second.online(); await second.driver.call('get_group_list');
  assert.equal((await second.driver.call('get_msg', { message_id: originalId })).native_message_id, source.msgId);
  const reply = await second.driver.call('get_msg', { message_id: receipt.message_id });
  assert.equal(reply.message[0].data.id, String(originalId));
  await second.driver.call('delete_msg', { message_id: String(receipt.message_id) });
  assert.equal(second.calls.filter(c => c[0] === 'recall').length, 1);
  t.after(() => rm(profile, { recursive: true, force: true }));
});

test('failed persistence suppresses realtime publication and never returns an unpersisted send ID', async t => {
  const f = await fixture(t, { createIndex: () => ({ load: async () => undefined, changed() {}, flush: async () => { throw new Error('fixture disk failure'); }, status: () => ({ failed: true }) }) });
  await f.select(); await f.online(); await f.driver.call('get_group_list');
  f.sessions[0].receive([record()]); await nextTurn(); await nextTurn();
  assert.equal(f.timeline.filter(c => c[0] === 'event').length, 0);
  await assert.rejects(f.driver.call('send_group_msg', { group_id: 10001, message: 'fixture' }), /accepted.*persisted.*Do not resend/);
  assert.equal(f.calls.filter(c => c[0] === 'send').length, 1);
  assert.equal(f.driver.status().good, false);
});

test('a disconnect after native acceptance preserves uncertainty and never retries a send', async t => {
  let accepted;
  const f = await fixture(t, { sendResult: new Promise(resolve => { accepted = resolve; }) });
  await f.select(); await f.online(); await f.driver.call('get_group_list');
  const send = f.driver.call('send_group_msg', { group_id: 10001, message: 'fixture' });
  await nextTurn();
  assert.equal(f.calls.filter(c => c[0] === 'send').length, 1);
  f.listener().onLoginDisConnected(); accepted({ result: 0 });
  await assert.rejects(send, /accepted.*session changed.*Do not resend/);
  assert.equal(f.calls.filter(c => c[0] === 'send').length, 1);
});

test('native message updates publish a deduplicated recall with the original event ID', async t => {
  const f = await fixture(t, { groupService: { getUinByUids: ids => ({errCode:0,uins:new Map(ids.map(id=>[id,'987654321']))}) } });
  await f.select(); await f.online(); await f.driver.call('get_group_list');
  f.sessions[0].receive([record()]);await waitFor(()=>f.timeline.some(x=>x[0]==='event'));
  const original=f.timeline.find(x=>x[0]==='event')[1];
  const recalled=record({isOnlineMsg:false,recallTime:'1800000000',elements:[{elementType:8,grayTipElement:{subElementType:1,revokeElement:{origMsgSenderUid:'u_fixture_sender',operatorUid:'u_fixture_sender'}}}]});
  f.sessions[0].updates([recalled,recalled]);await waitFor(()=>f.timeline.some(x=>x[1]?.notice_type==='group_recall'));
  const notice=f.timeline.filter(x=>x[1]?.notice_type==='group_recall');assert.equal(notice.length,1);assert.equal(notice[0][1].message_id,original.message_id);
});

test('MSF recovery clears group permissions until a fresh snapshot and cancels a short outage restart', async t => {
  const restarts=[];const f=await fixture(t,{recoveryGraceMs:100,requestRestart:r=>restarts.push(r)});
  await f.select();await f.online();await f.driver.call('get_group_list');
  f.sessions[0].offline();assert.equal(f.driver.status().online,false);assert.equal(f.driver.status().stage,'recovering');
  await assert.rejects(f.driver.call('send_group_msg',{group_id:10001,message:'fixture'}),{retcode:1503});
  await f.online();
  await assert.rejects(f.driver.call('send_group_msg',{group_id:10001,message:'fixture'}));
  f.sessions[0].groups(groups);await f.driver.call('send_group_msg',{group_id:10001,message:'fixture'});
  assert.equal(restarts.length,0);assert.equal(f.calls.filter(x=>x[0]==='send').length,1);
});

test('a disconnected initialized login transport requests one worker restart and never reuses the old kernel', async t => {
  const restarts=[];const f=await fixture(t,{loginUin:account.uin,recoveryGraceMs:5,requestRestart:r=>restarts.push(r)});
  await f.online();await f.driver.call('get_group_list');f.listener().onLoginDisConnected();f.listener().onLoginConnected();
  await waitFor(()=>restarts.length===1);assert.equal(restarts[0].mode,'automatic');assert.equal(f.driver.status().online,false);
  assert.equal(f.calls.filter(x=>x[0]==='session-start').length,1);assert.equal(f.calls.filter(x=>x[0]==='send').length,0);
});

test('native authentication revocation requests a fresh QR process rather than automatic login', async t => {
  const restarts=[];const f=await fixture(t,{requestRestart:r=>restarts.push(r)});await f.select();await f.online();
  f.sessions[0].authenticationRequired();await waitFor(()=>restarts.length===1);
  assert.equal(restarts[0].mode,'manual');assert.equal(f.driver.status().online,false);
});

test('generic remembered-login failure is recoverable and is not misclassified as revoked authentication', async t => {
  const restarts=[];const f=await fixture(t,{loginUin:account.uin,recoveryGraceMs:5,requestRestart:r=>restarts.push(r)});
  await f.online();f.listener().onLoginFailed();await waitFor(()=>restarts.length===1);
  assert.equal(restarts[0].mode,'automatic');assert.equal(f.calls.filter(x=>x[0]==='send').length,0);
});

test('force-QR recovery ignores unsolicited cached account callbacks until a QR was requested', async t => {
  const f=await fixture(t,{forceQr:true});await f.select();assert.equal(f.sessions.length,0);
  await f.driver.call('get_login_qrcode');await f.select();assert.equal(f.sessions.length,1);
});

test('private friend events, unified sends, queries, recall and IDs survive driver recreation', async t => {
  const profile=await mkdtemp(path.join(os.tmpdir(),'qqbridge-private-driver-'));
  const privateRecord=record({chatType:1,peerUin:'987654321',peerUid:'u_fixture_sender',senderUid:'u_fixture_sender',msgSeq:'17'});
  const list=[privateRecord],friendList=[{categroyMbCount:1,buddyList:[{uin:'987654321',uid:'u_fixture_sender',coreInfo:{uin:'987654321',uid:'u_fixture_sender',nick:'Fixture friend',remark:'Test'},baseInfo:{age:20}}]}];
  const options={profile,createIndex:createMessageIndex,friendList,allowedGroups:new Set(['10001']),allowedUsers:new Set(['987654321']),experimentalRichMedia:true,msgService:{
    getMsgsByMsgId(peer,ids){assert.equal(peer.chatType,1);assert.equal(peer.peerUid,'u_fixture_sender');return {result:0,msgList:list.filter(r=>ids.includes(r.msgId))};},
    getLatestDbMsgs(){return {result:0,msgList:list};},
    sendMsg(id,peer,elements){assert.equal(peer.chatType,1);list.push({...privateRecord,msgId:id,msgSeq:'18',senderUin:account.uin,senderUid:account.uid,elements});return {result:0};},
  }};
  const f=await fixture(t,options);await f.select();await f.online();
  const friends=await f.driver.call('get_friend_list');assert.equal(friends[0].user_id,987654321);
  f.sessions[0].receive([privateRecord]);await waitFor(()=>f.timeline.some(x=>x[1]?.message_type==='private'));
  const incoming=f.timeline.find(x=>x[1]?.message_type==='private')[1];assert.equal(incoming.sub_type,'friend');assert.equal('group_id'in incoming,false);
  const sent=await f.driver.call('send_msg',{message_type:'private',user_id:'987654321',message:[{type:'reply',data:{id:String(incoming.message_id)}},{type:'text',data:{text:'fixture private reply'}}]});
  assert.equal(f.calls.find(x=>x[0]==='generate-id')[1],1);
  await assert.rejects(f.driver.call('send_msg',{user_id:'987654321',group_id:'10001',message:'ambiguous'}),{retcode:1400});
  await assert.rejects(f.driver.call('send_private_msg',{user_id:'987654322',message:'unknown'}),{retcode:1403});
  await f.driver.stop();const next=await fixture(t,options);await next.select();await next.online();
  assert.equal((await next.driver.call('get_msg',{message_id:incoming.message_id})).message_type,'private');
  assert.equal((await next.driver.call('get_friend_msg_history',{user_id:'987654321'})).messages.length,2);
  await next.driver.call('delete_msg',{message_id:sent.message_id});assert.equal(next.calls.find(x=>x[0]==='recall')[1].chatType,1);
  t.after(()=>rm(profile,{recursive:true,force:true}));
});

test('fresh QR refresh cancels an existing session and ignores only its expected cancellation',async t=>{
  const f=await fixture(t,{qrCancelEvent:true});
  await f.driver.call('get_login_qrcode');
  assert.equal(f.calls.filter(c=>c[0]==='abort-polling').length,0);
  await f.driver.call('get_login_qrcode',{refresh:true});
  assert.equal(f.calls.filter(c=>c[0]==='abort-polling').length,1);
  assert.equal((await f.driver.call('get_login_state')).qr_failure,null);
  f.listener().onQRCodeSessionFailed(8,9,'private native diagnostics');
  const failed=await f.driver.call('get_login_state');
  assert.equal(failed.stage,'qr_session_expired');assert.deepEqual(failed.qr_failure,{reason:8,code:9});
  assert.equal(JSON.stringify(failed).includes('private native diagnostics'),false);
  await f.driver.call('get_login_qrcode');assert.equal(f.calls.filter(c=>c[0]==='qr').length,3);
});
test('QR login saves native remember preferences only when explicitly selected',async t=>{
  const f=await fixture(t);await f.driver.call('get_login_qrcode',{remember_login:true});
  assert.deepEqual(f.calls.filter(c=>['remember','auto-login'].includes(c[0])),[['remember',true],['auto-login',true]]);
  await f.driver.call('get_login_qrcode',{refresh:true,remember_login:false});
  assert.deepEqual(f.calls.filter(c=>['remember','auto-login'].includes(c[0])).slice(-2),[['remember',false],['auto-login',false]]);
  await assert.rejects(f.driver.call('get_login_qrcode',{refresh:true,remember_login:'yes'}),e=>e.retcode===1400);
});
test('fresh QR authentication binds generated QR, confirmed account and matching logged-in callback',async t=>{
  const f=await fixture(t,{autoUser:false});await f.driver.call('get_login_qrcode');await f.select();
  // No account session is initialized until the matching native callback.
  assert.equal(f.sessions.length,0);f.listener().onUserLoggedIn(account.uin);await nextTurn();await nextTurn();
  assert.equal(f.sessions[0].authenticationEvidence(),true);await f.driver.stop();assert.equal(f.sessions[0].authenticationEvidence(),false);
});
test('native auto-restore can precede cache enumeration without inventing a QR scan',async t=>{
  let resolveList;const f=await fixture(t,{loginUin:account.uin,quickResult:{result:'0'},loginList:()=>new Promise(resolve=>resolveList=resolve)});
  f.listener().onQRCodeLoginSucceed(account);await nextTurn();await nextTurn();
  const state=await f.driver.call('get_login_state');assert.equal(state.scan_confirmed,false);assert.equal(state.remembered_login.selected_via_cache,true);assert.equal(state.authenticated,true);
  assert.equal(f.calls.filter(c=>c[0]==='qr').length,0);resolveList({result:0,LocalLoginInfoList:[]});await nextTurn();
});
test('unsolicited native auto-restore cannot select another account',async t=>{
  const f=await fixture(t,{loginUin:account.uin,loginList:{result:0,LocalLoginInfoList:[]}});
  f.listener().onQRCodeLoginSucceed({...account,uin:'987654321'});await nextTurn();
  assert.equal(f.sessions.length,0);assert.equal(f.driver.status().online,false);assert.equal(f.driver.status().stage,'callback_error');
});
