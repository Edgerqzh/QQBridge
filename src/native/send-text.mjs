const MAX_INT64 = 9223372036854775807n;

export class NativeSendError extends Error {
  constructor(code, message, { retcode = 1500, deliveryUnknown = false, nativeResult } = {}) {
    super(message);
    this.name = 'NativeSendError';
    this.code = code;
    this.retcode = retcode;
    this.delivery_unknown = deliveryUnknown;
    if (nativeResult !== undefined) this.native_result = nativeResult;
  }
}

function decimalId(value, code, label) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > MAX_INT64) {
    throw new NativeSendError(code, `${label} must be a positive int64 decimal string.`, { retcode: 1400 });
  }
  return value;
}

/** Pure construction only. Permission and allowed-group policy belong to the caller. */
export function buildGroupText({ groupId, text, maxTextBytes = 4096 }) {
  if (!Number.isSafeInteger(maxTextBytes) || maxTextBytes < 1) throw new TypeError('maxTextBytes must be a positive safe integer');
  let group;
  if (typeof groupId === 'number') {
    if (!Number.isSafeInteger(groupId) || groupId <= 0) {
      throw new NativeSendError('INVALID_GROUP_ID', 'groupId must be a positive safe integer or decimal string.', { retcode: 1400 });
    }
    group = String(groupId);
  } else group = groupId;
  decimalId(group, 'INVALID_GROUP_ID', 'groupId');
  if (typeof text !== 'string' || text.length === 0 || Buffer.byteLength(text, 'utf8') > maxTextBytes) {
    throw new NativeSendError('INVALID_TEXT', `text must contain between 1 and ${maxTextBytes} UTF-8 bytes.`, { retcode: 1400 });
  }
  return {
    peer: { chatType: 2, peerUid: group, guildId: '' },
    elements: [{ elementType: 1, elementId: '0', textElement: { content: text, atType: 0 } }],
    attributes: new Map(),
  };
}

/**
 * Send one plain group text through the verified Linux QQ native interface.
 * The caller must authorize the operation and enforce its allowed-group policy.
 * A zero native result means accepted, and does not establish server delivery.
 * No retries are performed, including after timeouts or connection failures.
 */
export async function sendText({
  msgService, groupId, text, now = Date.now, timeoutMs = 15000, maxTextBytes = 4096,
} = {}) {
  const message = buildGroupText({ groupId, text, maxTextBytes });
  return sendElements({ msgService, message, now, timeoutMs });
}

export async function sendElements({ msgService, message, now = Date.now, timeoutMs = 12000 }) {
  if (![1,2].includes(message?.peer?.chatType) || typeof message.peer.peerUid !== 'string' || (message.peer.chatType === 1 && !/^u_[A-Za-z0-9_-]{1,126}$/.test(message.peer.peerUid))) throw new NativeSendError('INVALID_PEER', 'Invalid native message peer.', { retcode: 1400 });
  if (typeof msgService?.generateMsgUniqueId !== 'function' || typeof msgService?.sendMsg !== 'function') {
    throw new NativeSendError('NATIVE_SEND_UNAVAILABLE', 'QQ native message service is unavailable.', { retcode: 1503 });
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new TypeError('timeoutMs must be between 1 and 60000');
  const milliseconds = now();
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new NativeSendError('INVALID_CLOCK', 'Message ID generation requires a positive Unix millisecond timestamp.', { retcode: 1400 });
  }

  let nativeId;
  try {
    // The official generator takes chat_type=2 and epoch milliseconds as text.
    // It applies its own group-ID offset; never synthesize an ID from received IDs.
    nativeId = msgService.generateMsgUniqueId(message.peer.chatType, String(milliseconds));
  } catch {
    throw new NativeSendError('NATIVE_ID_GENERATION_FAILED', 'QQ could not generate a native message ID. No send was attempted.');
  }
  if (typeof nativeId !== 'string' || !/^[1-9]\d{0,18}$/.test(nativeId) || BigInt(nativeId) > MAX_INT64) {
    throw new NativeSendError('NATIVE_ID_INVALID', 'QQ returned an invalid native message ID. No send was attempted.');
  }

  let timer;
  let response;
  try {
    response = await Promise.race([
      Promise.resolve().then(() => msgService.sendMsg(nativeId, message.peer, message.elements, message.attributes)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new NativeSendError('NATIVE_SEND_TIMEOUT', 'QQ send acknowledgement timed out; delivery is unknown. Do not automatically resend.', { retcode: 1504, deliveryUnknown: true })), timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof NativeSendError) throw error;
    throw new NativeSendError('NATIVE_SEND_UNCONFIRMED', 'QQ send acknowledgement failed; delivery is unknown. Do not automatically resend.', { deliveryUnknown: true });
  } finally {
    clearTimeout(timer);
  }
  if (!response || typeof response !== 'object' || Array.isArray(response) || !Number.isInteger(response.result)) {
    throw new NativeSendError('NATIVE_SEND_INVALID_RESPONSE', 'QQ did not provide a valid send acknowledgement; delivery is unknown. Do not automatically resend.', { deliveryUnknown: true });
  }
  if (response.result !== 0) {
    throw new NativeSendError('NATIVE_SEND_REJECTED', `QQ rejected the message (native result ${response.result}).`, { retcode: 1502, nativeResult: response.result });
  }
  return { native_id: nativeId, accepted: true };
}
