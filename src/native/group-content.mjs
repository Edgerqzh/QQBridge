import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {positiveId} from './context-actions.mjs';
import {createMutationRunner,requireAck,strictBoolean,boundedText} from './mutations.mjs';
const fail=(message,retcode=1503)=>Object.assign(new Error(message),{retcode});
const validUid=v=>typeof v==='string'&&/^u_[A-Za-z0-9_-]{1,126}$/.test(v);
const decimal=v=>typeof v==='string'&&/^[1-9]\d{0,63}$/.test(v);
export const GROUP_CONTENT_ACTIONS=Object.freeze(['get_group_requests','set_group_add_request','get_group_notice','send_group_notice','delete_group_notice']);
export function createGroupContent({getContext,profile,emitEvent=()=>{},timeoutMs=8000}){
  const runner=createMutationRunner({timeoutMs}),seen=new Set(),bulletins=new Map(),bulletinSnapshots=new Map(),nativeReads=new Set();let closed=false,epoch=0,notifyWaiter=null,notifySnapshot=null,requestRead=null,eventTail=Promise.resolve(),queuedEvents=0;
  const context=group=>{if(closed)throw fail('Group content service stopped.');const c=getContext();c.check(group);return c;};
  const flag=(c,r)=>'group:'+createHash('sha256').update([c.account.uid,r.group.groupCode,r.seq,r.type].join('\0')).digest('hex');
  async function members(c,group){
    const r=await c.services.groupService.getAllMemberList(group,true);c.check(group);
    if(r?.errCode!==0||r.result?.finish!==true||!(r.result.infos instanceof Map)||r.result.infos.size>10000)throw fail('Complete group roster required.');
    const own=[...r.result.infos.values()].find(x=>x?.uin===c.account.uin&&x.uid===c.account.uid&&x.isDelete!==true);if(!own||![3,4].includes(own.role))throw fail('Group administrator permission is required.',1403);
  }
  function receiveNotifies(doubt,rows){
    if(closed||doubt!==false||!Array.isArray(rows)||rows.length>1000)return;
    notifySnapshot=rows;
    if(notifyWaiter){notifyWaiter.resolve(rows);return;}
    // A push is already a native snapshot. Mapping it must not fetch another
    // snapshot: the fetch's delayed callback would otherwise poll recursively.
    if(queuedEvents>=8)return;let c;try{c=context();}catch{return;}const receivedEpoch=epoch;queuedEvents++;
    eventTail=eventTail.catch(()=>{}).then(()=>receivedEpoch===epoch?runner.run('request-events',op=>mapRows(c,rows,op)):undefined).catch(()=>{}).finally(()=>queuedEvents--);
  }
  function receiveBulletin(group,value){
    if(closed||String(value?.groupCode)!==String(group)||!Array.isArray(value?.feedsRecords)||value.feedsRecords.length>1000)return;
    if(bulletinSnapshots.size>=256&&!bulletinSnapshots.has(String(group)))bulletinSnapshots.delete(bulletinSnapshots.keys().next().value);
    bulletinSnapshots.set(String(group),value.feedsRecords);
    const item=bulletins.get(String(group));item?.resolve?.(value.feedsRecords);
  }
  async function notices(c,op){
    if(nativeReads.has('requests'))throw fail('A native group request refresh is pending.',1429);
    let timer;const capturedEpoch=epoch;
    const snapshot=new Promise((resolve,reject)=>{notifyWaiter={resolve,reject};timer=setTimeout(()=>reject(fail('Group request callback timed out.',1504)),timeoutMs);if(notifySnapshot)resolve(notifySnapshot);});
    try{
      nativeReads.add('requests');const acknowledgement=Promise.resolve().then(async()=>{if(typeof c.services.groupService.fetchGroupNotify==='function')requireAck(await c.services.groupService.fetchGroupNotify(false));return c.services.groupService.getSingleScreenNotifies(false,'18446744073709551615',100);}).finally(()=>nativeReads.delete('requests')).then(requireAck);
      const [captured]=await Promise.all([snapshot,acknowledgement]);const rows=notifySnapshot??captured;op.check();c.check();if(capturedEpoch!==epoch)throw fail('Group request account changed.');
      return await mapRows(c,rows,op);
    }finally{clearTimeout(timer);notifyWaiter=null;}
  }
  async function mapRows(c,rows,op){
      const out=[];
      for(const r of rows){
        // Type 1 is an incoming membership application. Other notification
        // categories (roles, removals, invitations) must not become approvals.
        if(r?.type!==1||r.status!==1||!decimal(r.seq)||!validUid(r.user1?.uid)||!/^\d{1,12}$/.test(r.actionTime))continue;
        let group;try{group=positiveId(r.group?.groupCode);c.check(group);}catch{continue;}
        const ids=await c.services.groupService.getUinByUids([r.user1.uid]);op.check();c.check(group);
        const user=ids?.errCode===0&&ids.uins instanceof Map?ids.uins.get(r.user1.uid):null;if(typeof user!=='string'||!/^[1-9]\d{4,11}$/.test(user))continue;
        const item={raw:r,group_id:Number(group),user_id:Number(user),time:Number(r.actionTime),comment:boundedText(r.postscript,'',2048,'native comment'),sub_type:'add',flag:flag(c,r)};out.push(item);
        if(!seen.has(item.flag)){seen.add(item.flag);if(seen.size>2048)seen.delete(seen.values().next().value);emitEvent({time:item.time,self_id:Number(c.account.uin),post_type:'request',request_type:'group',sub_type:'add',group_id:item.group_id,user_id:item.user_id,comment:item.comment,flag:item.flag});}
      }
      return out;
  }
  async function claim(c,request){
    const dir=path.join(profile,'group-decisions');await mkdir(dir,{recursive:true,mode:0o700});const name=createHash('sha256').update(c.account.uid).digest('hex')+'.json',file=path.join(dir,name);
    let entries=[];try{entries=JSON.parse(await readFile(file,'utf8'));if(!Array.isArray(entries)||entries.length>2048||entries.some(x=>typeof x!=='string'||!/^group:[a-f0-9]{64}$/.test(x)))throw Error();}catch(e){if(e.code!=='ENOENT')throw fail('Group decision journal is invalid.');}
    if(entries.includes(request.flag))throw fail('This group request was already attempted; inspect QQ before retrying.',1409);if(entries.length>=2048)throw fail('Group decision journal is full.',1429);entries.push(request.flag);
    const temp=file+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(entries),{mode:0o600});await rename(temp,file);
  }
  async function readBulletins(c,group,op){
    if(nativeReads.has(group))throw fail('A native bulletin refresh is pending.',1429);
    let timer;const snapshot=new Promise((resolve,reject)=>{bulletins.set(group,{resolve,reject});timer=setTimeout(()=>reject(fail('Group bulletin callback timed out.',1504)),timeoutMs);if(bulletinSnapshots.has(group))resolve(bulletinSnapshots.get(group));});
    try{nativeReads.add(group);const acknowledgement=Promise.resolve().then(()=>c.services.groupService.getGroupBulletin(group)).finally(()=>nativeReads.delete(group)).then(requireAck);const [rows]=await Promise.all([snapshot,acknowledgement]);op.check();c.check(group);return bulletinSnapshots.get(group)??rows;}
    finally{clearTimeout(timer);bulletins.delete(group);}
  }
  const api={
    receiveNotifies,receiveBulletin,status:runner.status,
    invalidate(){epoch++;notifySnapshot=null;bulletinSnapshots.clear();notifyWaiter?.reject(fail('Group request session changed.'));for(const p of bulletins.values())p.reject(fail('Group bulletin session changed.'));},
    close(){closed=true;this.invalidate();runner.close();},
    async call(action,p){
      if(!GROUP_CONTENT_ACTIONS.includes(action))throw fail('Unsupported group content action.',1404);
      if(action==='get_group_requests'){
        if(requestRead)return requestRead;
        requestRead=runner.run('requests',async op=>{const rows=await notices(context(),op);return rows.map(({raw,...publicRow})=>publicRow);}).finally(()=>{requestRead=null;});return requestRead;
      }
      if(action==='set_group_add_request'){
        if(typeof p.flag!=='string'||!/^group:[a-f0-9]{64}$/.test(p.flag))throw fail('Use a group request flag from a real event or list.',1400);
        if((p.sub_type??p.type??'add')!=='add')throw fail('Only incoming group membership applications are supported.',1404);
        const approve=strictBoolean(p.approve,true,'approve'),reason=boundedText(p.reason,'',120,'reason');
        return runner.run('requests',async op=>{const c=context(),rows=await notices(c,op),r=rows.find(x=>x.flag===p.flag);if(!r)throw fail('Group request is unavailable or already handled.',1404);
          const group=String(r.group_id);await members(c,group);op.check();await claim(c,r);op.check();c.check(group);
          const raw=r.raw,result=await op.invoke(()=>c.services.groupService.operateSysNotify(false,{operateType:approve?1:2,targetMsg:{seq:raw.seq,type:raw.type,groupCode:group,postscript:approve?'':reason,setBlackList:false,operateData:'',operateTransInfo:raw.operateTransInfo??new Map()},operateSource:0}));requireAck(result);c.check();return null;});
      }
      const group=positiveId(p.group_id,'group_id'),c=context(group);
      const text=action==='send_group_notice'?boundedText(p.content,undefined,4096,'content'):null;
      if(text!==null&&!text.trim())throw fail('Announcement content must not be empty.',1400);
      const pinned=strictBoolean(p.pinned,false,'pinned'),confirm=strictBoolean(p.confirm_required,false,'confirm_required');
      const id=action==='delete_group_notice'?boundedText(p.notice_id,undefined,256,'notice_id'):null;if(id!==null&&!id)throw fail('notice_id must not be empty.',1400);
      return runner.run('bulletin:'+group,async op=>{
        if(action==='get_group_notice'){
          const rows=await readBulletins(c,group,op);
          return rows.filter(r=>String(r?.groupCode)===group&&typeof r.feedsId==='string'&&r.feedsId.length>0&&r.feedsId.length<=256&&!/[\u0000-\u001f\u007f]/.test(r.feedsId)).map(r=>({
            notice_id:r.feedsId,group_id:Number(group),publish_time:Number.isSafeInteger(r.createTime)&&r.createTime>=0?r.createTime:0,pinned:r.setTop===1,
            content:(Array.isArray(r.feedsMsg?.feedsContents)?r.feedsMsg.feedsContents:[]).filter(x=>x?.contentType===0&&typeof x.contentValue==='string').map(x=>x.contentValue).join('').slice(0,4096),
          }));
        }
        await members(c,group);op.check();c.check(group);
        // QQ's own bulletin implementation builds its HTTP Cookie / bkn from
        // this domain key. It stays inside the account session and native call.
        const credentials=await c.services.session.getTipOffService().getPskey(['qun.qq.com'],false);requireAck(credentials);op.check();c.check(group);
        const key=credentials.domainPskeyMap instanceof Map?credentials.domainPskeyMap.get('qun.qq.com'):null;
        if(typeof key!=='string'||!key.length||key.length>4096||/[\u0000-\u0020\u007f]/.test(key))throw fail('QQ group-announcement credentials are unavailable.');
        const result=await op.invoke(()=>action==='send_group_notice'?c.services.groupService.publishGroupBulletin(group,key,{text,oldFeedsId:'',picInfo:null,pinned:pinned?1:0,confirmRequired:confirm?1:0}):c.services.groupService.deleteGroupBulletin(group,key,id));requireAck(result);c.check(group);return null;
      });
    },
  };return api;
}
