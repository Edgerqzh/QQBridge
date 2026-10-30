import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {createMutationRunner,requireAck,strictBoolean,boundedText} from './mutations.mjs';
const fail=(message,retcode=1503)=>Object.assign(new Error(message),{retcode});
const validUid=v=>typeof v==='string'&&/^u_[A-Za-z0-9_-]{1,126}$/.test(v);
const validUin=v=>typeof v==='string'&&/^[1-9]\d{4,11}$/.test(v)&&Number.isSafeInteger(Number(v));
const digest=v=>createHash('sha256').update(v).digest('hex');
export const SOCIAL_ACTIONS=Object.freeze(['get_friend_requests','set_friend_add_request','add_friend']);

/** Incoming requests are explicit opt-in decisions. Only real native callbacks
 * produce flags; consumed decisions are recorded before native dispatch. */
export function createSocialActions({getContext,profile,allowedUsers,emitEvent=()=>{},timeoutMs=8000}){
  const runner=createMutationRunner({timeoutMs}),file=path.join(profile,'management-claims.json');
  let closed=false,revision=0,epoch=0,raw=null,waiter=null,queue=Promise.resolve(),queued=0,nativePending=false;
  let claims=null,claimWrite=Promise.resolve();const announced=new Set();
  const allowed=uin=>!allowedUsers||allowedUsers.has(uin);
  const context=()=>{if(closed)throw fail('Friend request service is closed.');const c=getContext();c.check();return c;};
  function acceptedContext(c){try{c.check();}catch{throw fail('QQ accepted the friend operation but the session changed. Do not retry automatically.',1504);}}
  const key=(c,row)=>digest(c.account.uid+'\0'+row.friendUid+'\0'+row.reqTime);
  function pendingRows(snapshot){
    if(!snapshot||!Array.isArray(snapshot.buddyReqs)||snapshot.buddyReqs.length>1000)throw fail('Invalid friend request snapshot.');
    const rows=[],seen=new Set(),now=Math.floor(Date.now()/1000);
    for(const row of snapshot.buddyReqs){
      if(row?.isDecide!==false||row.isInitiator!==false||row.isDoubt!==false||row.reqType!==1)continue;
      if(!validUid(row.friendUid)||typeof row.reqTime!=='string'||!/^\d{1,12}$/.test(row.reqTime))continue;
      const at=Number(row.reqTime);if(at<now-7*86400||at>now+300)continue;
      const id=row.friendUid+':'+row.reqTime;if(seen.has(id))continue;seen.add(id);rows.push({...row});
    }
    return rows;
  }
  async function normalize(c,snapshot){
    const rows=pendingRows(snapshot);if(!rows.length)return [];
    const r=await c.services.groupService.getUinByUids([...new Set(rows.map(row=>row.friendUid))]);c.check();
    if(r?.errCode!==0||!(r.uins instanceof Map))throw fail('Unable to resolve friend request account numbers.');
    return rows.flatMap(row=>{const uin=r.uins.get(row.friendUid);return validUin(uin)&&allowed(uin)?[{...row,uin,flag:'friend:'+key(c,row)}]:[];});
  }
  async function readClaims(){
    if(claims)return;
    try{const data=JSON.parse(await readFile(file,'utf8'));if(data.version!==1||!Array.isArray(data.claims)||data.claims.length>2048||data.claims.some(x=>!Array.isArray(x)||!/^[a-f0-9]{64}$/.test(x[0])||!Number.isSafeInteger(x[1])))throw Error();claims=new Map(data.claims);}
    catch(e){if(e.code==='ENOENT')claims=new Map();else throw fail('Friend decision journal is invalid; manual inspection is required.');}
  }
  async function claim(id){
    // Serialize the durable claim before invoking the side effect.
    const task=claimWrite.catch(()=>{}).then(async()=>{
      await readClaims();const now=Date.now();for(const [k,at] of claims)if(at<now-7*86400000)claims.delete(k);
      if(claims.has(id))throw fail('This friend request decision was already attempted; inspect QQ before retrying.',1409);
      if(claims.size>=2048)throw fail('Friend decision journal is full.',1429);
      const next=new Map(claims);next.set(id,now);await mkdir(profile,{recursive:true,mode:0o700});
      const temporary=file+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify({version:1,claims:[...next]}),{mode:0o600});await rename(temporary,file);claims=next;
    });claimWrite=task;await task;
  }
  function receive(snapshot){
    if(closed)return;
    let c;try{c=context();}catch{return;}const receivedEpoch=epoch;
    try{pendingRows(snapshot);}catch{raw=null;waiter?.reject(fail('Invalid friend request snapshot.'));return;}
    raw=snapshot;revision++;waiter?.resolve(snapshot);
    if(queued>=8)return;queued++;
    queue=queue.catch(()=>{}).then(async()=>{
      if(receivedEpoch!==epoch)return;
      const rows=await normalize(c,snapshot);c.check();if(closed||receivedEpoch!==epoch)return;
      for(const row of rows){
        if(announced.has(row.flag))continue;
        announced.add(row.flag);if(announced.size>2048)announced.delete(announced.values().next().value);
        emitEvent({time:Number(row.reqTime),self_id:Number(c.account.uin),post_type:'request',request_type:'friend',user_id:Number(row.uin),comment:boundedText(row.extWords,'',2048,'native comment'),flag:row.flag});
      }
    }).catch(()=>{}).finally(()=>queued--);
  }
  async function refresh(c,op){
    if(nativePending)throw fail('A native friend request refresh is still pending.',1429);
    let timer;const before=revision;
    const snapshot=new Promise((resolve,reject)=>{waiter={resolve,reject};timer=setTimeout(()=>reject(fail('Friend request notification timed out.',1504)),timeoutMs);});
    // Attach both rejection handlers before dispatch, even on synchronous throws.
    nativePending=true;
    const acknowledgement=Promise.resolve().then(()=>c.services.buddyService.getBuddyReq()).finally(()=>{nativePending=false;}).then(requireAck);
    const result=Promise.all([snapshot,acknowledgement]);
    try{const [value]=await result;c.check();op.check();if(revision===before)throw fail('A fresh native request callback is required.');return await normalize(c,value);}
    finally{clearTimeout(timer);waiter=null;}
  }
  return {
    receive,
    invalidate(){epoch++;raw=null;waiter?.reject(fail('Friend request session changed.'));waiter=null;},
    status:()=>({...runner.status(),snapshot:raw!==null,queued,native_pending:nativePending}),
    close(){closed=true;runner.close();waiter?.reject(fail('Friend request service stopped.'));waiter=null;},
    async call(action,p){
      const c=context();if(!SOCIAL_ACTIONS.includes(action))throw fail('Unsupported friend request action.',1404);
      if(action==='get_friend_requests')return runner.run('requests',async op=>(await refresh(c,op)).map(r=>({user_id:Number(r.uin),time:Number(r.reqTime),comment:boundedText(r.extWords,'',2048,'native comment'),flag:r.flag})));
      if(action==='set_friend_add_request'){
        if(typeof p.flag!=='string'||!/^friend:[a-f0-9]{64}$/.test(p.flag))throw fail('Use an unmodified friend request flag.',1400);
        const approve=strictBoolean(p.approve,true,'approve'),remark=boundedText(p.remark,'',60,'remark'),reason=boundedText(p.reason,'',120,'reason');
        // The approval SDK has no atomic remark field. Do not silently ignore it.
        if(remark)throw fail('Approval remarks are not supported; approve without remark.',1404);
        return runner.run('requests',async op=>{
          const rows=await refresh(c,op),row=rows.find(x=>x.flag===p.flag);if(!row)throw fail('Friend request is expired, handled, or outside the allowlist.',1404);
          await claim(key(c,row));op.check();c.check();
          const result=await op.invoke(()=>c.services.buddyService.approvalFriendRequest({friendUid:row.friendUid,accept:approve,refuseMsg:approve?'':reason,reqTime:row.reqTime}));requireAck(result);acceptedContext(c);return null;
        });
      }
      const uin=typeof p.user_id==='number'?String(p.user_id):p.user_id;
      if(!validUin(uin))throw fail('user_id must be a valid QQ number.',1400);
      if(!allowed(uin))throw fail('Target is outside QQBRIDGE_ALLOWED_USERS.',1403);
      if(uin===c.account.uin)throw fail('Cannot add the current account.',1400);
      const comment=boundedText(p.comment,'',120,'comment'),remark=boundedText(p.remark,'',60,'remark');
      return runner.run('add:'+uin,async op=>{
        await c.friends.load(true);op.check();c.check();
        if(c.friends.lookup(uin))throw fail('Target is already a current friend.',1409);
        const s=c.services.addBuddyService;if(!s)throw fail('Native add-friend service is unavailable.',1404);
        const info=await s.requestInfoByAccount('',{uin,uid:'',phoneNum:''},new Map());op.check();c.check();
        requireAck(info);const target=info.rsp?.targetInfo;
        if(target?.uin!==uin||!validUid(target.uid))throw fail('QQ returned a different or unresolved add-friend target.');
        const setting=await s.getBuddySetting('',{targetInfo:{uin,uid:target.uid,phoneNum:''},sourceId:2002,sourceSubId:0},new Map());op.check();c.check();requireAck(setting);
        const rsp=setting.rsp;
        if(rsp?.result!==0||rsp.errorCode!==0||rsp.targetInfo?.uin!==uin||rsp.targetInfo?.uid!==target.uid)throw fail('Unable to verify the target friend policy.');
        if(![0,1].includes(rsp.querySetting)||rsp.question?.length)throw fail('This target requires a question, verification challenge, or unsupported friend policy.',1404);
        const result=await op.invoke(()=>c.services.buddyService.reqToAddFriends({buddyUin:uin,buddyUid:target.uid,phoneNumber:'',addFriendSetting:rsp.querySetting,answer:'',remark,defaultCatgory:0,verifyInfo:comment,securityVerify:'',sourceID:2002,sourceSubID:0,qzoneNotWatch:false,qzoneNotWatched:false,onlyChat:false}));requireAck(result);acceptedContext(c);
        return {request_sent:true};
      });
    },
  };
}
