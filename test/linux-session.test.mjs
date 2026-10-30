import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createLinuxSession } from '../src/native/linux-session.mjs';

async function fixture(t, overrides = {}) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'qqbridge-session-test-'));
  const order = [], state = {}, forwarded = [], observed = [];
  const account = { uin: '123456789', uid: 'u_fixture_account' };
  const msgService = {
    addKernelMsgListener(value) { state.msgListener = value; },
    removeKernelMsgListener(value) { assert.equal(value, state.msgListener); state.msgRemoved = true; },
  };
  const groupService = {
    addKernelGroupListener(value) { state.groupListener = value; },
    removeKernelGroupListener(value) { assert.equal(value, state.groupListener); state.groupRemoved = true; },
  };
  const session = {
    init(config, depends, dispatcher, listener) {
      order.push('init'); Object.assign(state, { config, depends, dispatcher, listener });
      overrides.onInit?.(state);
    },
    getMsgService: () => msgService,
    getGroupService: () => groupService,
    onDispatchPush: (...args) => { assert.notEqual(state.inNativeCallback, true); forwarded.push(['push', ...args]); },
    onDispatchPushWithJson: (...args) => forwarded.push(['json', ...args]),
    onDispatchRequestReply: (...args) => forwarded.push(['reply', ...args]),
  };
  const startup = {
    getSessionIdList: () => new Map([['nt', 'nt_fixture'], ['gpro', 'gpro_fixture']]),
    start() {
      order.push('start'); state.starts = (state.starts ?? 0) + 1;
      if (overrides.autoComplete !== false) queueMicrotask(() => {
        state.listener.onNTSessionCreate(0, 'nt_fixture');
        state.listener.onSessionInitComplete(overrides.initCode ?? 0, '', overrides.returnedUid ?? account.uid);
      });
      return overrides.startResult ?? 0;
    },
  };
  const native = {
    NodeIQQNTStartupSessionWrapper: { create: () => { order.push('create'); return startup; } },
    NodeIQQNTWrapperSession: { getNTWrapperSession(id) { assert.equal(id, 'nt_fixture'); return session; } },
  };
  const core = createLinuxSession({
    native, engine: { readyToShow() { order.push('readyToShow'); }, getDeviceInfo: () => ({ guid: 'fixture-device' }) },
    account, profile, metadata: { version: '3.2.34-53644', appid: { linux: '537391511' } }, machineId: 'fixture-machine',
    onState: value => observed.push(['state', value.online]),
    onMessage: value => observed.push(['message', value]),
    onGroupList: value => observed.push(['groups', value]),
    onUnsupportedDependency: value => observed.push(['unsupported', value]),
    initTimeoutMs: 1000,
    ...overrides.options,
  });
  t.after(async () => {
    await core.stop();
    const absolute = path.resolve(profile), tempRoot = path.resolve(os.tmpdir()) + path.sep;
    if (!absolute.startsWith(tempRoot) || !path.basename(absolute).startsWith('qqbridge-session-test-')) throw new Error('Unexpected test cleanup target.');
    await rm(absolute, { recursive: true, force: true });
  });
  return { core, order, state, account, forwarded, observed, session, msgService, groupService };
}

test('uses the native module-to-session map and initializes before the one-time startup', async t => {
  const f = await fixture(t);
  assert.throws(() => f.core.getServices(), /not initialized/);
  const first = f.core.start();
  assert.equal(f.core.start(), first);
  const result = await first;
  assert.deepEqual(f.order, ['create', 'readyToShow', 'init', 'start']);
  assert.equal(f.state.starts, 1);
  assert.equal(result.session_ready, true);
  assert.equal(result.online, false);
  assert.equal(f.core.getServices().session, f.session);
  assert.equal(f.state.config.selfUin, f.account.uin);
  assert.equal(f.state.config.selfUid, f.account.uid);
  assert.equal(f.state.config.a2, '');
});

test('native result zero is insufficient when the returned account identity differs', async t => {
  const f = await fixture(t, { returnedUid: 'u_different_account', options: { getAuthenticationEvidence: () => true } });
  await assert.rejects(f.core.start(), /different identity/);
  f.state.depends.onMSFStatusChange(1, 0);
  assert.equal(f.core.status().session_ready, false);
  assert.equal(f.core.status().online, false);
});

test('an early init callback cannot mask an unsuccessful startup result', async t => {
  const f = await fixture(t, {
    startResult: 9,
    onInit: ({ listener, config }) => listener.onSessionInitComplete(0, '', config.selfUid),
  });
  await assert.rejects(f.core.start(), /Unable to initialize/);
  await nextTurn();
  assert.equal(f.core.status().session_ready, false);
});

test('a missing native completion times out without becoming ready', async t => {
  const f = await fixture(t, { autoComplete: false, options: { initTimeoutMs: 15 } });
  await assert.rejects(f.core.start(), /timed out/);
  assert.equal(f.core.status().init_result, null);
  assert.equal(f.core.status().session_ready, false);
});

test('MSF connection and imported messages do not fake online, and status precedes the first real event', async t => {
  const f = await fixture(t); await f.core.start();
  f.state.depends.onMSFStatusChange(1, 0);
  assert.equal(f.core.status().online, false);
  f.state.msgListener.onRecvMsg([{ isOnlineMsg: true, isImportMsg: true }]);
  assert.equal(f.core.status().online, false);
  f.state.msgListener.onRecvMsg([{ isOnlineMsg: true }]);
  assert.equal(f.core.status().online, false);
  f.observed.length = 0;
  const batch = [{ isOnlineMsg: true, isImportMsg: false }];
  f.state.msgListener.onRecvMsg(batch);
  assert.deepEqual(f.observed, [['state', true], ['message', batch]]);
  assert.equal(f.core.status().online, true);
  assert.equal(f.core.status().authentication_evidence, 'native_online_message');
  f.state.depends.onMSFStatusChange(0, 0);
  assert.equal(f.core.status().online, false);
});

test('verified native login evidence permits a quiet initialized session without inventing an incoming message', async t => {
  const f = await fixture(t, { options: { getAuthenticationEvidence: () => true } });
  assert.equal(f.core.status().online, false);
  await f.core.start();
  assert.equal(f.core.status().online, false);
  f.state.depends.onMSFStatusChange(1, 0);
  const status = f.core.status();
  assert.equal(status.online, true);
  assert.equal(status.good, true);
  assert.equal(status.online_message_observed, false);
  assert.equal(status.native_login_authenticated, true);
  assert.equal(status.authentication_evidence, 'native_login_result');
  assert.equal(f.observed.filter(event => event[0] === 'message').length, 0);
});

test('authentication getter is strict, fails closed on exceptions, and does not recurse through status', async t => {
  let mode = 'false', core;
  const f = await fixture(t, { options: { getAuthenticationEvidence: () => {
    if (mode === 'throw') throw new Error('private authentication detail');
    if (mode === 'truthy') return 'true';
    if (mode === 'recursive') return core.status().session_ready;
    return false;
  } } });
  core = f.core; await core.start(); f.state.depends.onMSFStatusChange(1, 0);
  for (mode of ['false', 'throw', 'truthy', 'recursive']) {
    assert.equal(core.status().online, false);
    assert.equal(core.status().native_login_authenticated, false);
    assert.equal(core.status().authentication_evidence, null);
  }
  mode = 'throw';
  f.state.msgListener.onRecvMsg([{ isOnlineMsg: true, isImportMsg: false }]);
  assert.equal(core.status().online, true);
  assert.equal(core.status().native_login_authenticated, false);
  assert.equal(core.status().authentication_evidence, 'native_online_message');
});

test('native login evidence cannot bypass withdrawal, MSF errors, or unsupported dependencies', async t => {
  let evidence = true;
  const f = await fixture(t, { options: { getAuthenticationEvidence: () => evidence } });
  await f.core.start(); f.state.depends.onMSFStatusChange(1, 0);
  assert.equal(f.core.status().online, true);
  evidence = false;
  assert.equal(f.core.status().online, false);
  evidence = true; f.state.depends.onMSFStatusChange(1, 9);
  assert.equal(f.core.status().online, false);
  f.state.depends.onMSFStatusChange(1, 0);
  assert.equal(f.core.status().online, true);
  f.state.depends.getLoginTicket('not-a-ticket');
  assert.equal(f.core.status().online, false);
  assert.equal(f.core.status().native_login_authenticated, true);
  await f.core.stop();
  assert.equal(f.core.status().online, false);
});

test('group-list notifications forward the second argument array', async t => {
  const f = await fixture(t); await f.core.start();
  const groups = [{ groupCode: '987654321', groupName: 'fixture' }];
  f.state.groupListener.onGroupListUpdate(0, groups);
  assert.deepEqual(f.observed.find(value => value[0] === 'groups')[1], [{ ...groups[0], memberCount: 0, maxMember: 0 }]);
  assert.equal(f.core.status().group_count, 1);
});

test('empty no-change and unknown group updates preserve a complete snapshot', async t => {
  const f = await fixture(t); await f.core.start();
  const groups = [{ groupCode: '111111111', groupName: 'one' }, { groupCode: '222222222', groupName: 'two' }];
  f.state.groupListener.onGroupListUpdate(0, groups);
  const notifications = () => f.observed.filter(value => value[0] === 'groups');
  assert.equal(notifications().length, 1);
  f.state.groupListener.onGroupListUpdate(4, []);
  assert.equal(f.core.status().group_count, 2);
  assert.equal(f.core.status().group_update_kind, 4);
  f.state.groupListener.onGroupListUpdate(99, []);
  f.state.groupListener.onGroupListUpdate('0', []);
  assert.equal(f.core.status().group_count, 2);
  assert.equal(f.core.status().group_update_kind, 99);
  assert.equal(f.core.status().group_snapshot_ready, true);
  assert.equal(notifications().length, 1);
});

test('group upserts merge and removals publish the remaining full snapshot', async t => {
  const f = await fixture(t); await f.core.start();
  const update = f.state.groupListener.onGroupListUpdate;
  update(1, [{ groupCode: '111111111', groupName: 'one', memberCount: 2, maxMember: 500 }, { groupCode: '222222222', groupName: 'two' }]);
  update(2, [{ groupCode: '111111111', memberCount: 3 }, { groupCode: '333333333', groupName: 'three' }]);
  const last = () => f.observed.filter(value => value[0] === 'groups').at(-1)[1];
  assert.equal(last().length, 3);
  assert.deepEqual(last().find(group => group.groupCode === '111111111'), { groupCode: '111111111', groupName: 'one', memberCount: 3, maxMember: 500 });
  update(3, [{ groupCode: '222222222', unrelated: 'not-retained' }]);
  assert.deepEqual(last().map(group => group.groupCode), ['111111111', '333333333']);
  assert.equal(f.core.status().group_count, 2);
});

test('group deltas before a complete snapshot do not claim a full list', async t => {
  const f = await fixture(t); await f.core.start();
  const update = f.state.groupListener.onGroupListUpdate;
  update(2, [{ groupCode: '111111111', groupName: 'partial' }]);
  update(3, [{ groupCode: '222222222' }]);
  update(4, []);
  assert.equal(f.core.status().group_count, 1);
  assert.equal(f.core.status().group_snapshot_ready, false);
  assert.equal(f.core.status().group_list_observed, false);
  assert.equal(f.observed.filter(value => value[0] === 'groups').length, 0);
  update(1, [{ groupCode: '333333333', groupName: 'complete' }]);
  assert.equal(f.core.status().group_snapshot_ready, true);
  assert.deepEqual(f.observed.filter(value => value[0] === 'groups').at(-1)[1].map(group => group.groupCode), ['333333333']);
});

test('group cache retains only public metadata and isolates callback mutations', async t => {
  const f = await fixture(t); await f.core.start();
  const update = f.state.groupListener.onGroupListUpdate;
  const native = { groupCode: '111111111', groupName: 'original', memberCount: 4, maxMember: 500, privateField: { secret: 'never-retained' } };
  update(0, [native]);
  const first = f.observed.find(value => value[0] === 'groups')[1];
  assert.deepEqual(Object.keys(first[0]).sort(), ['groupCode', 'groupName', 'maxMember', 'memberCount']);
  native.groupName = 'mutated native record'; first[0].groupName = 'mutated callback';
  update(2, [{ groupCode: '222222222', groupName: 'new' }]);
  const merged = f.observed.filter(value => value[0] === 'groups').at(-1)[1];
  assert.equal(merged.find(group => group.groupCode === '111111111').groupName, 'original');
  update(0, []);
  assert.equal(f.core.status().group_count, 0);
  assert.deepEqual(f.observed.filter(value => value[0] === 'groups').at(-1)[1], []);
});

test('group cache is bounded and an overflowing snapshot is not advertised as complete', async t => {
  const f = await fixture(t); await f.core.start();
  f.state.groupListener.onGroupListUpdate(0, Array.from({ length: 10001 }, (_, index) => ({ groupCode: String(100000000 + index), groupName: 'fixture' })));
  assert.equal(f.core.status().group_count, 10000);
  assert.equal(f.core.status().group_snapshot_ready, false);
  assert.equal(f.core.status().group_cache_overflow, true);
  assert.equal(f.observed.filter(value => value[0] === 'groups').length, 0);
  f.state.groupListener.onGroupListUpdate(1, [{ groupCode: '111111111', groupName: 'new complete snapshot' }]);
  assert.equal(f.core.status().group_snapshot_ready, true);
  assert.equal(f.core.status().group_cache_overflow, false);
  assert.equal(f.core.status().group_count, 1);
});

test('all three real dispatcher channels forward outside the native callback and copy bytes', async t => {
  const f = await fixture(t); await f.core.start();
  const bytes = new Uint8Array([1, 2]);
  f.state.inNativeCallback = true;
  f.state.dispatcher.dispatchCall(7, bytes);
  f.state.dispatcher.dispatchCallWithJson(8, '{"fixture":true}');
  f.state.dispatcher.dispatchRequest('fixture-request', 9, bytes);
  bytes[0] = 99;
  assert.equal(f.forwarded.length, 0);
  f.state.inNativeCallback = false;
  await nextTurn();
  assert.deepEqual(f.forwarded, [
    ['push', 7, new Uint8Array([1, 2])],
    ['json', 8, '{"fixture":true}'],
    ['reply', 'fixture-request', 9, new Uint8Array([1, 2])],
  ]);
  assert.equal(f.core.status().dispatch_processed, 3);
});

test('paused dispatcher buffering is bounded and overflow fails closed', async t => {
  const f = await fixture(t, { options: { forwardDispatcher: null } }); await f.core.start();
  for (let i = 0; i < 65; i++) f.state.dispatcher.dispatchCall(i, new Uint8Array([1]));
  assert.equal(f.core.status().dispatch_error, true);
  assert.equal(f.core.status().dispatch_pending, 0);
  assert.equal(f.core.status().online, false);
  assert.throws(() => f.core.setDispatcher(), /failed/);
});

test('unknown dependencies expose only argument shapes and never invoke a success callback', async t => {
  const f = await fixture(t); await f.core.start();
  let called = false;
  assert.equal(f.state.depends.getLoginTicket('private-fixture-ticket', () => { called = true; }), undefined);
  assert.equal(called, false);
  const diagnostic = f.observed.find(value => value[0] === 'unsupported')[1];
  assert.equal(diagnostic.name, 'getLoginTicket');
  assert.equal(JSON.stringify(diagnostic).includes('private-fixture-ticket'), false);
  f.state.depends.onMSFStatusChange(1, 0);
  f.state.msgListener.onRecvMsg([{ isOnlineMsg: true, isImportMsg: false }]);
  assert.equal(f.core.status().online, false);
});

test('repeated dispatcher loopback is stopped without an unbounded event loop', async t => {
  let state;
  const f = await fixture(t, { options: { forwardDispatcher: ({ args }) => state.dispatcher.dispatchCall(...args), getAuthenticationEvidence: () => true } });
  state = f.state; await f.core.start();
  state.depends.onMSFStatusChange(1, 0);
  assert.equal(f.core.status().online, true);
  state.dispatcher.dispatchCall(6, new Uint8Array([3]));
  await nextTurn();
  assert.equal(f.core.status().dispatch_error, true);
  assert.equal(f.core.status().dispatch_pending, 0);
  assert.equal(f.core.status().online, false);
});

test('stop detaches native listeners and prevents late message delivery', async t => {
  const f = await fixture(t); await f.core.start();
  await f.core.stop(); f.observed.length = 0;
  f.state.msgListener.onRecvMsg([{ isOnlineMsg: true }]);
  f.state.listener.onSessionInitComplete(0, '', f.account.uid);
  assert.equal(f.state.msgRemoved, true);
  assert.equal(f.state.groupRemoved, true);
  assert.equal(f.core.status().session_ready, false);
  assert.equal(f.core.status().online, false);
  assert.deepEqual(f.observed, []);
  await assert.rejects(f.core.start(), /stopped/);
});
