import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoginFlow } from '../src/native/login-flow.mjs';

test('real QR callback initiates the selected account once; selection is not authentication', async () => {
  let complete; const calls = [];
  const result = new Promise(resolve => { complete = resolve; });
  const flow = createLoginFlow({ quickLogin: async uin => { calls.push(uin); return result; } });
  const pending = flow.onQRCodeLoginSucceed({ uin: '1234567890', uid: 'fixture', nickName: 'Test' });
  flow.onQRCodeLoginSucceed({ uin: '1234567890' });
  await Promise.resolve();
  assert.deepEqual(calls, ['1234567890']);
  flow.onUserLoggedIn('1234567890');
  assert.equal(flow.snapshot().scan_confirmed, true);
  assert.equal(flow.snapshot().account_selected, true);
  assert.equal(flow.snapshot().authenticated, false);
  complete({ result: 0 }); await pending;
  assert.equal(flow.snapshot().authenticated, true);
  assert.equal(flow.snapshot().stage, 'authenticated_session_pending');
  assert.equal('online' in flow.snapshot(), false);
});

test('unknown state numbers, rejected login and invalid account data never imply success', async () => {
  const calls = [];
  const flow = createLoginFlow({ quickLogin: async uin => { calls.push(uin); throw new Error('private native details'); } });
  flow.onQRCodeLoginSucceed({ uin: 'not-an-account' });
  flow.onLoginState(0);
  assert.equal(flow.snapshot().authenticated, false);
  assert.equal(calls.length, 0);
  await flow.onQRCodeLoginSucceed({ uin: '1234567890' });
  assert.equal(flow.snapshot().stage, 'account_login_failed');
  assert.equal(JSON.stringify(flow.snapshot()).includes('private native details'), false);
});

test('stopping a native flow prevents a late successful login from changing state', async () => {
  let complete; let changes = 0;
  const flow = createLoginFlow({ quickLogin: () => new Promise(resolve => { complete = resolve; }), onChange: () => { changes++; } });
  const pending = flow.onQRCodeLoginSucceed({ uin: '1234567890' });
  await Promise.resolve(); flow.stop(); const count = changes;
  complete({ result: 0 }); await pending;
  assert.equal(changes, count);
  assert.equal(flow.snapshot().authenticated, false);
});

test('stop before leaving the callback prevents a queued native login request', async () => {
  let calls = 0;
  const flow = createLoginFlow({ quickLogin: async () => { calls++; return { result: 0 }; } });
  const pending = flow.onQRCodeLoginSucceed({ uin: '1234567890' });
  flow.stop(); await pending;
  assert.equal(calls, 0);
});

test('explicit remembered-account selection uses its native cache permission without inventing a QR confirmation', async () => {
  const calls = [];
  const flow = createLoginFlow({ quickLogin: async uin => { calls.push(uin); return { result: 0 }; } });
  flow.onRememberedAccountSelected({ uin: '1234567890', uid: 'fixture_uid', isQuickLogin: false });
  await Promise.resolve(); assert.equal(calls.length, 0);
  await flow.onRememberedAccountSelected({ uin: '1234567890', uid: 'fixture_uid', isQuickLogin: true });
  assert.deepEqual(calls, ['1234567890']);
  assert.equal(flow.snapshot().scan_confirmed, false);
  assert.equal(flow.snapshot().account_selected, true);
  assert.equal(flow.snapshot().authenticated, true);
});

test('verified string login code zero and canonical int32 errors have the same meaning as numeric codes', async () => {
  for (const value of [0, '0']) {
    const flow = createLoginFlow({ quickLogin: async () => ({ result: value }) });
    await flow.onRememberedAccountSelected({ uin: '1234567890', uid: 'fixture_uid', isQuickLogin: true });
    assert.equal(flow.snapshot().login_result_code, 0);
    assert.equal(flow.snapshot().authenticated, true);
    assert.equal(flow.snapshot().self_id, 1234567890);
    assert.equal(flow.snapshot().authenticated_evidence, 'native_login_result');
    assert.equal(flow.snapshot().stage, 'authenticated_session_pending');
  }
  for (const value of [1, '1', '-1', '-2147483648', '2147483647']) {
    const flow = createLoginFlow({ quickLogin: async () => ({ result: value }) });
    await flow.onRememberedAccountSelected({ uin: '1234567890', uid: 'fixture_uid', isQuickLogin: true });
    assert.equal(flow.snapshot().login_result_code, Number(value));
    assert.equal(flow.snapshot().authenticated, false);
    assert.equal(flow.snapshot().self_id, 0);
    assert.equal(flow.snapshot().account_selected, false);
  }
});

test('unknown or noncanonical login results retain selected identity without granting authentication', async () => {
  for (const value of [undefined, null, true, false, 'unknown', '', '00', '01', '-0', '+0', ' 0', '0 ', '0.0', '0e0', '2147483648', '-2147483649', NaN, Infinity, 0.5, 2147483648]) {
    const flow = createLoginFlow({ quickLogin: async () => ({ result: value }) });
    await flow.onRememberedAccountSelected({ uin: '1234567890', uid: 'fixture_uid', isQuickLogin: true });
    assert.equal(flow.snapshot().login_result_code, null);
    assert.equal(flow.snapshot().authenticated, false);
    assert.equal(flow.snapshot().account_selected, true);
    assert.equal(flow.snapshot().self_id, 1234567890);
    assert.equal(flow.snapshot().stage, 'login_result_unrecognized');
    flow.onUserLoggedIn('1234567890');
    flow.onSessionOnlineEvidence({ session_ready: true, online: true, online_message_observed: true, msf_status: 1, msf_error: 0 });
    assert.equal(flow.snapshot().authenticated, true);
    assert.equal(flow.snapshot().authenticated_evidence, 'native_online_message');
  }
});

test('verified live-message evidence confirms the account without inventing a legacy login result', async () => {
  let complete;
  const flow = createLoginFlow({ quickLogin: () => new Promise(resolve => { complete = resolve; }) });
  const pending = flow.onQRCodeLoginSucceed({ uin: '1234567890' });
  await Promise.resolve(); flow.onUserLoggedIn('1234567890');
  flow.onSessionOnlineEvidence({ session_ready: true, online: false, online_message_observed: true, msf_status: 1, msf_error: 0 });
  assert.equal(flow.snapshot().authenticated, false);
  flow.onSessionOnlineEvidence({ session_ready: true, online: true, online_message_observed: true, msf_status: 1, msf_error: 0 });
  assert.equal(flow.snapshot().authenticated, true);
  assert.equal(flow.snapshot().authenticated_evidence, 'native_online_message');
  assert.equal(flow.snapshot().login_result_code, null);
  complete({ result: 7 }); await pending;
  assert.equal(flow.snapshot().authenticated, true);
  assert.equal(flow.snapshot().login_result_code, 7);
  flow.onDisconnected();
  assert.equal(flow.snapshot().authenticated, false);
  assert.equal(flow.snapshot().authenticated_evidence, null);
});

test('a different account callback cannot inherit a previous account authentication', async () => {
  const flow = createLoginFlow({ quickLogin: async () => ({ result: 0 }) });
  await flow.onQRCodeLoginSucceed({ uin: '1234567890' });
  assert.equal(flow.snapshot().authenticated, true);
  flow.onUserLoggedIn('9876543210');
  const account = flow.snapshot();
  assert.equal(account.authenticated && account.self_id === 9876543210, false);
});

test('an account change invalidates a late successful result for the previous account', async () => {
  let complete;
  const flow = createLoginFlow({ quickLogin: () => new Promise(resolve => { complete = resolve; }) });
  const pending = flow.onQRCodeLoginSucceed({ uin: '1234567890' });
  await Promise.resolve();
  flow.onUserLoggedIn('9876543210');
  complete({ result: 0 });
  await pending;
  assert.equal(flow.snapshot().authenticated, false);
});

test('disconnect clears the previous QR selection and identity for a new login attempt', async () => {
  const flow = createLoginFlow({ quickLogin: async () => ({ result: 0 }) });
  await flow.onQRCodeLoginSucceed({ uin: '1234567890' });
  flow.onUserLoggedIn('1234567890');
  flow.onDisconnected();
  const account = flow.snapshot();
  assert.equal(account.authenticated, false);
  assert.equal(account.scan_confirmed, false);
  assert.equal(account.account_selected, false);
  assert.equal(account.self_id, 0);
});

test('native failure and stop cannot retain an earlier authenticated state', async () => {
  for (const action of ['onFailed', 'stop']) {
    const flow = createLoginFlow({ quickLogin: async () => ({ result: 0 }) });
    await flow.onQRCodeLoginSucceed({ uin: '1234567890' });
    assert.equal(flow.snapshot().authenticated, true);
    flow[action]();
    assert.equal(flow.snapshot().authenticated, false);
  }
});

test('a new QR account needs its own native result before inheriting authentication', async () => {
  const calls = []; let completeSecond;
  const flow = createLoginFlow({ quickLogin: uin => {
    calls.push(uin);
    return uin === '1234567890' ? Promise.resolve({ result: 0 }) : new Promise(resolve => { completeSecond = resolve; });
  } });
  await flow.onQRCodeLoginSucceed({ uin: '1234567890' });
  const pending = flow.onQRCodeLoginSucceed({ uin: '9876543210' });
  await Promise.resolve();
  assert.deepEqual(calls, ['1234567890', '9876543210']);
  assert.equal(flow.snapshot().self_id, 9876543210);
  assert.equal(flow.snapshot().authenticated, false);
  completeSecond({ result: 0 });
  await pending;
  assert.equal(flow.snapshot().authenticated, true);
  assert.equal(flow.snapshot().self_id, 9876543210);
});
