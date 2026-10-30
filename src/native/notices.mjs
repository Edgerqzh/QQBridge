const uin = value => typeof value === 'string' && /^[1-9]\d{4,14}$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const uid = value => typeof value === 'string' && /^u_[A-Za-z0-9_-]{1,126}$/.test(value);
const fail = message => Object.assign(new Error(message), { retcode: 1503 });
const time = value => /^\d{1,12}$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;

/** Decode structured kernel gray records, never display wording. Historical
 * database reads must not be fed here. Member removals require a before/after
 * complete member snapshot, so cache churn cannot impersonate a departure. */
export function createNoticeMapper({ account, mapper, getServices, allowed, checkCurrent, isObservedMember = () => true, now = Date.now, timeoutMs = 3000, maxGroups = 256 }) {
  const snapshots = new Map();
  const pending = new Map();
  let active = 0, closed = false;
  const activatedAt = Math.floor(now() / 1000);
  const metrics = { emitted: 0, ignored: 0, unresolved: 0, refresh_failed: 0 };
  async function bounded(key, task) {
    if (closed) throw fail('Notice mapper stopped.');
    if (pending.has(key)) return pending.get(key);
    if (active >= 4) throw fail('Notice native read limit reached.');
    active++;
    let timer;
    const operation = Promise.resolve().then(task).finally(() => { active--; });
    const result = Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(fail('Notice metadata read timed out.')), timeoutMs); })])
      .then(value => { checkCurrent(); if (closed) throw fail('Notice mapper stopped.'); return value; })
      .finally(() => { clearTimeout(timer); pending.delete(key); });
    pending.set(key, result); return result;
  }
  async function identity(value) {
    const direct = uin(value); if (direct) return direct;
    if (value === account.uid) return Number(account.uin);
    if (!uid(value)) return null;
    try {
      const result = await bounded('uid:' + value, () => getServices().groupService.getUinByUids([value]));
      return result?.errCode === 0 && result.uins instanceof Map ? uin(result.uins.get(value)) : null;
    } catch { checkCurrent(); return null; }
  }
  async function members(group) {
    const result = await bounded('members:' + group, () => getServices().groupService.getAllMemberList(group, true));
    if (result?.errCode !== 0 || result.result?.finish !== true || !(result.result.infos instanceof Map) || result.result.infos.size > 10000) throw fail('Incomplete member snapshot.');
    const set = new Set();
    for (const member of result.result.infos.values()) if (uid(member?.uid) && member.isDelete !== true) set.add(member.uid);
    return set;
  }
  function putSnapshot(group, value) {
    if (!snapshots.has(group) && snapshots.size >= maxGroups) snapshots.delete(snapshots.keys().next().value);
    snapshots.set(group, value);
  }
  async function prime(group) {
    if (!allowed(group) || snapshots.has(group)) return;
    try { putSnapshot(group, await members(group)); } catch { metrics.refresh_failed++; }
  }
  function event(kind, group, stamp, user, operator, extra = {}) {
    return { time: stamp, self_id: Number(account.uin), post_type: 'notice', notice_type: kind,
      group_id: Number(group), user_id: user, operator_id: operator, ...extra };
  }
  async function fromRecord(record) {
    if (closed || record?.chatType !== 2 || record.isImportMsg !== false || !uin(String(record.peerUin)) || !/^[1-9]\d{0,63}$/.test(record.msgId) || !Array.isArray(record.elements)) return [];
    checkCurrent();
    const group = String(record.peerUin);
    const out = [];
    for (const element of record.elements.slice(0, 64)) {
      if (element?.elementType !== 8 || !element.grayTipElement) continue;
      const gray = element.grayTipElement;
      if (gray.revokeElement && gray.subElementType === 1) {
        const key = `recall:${group}:${record.msgId}`;
        if (!allowed(group) || mapper.hasNotice(key)) continue;
        const stamp = time(record.recallTime);
        if (!stamp) continue;
        const revoke = gray.revokeElement;
        const sender = await identity(revoke.origMsgSenderUid), operator = await identity(revoke.operatorUid);
        if (!sender || !operator) { metrics.unresolved++; continue; }
        checkCurrent(); if (!allowed(group)) continue;
        const id = mapper.rememberNative(record);
        if (id && mapper.markNotice(key)) out.push(event('group_recall', group, stamp, sender, operator, { message_id: id }));
      } else if (gray.groupElement) {
        const change = gray.groupElement;
        const stamp = time(record.msgTime);
        const added = change.memberAdd;
        const memberUid = change.memberUid || added?.invited?.uid || added?.otherInviteOther?.invited?.uid || added?.otherAdd?.uid;
        // Only actual fresh live gray messages; refresh/import/history and
        // unrelated role/name/mute updates are never membership events.
        if (!stamp || stamp < activatedAt - 2 || Math.abs(now() / 1000 - stamp) > 300 || change.shutUp || change.createGroup || !uid(memberUid)) continue;
        const target = await identity(memberUid);
        if (!target || !allowed(group, target === Number(account.uin))) continue;
        let kind, subtype, operator;
        if (change.memberAdd && typeof change.memberAdd === 'object') {
          const add = change.memberAdd;
          const invite = add.otherInviteOther || add.otherInviteYou || add.youInviteOther || uid(add.inviter?.uid);
          const approved = add.otherAdd || add.otherAddByOtherQRCode || add.otherAddByYourQRCode || add.youAddByOtherQRCode;
          if (!invite && !approved) continue;
          kind = 'group_increase'; subtype = invite ? 'invite' : 'approve';
          operator = await identity(change.adminUid || add.inviter?.uid) ?? 0;
          if (!allowed(group)) continue;
        } else {
          const before = snapshots.get(group);
          if (!before?.has(memberUid)) { metrics.unresolved++; continue; }
          let after;
          if (target === Number(account.uin) && !isObservedMember(group)) after = new Set([...before].filter(value => value !== account.uid));
          else try { after = await members(group); } catch { metrics.refresh_failed++; continue; }
          putSnapshot(group, after);
          if (after.has(memberUid)) continue;
          operator = change.adminUid ? await identity(change.adminUid) : target;
          if (!operator) { metrics.unresolved++; continue; }
          kind = 'group_decrease'; subtype = operator === target ? 'leave' : target === Number(account.uin) ? 'kick_me' : 'kick';
        }
        const key = `member:${group}:${record.msgId}:${target}:${kind}`;
        checkCurrent(); if (!allowed(group, kind === 'group_decrease' && target === Number(account.uin))) continue;
        if (mapper.markNotice(key)) {
          snapshots.get(group)?.[kind === 'group_increase' ? 'add' : 'delete'](memberUid);
          out.push(event(kind, group, stamp, target, operator, { sub_type: subtype }));
        }
      }
    }
    metrics.emitted += out.length;
    return out;
  }
  return {
    prime, fromRecord,
    invalidate() { snapshots.clear(); },
    status: () => ({ ...metrics, active, pending: pending.size, tracked_groups: snapshots.size, group_limit: maxGroups }),
    close() { closed = true; snapshots.clear(); },
  };
}
