import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createAccountActions } from '../src/native/account-actions.mjs';

function fixture(t, { timeoutMs = 1000 } = {}) {
  const state = { ready: true, calls: 0, account: { uin: '123456789', uid: 'u_fixture', nickName: 'Fixture', ticket: 'not-exposed' } };
  const service = { getGroupList(flag) { assert.equal(flag, false); state.calls++; return Promise.resolve({ result: 0, errMsg: '' }); } };
  state.session = { status: () => ({ session_ready: state.ready }), getServices: () => ({ groupService: service }) };
  const actions = createAccountActions({ getSession: () => state.session, getAccount: () => state.account, timeoutMs });
  t.after(() => actions.close());
  return { state, service, actions };
}
const groups = () => [{ groupCode: '987654321', groupName: 'Fixture group', memberCount: 8, maxMember: 500, privateTicket: 'never-retained' }];
const expected = [{ group_id: 987654321, group_name: 'Fixture group', member_count: 8, max_member_count: 500 }];

test('login info exposes only the safe OneBot identity and nickname', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.actions.call('get_login_info'), { user_id: 123456789, nickname: 'Fixture' });
  f.state.ready = false;
  await assert.rejects(f.actions.call('get_login_info'), error => error.retcode === 1503);
});

test('unsafe, nondecimal or nonpositive account identities are rejected', async t => {
  const f = fixture(t);
  for (const uin of ['9007199254740992', '1e8', '0', '-1', '123abc', 9007199254740992]) {
    f.state.account = { ...f.state.account, uin };
    await assert.rejects(f.actions.call('get_login_info'), error => error.retcode === 1503);
  }
});

test('a native ACK with result zero does not fabricate an empty list', async t => {
  const f = fixture(t);
  let settled = false;
  const promise = f.actions.call('get_group_list').then(result => { settled = true; return result; });
  await nextTurn();
  assert.equal(settled, false);
  assert.equal(f.state.calls, 1);
  f.actions.updateGroupList([]);
  assert.deepEqual(await promise, []);
});

test('the waiter exists before native entry, including a synchronous list notification', async t => {
  const f = fixture(t);
  f.service.getGroupList = flag => {
    assert.equal(flag, false); f.state.calls++;
    f.actions.updateGroupList(groups());
    return Promise.resolve({ result: 0 });
  };
  assert.deepEqual(await f.actions.call('get_group_list'), expected);
  assert.equal(f.state.calls, 1);
});

test('concurrent readers share one request but receive independent sanitized results', async t => {
  const f = fixture(t);
  const first = f.actions.call('get_group_list'), second = f.actions.call('get_group_list');
  await nextTurn();
  assert.equal(f.state.calls, 1);
  f.actions.updateGroupList(groups());
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, expected); assert.deepEqual(b, expected);
  a[0].group_name = 'modified';
  assert.equal(b[0].group_name, 'Fixture group');
  assert.deepEqual(await f.actions.call('get_group_list'), expected);
  assert.equal(f.state.calls, 1);
});

test('group updates reject invalid IDs and retain no original extra fields or mutable references', async t => {
  const f = fixture(t);
  const native = groups();
  native.push(...['9007199254740992', '0', '2e6', '-7', 'not-a-group'].map(groupCode => ({ groupCode })));
  assert.equal(f.actions.updateGroupList(native), true);
  native[0].groupName = 'changed after callback';
  assert.deepEqual(await f.actions.call('get_group_list'), expected);
  assert.equal(f.state.calls, 0);
});

test('native failure ACK is rejected even when a notification arrived first', async t => {
  const f = fixture(t);
  f.service.getGroupList = () => {
    f.actions.updateGroupList(groups());
    return Promise.resolve({ result: 9, errMsg: 'private-native-value' });
  };
  await assert.rejects(f.actions.call('get_group_list'), error => error.retcode === 1503 && !error.message.includes('private-native-value'));
});

test('native exceptions and rejected promises do not expose their raw errors', async t => {
  const f = fixture(t);
  for (const mode of ['throw', 'reject']) {
    f.service.getGroupList = () => {
      if (mode === 'throw') throw new Error('private-native-ticket');
      return Promise.reject(new Error('private-native-ticket'));
    };
    await assert.rejects(f.actions.call('get_group_list'), error => error.retcode === 1503 && !error.message.includes('private-native-ticket'));
  }
});

test('ACK without an actual list times out explicitly', async t => {
  const f = fixture(t, { timeoutMs: 15 });
  await assert.rejects(f.actions.call('get_group_list'), error => error.retcode === 1504);
});

test('cache is invalidated across an account/session change', async t => {
  const f = fixture(t);
  f.actions.updateGroupList(groups());
  assert.deepEqual(await f.actions.call('get_group_list'), expected);
  f.state.account = { uin: '222222222', uid: 'u_other', nickName: 'Other' };
  const pending = f.actions.call('get_group_list');
  await nextTurn();
  assert.equal(f.state.calls, 1);
  f.actions.updateGroupList([]);
  assert.deepEqual(await pending, []);
});

test('changing the account rejects pending readers rather than reusing old state', async t => {
  const f = fixture(t);
  const old = f.actions.call('get_group_list');
  const rejected = assert.rejects(old, error => error.retcode === 1503);
  f.state.account = { uin: '222222222', uid: 'u_other', nickName: 'Other' };
  assert.deepEqual(await f.actions.call('get_login_info'), { user_id: 222222222, nickname: 'Other' });
  await rejected;
});

test('close rejects all pending readers and ignores later native notifications', async t => {
  const f = fixture(t);
  const promises = [f.actions.call('get_group_list'), f.actions.call('get_group_list')];
  const rejected = promises.map(promise => assert.rejects(promise, error => error.retcode === 1503));
  f.actions.close();
  await Promise.all(rejected);
  assert.equal(f.actions.updateGroupList(groups()), false);
  await assert.rejects(f.actions.call('get_login_info'), /closed/);
});
