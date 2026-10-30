import {faceElement,cardElement,videoElement} from './extended-segments.mjs';
const fail = (message, retcode = 1400) => Object.assign(new Error(message), { retcode });
export async function buildGroupSegments({ groupId, message, autoEscape, mediaStore, resolveUid, prepareImage, prepareVideo, resolveReply, peer }) {
  const targetPeer = peer ?? { chatType: 2, peerUid: String(groupId), guildId: '' };
  if (![1,2].includes(targetPeer.chatType) || targetPeer.chatType === 1 && !/^u_[A-Za-z0-9_-]{1,126}$/.test(targetPeer.peerUid)) throw fail('Invalid message peer.');
  if (autoEscape !== undefined && typeof autoEscape !== 'boolean') throw fail('auto_escape must be boolean.');
  if (typeof message === 'string') {
    if (autoEscape !== true && message.includes('[CQ:')) throw fail('CQ parsing is unsupported; use message segment arrays.', 1404);
    message = [{ type: 'text', data: { text: message } }];
  }
  if (!Array.isArray(message) || !message.length || message.length > 64) throw fail('message needs 1 to 64 segments.');
  const replies = message.filter(segment => segment?.type === 'reply');
  if (replies.length > 1 || (replies.length && (message[0]?.type !== 'reply' || message.length < 2))) throw fail('A single reply must be the first segment and include message content.');
  const elements = []; let textBytes = 0;
  for (const segment of message) {
    if (!segment || typeof segment !== 'object' || !segment.data || typeof segment.data !== 'object') throw fail('Invalid message segment.');
    const data = segment.data;
    if (segment.type === 'text') {
      if (typeof data.text !== 'string' || !data.text.length) throw fail('Text segment must not be empty.');
      textBytes += Buffer.byteLength(data.text);
      elements.push({ elementType: 1, elementId: '0', textElement: { content: data.text, atType: 0 } });
    } else if (segment.type === 'reply') {
      if (typeof resolveReply !== 'function') throw fail('Reply lookup is unavailable.', 1503);
      const source = await resolveReply(data.id);
      if (source?.chatType !== targetPeer.chatType || String(source.peerUin) !== String(groupId) || targetPeer.chatType === 1 && source.peerUid !== targetPeer.peerUid || !/^[1-9]\d{0,63}$/.test(source.msgId) || !/^[1-9]\d{0,63}$/.test(source.msgSeq) || !/^[1-9]\d{4,11}$/.test(source.senderUin) || typeof source.senderUid !== 'string' || !/^u_[A-Za-z0-9_-]{1,126}$/.test(source.senderUid) || !/^\d{1,12}$/.test(String(source.msgTime))) throw fail('Reply target has no usable native source metadata.', 1404);
      // Populate the SDK's reply element from the actual source record. The
      // numeric senderUid and NT senderUidStr are distinct native fields.
      const sourceText = (source.elements ?? []).filter(element => element.elementType === 1 && typeof element.textElement?.content === 'string').map(element => element.textElement.content).join('').slice(0, 4096);
      elements.push({ elementType: 7, elementId: '0', replyElement: {
        replayMsgId: source.msgId, replayMsgSeq: source.msgSeq, replayMsgRootSeq: '0', replayMsgRootMsgId: '0', replayMsgRootCommentCnt: '0',
        sourceMsgIdInRecords: source.msgId, sourceMsgText: '', sourceMsgTextElems: sourceText ? [{ replyAbsElemType: 1, textElemContent: sourceText, faceElem: null, picElem: null }] : [],
        senderUid: source.senderUin, senderUidStr: source.senderUid,
        replyMsgClientSeq: /^\d{1,20}$/.test(source.clientSeq) ? source.clientSeq : '0', replyMsgTime: String(source.msgTime), replyMsgRevokeType: 0,
        sourceMsgIsIncPic: source.elements?.some(element => element.elementType === 2) ?? false, sourceMsgExpired: false, anonymousNickName: '', originalMsgState: 0,
      } });
    } else if (segment.type === 'at') {
      if(targetPeer.chatType===1)throw fail('Mentions are not supported in friend conversations.',1404);
      const all = data.qq === 'all', uin = String(data.qq);
      if (!all && !/^[1-9]\d{4,11}$/.test(uin)) throw fail('at.qq must be a QQ account number or all.');
      const uid = all ? 'all' : await resolveUid(uin);
      if (typeof uid !== 'string' || !uid.length) throw fail('The mention target could not be resolved to a native UID.', 1503);
      elements.push({ elementType: 1, elementId: '0', textElement: {
        content: all ? '@全体成员' : `@${uin}`, atType: all ? 1 : 2, atUid: all ? '0' : uin, atNtUid: uid,
      } });
    } else if(segment.type==='face')elements.push(faceElement(data));
    else if(segment.type==='json')elements.push(cardElement(data));
    else if (['image', 'file', 'record','video'].includes(segment.type)) {
      if (!mediaStore) throw fail('Media storage is unavailable.', 1503);
      let m = await mediaStore.prepare(data.file, segment.type, data.name);
      if (segment.type === 'image' && prepareImage) m = await prepareImage(m);
      if(segment.type==='video'){
        if(typeof prepareVideo!=='function')throw fail('Video preparation is unavailable.',1503);
        elements.push(videoElement(await prepareVideo(m)));
      }
      if (segment.type === 'image') elements.push({ elementType: 2, elementId: '0', picElement: {
        picSubType: 0, picSubSubType: 0, fileName: m.fileName, fileSize: m.size,
        picWidth: m.width, picHeight: m.height, original: true, md5HexStr: m.md5,
        sourcePath: m.sourcePath, thumbPath: m.thumbPaths, thumbFileSize: m.thumbSize, picType: m.type,
      } });
      if (segment.type === 'file') elements.push({ elementType: 3, elementId: '0', fileElement: {
        fileName: m.fileName, filePath: m.sourcePath, fileSize: m.size,
        fileMd5: m.md5, file10MMd5: m.md5Ten, fileSha: m.sha1, fileSha3: '',
      } });
      if (segment.type === 'record') {
        const duration = m.duration ?? data.duration;
        if (!Number.isInteger(duration) || duration < 1 || duration > 600) throw fail('Voice duration must be an integer from 1 to 600 seconds.');
        elements.push({ elementType: 4, elementId: '0', pttElement: {
          fileName: m.fileName, filePath: m.sourcePath, fileSize: m.size, md5HexStr: m.md5,
          duration, formatType: m.format, voiceType: 0,
          waveAmplitudes: [], otherBusinessInfo: new Map(),
        } });
      }
    } else throw fail(`Unsupported message segment: ${String(segment.type).slice(0,32)}`, 1404);
  }
  if (textBytes > 4096) throw fail('Text content exceeds 4096 UTF-8 bytes.');
  return { peer: targetPeer, elements, attributes: new Map() };
}

export async function resolveGroupUid(groupService, uin) {
  if (typeof groupService?.getUidByUins !== 'function') throw fail('Native UID resolution is unavailable.', 1503);
  const value = await groupService.getUidByUins([uin]);
  const uid = value?.errCode === 0 && value.uids instanceof Map ? value.uids.get(uin) : undefined;
  if (typeof uid !== 'string' || !/^u_[A-Za-z0-9_-]{1,126}$/.test(uid)) throw fail('Native UID lookup did not return a valid identity.', 1503);
  return uid;
}
