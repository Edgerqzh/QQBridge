import os from 'node:os';
import path from 'node:path';
import { createLoginFlow } from './login-flow.mjs';
import { createLinuxSession } from './linux-session.mjs';
import { createMessageMapper } from './messages.mjs';
import { createAccountActions } from './account-actions.mjs';
import { sendText, sendElements } from './send-text.mjs';
import { createMediaStore } from './media.mjs';
import { buildGroupSegments, resolveGroupUid } from './segments.mjs';
import { recallMessage } from './recall.mjs';
import { createReceivedMediaCache } from './media-cache.mjs';
import { createAudioTranscoder } from './audio.mjs';
import { prepareNativePicture } from './picture-paths.mjs';
import { createMessageIndex } from './message-index.mjs';
import { createContextActions, messageAlias } from './context-actions.mjs';
import { createNoticeMapper } from './notices.mjs';
import { createRecoveryController } from './recovery.mjs';
import { createFriendActions } from './friends.mjs';
import { createPrivateActions } from './private-actions.mjs';
import { createGroupManagement, GROUP_MANAGEMENT_ACTIONS } from './group-management.mjs';
import { createSocialActions, SOCIAL_ACTIONS } from './social-actions.mjs';
import { createGroupContent, GROUP_CONTENT_ACTIONS } from './group-content.mjs';
import { createExtendedActions, EXTENDED_ACTIONS } from './extended-actions.mjs';
import {createVideoPreparer} from './video.mjs';
import {pokeNotices} from './poke.mjs';

const failure = (message, retcode = 1503) => Object.assign(new Error(message), { retcode });
const validUin = value => typeof value === 'string' && /^[1-9]\d{4,11}$/.test(value) && Number.isSafeInteger(Number(value));
const validUid = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
function groupId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  return typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value)) ? value : null;
}

export function parseAllowedGroups(value, label='QQBRIDGE_ALLOWED_GROUPS') {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw new TypeError(`${label} must be comma-separated QQ IDs.`);
  const ids = value.split(',').map(item => item.trim());
  if (ids.some(item => !groupId(item))) throw new TypeError(`${label} contains an invalid QQ ID.`);
  return new Set(ids);
}

function plainText(params) {
  if (params.auto_escape !== undefined && typeof params.auto_escape !== 'boolean') throw failure('auto_escape must be a boolean.', 1400);
  if (typeof params.message === 'string') {
    if (params.auto_escape !== true && params.message.includes('[CQ:')) throw failure('CQ-code parsing is not supported. Use text segments or auto_escape=true for literal text.', 1404);
    return params.message;
  }
  if (!Array.isArray(params.message) || params.message.length === 0) throw failure('message must be plain text or an array of text segments.', 1400);
  return params.message.map(segment => {
    if (!segment || typeof segment !== 'object' || segment.type !== 'text') throw failure('Only text message segments are supported.', 1404);
    if (!segment.data || typeof segment.data.text !== 'string') throw failure('Every text segment needs a text string.', 1400);
    return segment.data.text;
  }).join('');
}

/** Native orchestration separated from the production platform/module loader.
 * Dependencies can be injected in tests; there is no environment mock switch. */
export function createDriverCore({
  native, metadata, profile, prepareProfile, emitEvent = () => {}, emitStatus = () => {},
  allowedGroups, allowedUsers, loginUin = '', experimentalRichMedia = false, createSession = createLinuxSession, createIndex = createMessageIndex, persistSelectedAccount = async () => {},
  connectionTimeoutMs = 10000, qrTimeoutMs = 12000, accountTimeoutMs = 12000, sendTimeoutMs = 12000,
  requestRestart = () => {}, recoveryGraceMs = 15000, forceQr = false, manualRecoveryReason = '',
}) {
  if (typeof prepareProfile !== 'function') throw new TypeError('prepareProfile is required.');
  if (loginUin !== '' && !validUin(loginUin)) throw new TypeError('QQBRIDGE_LOGIN_UIN must be an explicit valid QQ account number.');
  if (!Number.isInteger(sendTimeoutMs) || sendTimeoutMs < 1 || sendTimeoutMs > 12000) throw new RangeError('sendTimeoutMs must be between 1 and 12000.');
  if (allowedGroups !== undefined && !Array.isArray(allowedGroups) && !(allowedGroups instanceof Set)) throw new TypeError('allowedGroups must be an array or Set.');
  const audio = createAudioTranscoder();
  const video=createVideoPreparer({profile,getMsgService:()=>session?.getServices().msgService});
  const mediaStore = createMediaStore({ directory: path.join(profile, 'media'), convertAudio: bytes => audio.convert(bytes,'silk') });
  const receivedMedia = createReceivedMediaCache({ profile, getMsgService: () => session?.getServices().msgService, getAccountId: () => selectedAccount?.uin });
  const allow = allowedGroups === undefined ? undefined : new Set(allowedGroups);
  if (allow && [...allow].some(value => groupId(value) === null)) throw new TypeError('Invalid allowed group ID.');
  if (allow) { const ids = [...allow].map(String); allow.clear(); for (const id of ids) allow.add(id); }
  let stage = 'created', transportConnected = false, stopped = false, loginFailed = false, observerFailed = false;
  let engine, login, machineId, qr = null, qrPending = null, connectPending = null, lastEvent = null, qrRevision = 0;
  let selectedAccount = null, session = null, mapper = null, generation = 0, sessionAttempted = false;
  let messageIndex = null, eventTail = Promise.resolve(), queuedEvents = 0;
  let noticeMapper = null, primeTail = Promise.resolve(), transportInvalidated = false;
  let previousMembership = new Set();
  let startPromise = null, stopPromise = null, rememberedQuickRequest = null;
  let rememberedSelection = false, userLoggedInUin = null, sessionStartHandle = null;
  let ignoreQrCancellation = false, qrFailure = null, rememberChoice = false, selectionSaveFailed = false, selectionWrite = Promise.resolve();
  let rememberedRevision = 0, rememberedReads = 0, rememberedBusy = false, rememberedQueued = false, cancelRememberedRead = null;
  const maxRememberedReads = 8;
  let groupListObserved = false, membership = new Set(), deferredGroups = null;
  const flow = createLoginFlow({
    quickLogin(uin) {
      if (uin !== loginUin) return login.quickLoginWithUin(uin);
      // The native request can remain pending after success. Reuse that same
      // operation across cache updates/transport generations, never resubmit it.
      if (rememberedQuickRequest) return rememberedQuickRequest;
      let resolve, reject;
      rememberedQuickRequest = new Promise((yes, no) => { resolve = yes; reject = no; });
      try { resolve(login.quickLoginWithUin(uin)); } catch (error) { reject(error); }
      return rememberedQuickRequest;
    },
    onChange(state) {
      if (state.stage === 'account_login_failed' || state.stage === 'unexpected_account_event') { loginFailed = true; stage = state.stage; }
      notify();
      requestSessionIfEligible();
      if (state.stage === 'account_login_failed' && !forceQr && (loginUin || rememberChoice)) recovery.observe({ online: false, sessionReady: true, reason: 'login_failed' });
    },
  });
  const accountActions = createAccountActions({ getSession: () => session, getAccount: () => selectedAccount, timeoutMs: accountTimeoutMs });
  if(allowedUsers!==undefined&&!Array.isArray(allowedUsers)&&!(allowedUsers instanceof Set))throw new TypeError('allowedUsers must be an array or Set.');
  const userAllow=allowedUsers===undefined?undefined:new Set([...allowedUsers].map(String));
  if(userAllow&&[...userAllow].some(id=>!validUin(id)))throw new TypeError('Invalid allowed private user ID.');
  function privateContext(){
    if(!session||!selectedAccount||!status().online)throw failure('QQ private session is offline.');
    const activeSession=session,current=generation,activeMapper=mapper,activeIndex=messageIndex,account={...selectedAccount};
    return {session:activeSession,services:activeSession.getServices(),account,mapper:activeMapper,friends:friendActions,
      rememberMedia(record){if(experimentalRichMedia)receivedMedia.remember(record);},flush:()=>activeIndex.flush(),
      check(friend){
        if(current!==generation||session!==activeSession||!status().online)throw failure('Private account session changed.');
        if(friend){const latest=friendActions.lookup(friend.uin);if(!latest||latest.uid!==friend.uid)throw failure('Private friend is unavailable or not allowed.',1403);}
      }};
  }
  const friendActions=createFriendActions({getContext:privateContext,allowedUsers:userAllow,timeoutMs:Math.min(accountTimeoutMs,8000)});
  const privateActions=createPrivateActions({getContext:privateContext,timeoutMs:Math.min(accountTimeoutMs,8000)});
  function managementContext(){
    const c=privateContext();
    return {...c,groups:()=>session.getGroups(),check(group){c.check();if(group!==undefined&&(!groupListObserved||!membership.has(group)||allow&&!allow.has(group)))throw failure('Management group is unavailable or outside the allowlist.',1403);}};
  }
  const groupManagement=createGroupManagement({getContext:managementContext,timeoutMs:Math.min(accountTimeoutMs,8000)});
  const socialActions=createSocialActions({getContext:privateContext,profile,allowedUsers:userAllow,emitEvent,timeoutMs:Math.min(accountTimeoutMs,8000)});
  const groupContent=createGroupContent({getContext:managementContext,profile,emitEvent,timeoutMs:Math.min(accountTimeoutMs,8000)});
  const extendedActions=createExtendedActions({getContext:managementContext,async resolveRecord(id){
    const meta=mapper?.lookup(id);if(!meta)throw failure('Source message ID is unknown.',1404);
    return meta.chatType===1?(await privateActions.getRecord(id)).record:(await contextActions.getRecord(id)).record;
  },timeoutMs:Math.min(sendTimeoutMs,10000)});
  const contextActions = createContextActions({ timeoutMs: Math.min(accountTimeoutMs, 8000), getContext() {
    if (!mapper || !messageIndex || !session || !status().online) throw failure('QQ account message session is offline.');
    const activeMapper = mapper, activeIndex = messageIndex, activeSession = session, current = generation;
    return { mapper: activeMapper, services: activeSession.getServices(), flush: () => activeIndex.flush(),
      rememberMedia(record) { if (experimentalRichMedia) receivedMedia.remember(record); },
      check(group) {
        if (current !== generation || session !== activeSession || !status().online) throw failure('Account session changed during context read.');
        if (group !== undefined && (!membership.has(group) || (allow && !allow.has(group)))) throw failure('Message group is unavailable or not allowed.', 1403);
      } };
  } });
  const recovery = createRecoveryController({ requestRestart, graceMs: recoveryGraceMs, onChange: () => notify(),
    canRestore: () => Boolean(!forceQr && loginUin || rememberChoice || rememberedSelection) });
  const sessionState = () => { try { return session?.status() ?? {}; } catch { return {}; } };
  function status() {
    const account = flow.snapshot(), core = sessionState();
    const online = core.online === true && transportConnected && !transportInvalidated && !stopped && !loginFailed;
    const recovering = recovery.status();
    return {
      online, good: online && core.good === true && !observerFailed && !messageIndex?.status().failed,
      self_id: account.self_id, nickname: account.nickname,
      stage: stopped ? 'stopped' : online ? 'online' : ['waiting', 'restart_requested'].includes(recovering.phase) ? 'recovering' : recovering.phase === 'manual_required' ? 'authentication_required' : loginFailed ? stage : selectedAccount || account.scan_confirmed || account.account_selected ? account.stage : stage,
      native_loaded: true, transport_connected: transportConnected,
      session_ready: core.session_ready === true && !stopped,
    };
  }
  function notify() { try { emitStatus(status()); } catch { observerFailed = true; } }
  function rejectPending(error) {
    qrPending?.reject(error); qrPending = null;
    connectPending?.reject(error); connectPending = null;
  }
  function clearAccount() {
    receivedMedia.clear();
    friendActions.invalidate();
    socialActions.invalidate();
    groupContent.invalidate();
    noticeMapper?.close();
    generation++; selectedAccount = null; mapper = null; membership.clear(); groupListObserved = false; deferredGroups = null;
    rememberedSelection = false; userLoggedInUin = null;
    clearImmediate(sessionStartHandle); sessionStartHandle = null;
    // Invalidate callbacks first; stop removes listeners without logging out.
    try { if (session) Promise.resolve(session.stop()).catch(() => {}); } catch {}
  }
  function readLoginRecords(result) {
    if (!result || result.result !== 0 || !Array.isArray(result.LocalLoginInfoList)) throw failure('QQ did not return a valid cached account list.');
    return result.LocalLoginInfoList;
  }
  function sanitizeAccount(info) {
    if (!info || !validUin(info.uin)) return null;
    return { uin: info.uin, ...(validUid(info.uid) ? { uid: info.uid } : {}), nickName: typeof info.nickName === 'string' ? info.nickName.slice(0, 256) : '' };
  }
  function selectAccount(info, remembered = false, nativeRestored = false) {
    const account = sanitizeAccount(info);
    if (!account || (remembered && (!account.uid || (!nativeRestored && info.isQuickLogin !== true)))) return false;
    if (sessionAttempted && selectedAccount?.uin !== account.uin) throw failure('Changing accounts requires restarting the native driver.', 1409);
    if (sessionAttempted && account.uid && selectedAccount?.uid && selectedAccount.uid !== account.uid) throw failure('The selected native account identity changed. Restart the native driver.', 1409);
    if (selectedAccount?.uin !== account.uin) { generation++; mapper = null; groupListObserved = false; membership.clear(); deferredGroups = null; }
    selectedAccount = selectedAccount?.uin === account.uin ? { ...selectedAccount, ...account } : account;
    rememberedSelection = remembered;
    if (!remembered && rememberChoice) selectionWrite = selectionWrite.catch(()=>{}).then(()=>persistSelectedAccount(account.uin)).catch(()=>{selectionSaveFailed=true;notify();});
    loginFailed = false; qr = null;
    if (nativeRestored) flow.onNativeAccountRestored(selectedAccount);
    else if (remembered) flow.onRememberedAccountSelected({ ...selectedAccount, isQuickLogin: true });
    else flow.onQRCodeLoginSucceed(selectedAccount);
    requestSessionIfEligible();
    return true;
  }
  function requestSessionIfEligible() {
    if (stopped || loginFailed || !transportConnected || sessionAttempted || !selectedAccount) return;
    const account = flow.snapshot(), ownUin = selectedAccount.uin;
    if (account.self_id !== Number(ownUin) || (account.authenticated !== true && userLoggedInUin !== ownUin)) return;
    // Some verified native paths complete with result: '0' and a QR-named
    // identity callback, without onUserLoggedIn. Both paths share one startup.
    sessionAttempted = true;
    const current = generation;
    sessionStartHandle = setImmediate(() => {
      sessionStartHandle = null;
      void initializeSession(current, ownUin);
    });
  }
  function canReadRememberedAccount() {
    return Boolean(loginUin) && !stopped && transportConnected && !loginFailed && !selectedAccount && !sessionAttempted;
  }
  function queueRememberedRead() {
    if (!canReadRememberedAccount() || rememberedBusy || rememberedQueued) return;
    if (rememberedReads >= maxRememberedReads) {
      if (stage !== 'remembered_account_lookup_exhausted') { stage = 'remembered_account_lookup_exhausted'; notify(); }
      return;
    }
    rememberedQueued = true;
    queueMicrotask(() => {
      rememberedQueued = false;
      if (canReadRememberedAccount() && !rememberedBusy) void selectRememberedAccount();
    });
  }
  function signalRememberedRecords() {
    rememberedRevision++;
    queueRememberedRead();
  }
  async function selectRememberedAccount() {
    if (!canReadRememberedAccount() || rememberedBusy || rememberedReads >= maxRememberedReads) return;
    const current = generation, revision = rememberedRevision;
    rememberedBusy = true; rememberedReads++;
    stage = 'remembered_account_loading'; notify();
    let timer, cancel;
    try {
      const cancellation = new Promise((_, reject) => {
        cancel = () => reject(failure('QQ cached-account lookup was interrupted.'));
        cancelRememberedRead = cancel;
        timer = setTimeout(() => reject(failure('QQ cached-account lookup timed out.')), accountTimeoutMs);
      });
      const records = readLoginRecords(await Promise.race([
        Promise.resolve().then(() => {
          if (stopped || current !== generation || !transportConnected) throw failure('QQ cached-account lookup was interrupted.');
          return login.getLoginList();
        }), cancellation,
      ]));
      if (stopped || current !== generation || selectedAccount || !transportConnected) return;
      const record = records.find(item => item?.uin === loginUin && item?.isQuickLogin === true && validUid(item.uid));
      if (record) selectAccount(record, true);
      else {
        // Native cache loading can finish after onLoginConnected. An empty or
        // not-yet-eligible list is not a permanent account authentication error.
        stage = 'remembered_account_waiting'; notify();
      }
    } catch {
      if (stopped || current !== generation || selectedAccount || !transportConnected) return;
      stage = 'remembered_account_lookup_failed'; notify();
    } finally {
      clearTimeout(timer);
      if (cancelRememberedRead === cancel) cancelRememberedRead = null;
      rememberedBusy = false;
      // Several notifications during one read collapse into at most one fresh
      // read. A disconnect changes generation and also advances the revision.
      if (rememberedRevision !== revision) queueRememberedRead();
    }
  }
  async function initializeSession(current, ownUin) {
    if (stopped || current !== generation || selectedAccount?.uin !== ownUin || flow.snapshot().self_id !== Number(ownUin)) return;
    try {
      if (!selectedAccount.uid) {
        const records = readLoginRecords(await login.getLoginList());
        if (stopped || current !== generation) return;
        const record = records.find(item => item?.uin === ownUin && validUid(item.uid));
        if (!record) throw failure('The selected QQ account has no usable native identity.');
        selectedAccount = { ...selectedAccount, uid: record.uid };
      }
      if (stopped || current !== generation || loginFailed || !transportConnected) return;
      const account = { ...selectedAccount };
      const index = createIndex({ profile, accountId: account.uin, snapshot: () => activeMapper.snapshot() });
      const savedMessages = await index.load();
      if (stopped || current !== generation) return;
      const activeMapper = createMessageMapper({ selfId: account.uin, allowedGroups: allow, privateMessages: true, richMedia: experimentalRichMedia, initialState: savedMessages, onChange: () => index.changed() });
      messageIndex = index; mapper = activeMapper;
      const isCurrent = () => !stopped && current === generation && selectedAccount?.uin === account.uin && selectedAccount?.uid === account.uid;
      const checkCurrent = () => { if (!isCurrent() || !status().online) throw failure('Notice account session changed.'); };
      const activeNotices = createNoticeMapper({ account, mapper: activeMapper, checkCurrent,
        getServices: () => session.getServices(),
        isObservedMember: group => membership.has(group),
        allowed: (group, selfDeparture = false) => (!allow || allow.has(group)) && (membership.has(group) || selfDeparture && previousMembership.has(group)),
      });
      noticeMapper = activeNotices;
      let wasOnline = false, everOnline = false;
      const priming = new Set();
      function updateGroups() {
        if (!isCurrent() || deferredGroups === null || !accountActions.updateGroupList(deferredGroups)) return;
        for (const group of membership) { if (previousMembership.size < 10000) previousMembership.add(group); }
        membership = new Set(deferredGroups.map(record => groupId(record.groupCode)).filter(Boolean));
        groupListObserved = true; deferredGroups = null;
        for (const group of [...membership].filter(group => !allow || allow.has(group)).slice(0, 256)) {
          if (priming.has(group) || priming.size >= 256) continue;
          priming.add(group);
          primeTail = primeTail.catch(() => {}).then(() => isCurrent() && status().online ? activeNotices.prime(group) : undefined).finally(() => priming.delete(group));
        }
      }
      function queueRecords(records, updateOnly = false) {
        if (!isCurrent() || !Array.isArray(records) || !status().online) return;
        for (const record of records) {
          const group = groupId(record?.peerUin);
          const direct=record?.chatType===1;
          if ((!direct&&record?.chatType!==2) || !group || (!direct&&allow&&!allow.has(group))) continue;
          if (queuedEvents >= 2500) { observerFailed = true; notify(); continue; }
          queuedEvents++;
          eventTail = eventTail.catch(() => {}).then(async () => {
            try {
              checkCurrent();
              if(direct){await friendActions.load();checkCurrent();const friend=friendActions.lookup(group);if(!friend||friend.uid!==record.peerUid)return;}
              let notices=[];
              if(direct||membership.has(group))notices=await pokeNotices(record,{account,mapper:activeMapper,groupService:session.getServices().groupService,check:checkCurrent});
              if(!notices.length)notices = direct ? await privateActions.notices(record) : await activeNotices.fromRecord(record);
              if (notices.length) {
                await index.flush(); checkCurrent();
                for (const notice of notices) {
                  emitEvent(notice);
                  if (notice.notice_type === 'group_decrease' && notice.user_id === Number(account.uin)) {
                    membership.delete(group); previousMembership.delete(group); accountActions.invalidate();
                  }
                }
                return;
              }
              if (updateOnly) return;
              let effectiveRecord=record;
              if(experimentalRichMedia&&direct)effectiveRecord=await privateActions.hydrate(record);
              else if (experimentalRichMedia && membership.has(group)) await contextActions.hydrateReplies(record);
              checkCurrent();
              const event = activeMapper.fromNative(effectiveRecord);
              if (!event) return;
              if (experimentalRichMedia) receivedMedia.remember(record);
              await index.flush(); checkCurrent(); emitEvent(event);
            } catch { if (isCurrent() && status().online) { observerFailed = true; notify(); } }
            finally { queuedEvents--; }
          });
        }
      }
      session = createSession({
        native, engine, account, profile, metadata, machineId,
        getAuthenticationEvidence() {
          if (!isCurrent() || !transportConnected || loginFailed) return false;
          const state = flow.snapshot();
          const nativeResult = state.authenticated === true && state.login_result_code === 0;
          const confirmedQr = qrRevision > 0 && state.scan_confirmed === true && state.account_selected === true && userLoggedInUin === account.uin && (state.login_result_code === null || state.login_result_code === 0);
          return state.self_id === Number(account.uin) && (nativeResult || confirmedQr);
        },
        getAuthenticationEvidenceType() { return flow.snapshot().login_result_code === 0 ? 'native_login_result' : 'native_qr_login'; },
        onState(state) {
          if (!isCurrent()) return;
          flow.onSessionOnlineEvidence(state); updateGroups(); notify();
          const online = status().online;
          if (wasOnline && !online) {
            previousMembership = new Set(membership); membership.clear(); groupListObserved = false;
            accountActions.invalidate(); activeNotices.invalidate();
            friendActions.invalidate();
            socialActions.invalidate();
            groupContent.invalidate();
          }
          if (!wasOnline && online && everOnline) {
            queueMicrotask(() => {
              if (!isCurrent()) return;
              try { Promise.resolve(session.getServices().groupService.getGroupList(true)).catch(() => {}); } catch {}
            });
          }
          if(!wasOnline&&online)queueMicrotask(()=>{if(isCurrent()){friendActions.load(true).catch(()=>{});socialActions.call('get_friend_requests',{}).catch(()=>{});}});
          wasOnline = online;
          everOnline ||= online;
          recovery.observe({ online, sessionReady: state.session_ready === true, reason: 'msf_disconnected' });
        },
        onMessage(records) {
          if (!isCurrent() || !Array.isArray(records)) return;
          // Publish actual session evidence before forwarding the first event.
          flow.onSessionOnlineEvidence(sessionState()); notify();
          if (experimentalRichMedia) for (const record of records) {
            const group = groupId(record?.peerUin);
            if (record?.chatType === 2 && group && membership.has(group) && (!allow || allow.has(group))) receivedMedia.remember(record);
          }
          queueRecords(records);
        },
        onMessageUpdate: records => queueRecords(records, true),
        onFriendList(rows){if(isCurrent())friendActions.update(rows);},
        onFriendRequests(rows){if(isCurrent())socialActions.receive(rows);},
        onGroupRequests(doubt,rows){if(isCurrent())groupContent.receiveNotifies(doubt,rows);},
        onGroupBulletin(group,rows){if(isCurrent())groupContent.receiveBulletin(group,rows);},
        onAuthenticationRequired(reason) {
          if (!isCurrent()) return;
          loginFailed = true; transportInvalidated = true; stage = 'authentication_required';
          generation++; flow.onFailed(); rejectPending(failure('QQ authentication must be renewed.'));
          recovery.authenticationRequired(reason); notify();
        },
        onGroupList(records) {
          if (!isCurrent() || !Array.isArray(records)) return;
          // Listener registration may synchronously report groups before ready.
          // Keep only bounded public group metadata until the ready callback.
          deferredGroups = records.slice(0, 10000).filter(record => record && groupId(record.groupCode)).map(record => ({
            groupCode: record.groupCode, groupName: record.groupName, memberCount: record.memberCount, maxMember: record.maxMember,
          }));
          updateGroups();
        },
      });
      await session.start();
      if (isCurrent()) { updateGroups(); notify(); }
    } catch {
      if (stopped || current !== generation) return;
      loginFailed = true; stage = 'session_init_failed'; notify();
    }
  }
  const handlers = {
    onLoginConnecting() { if (!loginFailed && !stage.startsWith('remembered_account_')) stage = 'connecting'; notify(); },
    onLoginConnected() {
      transportConnected = true;
      if (!loginFailed && !stage.startsWith('remembered_account_')) stage = 'connected';
      connectPending?.resolve(); connectPending = null; notify();
      signalRememberedRecords();
    },
    onLoginDisconnected() {
      const hadSession = sessionAttempted && Boolean(session);
      transportConnected = false; if (!loginFailed) stage = 'disconnected'; qr = null;
      rememberedReads = 0; rememberedRevision++; cancelRememberedRead?.();
      clearAccount(); if (!session) sessionAttempted = false; flow.onDisconnected();
      rejectPending(failure('QQ login transport disconnected.')); notify();
      if (hadSession) { transportInvalidated = true; recovery.observe({ online: false, sessionReady: true, reason: 'login_transport_disconnected' }); }
    },
    onLoginRecordUpdate() { signalRememberedRecords(); },
    onQRCodeGetPicture(data) {
      const png = String(data?.pngBase64QrcodeData ?? '').replace(/^data:image\/png;base64,/, '');
      const bytes = Buffer.from(png, 'base64');
      if (bytes.length > 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        qrPending?.reject(failure('QQ returned an invalid QR image.')); qrPending = null; return;
      }
      const expiration = Number(data.expireTime), now = Date.now();
      const expiresAt = expiration > 1e12 ? expiration : expiration > 1e9 ? expiration * 1000 : now + (Number.isFinite(expiration) && expiration > 0 ? expiration : 120) * 1000;
      qr = { image_base64: png, image_format: 'png', expires_at: Math.floor(expiresAt / 1000), expires_in: Math.max(0, Math.floor((expiresAt - now) / 1000)), poll_interval_ms: (Number(data.pollTimeInterval) || 2) * 1000, raw_expire_time: String(data.expireTime ?? '').slice(0, 64) };
      qrRevision++;
      stage = 'awaiting_scan'; qrPending?.resolve({ ...qr }); qrPending = null; notify();
    },
    onQRCodeLoginPollingStarted() { ignoreQrCancellation = false; qrFailure = null; stage = 'awaiting_scan'; notify(); },
    onQRCodeSessionFailed(reason, code) {
      if (ignoreQrCancellation && reason === 7 && code === 4) { ignoreQrCancellation = false; return; }
      qrFailure = { reason: Number.isInteger(reason) ? reason : null, code: Number.isInteger(code) ? code : null };
      if (!selectedAccount) { qr = null; stage = 'qr_session_expired'; qrPending?.reject(failure('The native QR login session expired. Request a fresh QR code.', 1409)); qrPending = null; notify(); }
    },
    onQRCodeSessionUserScaned() { if (!selectedAccount) { stage = 'qr_scanned'; notify(); } },
    onQRCodeSessionQuickLoginFailed() { handlers.onLoginFailed(); },
    onQRCodeLoginPollingStopped() { if (!selectedAccount && !flow.snapshot().authenticated) { stage = 'qr_polling_stopped'; qr = null; notify(); } },
    onLoginFailed() {
      loginFailed = true; stage = 'login_failed'; qr = null; clearAccount(); flow.onFailed();
      rejectPending(failure('QQ login failed.')); notify();
      if (!forceQr && (loginUin || rememberChoice)) recovery.observe({ online: false, sessionReady: true, reason: 'login_failed' });
    },
    onQRCodeLoginSucceed(info) {
      if (forceQr && qrRevision === 0) return;
      if (qrRevision === 0 && loginUin && !rememberedSelection) {
        const account = sanitizeAccount(info);
        if (!account || account.uin !== loginUin || !account.uid) throw failure('Native account restoration did not match the selected saved account.', 1409);
        selectAccount(account, true, true); return;
      }
      if (rememberedSelection && qrRevision === 0) {
        const account = sanitizeAccount(info);
        if (!account || account.uin !== selectedAccount?.uin || (info.uid !== undefined && (!validUid(info.uid) || info.uid !== selectedAccount.uid))) {
          throw failure('The native login callback does not match the explicitly selected cached account.', 1409);
        }
        // This native callback name is also used by remembered login. Preserve
        // its verified cache permission; no QR request/scan occurred this run.
        selectAccount({
          uin: selectedAccount.uin, uid: selectedAccount.uid,
          nickName: typeof info.nickName === 'string' ? account.nickName : selectedAccount.nickName,
          isQuickLogin: true,
        }, true);
      } else selectAccount(info);
    },
    onUserLoggedIn(uin) {
      if (!validUin(uin) || selectedAccount?.uin !== uin || flow.snapshot().self_id !== Number(uin)) {
        loginFailed = true; stage = 'unexpected_account_event'; clearAccount(); flow.onFailed(); notify(); return;
      }
      userLoggedInUin = uin; flow.onUserLoggedIn(uin); requestSessionIfEligible();
    },
    onLoginState(value) { flow.onLoginState(value); },
  };
  handlers.onLoginDisConnected = handlers.onLoginDisconnected;
  const listener = new Proxy({}, { get(_target, key) {
    if (typeof key !== 'string') return undefined;
    return (...args) => {
      if (stopped) return;
      lastEvent = key;
      try { handlers[key]?.(...args); }
      catch { loginFailed = true; stage = 'callback_error'; rejectPending(failure('QQ native login callback failed.')); notify(); }
    };
  } });
  async function waitConnected() {
    if (transportConnected) return;
    if (!connectPending) {
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      const timer = setTimeout(() => { connectPending = null; reject(failure('QQ login connection timed out.')); }, connectionTimeoutMs);
      connectPending = { promise, resolve: () => { clearTimeout(timer); resolve(); }, reject: error => { clearTimeout(timer); reject(error); } };
    }
    return connectPending.promise;
  }
  async function startNative() {
    machineId = await prepareProfile();
    if (stopped) throw failure('QQ native driver is stopped.');
    engine = native.NodeIQQNTWrapperEngine.get();
    engine.initWithDeskTopConfig({
      platform_type: 3, app_type: 1, app_version: metadata.version, os_version: os.release(),
      global_path_config: { desktopGlobalPath: profile + '/', mobileGlobalDBPath: path.join(profile, 'db') + '/', mobileGlobalDataPath: profile + '/', mobileGlobalTempPath: path.join(profile, 'tmp') + '/', base_path_prefix: profile + '/' },
      thumb_config: { maxSide: 1280, minSide: 720, longLimit: 4096, density: 1 }, use_xlog: false, qua: 'V1_LNX_NQ_3.2.34_53644_GW_B', enableEnvConfig: false,
    }, new Proxy({}, { get: (_target, key) => typeof key === 'string' ? () => {} : undefined }));
    login = native.NodeIKernelLoginService.get();
    login.initConfig({ commonPath: profile + '/', clientVer: metadata.version, machineId, platVer: os.release(), hostName: 'qqbridge', appid: String(metadata.appid.linux), externalVersion: 0 });
    login.addKernelLoginListener(listener); stage = 'connecting'; notify();
    if (login.connect() === false) throw failure('QQ native login transport refused to connect.');
  }
  return {
    actions: Object.freeze(['get_login_qrcode', 'get_login_state', 'get_login_info', 'get_group_list', 'send_group_msg', 'upload_group_file', 'delete_msg', 'get_file', 'get_record', 'convert_record', 'get_msg', 'get_group_msg_history', 'get_group_member_list', 'get_group_member_info', 'get_friend_list', 'get_friend_info', 'get_stranger_info', 'send_private_msg', 'send_msg', 'get_friend_msg_history', 'get_private_msg_history', 'upload_private_file',...GROUP_MANAGEMENT_ACTIONS,...SOCIAL_ACTIONS,...GROUP_CONTENT_ACTIONS,...EXTENDED_ACTIONS]), status,
    start() {
      if (stopped) return Promise.reject(failure('QQ native driver is stopped.'));
      if (!startPromise) startPromise = startNative().catch(error => { loginFailed = true; stage = 'start_failed'; notify(); throw error; });
      return startPromise;
    },
    async call(action, params = {}) {
      if (stopped) throw failure('QQ native driver is stopped.');
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw failure('Action parameters must be an object.', 1400);
      const account = flow.snapshot();
      if (action === 'get_login_state') return {
        ...account, ...status(), session: sessionState(), last_event: lastEvent, qq_version: metadata.version,
        qr_failure: qrFailure, saved_selection_error: selectionSaveFailed, media_downloads: receivedMedia.status(), audio: audio.status(),
        message_index: messageIndex?.status() ?? null, context_reads: contextActions.status(),
        notices: noticeMapper?.status() ?? null, recovery: { ...recovery.status(), manual_reason: manualRecoveryReason || null },
        friends:friendActions.status(),private_reads:privateActions.status(),
        group_management:groupManagement.status(),friend_requests:socialActions.status(),
        group_content:groupContent.status(),extended:extendedActions.status(),video:video.status(),
        remembered_login: { configured: Boolean(loginUin), selected_via_cache: rememberedSelection, lookup_reads: rememberedReads, lookup_pending: rememberedBusy, lookup_limit: maxRememberedReads },
      };
      if(GROUP_MANAGEMENT_ACTIONS.includes(action))return groupManagement.call(action,params);
      if(SOCIAL_ACTIONS.includes(action))return socialActions.call(action,params);
      if(GROUP_CONTENT_ACTIONS.includes(action))return groupContent.call(action,params);
      if(EXTENDED_ACTIONS.includes(action)){
        if(!experimentalRichMedia)throw failure('Experimental rich media is disabled.',1404);
        return extendedActions.call(action,params);
      }
      if(action==='send_msg'){
        const type=params.message_type??(params.group_id!==undefined&&params.user_id===undefined?'group':params.user_id!==undefined&&params.group_id===undefined?'private':null);
        if(!['group','private'].includes(type)||type==='group'&&params.user_id!==undefined||type==='private'&&params.group_id!==undefined)throw failure('send_msg needs one unambiguous group or private target.',1400);
        action=type==='group'?'send_group_msg':'send_private_msg';
      }
      if(action==='get_friend_list')return friendActions.list();
      if(action==='get_friend_info'||action==='get_stranger_info')return friendActions.info(params.user_id);
      if(action==='get_friend_msg_history'||action==='get_private_msg_history')return privateActions.call(action,params);
      if(action==='get_msg'&&mapper?.lookup(messageAlias(params.message_id))?.chatType===1)return privateActions.call(action,params);
      if(action==='send_private_msg'||action==='upload_private_file'){
        const c=privateContext();const friend=await friendActions.resolve(params.user_id,{refresh:true});c.check(friend);
        const segments=action==='upload_private_file'?[{type:'file',data:{file:params.file,name:params.name}}]:params.message;
        if(Array.isArray(segments)&&segments.some(s=>s?.type!=='text')&&!experimentalRichMedia)throw failure('Experimental rich media is disabled.',1404);
        const deadline=Date.now()+sendTimeoutMs;let timer,message;
        try{message=await Promise.race([buildGroupSegments({groupId:friend.uin,peer:{chatType:1,peerUid:friend.uid,guildId:''},message:segments,autoEscape:params.auto_escape,mediaStore,
          prepareImage:m=>prepareNativePicture({msgService:c.services.msgService,profile,media:m}),prepareVideo:m=>video.prepare(m),resolveReply:async id=>(await privateActions.getRecord(id,friend)).record}),
          new Promise((_,reject)=>{timer=setTimeout(()=>reject(failure('Private message preparation timed out; no send attempted.',1504)),sendTimeoutMs);})]);}finally{clearTimeout(timer);}
        c.check(friend);const remaining=deadline-Date.now();if(remaining<=0)throw failure('Private preparation deadline exceeded.',1504);
        const result=await sendElements({msgService:c.services.msgService,message,timeoutMs:remaining});let alias;
        try{alias=c.mapper.rememberNative({chatType:1,peerUin:friend.uin,peerUid:friend.uid,senderUin:c.account.uin,msgId:result.native_id});if(!alias)throw new Error();await c.flush();}
        catch{throw failure('QQ accepted the private message but its ID could not be persisted. Do not resend.',1500);}
        try{c.check(friend);}catch{throw failure('QQ accepted the private message but its session changed. Do not resend.',1500);}
        return {message_id:alias};
      }
      if (['get_msg', 'get_group_msg_history', 'get_group_member_list', 'get_group_member_info'].includes(action)) return contextActions.call(action, params);
      if (action === 'get_login_info' || action === 'get_group_list') {
        if (loginFailed || !transportConnected) throw failure('QQ account session is unavailable.');
        const result = await accountActions.call(action, params);
        return action === 'get_group_list' && allow ? result.filter(group => allow.has(String(group.group_id))) : result;
      }
      if (action === 'convert_record') {
        if (!experimentalRichMedia) throw failure('Experimental media is disabled.', 1404);
        const input = await mediaStore.prepare(params.file, 'file');
        const { readFile } = await import('node:fs/promises');
        const result = await audio.convert(await readFile(input.sourcePath), params.out_format ?? 'silk');
        return { base64: result.bytes.toString('base64'), format: result.format, duration_ms: result.duration_ms };
      }
      if (action === 'get_file' || action === 'get_record') {
        if (!experimentalRichMedia) throw failure('Experimental media is disabled.', 1404);
        if (!status().online) throw failure('QQ account message session is offline.');
        const current = generation, deadline = Date.now() + 12000;
        const file=params.file_id??params.file;if(typeof file==='string'&&file.startsWith('private:'))await friendActions.load();
        const result = await receivedMedia.read(file, (peer,type,uid) => type===1 ? friendActions.lookup(peer)?.uid===uid : membership.has(peer) && (!allow || allow.has(peer)));
        if (current !== generation || !status().online) throw failure('Account session changed while reading media.');
        if (action === 'get_record') {
          const converted = await audio.convert(Buffer.from(result.base64,'base64'), params.out_format ?? 'wav', { timeoutMs: Math.max(1,deadline-Date.now()) });
          if (current !== generation || !status().online) throw failure('Account session changed during conversion.');
          return { ...result, name: result.name.replace(/\.[^.]*$/,'') + '.' + converted.format, base64: converted.bytes.toString('base64'), size: converted.bytes.length, format: converted.format, duration_ms: converted.duration_ms };
        }
        return result;
      }
      if (action === 'delete_msg') {
        if (!experimentalRichMedia) throw failure('Experimental rich media and recall are disabled.', 1404);
        if (!status().online) throw failure('QQ account message session is offline.');
        const message = mapper?.lookup(messageAlias(params.message_id));
        if (!message) throw failure('Message ID is invalid or expired.', 1400);
        if(message.chatType===1){const friend=await friendActions.resolve(message.peerUin,{refresh:true});if(friend.uid!==message.peerUid)throw failure('Private peer is unavailable.',1403);}
        else if ((allow && !allow.has(message.peerUin)) || !membership.has(message.peerUin)) throw failure('Message group is unavailable or not allowed.', 1403);
        return recallMessage({ msgService: session.getServices().msgService, metadata: message, timeoutMs: sendTimeoutMs });
      }
      if (action === 'send_group_msg' || action === 'upload_group_file') {
        if (!status().online) throw failure('QQ account message session is offline.');
        const group = groupId(params.group_id);
        if (!group) throw failure('group_id must be a positive safe integer or decimal string.', 1400);
        const segments = action === 'upload_group_file' ? [{ type: 'file', data: { file: params.file, name: params.name } }] : params.message;
        const rich = Array.isArray(segments) && segments.some(segment => segment?.type !== 'text');
        if (rich && !experimentalRichMedia) throw failure('Experimental rich media is disabled.', 1404);
        const text = rich ? null : plainText(params);
        if (allow && !allow.has(group)) throw failure('The group is outside QQBRIDGE_ALLOWED_GROUPS.', 1403);
        if (!groupListObserved) throw failure('A real group list notification is required before sending. Call get_group_list first.');
        if (!membership.has(group)) throw failure('The current account is not an observed member of this group.', 1403);
        const activeMapper = mapper, activeIndex = messageIndex, activeSession = session, current = generation;
        const deadline = Date.now() + sendTimeoutMs;
        const services = activeSession.getServices();
        let preparationTimer, message;
        try {
          message = rich ? await Promise.race([
            buildGroupSegments({ groupId: group, message: segments, autoEscape: params.auto_escape,
              mediaStore, resolveUid: uin => resolveGroupUid(services.groupService, uin),
              prepareImage: media => prepareNativePicture({ msgService: services.msgService, profile, media }),
              prepareVideo:media=>video.prepare(media),
              resolveReply: async id => (await contextActions.getRecord(id, group)).record }),
            new Promise((_, reject) => { preparationTimer = setTimeout(() => reject(failure('Media preparation timed out; no send was attempted.', 1504)), sendTimeoutMs); }),
          ]) : null;
        } finally { clearTimeout(preparationTimer); }
        if (current !== generation || activeSession !== session || !status().online || !membership.has(group)) throw failure('Account session changed before sending.');
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw failure('Preparation deadline exceeded; no send was attempted.', 1504);
        const result = rich
          ? await sendElements({ msgService: services.msgService, message, timeoutMs: remaining })
          : await sendText({ msgService: services.msgService, groupId: group, text, timeoutMs: remaining });
        let alias;
        try {
          alias = activeMapper.rememberNative({ chatType: 2, peerUin: group, peerUid: group, msgId: result.native_id });
          if (!alias) throw new Error('No alias.');
          await activeIndex.flush();
        } catch { throw failure('QQ accepted the message but its ID could not be persisted. Do not resend.', 1500); }
        if (current !== generation || activeSession !== session || !status().online) throw failure('QQ accepted the message but the account session changed. Do not resend.', 1500);
        return { message_id: alias };
      }
      if (action !== 'get_login_qrcode') throw failure('Unsupported QQ native action.', 1404);
      if (!login) throw failure('QQ native driver has not started.');
      if (account.scan_confirmed || account.account_selected || selectedAccount) throw failure('Account login is in progress or already selected.', 1409);
      if (qr && params.refresh !== true && qr.expires_at * 1000 > Date.now() + 10000) return { ...qr, expires_in: Math.max(0, qr.expires_at - Math.floor(Date.now() / 1000)) };
      if (params.remember_login !== undefined && typeof params.remember_login !== 'boolean') throw failure('remember_login must be boolean.', 1400);
      if (params.remember_login !== undefined) {
        rememberChoice = params.remember_login;
        if (!rememberChoice) selectionWrite = selectionWrite.catch(()=>{}).then(()=>persistSelectedAccount(null)).catch(()=>{selectionSaveFailed=true;notify();});
      }
      const requestedRevision = qrRevision;
      await waitConnected();
      if (stopped) throw failure('QQ native driver is stopped.');
      if (selectedAccount) throw failure('Account login is in progress or already selected.', 1409);
      // Another waiter can synchronously receive/cache a QR while we yield.
      if (qr && (params.refresh !== true || qrRevision !== requestedRevision) && qr.expires_at * 1000 > Date.now() + 10000) return { ...qr, expires_in: Math.max(0, qr.expires_at - Math.floor(Date.now() / 1000)) };
      if (qrPending) return qrPending.promise;
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      const timer = setTimeout(() => { qrPending = null; reject(failure('QQ did not return a QR image in time.')); }, qrTimeoutMs);
      qrPending = { promise, resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
      try { if (params.remember_login !== undefined) { login.setRemerberPwd(params.remember_login); login.setAutoLogin(params.remember_login); } qr = null; if (qrRevision > 0) { ignoreQrCancellation = true; login.abortPolling(); } if (login.getQRCodePicture() === false) throw failure('QQ native module rejected the QR request.'); }
      catch { qrPending?.reject(failure('QQ native module rejected the QR request.')); qrPending = null; }
      return promise;
    },
    stop() {
      if (stopPromise) return stopPromise;
      stopped = true; transportConnected = false; stage = 'stopped'; generation++;
      recovery.stop(); noticeMapper?.close(); friendActions.close(); privateActions.close(); groupManagement.close();socialActions.close();groupContent.close();extendedActions.close();video.close();flow.stop(); accountActions.close(); contextActions.close(); audio.close(); cancelRememberedRead?.(); rejectPending(failure('QQ native driver stopped.'));
      clearImmediate(sessionStartHandle); sessionStartHandle = null;
      stopPromise = (async () => {
        try { await selectionWrite; } catch {}
        try { await eventTail; await messageIndex?.flush(); } catch {}
        try { await receivedMedia.flush(); } catch {}
        receivedMedia.clear();
        try { await session?.stop(); } catch {}
        try { login?.abortPolling(); } catch {}
        try { login?.removeKernelLoginListener(listener); } catch {}
        membership.clear(); receivedMedia.clear(); selectedAccount = null; mapper = null; qr = null; notify();
      })();
      return stopPromise;
    },
  };
}
