import {createMutationRunner,requireAck} from './mutations.mjs';
import {positiveId,messageAlias} from './context-actions.mjs';
import {receivedSegments} from './received-segments.mjs';
import {sendElements} from './send-text.mjs';
const fail=(message,retcode=1503)=>Object.assign(new Error(message),{retcode});
const peer=r=>({chatType:r.chatType,peerUid:r.peerUid??r.peerUin,guildId:''});
export const EXTENDED_ACTIONS=Object.freeze(['get_forward_msg','send_group_forward_msg','send_private_forward_msg','group_poke','friend_poke']);
export function createExtendedActions({getContext,resolveRecord,timeoutMs=10000}){
  const runner=createMutationRunner({timeoutMs});
  async function destination(c,action,p){
    if(action.startsWith('send_group')||action==='group_poke'){const group=positiveId(p.group_id,'group_id');c.check(group);return {chatType:2,peerUin:group,peerUid:group};}
    const friend=await c.friends.resolve(p.user_id,{refresh:true});c.check();return {chatType:1,peerUin:friend.uin,peerUid:friend.uid};
  }
  return {
    status:runner.status,close:runner.close,
    async call(action,p){
      if(!EXTENDED_ACTIONS.includes(action))throw fail('Unsupported extended action.',1404);
      const c=getContext();c.check();
      if(action==='get_forward_msg'){
        if(typeof p.id!=='string'||!/^forward:[1-9]\d{0,9}(?::[1-9]\d{0,63})?$/.test(p.id))throw fail('Use a forward handle from a received message.',1400);
        const [,id,nested]=p.id.split(':');
        return runner.run('forward-read:'+p.id,async op=>{
          const root=await resolveRecord(messageAlias(id));op.check();c.check();if(!root.elements?.some(e=>e.elementType===16&&e.multiForwardMsgElement))throw fail('Message is not a merged forward.',1404);
          const service=c.services.msgService;let value=await service.getMultiMsg(peer(root),root.msgId,root.msgId);requireAck(value);op.check();
          if(nested){const node=value.msgList?.find(n=>n.msgId===nested&&n.elements?.some(e=>e.elementType===16));if(!node)throw fail('Nested forward is not part of the authorized root.',1403);value=await service.getMultiMsg(peer(root),nested,root.msgId);requireAck(value);op.check();}
          if(!Array.isArray(value.msgList)||value.msgList.length>100)throw fail('Invalid or oversized merged forward.');
          // Re-read the enclosing record to re-check current conversation access.
          await resolveRecord(messageAlias(id));op.check();c.check();
          const messages=value.msgList.map(row=>{
            const parsed=receivedSegments(row.elements,()=>null,file=>'forward-media:'+id+':'+file,()=>nested?null:`forward:${id}:${row.msgId}`);
            if(!parsed||!/^[1-9]\d{4,11}$/.test(row.senderUin)||!/^\d{1,12}$/.test(row.msgTime))return null;
            return {type:'node',data:{user_id:Number(row.senderUin),nickname:typeof row.sendNickName==='string'?row.sendNickName.slice(0,256):'',time:Number(row.msgTime),content:parsed.message}};
          });
          return {message:messages.filter(Boolean),messages:messages.filter(Boolean),unsupported_count:messages.filter(x=>x===null).length};
        });
      }
      if(action==='group_poke'||action==='friend_poke'){
        return runner.run('poke',async op=>{const dest=await destination(c,action,p);let target=dest.peerUin;
          if(dest.chatType===2){const id=positiveId(p.user_id,'user_id');const r=await c.services.groupService.getAllMemberList(dest.peerUin,true);c.check(dest.peerUin);if(r?.errCode!==0||r.result?.finish!==true||!(r.result.infos instanceof Map))throw fail('Complete poke target roster required.');const row=[...r.result.infos.values()].find(m=>m?.uin===id&&m.isDelete!==true);if(!/^u_[A-Za-z0-9_-]{1,126}$/.test(row?.uid))throw fail('Poke target is not a current group member.',1403);target=id;}
          // The native ABI uses target_uin / aio_uin, both numeric strings.
          op.check();c.check(dest.chatType===2?dest.peerUin:undefined);const r=await op.invoke(()=>c.services.msgService.sendNudge(peer(dest),target,dest.peerUin));requireAck(r);c.check();return null;});
      }
      if(!Array.isArray(p.messages)||p.messages.length<1||p.messages.length>50||p.messages.some(n=>n?.type!=='node'||!n.data||Object.keys(n.data).some(k=>k!=='id')||n.data.id===undefined))throw fail('Merged forwarding needs 1 to 50 node segments containing only existing message IDs.',1400);
      return runner.run('forward-send',async op=>{
        const dest=await destination(c,action,p),records=[];
        for(const node of p.messages){records.push(await resolveRecord(messageAlias(node.data.id)));op.check();}
        const source=records[0];if(records.some(r=>r.chatType!==source.chatType||r.peerUin!==source.peerUin||r.peerUid!==source.peerUid))throw fail('Forwarded messages must come from one authorized conversation.',1403);
        const result=await c.services.msgService.buildMultiForwardMsg({srcMsgIds:records.map(r=>r.msgId),srcContact:peer(source)});requireAck(result);op.check();
        const elements=result.rspInfo?.elements;if(!Array.isArray(elements)||elements.length!==1||elements[0]?.elementType!==10||!elements[0].arkElement)throw fail('QQ did not prepare a valid merged-forward card.');
        await resolveRecord(messageAlias(p.messages[0].data.id));op.check();
        if(dest.chatType===1){const f=await c.friends.resolve(dest.peerUin,{refresh:true});if(f.uid!==dest.peerUid)throw fail('Forward destination changed.',1403);}else c.check(dest.peerUin);
        const sent=await op.invoke(()=>sendElements({msgService:c.services.msgService,message:{peer:peer(dest),elements,attributes:new Map()},timeoutMs:Math.min(8000,timeoutMs)}));
        const alias=c.mapper.rememberNative({...dest,msgId:sent.native_id,senderUin:c.account.uin});if(!alias)throw fail('QQ accepted the merged forward but its ID was not saved. Do not resend.',1500);
        try{await c.flush();c.check();}catch{throw fail('QQ accepted the merged forward; persistence or session changed. Do not resend.',1504);}
        return {message_id:alias};
      });
    },
  };
}
