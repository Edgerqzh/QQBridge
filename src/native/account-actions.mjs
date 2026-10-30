const failure = (message, retcode = 1503) => Object.assign(new Error(message), { retcode });

function identity(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== 'string' || !/^[1-9]\d{0,15}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
function count(value) { return Number.isInteger(value) && value >= 0 && value <= 0xffffffff ? value : 0; }
function copyGroups(groups) { return groups.map(group => ({ ...group })); }
function sanitizeGroups(nativeArray) {
  const groups = new Map();
  for (const record of nativeArray) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    const groupId = identity(record.groupCode);
    if (groupId === null) continue;
    groups.set(groupId, {
      group_id: groupId,
      group_name: typeof record.groupName === 'string' ? record.groupName.slice(0, 256) : '',
      member_count: count(record.memberCount), max_member_count: count(record.maxMember),
    });
  }
  return [...groups.values()];
}

/** Safe account reads backed by actual native session/list notifications. */
export function createAccountActions({ getSession, getAccount, timeoutMs = 12000 }) {
  if (typeof getSession !== 'function' || typeof getAccount !== 'function') throw new TypeError('Session and account getters are required.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new RangeError('timeoutMs must be a positive integer.');
  let closed = false, context = null, cachedGroups = null, pending = null;

  function rejectPending(message, retcode = 1503) {
    const current = pending;
    if (!current) return;
    pending = null; clearTimeout(current.timer); current.groups = null; current.context = null;
    current.reject(failure(message, retcode));
  }
  function readContext() {
    if (closed) throw failure('QQ account actions are closed.');
    let session, account, ready;
    try { session = getSession(); account = getAccount(); ready = session?.status()?.session_ready === true; }
    catch { throw failure('QQ account session is unavailable.'); }
    const userId = identity(account?.uin);
    if (!ready || userId === null || typeof account?.uid !== 'string' || !account.uid || account.uid.length > 256) {
      throw failure('QQ account session is not initialized.');
    }
    return { session, userId, uid: account.uid, nickname: typeof account.nickName === 'string' ? account.nickName.slice(0, 256) : '' };
  }
  function sameContext(first, second) {
    return first?.session === second?.session && first?.userId === second?.userId && first?.uid === second?.uid;
  }
  function syncContext() {
    let next;
    try { next = readContext(); }
    catch (error) {
      cachedGroups = null; context = null;
      rejectPending('QQ account session is no longer initialized.');
      throw error;
    }
    if (!sameContext(context, next)) {
      cachedGroups = null;
      rejectPending('QQ account session changed while the group list was loading.');
    }
    context = next;
    return next;
  }
  function finishPending(current) {
    if (pending !== current || !current.acknowledged || !current.eventSeen) return;
    pending = null; clearTimeout(current.timer);
    const groups = copyGroups(current.groups); current.groups = null; current.context = null; current.resolve(groups);
  }
  function loadGroups(currentContext) {
    if (pending) return pending.promise;
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const current = { promise, resolve, reject, context: currentContext, acknowledged: false, eventSeen: false, groups: null, timer: null };
    // Register before entering the native service: it may synchronously notify.
    pending = current;
    current.timer = setTimeout(() => {
      if (pending === current) rejectPending('QQ group list notification timed out.', 1504);
    }, timeoutMs);
    let acknowledgement;
    try {
      const service = currentContext.session.getServices().groupService;
      if (typeof service?.getGroupList !== 'function') throw new Error('Missing group service.');
      acknowledgement = service.getGroupList(false);
    } catch {
      rejectPending('QQ native group list request failed.');
      return promise;
    }
    Promise.resolve(acknowledgement).then(result => {
      if (pending !== current || closed) return;
      let latest;
      try { latest = readContext(); } catch { rejectPending('QQ account session is no longer initialized.'); return; }
      if (!sameContext(current.context, latest)) { rejectPending('QQ account session changed while the group list was loading.'); return; }
      if (!result || typeof result !== 'object' || result.result !== 0) {
        rejectPending('QQ native group list request was unsuccessful.'); return;
      }
      current.acknowledged = true; finishPending(current);
    }, () => { if (pending === current) rejectPending('QQ native group list request failed.'); });
    return promise;
  }
  return {
    actions: Object.freeze(['get_login_info', 'get_group_list']),
    async call(action, params = {}) {
      if (closed) throw failure('QQ account actions are closed.');
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw failure('Action parameters must be an object.', 1400);
      if (action !== 'get_login_info' && action !== 'get_group_list') throw failure('Unsupported QQ account action.', 1404);
      const current = syncContext();
      if (action === 'get_login_info') return { user_id: current.userId, nickname: current.nickname };
      if (pending) return copyGroups(await pending.promise);
      if (cachedGroups !== null) return copyGroups(cachedGroups);
      return copyGroups(await loadGroups(current));
    },
    updateGroupList(nativeArray) {
      if (closed || !Array.isArray(nativeArray)) return false;
      let current;
      try { current = syncContext(); } catch { return false; }
      cachedGroups = sanitizeGroups(nativeArray);
      if (pending && sameContext(pending.context, current)) {
        pending.eventSeen = true; pending.groups = cachedGroups;
        finishPending(pending);
      }
      return true;
    },
    invalidate() { cachedGroups = null; context = null; rejectPending('Group membership must be refreshed.'); },
    close() {
      if (closed) return;
      closed = true; cachedGroups = null; context = null;
      rejectPending('QQ account actions closed before the group list arrived.');
    },
  };
}
