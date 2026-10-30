import { receivedSegments } from './received-segments.mjs';
const MAX_ALIAS = 0x7fffffff;
const MAX_UNIX_SECONDS = 253402300799;

function numericIdentity(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? { value, text: String(value) } : null;
  if (typeof value !== 'string' || !/^[1-9]\d{0,15}$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? { value: number, text: value } : null;
}

function nativeIdentifier(value) {
  // Native message IDs exceed JavaScript's safe integer range. Preserve the
  // original decimal string throughout, including in the deduplication key.
  return typeof value === 'string' && /^[1-9]\d{0,63}$/.test(value) ? value : null;
}

function sequenceIdentifier(value) {
  if (typeof value === 'string' && /^(?:0|[1-9]\d{0,63})$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return undefined;
}

function timestamp(value) {
  if (typeof value === 'string' && !/^[1-9]\d{0,11}$/.test(value)) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && number <= MAX_UNIX_SECONDS ? number : null;
}

function textContent(elements) {
  if (!Array.isArray(elements) || elements.length === 0) return null;
  const parts = [];
  for (const element of elements) {
    if (!element || typeof element !== 'object' || Array.isArray(element)) return null;
    if (element.elementType !== undefined && element.elementType !== 1) return null;
    if (!element.textElement || typeof element.textElement !== 'object' || Array.isArray(element.textElement) || typeof element.textElement.content !== 'string') return null;
    if (element.textElement.atType !== undefined && (!Number.isInteger(element.textElement.atType) || element.textElement.atType < -0x80000000 || element.textElement.atType > 0x7fffffff)) return null;
    for (const [key, value] of Object.entries(element)) {
      if (key !== 'textElement' && key.endsWith('Element') && value !== undefined && value !== null) return null;
    }
    // Mention semantics have not been verified. Keep visible text literal and
    // never invent an at/image/other non-text segment from an unknown element.
    parts.push(element.textElement.content);
  }
  const text = parts.join('');
  return text.length ? text : null;
}

function nickname(record) {
  for (const key of ['sendNickName', 'sendMemberName', 'sendRemarkName', 'memberName']) {
    if (typeof record[key] === 'string' && record[key].length) return record[key].slice(0, 256);
  }
  return '';
}

function cqText(text) { return text.replaceAll('&', '&amp;').replaceAll('[', '&#91;').replaceAll(']', '&#93;'); }
function sequenceKey(meta, sequence = meta.msgSeq, sender = meta.senderUin) { return `${meta.chatType}:${meta.peerUin}:${meta.chatType === 1 ? (sender ?? '') + ':' : ''}${sequence}`; }

/**
 * Map group records to events and query results without retaining bodies.
 * IDs and deduplication are FIFO bounded; optional snapshots preserve them.
 * rememberNative allocates an alias but does not mark an event as emitted.
 */
export function createMessageMapper({ selfId, allowedGroups, capacity = 5000, richMedia = false, privateMessages = false, initialState, onChange = () => {} } = {}) {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_ALIAS) throw new RangeError('capacity must be a positive int32 integer');
  if (typeof selfId !== 'function' && !numericIdentity(selfId)) throw new TypeError('selfId must be a positive safe integer identity or getter');
  let allow;
  if (allowedGroups !== undefined) {
    if (!Array.isArray(allowedGroups) && !(allowedGroups instanceof Set)) throw new TypeError('allowedGroups must be an array or Set of group identities');
    allow = new Set();
    for (const group of allowedGroups) {
      const identity = numericIdentity(group);
      if (!identity) throw new TypeError('allowedGroups contains an invalid group identity');
      allow.add(identity.text);
    }
  }
  const byNative = new Map();
  const byAlias = new Map();
  const bySequence = new Map();
  const notices = new Set();
  let nextAlias = 1;

  if (initialState !== undefined) {
    if (initialState?.version !== 1 || !Number.isInteger(initialState.nextAlias) || initialState.nextAlias < 1 || initialState.nextAlias > MAX_ALIAS + 1 || !Array.isArray(initialState.entries) || initialState.entries.length > capacity) throw new Error('Invalid message index snapshot.');
    const seenAliases = new Set(), seenKeys = new Set();
    for (const saved of initialState.entries) {
      const parsed = metadata(saved?.metadata);
      if (!parsed || !Number.isInteger(saved.alias) || saved.alias < 1 || saved.alias >= initialState.nextAlias || typeof saved.emitted !== 'boolean' || seenAliases.has(saved.alias) || seenKeys.has(parsed.key)) throw new Error('Invalid message index entry.');
      seenAliases.add(saved.alias); seenKeys.add(parsed.key);
      byNative.set(parsed.key, saved.alias);
      byAlias.set(saved.alias, { key: parsed.key, metadata: parsed.value, emitted: saved.emitted });
      if (parsed.value.msgSeq && parsed.value.msgSeq !== '0') bySequence.set(sequenceKey(parsed.value), saved.alias);
    }
    nextAlias = initialState.nextAlias;
    if (initialState.notices !== undefined) {
      if (!Array.isArray(initialState.notices) || initialState.notices.length > capacity || initialState.notices.some(key => typeof key !== 'string' || key.length > 256 || !key.length)) throw new Error('Invalid notice index.');
      for (const key of initialState.notices) notices.add(key);
    }
  }

  function metadata(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record) || !(record.chatType === 2 || privateMessages && record.chatType === 1)) return null;
    const peer = numericIdentity(record.peerUin);
    const msgId = nativeIdentifier(record.msgId);
    if (!peer || !msgId) return null;
    if (record.chatType === 1 && (typeof record.peerUid !== 'string' || !/^u_[A-Za-z0-9_-]{1,126}$/.test(record.peerUid))) return null;
    const value = { chatType: record.chatType, peerUin: peer.text, msgId };
    if(record.chatType===1&&numericIdentity(record.senderUin))value.senderUin=String(record.senderUin);
    if(record.chatType===1&&timestamp(record.msgTime)!==null)value.msgTime=String(record.msgTime);
    if (typeof record.peerUid === 'string' && record.peerUid.length > 0 && record.peerUid.length <= 256 && !/[\u0000-\u001f\u007f]/.test(record.peerUid)) value.peerUid = record.peerUid;
    const msgSeq = sequenceIdentifier(record.msgSeq);
    if (msgSeq !== undefined) value.msgSeq = msgSeq;
    return { key: `${record.chatType}:${peer.text}:${msgId}`, value, peer };
  }

  function remember(parsed) {
    if (parsed.value.chatType === 2 && allow && !allow.has(parsed.peer.text)) return null;
    const existing = byNative.get(parsed.key);
    if (existing !== undefined) {
      const entry = byAlias.get(existing);
      const updated = { ...entry.metadata, ...parsed.value };
      if (sequenceKey(entry.metadata) !== sequenceKey(updated) && bySequence.get(sequenceKey(entry.metadata)) === existing) bySequence.delete(sequenceKey(entry.metadata));
      if (JSON.stringify(updated) !== JSON.stringify(entry.metadata)) { entry.metadata = updated; onChange(); }
      if (updated.msgSeq && updated.msgSeq !== '0') bySequence.set(sequenceKey(updated), existing);
      return existing;
    }
    // Never reuse an evicted alias. Old application references must fail rather
    // than silently target another message, including across process restarts.
    if (nextAlias > MAX_ALIAS) throw new Error('Message ID space exhausted.');
    if (byAlias.size >= capacity) {
      const oldestAlias = byAlias.keys().next().value;
      const oldest = byAlias.get(oldestAlias);
      byAlias.delete(oldestAlias);
      byNative.delete(oldest.key);
      if (bySequence.get(sequenceKey(oldest.metadata)) === oldestAlias) bySequence.delete(sequenceKey(oldest.metadata));
    }
    const alias = nextAlias;
    nextAlias++;
    byNative.set(parsed.key, alias);
    byAlias.set(alias, { key: parsed.key, metadata: { ...parsed.value }, emitted: false });
    if (parsed.value.msgSeq && parsed.value.msgSeq !== '0') bySequence.set(sequenceKey(parsed.value), alias);
    onChange();
    return alias;
  }

  function content(record, parsed) {
    return richMedia ? receivedSegments(record.elements, (nativeId, reply) => {
      const exact=byNative.get(`${parsed.value.chatType}:${parsed.peer.text}:${nativeId}`);
      if(exact!==undefined)return exact;
      const bySeq = bySequence.get(sequenceKey(parsed.value,reply?.replayMsgSeq,reply?.senderUid));
      if (bySeq !== undefined && (parsed.value.chatType!==1 || !timestamp(reply?.replyMsgTime) || byAlias.get(bySeq)?.metadata.msgTime===String(reply.replyMsgTime))) return bySeq;
      if (!nativeIdentifier(nativeId)) return null;
      return remember(metadata({ chatType: parsed.value.chatType, peerUin: parsed.peer.text, peerUid: parsed.value.peerUid, msgId: nativeId, msgSeq: reply?.replayMsgSeq, senderUin: reply?.senderUid }));
    }, id => parsed.value.chatType === 1 ? `private:${parsed.peer.text}:${id}` : id) : (() => { const text = textContent(record.elements); return text === null ? null : { message: [{ type: 'text', data: { text } }], raw: cqText(text) }; })();
  }

  return {
    fromNative(record) {
      const parsed = metadata(record);
      if (!parsed || (record.chatType === 2 && allow && !allow.has(parsed.peer.text)) || record.isOnlineMsg !== true || record.isImportMsg !== false) return null;
      let own;
      try { own = numericIdentity(typeof selfId === 'function' ? selfId() : selfId); } catch { return null; }
      const sender = numericIdentity(record.senderUin);
      if (!own || !sender || own.text === sender.text) return null;
      if(record.chatType===1&&sender.text!==parsed.peer.text)return null;
      // msgTime is the observed native field. time is only a strict integer
      // seconds compatibility fallback when the native field is absent.
      const time = timestamp(record.msgTime === undefined ? record.time : record.msgTime);
      if (time === null) return null;
      const rich = content(record, parsed);
      if (rich === null) return null;
      const alias = remember(parsed);
      const entry = byAlias.get(alias);
      if (entry.emitted) return null;
      entry.emitted = true;
      onChange();
      return {
        time, self_id: own.value, post_type: 'message', message_type: record.chatType === 1 ? 'private' : 'group', sub_type: record.chatType === 1 ? 'friend' : 'normal',
        message_id: alias, ...(record.chatType === 2 ? { group_id: parsed.peer.value, anonymous: null } : {}), user_id: sender.value,
        message: rich.message, raw_message: rich.raw, font: 0,
        sender: { user_id: sender.value, nickname: nickname(record) },
      };
    },
    toMessage(record) {
      const parsed = metadata(record), sender = numericIdentity(record?.senderUin);
      const time = timestamp(record?.msgTime === undefined ? record?.time : record.msgTime);
      if (!parsed || !sender || time === null || (record.chatType === 2 && allow && !allow.has(parsed.peer.text))) return null;
      const rich = content(record, parsed);
      if (!rich) return null;
      const alias = remember(parsed);
      return { time, message_type: record.chatType === 1 ? 'private' : 'group', message_id: alias, real_id: alias, ...(record.chatType === 2 ? { group_id: parsed.peer.value } : { user_id: parsed.peer.value }),
        message_seq: parsed.value.msgSeq ?? null, native_message_id: parsed.value.msgId,
        sender: { user_id: sender.value, nickname: nickname(record) }, message: rich.message, raw_message: rich.raw };
    },
    snapshot() {
      return { version: 1, nextAlias, entries: [...byAlias].map(([alias, entry]) => ({ alias, metadata: { ...entry.metadata }, emitted: entry.emitted })), notices: [...notices] };
    },
    hasNotice(key) { return notices.has(key); },
    markNotice(key) {
      if (typeof key !== 'string' || !key.length || key.length > 256) throw new TypeError('Invalid notice key.');
      if (notices.has(key)) return false;
      if (notices.size >= capacity) notices.delete(notices.values().next().value);
      notices.add(key); onChange(); return true;
    },
    lookupSequence(group, sequence, chatType = 2, senderUin) { return bySequence.get(sequenceKey({chatType,peerUin:String(group)},sequence,senderUin)) ?? null; },
    rememberNative(record) {
      const parsed = metadata(record);
      return parsed ? remember(parsed) : null;
    },
    lookup(oneBotId) {
      if (!Number.isInteger(oneBotId) || oneBotId < 1 || oneBotId > MAX_ALIAS) return null;
      const entry = byAlias.get(oneBotId);
      return entry ? { ...entry.metadata } : null;
    },
  };
}
