const fail = (message, retcode = 1503) => Object.assign(new Error(message), { retcode });
export function positiveId(value, label = 'ID') {
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value > 0) return String(value);
  } else if (typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value))) return value;
  throw fail(`${label} must be a positive safe integer or decimal string.`, 1400);
}
export function messageAlias(value) {
  const id = Number(positiveId(value, 'message_id'));
  if (id > 0x7fffffff) throw fail('message_id must be a bridge int32 ID.', 1400);
  return id;
}
function boolean(value, label) {
  if (value === undefined) return false;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw fail(`${label} must be boolean.`, 1400);
}
const text = value => typeof value === 'string' ? value.slice(0, 512) : '';
const seconds = value => {
  const number = typeof value === 'string' && /^\d{1,12}$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(number) && number >= 0 && number <= 253402300799 ? number : 0;
};

export function groupMember(record, group) {
  if (!record || record.isDelete === true) return null;
  let user;
  try { user = positiveId(record.uin, 'native member'); } catch { return null; }
  const role = { 2: 'member', 3: 'admin', 4: 'owner' }[record.role];
  if (!role) throw fail('QQ returned an unsupported member role.');
  return { group_id: Number(group), user_id: Number(user), nickname: text(record.nick), card: text(record.cardName),
    sex: 'unknown', age: 0, area: '', join_time: seconds(record.joinTime), last_sent_time: seconds(record.lastSpeakTime),
    level: Number.isInteger(record.memberLevel) ? String(record.memberLevel) : '', role,
    title: text(record.memberSpecialTitle), title_expire_time: seconds(record.specialTitleExpireTime),
    shut_up_timestamp: seconds(record.shutUpTime) };
}

/** Read operations are account/session guarded, bounded and deduplicated.
 * A timed-out native promise keeps its concurrency slot until it settles. */
export function createContextActions({ getContext, timeoutMs = 8000, maxConcurrent = 4 }) {
  const jobs = new Map();
  let active = 0, closed = false, unresolvedReplies = 0;
  function context(group) {
    if (closed) throw fail('Message context actions are closed.');
    const current = getContext();
    current.check(group);
    return current;
  }
  function read(key, current, group, fn, deadlineMs = timeoutMs) {
    current.check(group);
    if (jobs.has(key)) return jobs.get(key);
    if (active >= maxConcurrent) return Promise.reject(fail('Too many native context reads.', 1429));
    active++;
    let operation;
    try { operation = Promise.resolve(fn()); } catch (error) { operation = Promise.reject(error); }
    const settled = operation.finally(() => { active--; });
    let timer;
    const promise = Promise.race([settled, new Promise((_, reject) => {
      timer = setTimeout(() => reject(fail('QQ context read timed out.', 1504)), deadlineMs);
    })]).then(result => { current.check(group); if (closed) throw fail('Context read was cancelled.'); return result; })
      .catch(error => { if (Number.isInteger(error?.retcode)) throw error; throw fail('QQ context read failed.'); })
      .finally(() => { clearTimeout(timer); jobs.delete(key); });
    jobs.set(key, promise);
    return promise;
  }
  const peer = group => ({ chatType: 2, peerUid: group, guildId: '' });
  function records(result, group, limit) {
    if (result?.result !== 0 || !Array.isArray(result.msgList) || result.msgList.length > limit) throw fail('QQ did not return a valid message list.');
    for (const record of result.msgList) {
      if (record?.chatType !== 2 || String(record.peerUin) !== group || typeof record.msgId !== 'string' || !/^[1-9]\d{0,63}$/.test(record.msgId)) throw fail('QQ returned a message outside the requested group.', 1403);
    }
    return result.msgList;
  }
  async function getRecord(id, expectedGroup) {
    const alias = messageAlias(id), current = context();
    const known = current.mapper.lookup(alias);
    if (!known) throw fail('Message ID is unknown or expired.', 1404);
    const group = known.peerUin;
    if (expectedGroup !== undefined && group !== expectedGroup) throw fail('Reply target belongs to another group.', 1403);
    current.check(group);
    const result = await read(`msg:${group}:${known.msgId}`, current, group, () => current.services.msgService.getMsgsByMsgId(peer(group), [known.msgId]));
    const list = records(result, group, 1);
    if (list.length !== 1 || list[0].msgId !== known.msgId) throw fail('Message is no longer available in the QQ database.', 1404);
    return { current, record: list[0], alias };
  }
  async function hydrateReplies(current, record, deadline = Date.now() + 2000) {
    const replies = (record.elements ?? []).filter(element => element.elementType === 7 && element.replyElement);
    if (replies.length > 1) { unresolvedReplies++; return; }
    const group = String(record.peerUin);
    for (const { replyElement: reply } of replies) {
      const sequence = reply.replayMsgSeq;
      if (current.mapper.lookupSequence(group, sequence)) continue;
      if (Date.now() >= deadline) { unresolvedReplies++; continue; }
      if (typeof sequence !== 'string' || !/^[1-9]\d{0,63}$/.test(sequence)) { unresolvedReplies++; continue; }
      try {
        const result = await read(`sequence:${group}:${sequence}`, current, group,
          () => current.services.msgService.getMsgsBySeqAndCount(peer(group), sequence, 1, true, false), Math.max(1, Math.min(timeoutMs, deadline - Date.now())));
        const source = records(result, group, 1).find(item => item.msgSeq === sequence);
        if (source) current.mapper.rememberNative(source); else unresolvedReplies++;
      } catch { current.check(group); unresolvedReplies++; }
    }
  }
  async function members(current, group) {
    // The tested SDK's true flag refreshes the complete server list. A cached
    // finish=true response can still lack the owner, so never use that cache.
    const result = await read(`members:${group}`, current, group, () => current.services.groupService.getAllMemberList(group, true));
    if (result?.errCode !== 0 || result.result?.finish !== true || !(result.result.infos instanceof Map) || result.result.infos.size > 10000) throw fail('QQ did not return a complete group member list.');
    const unique = new Map();
    for (const raw of result.result.infos.values()) { const member = groupMember(raw, group); if (member) unique.set(member.user_id, member); }
    return [...unique.values()];
  }
  return {
    getRecord,
    hydrateReplies(record) { const current = context(String(record.peerUin)); return hydrateReplies(current, record); },
    status: () => ({ active, pending: jobs.size, limit: maxConcurrent, unresolved_replies: unresolvedReplies }),
    close() { closed = true; },
    async call(action, params) {
      if (action === 'get_msg') {
        const { current, record } = await getRecord(params.message_id);
        await hydrateReplies(current, record);
        const result = current.mapper.toMessage(record);
        if (!result) throw fail('This message contains unsupported elements.', 1404);
        current.rememberMedia(record);
        await current.flush(); current.check(String(record.peerUin));
        return result;
      }
      const group = positiveId(params.group_id, 'group_id'), current = context(group);
      if (action === 'get_group_member_list' || action === 'get_group_member_info') {
        boolean(params.no_cache, 'no_cache');
        const user = action === 'get_group_member_info' ? Number(positiveId(params.user_id, 'user_id')) : null;
        const list = await members(current, group);
        if (user === null) return list;
        const member = list.find(item => item.user_id === user);
        if (!member) throw fail('User is not in the current group member list.', 1404);
        return member;
      }
      if (action !== 'get_group_msg_history') throw fail('Unsupported context action.', 1404);
      const count = params.count === undefined ? 20 : Number(positiveId(params.count, 'count'));
      if (count > 100) throw fail('count must be between 1 and 100.', 1400);
      if (params.message_seq !== undefined) throw fail('Use message_id as the history cursor; message_seq cursors are unsupported.', 1400);
      let anchor;
      if (params.message_id !== undefined) {
        anchor = current.mapper.lookup(messageAlias(params.message_id));
        if (!anchor) throw fail('History cursor is unknown or expired.', 1404);
        if (anchor.peerUin !== group) throw fail('History cursor belongs to another group.', 1403);
      }
      const result = await read(`history:${group}:${anchor?.msgId ?? 'latest'}:${count}`, current, group, () => anchor
        ? current.services.msgService.getMsgs(peer(group), anchor.msgId, count, true)
        : current.services.msgService.getLatestDbMsgs(peer(group), count));
      const list = records(result, group, count).filter(record => !anchor || record.msgId !== anchor.msgId);
      list.sort((a, b) => {
        const first = /^\d{1,64}$/.test(a.msgSeq) ? BigInt(a.msgSeq) : BigInt(a.msgId);
        const second = /^\d{1,64}$/.test(b.msgSeq) ? BigInt(b.msgSeq) : BigInt(b.msgId);
        return first < second ? -1 : first > second ? 1 : 0;
      });
      for (const record of list) current.mapper.rememberNative(record);
      const messages = [], replyDeadline = Date.now() + 2000;
      for (const record of list) {
        await hydrateReplies(current, record, replyDeadline);
        const message = current.mapper.toMessage(record);
        if (message) { messages.push(message); current.rememberMedia(record); }
      }
      const next = list.length ? current.mapper.rememberNative(list[0]) : null;
      await current.flush(); current.check(group);
      return { messages, next_message_id: next, unsupported_count: list.length - messages.length };
    },
  };
}
