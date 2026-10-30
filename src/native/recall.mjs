import { NativeSendError } from './send-text.mjs';

export async function recallMessage({ msgService, metadata, timeoutMs = 12000 }) {
  if (!metadata || metadata.chatType !== 2 || !/^[1-9]\d*$/.test(metadata.msgId) || !/^[1-9]\d*$/.test(metadata.peerUin))
    throw new NativeSendError('INVALID_MESSAGE', 'The process-local message ID is unavailable or expired.', { retcode: 1400 });
  if (typeof msgService?.recallMsg !== 'function') throw new NativeSendError('RECALL_UNAVAILABLE', 'Native recall is unavailable.', { retcode: 1503 });
  let timer, result;
  try {
    result = await Promise.race([
      Promise.resolve().then(() => msgService.recallMsg({ chatType: 2, peerUid: metadata.peerUid ?? metadata.peerUin, guildId: '' }, [metadata.msgId])),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new NativeSendError('RECALL_TIMEOUT', 'Recall acknowledgement timed out; outcome unknown. Do not retry automatically.', { retcode: 1504, deliveryUnknown: true })), timeoutMs); }),
    ]);
  } catch (error) {
    if (error instanceof NativeSendError) throw error;
    throw new NativeSendError('RECALL_UNCONFIRMED', 'Recall acknowledgement failed; outcome unknown.', { deliveryUnknown: true });
  } finally { clearTimeout(timer); }
  if (!result || !Number.isInteger(result.result)) throw new NativeSendError('RECALL_UNCONFIRMED', 'Invalid recall acknowledgement; outcome unknown.', { deliveryUnknown: true });
  if (result.result !== 0) throw new NativeSendError('RECALL_REJECTED', 'QQ rejected the recall request.', { retcode: 1502, nativeResult: result.result });
  return null;
}
