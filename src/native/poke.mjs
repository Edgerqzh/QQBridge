const pending=new Set();
async function identity(service,uid){
  if(pending.size>=4)return null;
  let timer;const operation=Promise.resolve().then(()=>service.getUinByUids([uid])).finally(()=>pending.delete(operation));pending.add(operation);
  try{return await Promise.race([operation,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),3000);})]);}catch{return null;}finally{clearTimeout(timer);}
}
/** Verified native nudge gray record: business 1061, structured QQ actors.
 * Display text, links and image labels never determine the event type. */
export async function pokeNotices(record,{account,mapper,groupService,check}){
  if(![1,2].includes(record?.chatType)||record.isImportMsg!==false||!/^\d{1,12}$/.test(String(record.msgTime))||!Number.isSafeInteger(Number(record.msgTime))||Number(record.msgTime)<=0||!/^[1-9]\d{0,63}$/.test(record.msgId)||!Array.isArray(record.elements))return [];
  const key=`poke:${record.chatType}:${record.peerUin}:${record.msgId}`;if(mapper.hasNotice(key))return [];
  for(const e of record.elements){
    const gray=e.grayTipElement,j=gray?.jsonGrayTipElement;if(e.elementType!==8||gray.subElementType!==17||j?.busiId!=='1061'||typeof j.jsonStr!=='string'||Buffer.byteLength(j.jsonStr)>65536)continue;
    let data;try{data=JSON.parse(j.jsonStr);}catch{continue;}
    if(!Array.isArray(data.items)||data.items.length>64)continue;
    const actors=data.items.filter(x=>x?.type==='qq');if(actors.length!==2||actors.some(x=>typeof x.uid!=='string'))continue;
    check();const ids=[];
    for(const actor of actors){
      if(actor.uid===account.uid){ids.push(Number(account.uin));continue;}
      if(/^[1-9]\d{4,11}$/.test(actor.uid)){ids.push(Number(actor.uid));continue;}
      if(!/^u_[A-Za-z0-9_-]{1,126}$/.test(actor.uid))break;
      const result=await identity(groupService,actor.uid),uin=result?.errCode===0&&result.uins instanceof Map?result.uins.get(actor.uid):null;if(typeof uin!=='string'||!/^[1-9]\d{4,11}$/.test(uin))break;ids.push(Number(uin));
    }
    check();if(ids.length!==2||!mapper.markNotice(key))continue;
    return [{time:Number(record.msgTime),self_id:Number(account.uin),post_type:'notice',notice_type:'notify',sub_type:'poke',user_id:ids[0],target_id:ids[1],...(record.chatType===2?{group_id:Number(record.peerUin)}:{})}];
  }
  return [];
}
