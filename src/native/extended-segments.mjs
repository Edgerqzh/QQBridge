const fail=message=>Object.assign(new Error(message),{retcode:1400});
export function faceElement(data){
  const value=data?.id,id=typeof value==='string'&&/^\d{1,5}$/.test(value)?Number(value):value;
  if(!Number.isInteger(id)||id<0||id>65535)throw fail('face.id must be an integer from 0 to 65535.');
  return {elementType:6,elementId:'0',faceElement:{faceIndex:id,faceType:3,faceText:'',packId:'',stickerId:'',sourceType:0,stickerType:0,resultId:'',surpriseId:'',randomType:0}};
}
export function cardElement(data){
  if(typeof data?.data!=='string'||Buffer.byteLength(data.data)>65536)throw fail('json.data must be a JSON string of at most 65536 bytes.');
  let card;try{card=JSON.parse(data.data);}catch{throw fail('Invalid card JSON.');}
  if(!card||typeof card!=='object'||Array.isArray(card)||typeof card.app!=='string'||!card.app||card.app.length>128)throw fail('A card must have an app identifier.');
  if(card.app==='com.tencent.multimsg')throw fail('Use the forward API for merged forwards.');
  return {elementType:10,elementId:'0',arkElement:{bytesData:JSON.stringify(card)}};
}
export function videoElement(media){
  return {elementType:5,elementId:'0',videoElement:{filePath:media.sourcePath,fileName:media.fileName,videoMd5:media.md5,thumbMd5:media.thumbMd5,
    fileTime:media.duration,thumbSize:media.thumbSize,fileFormat:2,fileSize:media.size,thumbWidth:media.width,thumbHeight:media.height,
    busiType:0,subBusiType:0,thumbPath:new Map([[0,media.thumbPath]]),sourceVideoCodecFormat:media.codec,original:true,isInApplicationDataPath:false}};
}
/** An opaque forward handle is tied to the enclosing bridge message. It is
 * resolved again from that message, never from arbitrary caller resIds. */
export function forwardHandle(alias){return 'forward:'+alias;}
