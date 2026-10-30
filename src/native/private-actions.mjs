import { messageAlias, positiveId } from './context-actions.mjs';
const fail=(message,retcode=1503)=>Object.assign(new Error(message),{retcode});
const peer=friend=>({chatType:1,peerUid:friend.uid,guildId:''});
/** Friend-only private reads share the account mapper but never group cursors. */
export function createPrivateActions({getContext,timeoutMs=8000}) {
  const jobs=new Map();let active=0,closed=false,unresolved=0;
  function context(){if(closed)throw fail('Private actions stopped.');const c=getContext();c.check();return c;}
  function read(key,c,friend,fn,budget=timeoutMs){
    c.check(friend);if(jobs.has(key))return jobs.get(key);if(active>=4)return Promise.reject(fail('Too many private reads.',1429));active++;
    let timer;const operation=Promise.resolve().then(fn).finally(()=>active--);
    const pending=Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail('Private read timed out.',1504)),budget);})])
      .then(result=>{c.check(friend);if(closed)throw fail('Private read cancelled.');return result;})
      .catch(error=>{if(error.retcode)throw error;throw fail('Native private read failed.');})
      .finally(()=>{clearTimeout(timer);jobs.delete(key);});jobs.set(key,pending);return pending;
  }
  function records(result,c,friend,limit){
    if(result?.result!==0||!Array.isArray(result.msgList)||result.msgList.length>limit)throw fail('Invalid private message list.');
    for(const r of result.msgList)if(r.chatType!==1||r.peerUid!==friend.uid||String(r.peerUin)!==friend.uin||typeof r.msgId!=='string'||!/^[1-9]\d{0,63}$/.test(r.msgId))throw fail('Private record belongs to another conversation.',1403);
    // Native friend-system notices have sender zero, type 5, and gray-only
    // elements. They belong to this peer but are not user history messages;
    // retain them as pagination anchors while the mapper omits their bodies.
    const messages=result.msgList.filter(r=>!(r.senderUin==='0'&&r.msgType===5&&Array.isArray(r.elements)&&r.elements.length>0&&r.elements.every(e=>e.elementType===8&&e.grayTipElement)));
    for(const r of messages)if(![friend.uin,c.account.uin].includes(r.senderUin))throw fail('Private record has an unrelated sender.',1403);
    return result.msgList;
  }
  async function getRecord(id,expected){
    const c=context(),known=c.mapper.lookup(messageAlias(id));
    if(!known||known.chatType!==1)throw fail('Private message ID is unknown or belongs to a group.',1404);
    const friend=await c.friends.resolve(known.peerUin);
    c.check(friend);if(known.peerUid!==friend.uid||expected&&(expected.uin!==friend.uin||expected.uid!==friend.uid))throw fail('Reply target belongs to another conversation.',1403);
    const list=records(await read(`message:${friend.uid}:${known.msgId}`,c,friend,()=>c.services.msgService.getMsgsByMsgId(peer(friend),[known.msgId])),c,friend,1);
    if(list.length!==1||list[0].msgId!==known.msgId)throw fail('Private message is unavailable.',1404);
    return {c,friend,record:list[0]};
  }
  async function hydrate(c,friend,record,deadline=Date.now()+2000){
    record={...record,elements:(record.elements??[]).map(element=>{
      const r=element.elementType===7?element.replyElement:null;if(!r||[friend.uin,c.account.uin].includes(r.senderUid))return element;
      const sender=r.senderUidStr===friend.uid?friend.uin:r.senderUidStr===c.account.uid?c.account.uin:null;
      return sender?{...element,replyElement:{...r,senderUid:sender}}:element;
    })};
    for(const element of record.elements??[]){
      const r=element.elementType===7?element.replyElement:null;if(!r)continue;
      const known=c.mapper.lookupSequence(friend.uin,r.replayMsgSeq,1,r.senderUid);
      if(known&&(!/^[1-9]\d+$/.test(r.replyMsgTime)||c.mapper.lookup(known)?.msgTime===r.replyMsgTime))continue;
      if(!/^[1-9]\d{0,63}$/.test(r.replayMsgSeq)||![friend.uin,c.account.uin].includes(r.senderUid)||Date.now()>=deadline){unresolved++;continue;}
      try{
        // Private sequences can overlap between senders. A source is accepted
        // only when sequence, sender and any provided timestamp all agree.
        const list=records(await read(`reply:${friend.uid}`,c,friend,()=>c.services.msgService.getLatestDbMsgs(peer(friend),100),Math.max(1,Math.min(timeoutMs,deadline-Date.now()))),c,friend,100);
        const matches=list.filter(m=>m.msgSeq===r.replayMsgSeq&&m.senderUin===r.senderUid&&(!/^[1-9]\d+$/.test(r.replyMsgTime)||m.msgTime===r.replyMsgTime));
        if(matches.length===1)c.mapper.rememberNative(matches[0]);else unresolved++;
      }catch{c.check(friend);unresolved++;}
    }
    return record;
  }
  return {
    getRecord,
    async notices(record){
      if(record?.chatType!==1||record.isImportMsg!==false||!/^\d{1,12}$/.test(String(record.recallTime))||Number(record.recallTime)<=0)return [];
      const c=context(),f=await c.friends.resolve(record.peerUin);c.check(f);if(f.uid!==record.peerUid)return [];
      const revoke=record.elements?.find(e=>e.elementType===8&&e.grayTipElement?.subElementType===1)?.grayTipElement.revokeElement;
      if(!revoke)return [];
      const sender=revoke.origMsgSenderUid===c.account.uid?Number(c.account.uin):revoke.origMsgSenderUid===f.uid?f.user_id:null;
      if(!sender)return [];
      const key=`private-recall:${f.uin}:${record.msgId}`;if(c.mapper.hasNotice(key))return [];
      const id=c.mapper.rememberNative(record);if(!id||!c.mapper.markNotice(key))return [];
      return [{time:Number(record.recallTime),self_id:Number(c.account.uin),post_type:'notice',notice_type:'friend_recall',user_id:sender,message_id:id}];
    },
    async hydrate(record){const c=context(),f=await c.friends.resolve(record.peerUin);c.check(f);if(f.uid!==record.peerUid)throw fail('Private peer changed.',1403);return hydrate(c,f,record);},
    status:()=>({active,pending:jobs.size,unresolved_replies:unresolved}),
    close(){closed=true;},
    async call(action,params){
      if(action==='get_msg'){
        const {c,friend,record}=await getRecord(params.message_id);const normalized=await hydrate(c,friend,record);
        const result=c.mapper.toMessage(normalized);if(!result)throw fail('Private message contains unsupported elements.',1404);
        c.rememberMedia(record);await c.flush();c.check(friend);return result;
      }
      const user=positiveId(params.user_id,'user_id'),c=context(),friend=await c.friends.resolve(user);c.check(friend);
      const count=params.count===undefined?20:Number(positiveId(params.count,'count'));if(count>100)throw fail('count must be 1 to 100.',1400);
      if(params.message_seq!==undefined)throw fail('Use a bridge message_id history cursor.',1400);
      let anchor;if(params.message_id!==undefined){anchor=c.mapper.lookup(messageAlias(params.message_id));if(!anchor||anchor.chatType!==1||anchor.peerUin!==friend.uin||anchor.peerUid!==friend.uid)throw fail('Private history cursor belongs to another conversation or expired.',1403);}
      const raw=await read(`history:${friend.uid}:${anchor?.msgId??'latest'}:${count}`,c,friend,()=>anchor?c.services.msgService.getMsgs(peer(friend),anchor.msgId,count,true):c.services.msgService.getLatestDbMsgs(peer(friend),count));
      const list=records(raw,c,friend,count).filter(m=>!anchor||m.msgId!==anchor.msgId);
      list.sort((a,b)=>Number(a.msgTime)-Number(b.msgTime)||(BigInt(a.msgId)<BigInt(b.msgId)?-1:BigInt(a.msgId)>BigInt(b.msgId)?1:0));
      for(const r of list)c.mapper.rememberNative(r);
      const messages=[],deadline=Date.now()+2000;for(const r of list){const normalized=await hydrate(c,friend,r,deadline);const m=c.mapper.toMessage(normalized);if(m){messages.push(m);c.rememberMedia(r);}}
      const next=list.length?c.mapper.rememberNative(list[0]):null;await c.flush();c.check(friend);
      return {messages,next_message_id:next,unsupported_count:list.length-messages.length};
    },
  };
}
