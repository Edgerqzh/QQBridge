const escape = text => text.replaceAll('&', '&amp;').replaceAll('[', '&#91;').replaceAll(']', '&#93;').replaceAll(',', '&#44;');
const safe = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\\/\u0000-\u001f\u007f]/.test(value) ? value : null;
export function receivedSegments(elements, resolveReply = () => null, mediaId = id => id, resolveForward = () => null) {
  if (!Array.isArray(elements) || !elements.length || elements.length > 64) return null;
  const message = [];
  for (const element of elements) {
    if (element?.elementType === 1 && typeof element.textElement?.content === 'string') {
      const text = element.textElement;
      if (text.atType === 1) message.push({ type: 'at', data: { qq: 'all' } });
      else if (text.atType === 2 && /^[1-9]\d{4,11}$/.test(text.atUid)) message.push({ type: 'at', data: { qq: text.atUid } });
      else message.push({ type: 'text', data: { text: text.content } });
    } else if (element?.elementType === 2 && element.picElement) {
      const picture = element.picElement, id = safe(picture.fileUuid) ?? safe(picture.md5HexStr);
      if (!id) return null;
      message.push({ type: 'image', data: { file: mediaId(id) } });
    } else if (element?.elementType === 3 && element.fileElement) {
      const file = element.fileElement, id = safe(file.fileUuid) ?? safe(file.fileMd5);
      if (!id || !safe(file.fileName) || !/^\d{1,16}$/.test(String(file.fileSize))) return null;
      message.push({ type: 'file', data: { file: mediaId(id), name: file.fileName, size: String(file.fileSize) } });
    } else if (element?.elementType === 4 && element.pttElement) {
      const voice = element.pttElement, id = safe(voice.fileUuid) ?? safe(voice.md5HexStr);
      if (!id) return null;
      message.push({ type: 'record', data: { file: mediaId(id) } });
    } else if(element?.elementType===5&&element.videoElement){
      const video=element.videoElement,id=safe(video.fileUuid)??safe(video.videoMd5);if(!id)return null;
      message.push({type:'video',data:{file:mediaId(id)}});
    } else if(element?.elementType===6&&element.faceElement){
      const id=element.faceElement.faceIndex;if(!Number.isInteger(id)||id<0||id>65535)return null;
      message.push({type:'face',data:{id:String(id)}});
    } else if(element?.elementType===10&&typeof element.arkElement?.bytesData==='string'){
      const data=element.arkElement.bytesData;if(Buffer.byteLength(data)>65536)return null;
      try{const card=JSON.parse(data);if(!card||typeof card!=='object'||Array.isArray(card))return null;}catch{return null;}
      message.push({type:'json',data:{data}});
    } else if(element?.elementType===16&&element.multiForwardMsgElement){
      const resource=element.multiForwardMsgElement.resId;if(typeof resource!=='string'||!resource.length||resource.length>2048||/[\u0000-\u001f\u007f]/.test(resource))return null;
      const id=resolveForward();if(typeof id!=='string')return null;message.push({type:'forward',data:{id}});
    } else if (element?.elementType === 7 && element.replyElement) {
      const id = resolveReply(element.replyElement.replayMsgId, element.replyElement);
      if (Number.isInteger(id) && id > 0) message.push({ type: 'reply', data: { id: String(id) } });
      // Preserve visible content if the native database cannot resolve a
      // source; never invent an alias from an unusable foreign-client ID.
    } else return null;
  }
  if (!message.length) return null;
  const raw = message.map(segment => segment.type === 'text'
    ? segment.data.text.replaceAll('&','&amp;').replaceAll('[','&#91;').replaceAll(']','&#93;')
    : `[CQ:${segment.type},${Object.entries(segment.data).map(([key,value]) => `${key}=${escape(String(value))}`).join(',')}]`).join('');
  return { message, raw };
}
