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

/**
 * Map realtime group text records to OneBot 11 events without retaining bodies.
 * IDs and deduplication state are process-local and FIFO-bounded by capacity.
 * rememberNative allocates an alias but does not mark an event as emitted.
 */
export function createMessageMapper({ selfId, allowedGroups, capacity = 5000 } = {}) {
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
  let nextAlias = 1;

  function metadata(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record) || record.chatType !== 2) return null;
    const peer = numericIdentity(record.peerUin);
    const msgId = nativeIdentifier(record.msgId);
    if (!peer || !msgId || (allow && !allow.has(peer.text))) return null;
    const value = { chatType: 2, peerUin: peer.text, msgId };
    if (typeof record.peerUid === 'string' && record.peerUid.length > 0 && record.peerUid.length <= 256 && !/[\u0000-\u001f\u007f]/.test(record.peerUid)) value.peerUid = record.peerUid;
    const msgSeq = sequenceIdentifier(record.msgSeq);
    if (msgSeq !== undefined) value.msgSeq = msgSeq;
    return { key: `2:${peer.text}:${msgId}`, value, peer };
  }

  function remember(parsed) {
    const existing = byNative.get(parsed.key);
    if (existing !== undefined) {
      const entry = byAlias.get(existing);
      entry.metadata = { ...entry.metadata, ...parsed.value };
      return existing;
    }
    if (byAlias.size >= capacity) {
      const oldestAlias = byAlias.keys().next().value;
      const oldest = byAlias.get(oldestAlias);
      byAlias.delete(oldestAlias);
      byNative.delete(oldest.key);
    }
    while (byAlias.has(nextAlias)) nextAlias = nextAlias === MAX_ALIAS ? 1 : nextAlias + 1;
    const alias = nextAlias;
    nextAlias = nextAlias === MAX_ALIAS ? 1 : nextAlias + 1;
    byNative.set(parsed.key, alias);
    byAlias.set(alias, { key: parsed.key, metadata: { ...parsed.value }, emitted: false });
    return alias;
  }

  return {
    fromNative(record) {
      const parsed = metadata(record);
      if (!parsed || record.isOnlineMsg !== true || record.isImportMsg !== false) return null;
      let own;
      try { own = numericIdentity(typeof selfId === 'function' ? selfId() : selfId); } catch { return null; }
      const sender = numericIdentity(record.senderUin);
      if (!own || !sender || own.text === sender.text) return null;
      // msgTime is the observed native field. time is only a strict integer
      // seconds compatibility fallback when the native field is absent.
      const time = timestamp(record.msgTime === undefined ? record.time : record.msgTime);
      if (time === null) return null;
      const text = textContent(record.elements);
      if (text === null) return null;
      const alias = remember(parsed);
      const entry = byAlias.get(alias);
      if (entry.emitted) return null;
      entry.emitted = true;
      return {
        time, self_id: own.value, post_type: 'message', message_type: 'group', sub_type: 'normal',
        message_id: alias, group_id: parsed.peer.value, user_id: sender.value,
        anonymous: null, message: [{ type: 'text', data: { text } }], raw_message: cqText(text), font: 0,
        sender: { user_id: sender.value, nickname: nickname(record) },
      };
    },
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
