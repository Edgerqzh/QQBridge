import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {buildGroupSegments} from '../src/native/segments.mjs';
import {receivedSegments} from '../src/native/received-segments.mjs';
import {createMessageMapper} from '../src/native/messages.mjs';
import {createExtendedActions} from '../src/native/extended-actions.mjs';
import {createGroupContent} from '../src/native/group-content.mjs';
import {createMediaStore} from '../src/native/media.mjs';
import {createVideoPreparer} from '../src/native/video.mjs';
import {pokeNotices} from '../src/native/poke.mjs';
import {createGroupManagement} from '../src/native/group-management.mjs';
import {createPrivateActions} from '../src/native/private-actions.mjs';
import {createReceivedMediaCache} from '../src/native/media-cache.mjs';
import {createHash} from 'node:crypto';
const owner={uin:'10000001',uid:'u_owner'},target={uin:'20000001',uid:'u_target'},ret=code=>e=>e.retcode===code;
const record={chatType:2,peerUin:'10001',peerUid:'10001',senderUin:target.uin,senderUid:target.uid,msgId:'7000000000000000001',msgSeq:'1',msgTime:'1793340000',isImportMsg:false,isOnlineMsg:true,elements:[{elementType:1,textElement:{content:'Fixture'}}]};
async function dir(t){const p=await mkdtemp(path.join(os.tmpdir(),'qqbridge-extended-'));t.after(()=>rm(p,{recursive:true,force:true}));return p;}
test('face and JSON cards build native elements with bounded payloads',async()=>{
  const built=await buildGroupSegments({groupId:'10001',message:[{type:'face',data:{id:'311'}},{type:'json',data:{data:'{"app":"com.tencent.test","meta":{}}'}}]});assert.deepEqual(built.elements.map(x=>x.elementType),[6,10]);assert.equal(built.elements[0].faceElement.faceIndex,311);
  for(const message of [[{type:'face',data:{id:-1}}],[{type:'json',data:{data:'[]'}}],[{type:'json',data:{data:'{"app":"com.tencent.multimsg"}'}}]])await assert.rejects(buildGroupSegments({groupId:'10001',message}),ret(1400));
});
test('video, face, card and forward map without leaking native resource identifiers',()=>{
  const mapper=createMessageMapper({selfId:owner.uin,richMedia:true});const event=mapper.fromNative({...record,elements:[{elementType:5,videoElement:{fileUuid:'video-fixture'}},{elementType:6,faceElement:{faceIndex:311}},{elementType:10,arkElement:{bytesData:'{"app":"com.tencent.test"}'}},{elementType:16,multiForwardMsgElement:{resId:'native-resource'}}]});
  assert.deepEqual(event.message.map(x=>x.type),['video','face','json','forward']);assert.equal(event.message[3].data.id,'forward:'+event.message_id);assert.equal(JSON.stringify(event).includes('native-resource'),false);
});
test('malformed incoming cards and unknown forwards remain unsupported',()=>{
  assert.equal(receivedSegments([{elementType:10,arkElement:{bytesData:'not-json'}}]),null);assert.equal(receivedSegments([{elementType:16,multiForwardMsgElement:{resId:'x'}}]),null);
});
test('poke notices require verified business identifiers, structured actors and persistent dedup',async()=>{
  const mapper=createMessageMapper({selfId:owner.uin,richMedia:true}),args={account:owner,mapper,check(){},groupService:{getUinByUids:async()=>({errCode:0,uins:new Map([[target.uid,target.uin]])})}};
  const poke={...record,elements:[{elementType:8,grayTipElement:{subElementType:17,jsonGrayTipElement:{busiId:'1061',jsonStr:JSON.stringify({items:[{type:'qq',uid:target.uid},{type:'nor',txt:'arbitrary display text'},{type:'qq',uid:owner.uid}]})}}}]};
  const [event]=await pokeNotices(poke,args);assert.equal(event.sub_type,'poke');assert.equal(event.user_id,Number(target.uin));assert.equal(event.target_id,Number(owner.uin));assert.deepEqual(await pokeNotices(poke,args),[]);
  const restored=createMessageMapper({selfId:owner.uin,richMedia:true,initialState:mapper.snapshot()});assert.deepEqual(await pokeNotices(poke,{...args,mapper:restored}),[]);
  poke.msgId='7000000000000000002';poke.elements[0].grayTipElement.jsonGrayTipElement.busiId='19324';assert.deepEqual(await pokeNotices(poke,args),[]);
});
test('private poke notices omit group fields and reject incomplete actors',async()=>{
  const mapper=createMessageMapper({selfId:owner.uin,richMedia:true,privateMessages:true}),args={account:owner,mapper,check(){},groupService:{}};
  const poke={...record,chatType:1,peerUin:target.uin,elements:[{elementType:8,grayTipElement:{subElementType:17,jsonGrayTipElement:{busiId:'1061',jsonStr:JSON.stringify({items:[{type:'qq',uid:target.uin},{type:'qq',uid:owner.uin}]})}}}]};
  assert.equal('group_id' in (await pokeNotices(poke,args))[0],false);
});
function extended(t,options={}){
  const calls=[];let valid=true;const source={...record,elements:[{elementType:16,multiForwardMsgElement:{resId:'fixture'}}]};
  const services={msgService:{getMultiMsg:async(...args)=>{calls.push(['read',...args]);return {result:0,msgList:[record]};},buildMultiForwardMsg:async(...args)=>{calls.push(['build',...args]);return {result:0,rspInfo:{elements:[{elementType:10,arkElement:{bytesData:'{}'}}]}};},generateMsgUniqueId:()=> '7000000000000000003',sendMsg:async(...args)=>{calls.push(['send',...args]);return {result:0};},sendNudge:async(...args)=>{calls.push(['poke',...args]);return {result:0};}},groupService:{getAllMemberList:async()=>({errCode:0,result:{finish:true,infos:new Map([[target.uid,{...target,role:2}]])}})}};
  const context={account:owner,services,friends:{resolve:async()=>target},mapper:{rememberNative:()=>5},flush:async()=>{},check(group){if(!valid||group!==undefined&&group!=='10001')throw Object.assign(Error(),{retcode:1403});}};
  const api=createExtendedActions({getContext:()=>context,resolveRecord:async id=>{if(id!==1)throw Object.assign(Error(),{retcode:1404});return source;},timeoutMs:80});t.after(()=>api.close());return {api,calls,services,context,setValid:x=>valid=x};
}
test('forward reads derive native root IDs only from an authorized message',async t=>{
  const f=extended(t),v=await f.api.call('get_forward_msg',{id:'forward:1'});assert.equal(v.message.length,1);assert.deepEqual(f.calls[0],['read',{chatType:2,peerUid:'10001',guildId:''},record.msgId,record.msgId]);
  await assert.rejects(f.api.call('get_forward_msg',{id:'arbitrary-resource'}),ret(1400));await assert.rejects(f.api.call('get_forward_msg',{id:'forward:1:999'}),ret(1403));
});
test('merged forwarding builds from existing source IDs then persists its real send alias',async t=>{
  const f=extended(t),v=await f.api.call('send_group_forward_msg',{group_id:10001,messages:[{type:'node',data:{id:1}}]});assert.equal(v.message_id,5);assert.deepEqual(f.calls.map(x=>x[0]),['build','send']);assert.equal(f.calls[0][1].srcMsgIds[0],record.msgId);
  await assert.rejects(f.api.call('send_group_forward_msg',{group_id:10001,messages:[{type:'node',data:{content:'invented'}}]}),ret(1400));
});
test('poke sends resolve current members and never accept arbitrary native UIDs',async t=>{
  const f=extended(t);await f.api.call('group_poke',{group_id:10001,user_id:target.uin});assert.equal(f.calls[0][2],target.uin);assert.equal(f.calls[0][3],'10001');await assert.rejects(f.api.call('group_poke',{group_id:10001,user_id:'u_arbitrary'}),ret(1400));await assert.rejects(f.api.call('group_poke',{group_id:10001,user_id:'30000001'}),ret(1403));
});
test('scope changes during forward preparation prevent its outgoing send',async t=>{
  const f=extended(t);f.services.msgService.buildMultiForwardMsg=async()=>{f.setValid(false);return {result:0,rspInfo:{elements:[{elementType:10,arkElement:{bytesData:'{}'}}]}};};await assert.rejects(f.api.call('send_group_forward_msg',{group_id:10001,messages:[{type:'node',data:{id:1}}]}),ret(1403));assert.equal(f.calls.some(x=>x[0]==='send'),false);
});
async function content(t,role=4){
  const profile=await dir(t),calls=[],events=[];let api,rows=[{seq:'7000000000000000001',type:1,status:1,group:{groupCode:'10001'},user1:{uid:target.uid},actionTime:'1793340000',postscript:'Fixture'}],valid=true;
  const services={session:{getTipOffService:()=>({getPskey:async domains=>{assert.deepEqual(domains,['qun.qq.com']);return {result:0,domainPskeyMap:new Map([['qun.qq.com','fixture-domain-key']])};}})},groupService:{getSingleScreenNotifies(){api.receiveNotifies(false,rows);return {result:0};},getUinByUids:async()=>({errCode:0,uins:new Map([[target.uid,target.uin]])}),getAllMemberList:async()=>({errCode:0,result:{finish:true,infos:new Map([[owner.uid,{...owner,role}]])}}),operateSysNotify:async(...a)=>{calls.push(['approve',...a]);return {result:0};},getGroupBulletin(group){api.receiveBulletin(group,{groupCode:group,feedsRecords:[]});return {result:0};},publishGroupBulletin:async(...a)=>{calls.push(['publish',...a]);return {result:0};},deleteGroupBulletin:async(...a)=>{calls.push(['delete',...a]);return {result:0};}}};
  api=createGroupContent({profile,getContext:()=>({account:owner,services,check(g){if(!valid||g!==undefined&&g!=='10001')throw Object.assign(Error(),{retcode:1403});}}),emitEvent:e=>events.push(e),timeoutMs:60});t.after(()=>api.close());return {api,calls,events,services,setRows:x=>rows=x,setValid:x=>valid=x};
}
test('pending group applications emit opaque flags and preserve native sequence for approval',async t=>{
  const f=await content(t),rows=await f.api.call('get_group_requests',{});assert.equal(rows.length,1);assert.match(rows[0].flag,/^group:[a-f0-9]{64}$/);assert.equal(f.events[0].request_type,'group');await f.api.call('set_group_add_request',{flag:rows[0].flag,approve:true});assert.equal(f.calls[0][1],false);assert.equal(f.calls[0][2].targetMsg.seq,'7000000000000000001');assert.equal(f.calls[0][2].operateType,1);await assert.rejects(f.api.call('set_group_add_request',{flag:rows[0].flag}),ret(1409));
});
test('group role changes and handled notifications never become applications',async t=>{
  const f=await content(t);f.setRows([{type:8,status:0},{type:1,status:2}]);assert.deepEqual(await f.api.call('get_group_requests',{}),[]);assert.equal(f.events.length,0);
});
test('ordinary members cannot approve applications or publish announcements',async t=>{
  const f=await content(t,2),[r]=await f.api.call('get_group_requests',{});await assert.rejects(f.api.call('set_group_add_request',{flag:r.flag}),ret(1403));await assert.rejects(f.api.call('send_group_notice',{group_id:10001,content:'Fixture'}),ret(1403));assert.equal(f.calls.length,0);
});
test('announcement read, publish and removal use exact native contracts',async t=>{
  const f=await content(t);assert.deepEqual(await f.api.call('get_group_notice',{group_id:10001}),[]);await f.api.call('send_group_notice',{group_id:10001,content:'Fixture',pinned:true});await f.api.call('delete_group_notice',{group_id:10001,notice_id:'fixture'});assert.deepEqual(f.calls,[['publish','10001','fixture-domain-key',{text:'Fixture',oldFeedsId:'',picInfo:null,pinned:1,confirmRequired:0}],['delete','10001','fixture-domain-key','fixture']]);
});
test('transfer and dissolution require a verified owner and exact member identity',async t=>{
  const calls=[];let role=4;const service={getAllMemberList:async()=>({errCode:0,result:{finish:true,infos:new Map([[owner.uid,{...owner,role}],[target.uid,{...target,role:2}]])}}),transferGroup:async(...a)=>{calls.push(['transfer',...a]);return {result:0};},destroyGroup:async(...a)=>{calls.push(['dismiss',...a]);return {result:0};}};
  const api=createGroupManagement({getContext:()=>({account:owner,services:{groupService:service},check(){}})});t.after(()=>api.close());await api.call('transfer_group',{group_id:10001,user_id:target.uin});await api.call('set_group_leave',{group_id:10001,is_dismiss:true});assert.deepEqual(calls,[['transfer','10001',target.uid,''],['dismiss','10001']]);role=3;await assert.rejects(api.call('dismiss_group',{group_id:10001}),ret(1403));await assert.rejects(api.call('transfer_group',{group_id:10001,user_id:target.uin}),ret(1403));assert.equal(calls.length,2);
});
test('video preparation rejects non-MP4 input before invoking external tools',async t=>{
  const profile=await dir(t),store=createMediaStore({directory:profile}),video=createVideoPreparer();t.after(()=>video.close());const m=await store.prepare('base64://'+Buffer.from('not video').toString('base64'),'video');await assert.rejects(video.prepare(m),ret(1400));assert.equal(video.status().active,0);
});
test('video probe generates a real H.264 thumbnail and releases every process',async t=>{
  if(spawnSync('ffmpeg',['-version'],{windowsHide:true}).status!==0||spawnSync('ffprobe',['-version'],{windowsHide:true}).status!==0){t.skip('FFmpeg / ffprobe unavailable');return;}
  const profile=await dir(t),input=path.join(profile,'fixture.mp4');const made=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=32x32:d=1','-c:v','libx264','-pix_fmt','yuv420p','-y',input],{windowsHide:true});assert.equal(made.status,0);
  const store=createMediaStore({directory:path.join(profile,'media')}),video=createVideoPreparer();t.after(()=>video.close());const m=await store.prepare('base64://'+(await readFile(input)).toString('base64'),'video');const v=await video.prepare(m);assert.equal(v.duration,1);assert.equal((await readFile(v.thumbPath))[0],255);assert.equal(video.status().active,0);assert.equal(video.status().processes,0);
});

test('large canonical Base64 does not overflow the regular expression stack',async t=>{
  const profile=await dir(t),store=createMediaStore({directory:profile}),bytes=Buffer.alloc(5*1024*1024,7);const m=await store.prepare('base64://'+bytes.toString('base64'),'file');assert.equal(Number(m.size),bytes.length);await assert.rejects(store.prepare('base64://AB==','file'),ret(1400));
});
test('private system gray records are skipped without relaxing peer or user sender checks',async t=>{
  const mapper=createMessageMapper({selfId:owner.uin,privateMessages:true,richMedia:true}),friend={...target,user_id:Number(target.uin)};
  const good={...record,chatType:1,peerUin:target.uin,peerUid:target.uid},gray={...good,msgId:'7000000000000000002',senderUin:'0',msgType:5,elements:[{elementType:8,grayTipElement:{subElementType:17}}]};let rows=[good,gray];
  const api=createPrivateActions({getContext:()=>({account:owner,mapper,friends:{resolve:async()=>friend},services:{msgService:{getLatestDbMsgs:async()=>({result:0,msgList:rows})}},check(){},rememberMedia(){},flush:async()=>{}})});t.after(()=>api.close());
  assert.equal((await api.call('get_friend_msg_history',{user_id:target.uin})).messages.length,1);
  rows=[{...gray,peerUid:'u_foreign'}];await assert.rejects(api.call('get_friend_msg_history',{user_id:target.uin}),ret(1403));
  rows=[{...good,senderUin:'30000001'}];await assert.rejects(api.call('get_friend_msg_history',{user_id:target.uin}),ret(1403));
});
test('small online files use a ten-megabyte digest as their complete checksum',async t=>{
  const profile=await dir(t),bytes=Buffer.from('Fixture video bytes'),md5=createHash('md5').update(bytes).digest('hex');
  const cache=createReceivedMediaCache({profile,getMsgService:()=>({getRichMediaElement:async p=>{const {writeFile}=await import('node:fs/promises');await writeFile(p.filePath,bytes);}})});t.after(()=>cache.clear());
  cache.remember({...record,elements:[{elementType:3,elementId:'1',fileElement:{fileUuid:'fixture-video',fileName:'fixture.mp4',fileSize:String(bytes.length),file10MMd5:md5}}]});assert.equal((await cache.read('fixture-video',()=>true)).base64,bytes.toString('base64'));
});
test('cached bulletin snapshots are reused only after a successful native acknowledgement',async t=>{
  const f=await content(t);await f.api.call('get_group_notice',{group_id:10001});f.services.groupService.getGroupBulletin=()=>({result:0});assert.deepEqual(await f.api.call('get_group_notice',{group_id:10001}),[]);
  f.services.groupService.getGroupBulletin=()=>({result:3});await assert.rejects(f.api.call('get_group_notice',{group_id:10001}),ret(1500));
});
test('concurrent group application readers share one native snapshot request',async t=>{
  const f=await content(t);let calls=0,complete;f.services.groupService.getSingleScreenNotifies=()=>{calls++;return new Promise(resolve=>complete=()=>{f.api.receiveNotifies(false,[]);resolve({result:0});});};
  const reads=Array.from({length:10},()=>f.api.call('get_group_requests',{}));await new Promise(setImmediate);complete();await Promise.all(reads);assert.equal(calls,1);
});

test('delayed native notification pushes do not recursively poll the server',async t=>{
  const f=await content(t);let requests=0;const original=f.services.groupService.getSingleScreenNotifies;f.services.groupService.getSingleScreenNotifies=(...args)=>{requests++;return original(...args);};
  await f.api.call('get_group_requests',{});f.api.receiveNotifies(false,[]);await new Promise(resolve=>setTimeout(resolve,20));assert.equal(requests,1);
});

test('announcement output exposes a stable public schema without native identities or settings',async t=>{
  const f=await content(t);f.services.groupService.getGroupBulletin=group=>{f.api.receiveBulletin(group,{groupCode:group,feedsRecords:[{groupCode:group,fromUid:'u_private_native_identity',feedsId:'fixture-notice',createTime:1793340000,setTop:1,feedsMsg:{feedsContents:[{contentType:0,contentValue:'Fixture announcement'},{contentType:10,contentValue:'SDK setting'}]}}]});return {result:0};};
  const data=await f.api.call('get_group_notice',{group_id:10001});assert.deepEqual(data,[{notice_id:'fixture-notice',group_id:10001,publish_time:1793340000,pinned:true,content:'Fixture announcement'}]);assert.equal(JSON.stringify(data).includes('u_private_native_identity'),false);
});
