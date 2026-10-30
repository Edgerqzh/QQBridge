import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dependencyNames = [
  'onSendOidbRequest','onSendSSORequest','onSendNetRequest','registerMSFPushCmd',
  'registerABatchOfMSFPushCommands','getBigDataIpList','getBigDataCustomEnvIpList',
  'getBigDataTicket','getIpDirectList','getConfigFromUI','getTestEnvConfig',
  'getQFixConfigReqBodyBytes','getGroupCode','getRegisterProxyOnlineReqParam',
  'onRegisterProxyOnlineResp','getLoginTicket','getBatteryStatus','getA2Ticket',
  'getBatchMigrationFileAssistantModels','getBatchMigrationFileAssistantModelsForBatch',
  'getBatchMigrationStatus','getAppActiveStatus','onMSFStatusChange','onMSFSsoError','onSendMsfReply',
];
const mobileFolders = [
  'mobile_qq_pic_path','mobile_qq_video_path','mobile_qq_ptt_path','mobile_qq_file_path',
  'mobile_qq_market_path','mobile_qq_aplication_data_pic_path',
  'mobile_qq_aplication_data_video_path','mobile_qq_aplication_data_ptt_path',
  'mobile_qq_aplication_data_file_path',
];
const fail = message => Object.assign(new Error(message), { retcode: 1503 });
const MAX_GROUPS = 10000;
function groupKey(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  if (typeof value !== 'string' || !/^[1-9]\d{0,15}$/.test(value)) return null;
  return Number.isSafeInteger(Number(value)) ? value : null;
}
function publicGroup(record, previous) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const key = groupKey(record.groupCode);
  if (!key) return null;
  const count = (value, fallback) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff ? value : fallback ?? 0;
  return {
    groupCode: key,
    groupName: typeof record.groupName === 'string' ? record.groupName.slice(0, 256) : previous?.groupName ?? '',
    memberCount: count(record.memberCount, previous?.memberCount),
    maxMember: count(record.maxMember, previous?.maxMember),
  };
}
const nativeDispatcher = ({ name, args, session }) => {
  const method = { dispatchCall: 'onDispatchPush', dispatchCallWithJson: 'onDispatchPushWithJson', dispatchRequest: 'onDispatchRequestReply' }[name];
  session[method](...args);
};
const shape = value => {
  if (value === null) return { type: 'null' };
  if (ArrayBuffer.isView(value)) return { type: 'bytes', bytes: value.byteLength };
  if (Array.isArray(value)) return { type: 'array', length: value.length };
  if (value instanceof Map) return { type: 'map', size: value.size };
  if (typeof value === 'string') return { type: 'string', length: value.length };
  if (typeof value === 'object') return { type: 'object', keys: Object.keys(value).slice(0, 48) };
  return { type: typeof value };
};

/**
 * Account-session initialization observed on official Linux QQ 3.2.34-53644.
 * Native initialization and dispatcher readiness are reported separately.
 * This component never logs payloads, sends messages, or calls onLine. Online
 * status requires native session success, MSF state, and a verified native
 * login acknowledgement or a real online message.
 * The caller supplies the authenticated account identity.
 */
export function createLinuxSession({
  native, engine, account, profile, metadata, machineId,
  onState = () => {}, onMessage, onMessageUpdate, onGroupList, onFriendList, onFriendRequests, onAuthenticationRequired, onUnsupportedDependency = () => {},
  forwardDispatcher, initTimeoutMs = 20000, getAuthenticationEvidence = () => false, getAuthenticationEvidenceType = () => 'native_login_result',
}) {
  if (typeof account?.uin !== 'string' || !/^\d{5,12}$/.test(account.uin) ||
      typeof account.uid !== 'string' || !account.uid || account.uid.length > 128) {
    throw fail('An authenticated QQ account with a valid uin and uid is required.');
  }
  if (typeof profile !== 'string' || !path.isAbsolute(profile) || path.resolve(profile) === path.parse(profile).root) {
    throw fail('A dedicated absolute QQ profile directory is required.');
  }
  if (metadata?.version !== '3.2.34-53644' || typeof metadata?.appid?.linux !== 'string' || !metadata.appid.linux) {
    throw fail('The tested official Linux QQ build metadata is required.');
  }
  if (typeof machineId !== 'string' || !machineId || machineId.length > 256) throw fail('The existing profile machine ID is required.');
  if (!Number.isInteger(initTimeoutMs) || initTimeoutMs < 1) throw new Error('Invalid session initialization timeout.');
  if (forwardDispatcher !== undefined && forwardDispatcher !== null && typeof forwardDispatcher !== 'function') throw new Error('Invalid dispatcher forwarder.');
  if (typeof getAuthenticationEvidence !== 'function') throw new TypeError('Authentication evidence must be a pure getter.');

  const root = path.resolve(profile);
  let startup, session, msgService, groupService, buddyService, msgListener, groupListener, buddyListener;
  let startPromise, resolveStart, rejectStart, timer, stopped = false, failed = false;
  let nativeReady = false, startupAccepted = false;
  let readingAuthentication = false, recursiveAuthenticationRead = false;
  let forwarder = forwardDispatcher === undefined ? nativeDispatcher : forwardDispatcher, scheduled = false, draining = false, queueBytes = 0;
  const queue = [], fingerprints = new Map(), unsupported = new Set();
  let groupCache = new Map();
  const state = {
    stage: 'created', session_ready: false, online: false, good: false,
    init_result: null, startup_result: null, nt_session_created: false,
    dispatch_error: false, dispatch_processed: 0, dispatch_rejected: 0,
    msf_status: null, message_listener_attached: false, group_listener_attached: false,
    online_message_observed: false, message_batches_received: 0, group_list_observed: false,
    group_snapshot_ready: false, group_count: 0, group_update_kind: null, group_cache_overflow: false,
  };
  function nativeAuthenticationEvidence() {
    // The driver must read its account/generation-bound login ledger here,
    // never driver.status() or session.status(). Reject accidental recursion.
    if (readingAuthentication) { recursiveAuthenticationRead = true; return false; }
    readingAuthentication = true; recursiveAuthenticationRead = false;
    let authenticated = false;
    try { authenticated = getAuthenticationEvidence() === true; } catch {}
    finally { readingAuthentication = false; }
    return authenticated && !recursiveAuthenticationRead;
  }
  const status = () => {
    const nativeLoginAuthenticated = nativeAuthenticationEvidence();
    let nativeEvidenceType=null;try{const value=getAuthenticationEvidenceType();if(['native_login_result','native_qr_login'].includes(value))nativeEvidenceType=value;}catch{}
    const authenticationEvidence = nativeLoginAuthenticated ? nativeEvidenceType : state.online_message_observed ? 'native_online_message' : null;
    const dispatchReady = Boolean(session) && typeof forwarder === 'function' && !state.dispatch_error && !stopped;
    const online = state.session_ready && !state.authentication_revoked && state.startup_result === 0 && state.init_result === 0 && authenticationEvidence !== null && state.msf_status === 1 && state.msf_error === 0 && dispatchReady && unsupported.size === 0 && !stopped;
    return { ...state, online, good: online && !state.observer_error, dispatch_ready: dispatchReady,
      authentication_evidence: authenticationEvidence, native_login_authenticated: nativeLoginAuthenticated,
      dispatch_pending: queue.length, unsupported_dependencies: [...unsupported], stopped };
  };
  const notify = () => { try { onState(status()); } catch { /* Never throw through a native callback. */ } };
  function observer(fn, ...args) { try { fn?.(...args); } catch { state.observer_error = true; notify(); } }
  function rejectInitialization(message) {
    if (stopped || failed) return;
    failed = true; clearTimeout(timer); state.session_ready = false; state.stage = 'failed';
    rejectStart?.(fail(message)); notify();
  }
  function unsupportedDependency(name, args) {
    if (stopped) return;
    if (unsupported.size < 64) unsupported.add(name);
    observer(onUnsupportedDependency, { name, arguments: args.map(shape) });
    notify();
    // There is intentionally no success result, fabricated ticket, or callback invocation.
  }
  const depends = new Proxy(Object.fromEntries(dependencyNames.map(name => [name, (...args) => unsupportedDependency(name, args)])), {
    has: () => true,
    get(target, key) {
      if (typeof key !== 'string') return undefined;
      return target[key] ??= (...args) => unsupportedDependency(key, args);
    },
  });
  depends.onMSFStatusChange = (statusCode, errorCode) => {
    if (stopped) return;
    state.msf_status = Number.isInteger(statusCode) ? statusCode : null;
    state.msf_error = Number.isInteger(errorCode) ? errorCode : null;
    notify();
  };
  function authenticationRequired(reason) {
    if (stopped || state.authentication_revoked) return;
    state.authentication_revoked = true; notify(); observer(onAuthenticationRequired, reason);
  }
  depends.onMSFSsoError = () => authenticationRequired('sso_error');

  function blockDispatch() {
    state.dispatch_error = true; state.dispatch_rejected++; queue.length = 0; queueBytes = 0;
    notify();
  }
  function schedule() {
    if (!scheduled && !draining && !stopped && !state.dispatch_error && forwarder && queue.length) {
      scheduled = true; setImmediate(drain);
    }
  }
  async function drain() {
    scheduled = false;
    if (stopped || state.dispatch_error || draining) return;
    draining = true;
    try {
      for (let count = 0; count < 32 && forwarder && queue.length && !stopped && !state.dispatch_error; count++) {
        const packet = queue.shift(); queueBytes -= packet.bytes;
        const bytes = packet.args.find(value => value instanceof Uint8Array);
        const hash = createHash('sha256').update(packet.name).update(String(packet.args[0]));
        hash.update(bytes ?? String(packet.args.at(-1)));
        const fingerprint = hash.digest('hex'), previous = fingerprints.get(fingerprint), now = Date.now();
        const repeats = previous && now - previous.at < 1000 ? previous.count + 1 : 1;
        fingerprints.set(fingerprint, { at: now, count: repeats });
        if (fingerprints.size > 128) fingerprints.delete(fingerprints.keys().next().value);
        if (repeats > 8) { blockDispatch(); break; }
        try { await forwarder({ name: packet.name, args: packet.args, session }); state.dispatch_processed++; }
        catch { blockDispatch(); break; }
      }
    } finally { draining = false; notify(); schedule(); }
  }
  function enqueue(name, args) {
    if (stopped || state.dispatch_error) return;
    const command = args[name === 'dispatchRequest' ? 1 : 0];
    const payload = args[name === 'dispatchRequest' ? 2 : 1];
    if (!Number.isInteger(command) || command < -2147483648 || command > 2147483647) return blockDispatch();
    if (name === 'dispatchRequest' && (typeof args[0] !== 'string' || !args[0] || args[0].length > 256)) return blockDispatch();
    let data, bytes;
    if (name === 'dispatchCallWithJson') {
      if (typeof payload !== 'string') return blockDispatch();
      data = payload; bytes = Buffer.byteLength(payload);
    } else {
      if (!(payload instanceof Uint8Array)) return blockDispatch();
      if (payload.byteLength > 1024 * 1024) return blockDispatch();
      data = new Uint8Array(payload); bytes = data.byteLength;
    }
    if (bytes > 1024 * 1024 || queue.length >= 64 || queueBytes + bytes > 4 * 1024 * 1024) return blockDispatch();
    queue.push({ name, args: name === 'dispatchRequest' ? [args[0], command, data] : [command, data], bytes });
    queueBytes += bytes; schedule();
  }
  const dispatcher = {
    dispatchCall: (...args) => enqueue('dispatchCall', args),
    dispatchCallWithJson: (...args) => enqueue('dispatchCallWithJson', args),
    dispatchRequest: (...args) => enqueue('dispatchRequest', args),
  };
  function notificationAdapter(handlers) {
    return new Proxy(handlers, { has: () => true, get(target, key) {
      if (typeof key !== 'string') return undefined;
      return target[key] ??= () => {}; // Optional notification; no native request completion is forged.
    } });
  }
  function updateGroups(kind, groups) {
    if (stopped) return;
    if (Number.isInteger(kind)) state.group_update_kind = kind;
    // The native API uses 0/1 for complete snapshots, 2 for upsert, 3 for
    // removal, and 4 for no change. Empty deltas are not empty snapshots.
    if (!Number.isInteger(kind) || !Array.isArray(groups) || ![0, 1, 2, 3].includes(kind)) { notify(); return; }
    if (kind === 0 || kind === 1) {
      const snapshot = new Map();
      let overflow = false;
      for (const record of groups) {
        const value = publicGroup(record);
        if (!value) continue;
        if (snapshot.has(value.groupCode) || snapshot.size < MAX_GROUPS) snapshot.set(value.groupCode, value);
        else overflow = true;
      }
      groupCache = snapshot;
      state.group_cache_overflow = overflow;
      state.group_snapshot_ready = !overflow;
    } else if (kind === 2) {
      for (const record of groups) {
        const key = groupKey(record?.groupCode);
        const value = key ? publicGroup(record, groupCache.get(key)) : null;
        if (!value) continue;
        if (groupCache.has(key) || groupCache.size < MAX_GROUPS) groupCache.set(key, value);
        else { state.group_cache_overflow = true; state.group_snapshot_ready = false; }
      }
    } else {
      for (const record of groups) {
        const key = groupKey(record?.groupCode);
        if (key) groupCache.delete(key);
      }
    }
    state.group_count = groupCache.size;
    state.group_list_observed = state.group_snapshot_ready;
    if (state.group_snapshot_ready) observer(onGroupList, [...groupCache.values()].map(record => ({ ...record })));
    notify();
  }
  function attachServices() {
    msgService = session.getMsgService(); groupService = session.getGroupService();
    buddyService = session.getBuddyService?.();
    if (buddyService && (typeof onFriendList === 'function'||typeof onFriendRequests==='function')) {
      buddyListener = notificationAdapter({ onBuddyListChange: rows => { if (!stopped) observer(onFriendList, rows); },onBuddyReqChange: rows=>{if(!stopped)observer(onFriendRequests,rows);} });
      buddyService.addKernelBuddyListener(buddyListener);
    }
    msgListener = notificationAdapter({ onRecvMsg: raw => {
      if (stopped || !Array.isArray(raw)) return;
      state.message_batches_received++;
      if (raw.some(message => message?.isOnlineMsg === true && message?.isImportMsg === false)) state.online_message_observed = true;
      notify(); observer(onMessage, raw);
    }, onMsgInfoListUpdate: raw => {
      if (!stopped && Array.isArray(raw)) observer(onMessageUpdate, raw);
    }, onKickedOffLine: () => authenticationRequired('kicked_offline') });
    msgService.addKernelMsgListener(msgListener); state.message_listener_attached = true;
    if (typeof onGroupList === 'function') {
      groupListener = notificationAdapter({ onGroupListUpdate: updateGroups });
      groupService.addKernelGroupListener(groupListener); state.group_listener_attached = true;
    }
  }
  function completeReady() {
    if (!nativeReady || !startupAccepted || stopped || failed || state.session_ready) return;
    queueMicrotask(() => {
      if (!startupAccepted || stopped || failed || state.session_ready) return;
      try { attachServices(); }
      catch { return rejectInitialization('QQ native service listener registration failed.'); }
      clearTimeout(timer); state.session_ready = true; state.stage = 'session_initialized'; notify(); resolveStart?.(status());
    });
  }
  const listener = notificationAdapter({
    onNTSessionCreate(code) {
      if (stopped || failed) return;
      state.nt_session_created = code === 0;
      if (code !== 0) return rejectInitialization('QQ native account session creation failed.');
      notify();
    },
    onSessionFileSysChecked() { if (!stopped) { state.file_system_event_seen = true; notify(); } },
    onSessionInitComplete(code, _message, uid) {
      if (stopped || failed || state.session_ready) return;
      state.init_result = Number.isInteger(code) ? code : null;
      if (code !== 0 || uid !== account.uid) return rejectInitialization('QQ native account session initialization failed or returned a different identity.');
      nativeReady = true; completeReady();
    },
  });
  async function initialize() {
    state.stage = 'preparing'; notify();
    await mkdir(root, { recursive: true, mode: 0o700 });
    for (const folder of ['account','downloads','ext','mobile']) await mkdir(path.join(root, folder), { recursive: true, mode: 0o700 });
    if (stopped) return;
    startup = native.NodeIQQNTStartupSessionWrapper.create();
    const ids = startup.getSessionIdList();
    const id = ids instanceof Map ? ids.get('nt') : undefined;
    if (typeof id !== 'string' || !id) throw fail('QQ native startup did not provide the NT session identifier.');
    session = native.NodeIQQNTWrapperSession.getNTWrapperSession(id);
    if (!session) throw fail('QQ native account session is unavailable.');
    const folder = name => path.join(root, name) + path.sep;
    const config = {
      selfUin: account.uin, selfUid: account.uid, sysPath: root + path.sep, userPath: folder('account'),
      gproDBName: 'gpro', clientVer: metadata.version, a2: '', d2: '', d2Key: '', machineId,
      platform: 3, deviceType: 1, platVer: os.release(),
      rdeliveryConfig: { appKey: '', systemId: 0, appId: metadata.appid.linux, logicEnvironment: '', platform: 3, language: 'zh', sdkVersion: '', userId: account.uin, appVersion: metadata.version, osVersion: 'Linux', bundleId: 'com.tencent.qq', serverUrl: '', fixedAfterHitKeys: [] },
      defaultFileDownloadPath: folder('downloads'), extDataPath: folder('ext'), desktopPathConfig: { account_path: folder('account') },
      mobilePathConfig: Object.fromEntries(mobileFolders.map(key => [key, folder('mobile')])),
      appid: metadata.appid.linux, deviceInfo: engine.getDeviceInfo(), deviceConfig: '', useNewVerBuddyData: false,
    };
    engine.readyToShow();
    state.stage = 'initializing'; notify();
    timer = setTimeout(() => rejectInitialization('QQ native account session initialization timed out.'), initTimeoutMs);
    session.init(config, depends, dispatcher, listener);
    state.startup_result = startup.start();
    if (state.startup_result !== 0) throw fail('QQ native startup returned an unsuccessful result.');
    startupAccepted = true; completeReady();
  }
  return {
    start() {
      if (stopped) return Promise.reject(fail('QQ native account session is stopped.'));
      if (!startPromise) {
        startPromise = new Promise((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
        initialize().catch(() => rejectInitialization('Unable to initialize the QQ native account session.'));
      }
      return startPromise;
    },
    async stop() {
      if (stopped) return;
      stopped = true; clearTimeout(timer); queue.length = 0; queueBytes = 0; fingerprints.clear();
      groupCache.clear(); state.group_count = 0; state.group_snapshot_ready = false; state.group_list_observed = false;
      if (!state.session_ready) rejectStart?.(fail('QQ native account session stopped before initialization completed.'));
      try { if (msgListener) msgService?.removeKernelMsgListener(msgListener); } catch {}
      try { if (groupListener) groupService?.removeKernelGroupListener(groupListener); } catch {}
      try { if (buddyListener) buddyService?.removeKernelBuddyListener(buddyListener); } catch {}
      state.session_ready = false; state.stage = 'stopped'; notify();
      // The owning native host process performs final kernel teardown. Do not
      // invoke unverified native logout/close operations on the user's account.
    },
    getServices() {
      if (!state.session_ready || stopped) throw fail('QQ native account session is not initialized.');
      return { session, startup, msgService, groupService, buddyService, addBuddyService:session.getAddBuddyService?.() };
    },
    getGroups(){return [...groupCache.values()].map(row=>({...row}));},
    status,
    setDispatcher(hook) {
      if (hook !== undefined && hook !== null && typeof hook !== 'function') throw new Error('Invalid dispatcher forwarder.');
      if (stopped || state.dispatch_error) throw fail('QQ native dispatcher is stopped or failed.');
      forwarder = hook === undefined ? nativeDispatcher : hook; notify(); schedule();
    },
  };
}
