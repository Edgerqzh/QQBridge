import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createGroupManagement} from '../src/native/group-management.mjs';
import {createSocialActions} from '../src/native/social-actions.mjs';
import {createMutationRunner} from '../src/native/mutations.mjs';
const own={uin:'10000001',uid:'u_owner'},target={uin:'20000001',uid:'u_target',role:2};
const reject=code=>e=>e.retcode===code;
const tick=()=>new Promise(r=>setTimeout(r,3));
function groupFixture(t,role=4){
  const calls=[];let valid=true,complete=true,ack={result:0},rows=[{...own,role},target];
  const service={getAllMemberList:async(g,force)=>{assert.equal(force,true);return {errCode:0,result:{finish:complete,infos:new Map(rows.map(r=>[r.uid,r]))}};}};
  for(const method of ['setMemberShutUp','setGroupShutUp','kickMember','modifyMemberRole','modifyMemberCardName','modifyGroupName','quitGroup'])service[method]=(...args)=>{calls.push([method,...args]);return ack;};
  const manager=createGroupManagement({timeoutMs:40,getContext:()=>({account:own,services:{groupService:service},groups:()=>[{groupCode:'10001',groupName:'Fixture',maxMember:200}],check(g){if(!valid||g!=='10001')throw Object.assign(Error('scope'),{retcode:1403});}})});t.after(()=>manager.close());
  return {manager,calls,service,setRows:v=>rows=v,setValid:v=>valid=v,setComplete:v=>complete=v,setAck:v=>ack=v};
}
test('group mutations use verified member UIDs and exact native argument shapes',async t=>{
  const f=groupFixture(t);
  for(const [action,params] of [['set_group_ban',{duration:60}],['set_group_whole_ban',{enable:false}],['set_group_kick',{reject_add_request:true}],['set_group_admin',{enable:true}],['set_group_card',{card:'Card'}],['set_group_name',{group_name:'Name'}]])await f.manager.call(action,{group_id:10001,user_id:20000001,...params});
  assert.deepEqual(f.calls,[['setMemberShutUp','10001',[{uid:'u_target',timeStamp:60}]],['setGroupShutUp','10001',false],['kickMember','10001',['u_target'],true,''],['modifyMemberRole','10001','u_target',3],['modifyMemberCardName','10001','u_target','Card'],['modifyGroupName','10001','Name',false]]);
});
test('members can edit their own card and leave; cannot moderate others',async t=>{
  const f=groupFixture(t,2);await f.manager.call('set_group_card',{group_id:10001,user_id:own.uin,card:''});await f.manager.call('set_group_leave',{group_id:10001});
  await assert.rejects(f.manager.call('set_group_ban',{group_id:10001,user_id:target.uin}),reject(1403));assert.equal(f.calls.length,2);
});
test('admin role hierarchy and owner-only role assignment fail before dispatch',async t=>{
  const f=groupFixture(t,3);f.setRows([{...own,role:3},{...target,role:3}]);
  for(const action of ['set_group_ban','set_group_kick','set_group_admin','set_group_card'])await assert.rejects(f.manager.call(action,{group_id:10001,user_id:target.uin}),reject(1403));assert.equal(f.calls.length,0);
});
test('invalid options, missing membership and incomplete rosters cannot mutate',async t=>{
  const f=groupFixture(t);
  for(const [action,p] of [['set_group_ban',{duration:-1}],['set_group_ban',{duration:2592001}],['set_group_whole_ban',{enable:'false'}],['set_group_name',{group_name:''}],['set_group_leave',{is_dismiss:true}]])await assert.rejects(f.manager.call(action,{group_id:10001,user_id:target.uin,...p}));
  f.setComplete(false);await assert.rejects(f.manager.call('set_group_ban',{group_id:10001,user_id:target.uin}));f.setComplete(true);f.setValid(false);await assert.rejects(f.manager.call('set_group_name',{group_id:10001,group_name:'Name'}),reject(1403));assert.equal(f.calls.length,0);
});
test('group info reflects verified roster; owners cannot leave or promote themselves',async t=>{
  const f=groupFixture(t);assert.deepEqual(await f.manager.call('get_group_info',{group_id:10001}),{group_id:10001,group_name:'Fixture',member_count:2,max_member_count:200});
  await assert.rejects(f.manager.call('set_group_leave',{group_id:10001}),reject(1403));await assert.rejects(f.manager.call('set_group_admin',{group_id:10001,user_id:own.uin}),reject(1403));assert.equal(f.calls.length,0);
});
test('malformed or rejected group acknowledgements are never treated as success or retried',async t=>{
  const f=groupFixture(t);for(const ack of [undefined,{result:1},{errCode:0}]){f.setAck(ack);await assert.rejects(f.manager.call('set_group_name',{group_id:10001,group_name:'Name'}),reject(1500));}assert.equal(f.calls.length,3);
});
test('timed out mutations retain locks and never dispatch after preflight expires',async()=>{
  const r=createMutationRunner({timeoutMs:15,maxConcurrent:1});let finish,dispatched=0;
  const p=r.run('g',async op=>{await new Promise(resolve=>finish=resolve);op.invoke(()=>dispatched++);});await assert.rejects(p,reject(1504));await assert.rejects(r.run('g',()=>{}),reject(1429));finish();await tick();assert.equal(dispatched,0);assert.equal(r.status().active,0);r.close();
});
async function socialFixture(t,options={}){
  const profile=options.profile??await mkdtemp(path.join(os.tmpdir(),'qqbridge-social-'));if(!options.profile)t.after(()=>rm(profile,{recursive:true,force:true}));
  const calls=[],events=[];let valid=true,snapshot={unreadNums:1,buddyReqs:[{friendUid:target.uid,reqTime:String(Math.floor(Date.now()/1000)),isDecide:false,isInitiator:false,isDoubt:false,reqType:1,extWords:'Fixture request'}]},social;
  const services={groupService:{getUinByUids:async ids=>({errCode:0,uins:new Map(ids.map(id=>[id,target.uin]))})},buddyService:{getBuddyReq(){social.receive(snapshot);return {result:0};},approvalFriendRequest(p){calls.push(['approve',p]);return {result:0};},reqToAddFriends(p){calls.push(['add',p]);return {result:0};}},addBuddyService:{requestInfoByAccount:async()=>({result:0,rsp:{targetInfo:{...target}}}),getBuddySetting:async()=>({result:0,rsp:{result:0,errorCode:0,querySetting:1,question:[],targetInfo:{...target}}})}};
  const getContext=()=>({account:own,services,friends:{load:async()=>{},lookup:()=>null},check(){if(!valid)throw Object.assign(Error('session'),{retcode:1503});}});
  social=createSocialActions({getContext,profile,emitEvent:e=>events.push(e),timeoutMs:50,allowedUsers:options.allowedUsers});t.after(()=>social.close());
  return {social,calls,events,services,profile,getContext,setValid:v=>valid=v,setSnapshot:v=>snapshot=v,snapshot:()=>snapshot};
}
test('real-shaped requests emit deduplicated OneBot events and stable opaque flags',async t=>{
  const f=await socialFixture(t),list=await f.social.call('get_friend_requests',{});await tick();assert.equal(list.length,1);assert.match(list[0].flag,/^friend:[a-f0-9]{64}$/);assert.equal(list[0].flag.includes('u_target'),false);
  f.social.receive(f.snapshot());await tick();assert.equal(f.events.length,1);assert.equal(f.events[0].post_type,'request');assert.equal(f.events[0].user_id,20000001);assert.equal(f.events[0].flag,list[0].flag);
});
test('outgoing, handled, doubtful and disallowed incoming requests are excluded',async t=>{
  const f=await socialFixture(t,{allowedUsers:new Set()});assert.deepEqual(await f.social.call('get_friend_requests',{}),[]);await tick();assert.equal(f.events.length,0);
  const g=await socialFixture(t);g.setSnapshot({buddyReqs:[{...g.snapshot().buddyReqs[0],isInitiator:true},{...g.snapshot().buddyReqs[0],isDecide:true},{...g.snapshot().buddyReqs[0],isDoubt:true}]});assert.deepEqual(await g.social.call('get_friend_requests',{}),[]);
});
test('request approval uses exact UID/time and durable claim blocks a second process attempt',async t=>{
  const f=await socialFixture(t),[row]=await f.social.call('get_friend_requests',{});await f.social.call('set_friend_add_request',{flag:row.flag,approve:true});assert.deepEqual(f.calls[0],['approve',{friendUid:target.uid,accept:true,refuseMsg:'',reqTime:row.time.toString()}]);
  await assert.rejects(f.social.call('set_friend_add_request',{flag:row.flag}),reject(1409));
  const g=await socialFixture(t,{profile:f.profile});g.setSnapshot(f.snapshot());await assert.rejects(g.social.call('set_friend_add_request',{flag:row.flag}),reject(1409));assert.equal(g.calls.length,0);
  const journal=await readFile(path.join(f.profile,'management-claims.json'),'utf8');assert.equal(journal.includes(target.uid),false);
});
test('rejection forwards reason; stale or fabricated request flags cannot approve',async t=>{
  const f=await socialFixture(t),[row]=await f.social.call('get_friend_requests',{});await assert.rejects(f.social.call('set_friend_add_request',{flag:'friend:'+'a'.repeat(64)}),reject(1404));
  await f.social.call('set_friend_add_request',{flag:row.flag,approve:false,reason:'Fixture rejection'});assert.equal(f.calls[0][1].accept,false);assert.equal(f.calls[0][1].refuseMsg,'Fixture rejection');
});
test('corrupt decision journal fails closed before sending approval',async t=>{
  const f=await socialFixture(t),[row]=await f.social.call('get_friend_requests',{});await writeFile(path.join(f.profile,'management-claims.json'),'{}');await assert.rejects(f.social.call('set_friend_add_request',{flag:row.flag}),reject(1503));assert.equal(f.calls.length,0);
});
test('outgoing friend request verifies target and policy and sends exactly once',async t=>{
  const f=await socialFixture(t);assert.deepEqual(await f.social.call('add_friend',{user_id:20000001,comment:'Fixture verification',remark:'Fixture'}),{request_sent:true});assert.equal(f.calls.length,1);assert.equal(f.calls[0][1].buddyUid,target.uid);assert.equal(f.calls[0][1].verifyInfo,'Fixture verification');
});
test('mismatched target, unsupported question policy and whitelist prevent outgoing requests',async t=>{
  const f=await socialFixture(t);f.services.addBuddyService.getBuddySetting=async()=>({result:0,rsp:{result:0,errorCode:0,querySetting:2,question:['Question'],targetInfo:target}});await assert.rejects(f.social.call('add_friend',{user_id:target.uin}),reject(1404));
  f.services.addBuddyService.requestInfoByAccount=async()=>({result:0,rsp:{targetInfo:{...target,uin:'30000001'}}});await assert.rejects(f.social.call('add_friend',{user_id:target.uin}));assert.equal(f.calls.length,0);
  const g=await socialFixture(t,{allowedUsers:new Set()});await assert.rejects(g.social.call('add_friend',{user_id:target.uin}),reject(1403));assert.equal(g.calls.length,0);
});
test('lost friend refresh acknowledgement keeps the native slot occupied',async t=>{
  const f=await socialFixture(t);f.services.buddyService.getBuddyReq=()=>new Promise(()=>{});await assert.rejects(f.social.call('get_friend_requests',{}),reject(1504));await assert.rejects(f.social.call('get_friend_requests',{}),reject(1429));assert.equal(f.social.status().native_pending,true);
});

test('an already-dispatched timed-out mutation stays locked until native settlement',async()=>{
  const r=createMutationRunner({timeoutMs:12});let resolveNative,attempts=0;
  const result=r.run('g',op=>op.invoke(()=>{attempts++;return new Promise(resolve=>resolveNative=resolve);}));
  await assert.rejects(result,e=>e.retcode===1504&&/unknown/.test(e.message));await assert.rejects(r.run('g',()=>attempts++),reject(1429));assert.equal(attempts,1);
  resolveNative({result:0});await tick();assert.equal(r.status().active,0);r.close();
});
test('a rejected approval is durably marked and does not dispatch twice',async t=>{
  const f=await socialFixture(t),[row]=await f.social.call('get_friend_requests',{});let attempts=0;
  f.services.buddyService.approvalFriendRequest=()=>{attempts++;return {result:5};};
  await assert.rejects(f.social.call('set_friend_add_request',{flag:row.flag}),reject(1500));await assert.rejects(f.social.call('set_friend_add_request',{flag:row.flag}),reject(1409));assert.equal(attempts,1);
});
test('multiple distinct request claims survive atomic journal replacement',async t=>{
  const f=await socialFixture(t);let [row]=await f.social.call('get_friend_requests',{});await f.social.call('set_friend_add_request',{flag:row.flag});
  f.setSnapshot({buddyReqs:[{...f.snapshot().buddyReqs[0],reqTime:String(row.time-1)}]});[row]=await f.social.call('get_friend_requests',{});await f.social.call('set_friend_add_request',{flag:row.flag});
  const journal=JSON.parse(await readFile(path.join(f.profile,'management-claims.json'),'utf8'));assert.equal(journal.claims.length,2);assert.equal(f.calls.length,2);
});
test('invalidating during UID lookup suppresses stale account request events',async t=>{
  const f=await socialFixture(t);let settle;f.services.groupService.getUinByUids=()=>new Promise(resolve=>settle=resolve);
  f.social.receive(f.snapshot());await tick();f.social.invalidate();settle({errCode:0,uins:new Map([[target.uid,target.uin]])});await tick();assert.equal(f.events.length,0);
});
test('account changes after accepted approval report uncertain outcome',async t=>{
  const f=await socialFixture(t),[row]=await f.social.call('get_friend_requests',{});
  f.services.buddyService.approvalFriendRequest=()=>{f.setValid(false);return {result:0};};await assert.rejects(f.social.call('set_friend_add_request',{flag:row.flag}),reject(1504));
});
test('invalid native roster identities cannot authorize a group mutation',async t=>{
  const f=groupFixture(t);f.setRows([{...own,role:4},{...target,uid:'20000001'}]);await assert.rejects(f.manager.call('set_group_ban',{group_id:10001,user_id:target.uin}));assert.equal(f.calls.length,0);
});
