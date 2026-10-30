const fail = (message, retcode = 1400) => Object.assign(new Error(message), { retcode });
export async function buildGroupSegments({ groupId, message, autoEscape, mediaStore, resolveUid }) {
  if (autoEscape !== undefined && typeof autoEscape !== 'boolean') throw fail('auto_escape must be boolean.');
  if (typeof message === 'string') {
    if (autoEscape !== true && message.includes('[CQ:')) throw fail('CQ parsing is unsupported; use message segment arrays.', 1404);
    message = [{ type: 'text', data: { text: message } }];
  }
  if (!Array.isArray(message) || !message.length || message.length > 64) throw fail('message needs 1 to 64 segments.');
  const elements = []; let textBytes = 0;
  for (const segment of message) {
    if (!segment || typeof segment !== 'object' || !segment.data || typeof segment.data !== 'object') throw fail('Invalid message segment.');
    const data = segment.data;
    if (segment.type === 'text') {
      if (typeof data.text !== 'string' || !data.text.length) throw fail('Text segment must not be empty.');
      textBytes += Buffer.byteLength(data.text);
      elements.push({ elementType: 1, elementId: '0', textElement: { content: data.text, atType: 0 } });
    } else if (segment.type === 'at') {
      const all = data.qq === 'all', uin = String(data.qq);
      if (!all && !/^[1-9]\d{4,11}$/.test(uin)) throw fail('at.qq must be a QQ account number or all.');
      const uid = all ? 'all' : await resolveUid(uin);
      if (typeof uid !== 'string' || !uid.length) throw fail('The mention target could not be resolved to a native UID.', 1503);
      elements.push({ elementType: 1, elementId: '0', textElement: {
        content: all ? '@全体成员' : `@${uin}`, atType: all ? 1 : 2, atUid: all ? '0' : uin, atNtUid: uid,
      } });
    } else if (['image', 'file', 'record'].includes(segment.type)) {
      if (!mediaStore) throw fail('Media storage is unavailable.', 1503);
      const m = await mediaStore.prepare(data.file, segment.type, data.name);
      if (segment.type === 'image') elements.push({ elementType: 2, elementId: '0', picElement: {
        picSubType: 0, picSubSubType: 0, fileName: m.fileName, fileSize: m.size,
        picWidth: m.width, picHeight: m.height, original: true, md5HexStr: m.md5,
        sourcePath: m.sourcePath, thumbPath: new Map(), picType: m.type,
      } });
      if (segment.type === 'file') elements.push({ elementType: 3, elementId: '0', fileElement: {
        fileName: m.fileName, filePath: m.sourcePath, fileSize: m.size,
        fileMd5: m.md5, file10MMd5: m.md5Ten, fileSha: m.sha1, fileSha3: '',
      } });
      if (segment.type === 'record') {
        if (!Number.isInteger(data.duration) || data.duration < 1 || data.duration > 600) throw fail('Voice duration must be an integer from 1 to 600 seconds.');
        elements.push({ elementType: 4, elementId: '0', pttElement: {
          fileName: m.fileName, filePath: m.sourcePath, fileSize: m.size, md5HexStr: m.md5,
          duration: data.duration, formatType: m.format, voiceType: 0,
          waveAmplitudes: [], otherBusinessInfo: new Map(),
        } });
      }
    } else throw fail(`Unsupported message segment: ${String(segment.type).slice(0,32)}`, 1404);
  }
  if (textBytes > 4096) throw fail('Text content exceeds 4096 UTF-8 bytes.');
  return { peer: { chatType: 2, peerUid: String(groupId), guildId: '' }, elements, attributes: new Map() };
}

export async function resolveGroupUid(groupService, uin) {
  if (typeof groupService?.getUidByUins !== 'function') throw fail('Native UID resolution is unavailable.', 1503);
  const value = await groupService.getUidByUins([uin]);
  const uid = value?.errCode === 0 && value.uids instanceof Map ? value.uids.get(uin) : undefined;
  if (typeof uid !== 'string' || !/^u_[A-Za-z0-9_-]{1,126}$/.test(uid)) throw fail('Native UID lookup did not return a valid identity.', 1503);
  return uid;
}
