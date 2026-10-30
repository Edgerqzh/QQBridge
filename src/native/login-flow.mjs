function resultCode(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff ? value : null;
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d{0,9})$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= -0x80000000 && parsed <= 0x7fffffff && String(parsed) === value ? parsed : null;
}

/** QR confirmation, account selection and a usable message session are distinct.
 * Confirm authentication from a native login result or verified live-session evidence. */
export function createLoginFlow({ quickLogin, onChange = () => {} }) {
  let stopped = false;
  let generation = 0;
  let pending = null;
  let state = {
    stage: 'created', scan_confirmed: false, account_selected: false,
    authenticated: false, self_id: 0, nickname: '', login_state: null,
    login_result_code: null, login_result_fields: [], authenticated_evidence: null,
  };
  const publish = () => { if (!stopped) onChange({ ...state }); };
  const validUin = value => typeof value === 'string' && /^[1-9]\d{4,14}$/.test(value) && Number.isSafeInteger(Number(value));
  function begin(ownUin) {
    if (stopped || !validUin(ownUin)) return;
    if (pending?.uin === ownUin) return pending.promise;
    if (state.authenticated && state.self_id === Number(ownUin)) return;
    const current = ++generation;
    state = { ...state, stage: 'account_login_pending', self_id: Number(ownUin), authenticated: false, login_result_code: null };
    publish();
    // Leave the native callback before entering another native login operation.
    const promise = Promise.resolve().then(() => {
      if (stopped || current !== generation) return;
      return quickLogin(ownUin);
    }).then(result => {
      if (stopped || current !== generation) return;
      pending = null;
      // The verified native remembered-login response uses result: '0'.
      // Recognize canonical int32 decimal strings without coercing unknown data.
      const code = resultCode(result?.result);
      if (state.authenticated_evidence === 'native_qr_login' && (code === null || code === 0)) { state = { ...state, login_result_code: code }; publish(); return; }
      if (state.authenticated_evidence === 'native_online_message') {
        state = { ...state, login_result_code: code }; publish(); return;
      }
      state = { ...state, authenticated: code === 0, authenticated_evidence: code === 0 ? 'native_login_result' : null, login_result_code: code,
        login_result_fields: result && typeof result === 'object' ? Object.keys(result).slice(0, 64) : [],
        stage: code === 0 ? 'authenticated_session_pending' : code === null ? 'login_result_unrecognized' : 'account_login_failed',
      };
      // An unknown completion value is not proof of failure. Keep the verified
      // selected identity so later native account/session callbacks can proceed.
      if (code !== null && code !== 0) state = { ...state, scan_confirmed: false, account_selected: false, self_id: 0, nickname: '' };
      publish();
    }, () => {
      if (stopped || current !== generation) return;
      pending = null;
      if (state.authenticated_evidence === 'native_online_message') return;
      state = { ...state, stage: 'account_login_failed', authenticated: false, authenticated_evidence: null, scan_confirmed: false, account_selected: false, self_id: 0, nickname: '' };
      publish();
    });
    pending = { uin: ownUin, promise };
    return promise;
  }
  return {
    snapshot() { return { ...state, login_result_fields: [...state.login_result_fields] }; },
    onQRCodeLoginSucceed(info) {
      if (stopped || !info || !validUin(info.uin)) return;
      const sameAccount = state.self_id === Number(info.uin);
      if (!sameAccount) {
        generation++; pending = null;
        state = { ...state, authenticated: false, authenticated_evidence: null, account_selected: false };
      }
      state = { ...state, scan_confirmed: true, nickname: typeof info.nickName === 'string' ? info.nickName.slice(0, 256) : sameAccount ? state.nickname : '', self_id: Number(info.uin) };
      return begin(info.uin);
    },
    onRememberedAccountSelected(info) {
      if (stopped || !info || info.isQuickLogin !== true || !validUin(info.uin) || typeof info.uid !== 'string' || !info.uid) return;
      const sameAccount = state.self_id === Number(info.uin);
      if (!sameAccount) {
        generation++; pending = null;
        state = { ...state, authenticated: false, authenticated_evidence: null };
      }
      state = { ...state, scan_confirmed: false, account_selected: true, self_id: Number(info.uin), nickname: typeof info.nickName === 'string' ? info.nickName.slice(0, 256) : sameAccount ? state.nickname : '' };
      return begin(info.uin);
    },
    onNativeAccountRestored(info) {
      if (stopped || !info || !validUin(info.uin) || typeof info.uid !== 'string' || !info.uid) return;
      const sameAccount = state.self_id === Number(info.uin);
      if (!sameAccount) { generation++; pending = null; state = { ...state, authenticated: false, authenticated_evidence: null }; }
      state = { ...state, scan_confirmed: false, account_selected: true, self_id: Number(info.uin), nickname: typeof info.nickName === 'string' ? info.nickName.slice(0,256) : sameAccount ? state.nickname : '' };
      return begin(info.uin);
    },
    onUserLoggedIn(ownUin) {
      if (stopped || !validUin(ownUin)) return;
      if (state.self_id && state.self_id !== Number(ownUin)) {
        generation++; pending = null;
        state = { ...state, authenticated: false, authenticated_evidence: null, scan_confirmed: false, account_selected: false, self_id: 0, nickname: '', stage: 'unexpected_account_event' };
        publish(); return;
      }
      state = { ...state, account_selected: true, self_id: Number(ownUin), stage: state.authenticated_evidence === 'native_online_message' ? 'online' : state.authenticated ? 'authenticated_session_pending' : 'account_session_pending' };
      publish();
    },
    onLoginState(value) {
      if (stopped || !Number.isInteger(value)) return;
      state = { ...state, login_state: value };
      publish();
    },
    onSessionOnlineEvidence(evidence) {
      const confirmedQr = state.scan_confirmed === true && evidence?.authentication_evidence === 'native_qr_login' && (state.login_result_code === null || state.login_result_code === 0);
      if (stopped || !state.self_id || !state.account_selected || evidence?.session_ready !== true || evidence?.online !== true || (!confirmedQr && evidence?.online_message_observed !== true) || evidence?.msf_status !== 1 || evidence?.msf_error !== 0) return;
      state = { ...state, authenticated: true, authenticated_evidence: confirmedQr ? 'native_qr_login' : 'native_online_message', stage: 'online' };
      publish();
    },
    onDisconnected() {
      if (stopped) return;
      generation++; pending = null;
      state = { ...state, stage: 'disconnected', authenticated: false, authenticated_evidence: null, scan_confirmed: false, account_selected: false, self_id: 0, nickname: '' };
      publish();
    },
    onFailed() {
      if (stopped) return;
      generation++; pending = null;
      state = { ...state, stage: 'account_login_failed', authenticated: false, authenticated_evidence: null, scan_confirmed: false, account_selected: false, self_id: 0, nickname: '' };
      publish();
    },
    stop() {
      stopped = true; generation++; pending = null;
      state = { ...state, stage: 'stopped', authenticated: false, authenticated_evidence: null, scan_confirmed: false, account_selected: false, self_id: 0, nickname: '' };
    },
  };
}
