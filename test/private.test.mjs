import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createFriendActions} from '../src/native/friends.mjs';
import {createMessageMapper} from '../src/native/messages.mjs';
import {createPrivateActions} from '../src/native/private-actions.mjs';
import {createReceivedMediaCache} from '../src/native/media-cache.mjs';
import {buildGroupSegments} from '../src/native/segments.mjs';
import {sendElements} from '../src/native/send-text.mjs';

const own={uin:'10000001',uid:'u_self'},friend={uin:'20000001',uid:'u_friend',user_id:20000001};
const buddy={...friend,coreInfo:{uid:friend.uid,uin:friend.uin,nick:'Fixture',remark:'Test'},baseInfo:{age:20}};
const categories=[{categroyMbCount:1,buddyList:[buddy]}];
const record=(seq,extra={})=>({chatType:1,peerUin:friend.uin,peerUid:friend.uid,senderUin:friend.uin,senderUid:friend.uid,msgId:String(7000000000000000000n+BigInt(seq)),msgSeq:String(seq),msgTime:String(1800000000+seq),isImportMsg:false,isOnlineMsg:true,elements:[{elementType:1,textElement:{content:'fixture '+seq,atType:0}}],...extra});

test('friend snapshots require acknowledgement and complete native callback, and filter allowed users',async t=>{
  let catalog,calls=0,finish;const session={};
  catalog=createFriendActions({allowedUsers:new Set([friend.uin]),getContext:()=>({session,check(){},services:{buddyService:{getBuddyList(force){assert.equal(force,true);calls++;catalog.update(categories);return new Promise(r=>finish=r);}}}})});t.after(()=>catalog.close());
  let done=false;const pending=catalog.list().then(r=>{done=true;return r;});await new Promise(setImmediate);assert.equal(done,false);finish({result:0});
  assert.deepEqual(await pending,[{user_id:20000001,nickname:'Fixture',remark:'Test'}]);assert.equal(calls,1);
  assert.equal(catalog.lookup(friend.uin).uid,friend.uid);assert.equal(catalog.lookup('30000001'),null);
});

test('incomplete or mismatched friend lists revoke cached access instead of accepting a partial catalog',async t=>{
  let catalog;const session={};catalog=createFriendActions({getContext:()=>({session,check(){},services:{buddyService:{getBuddyList(){catalog.update(categories);return {result:0};}}}})});t.after(()=>catalog.close());
  await catalog.load();assert.ok(catalog.lookup(friend.uin));
  assert.equal(catalog.update([{categroyMbCount:2,buddyList:[buddy]}]),false);assert.equal(catalog.lookup(friend.uin),null);
  assert.equal(catalog.update([{categroyMbCount:1,buddyList:[{...buddy,coreInfo:{uid:'u_wrong'}}]}]),false);
});

test('hung friend acknowledgements retain the native slot and do not generate unbounded refreshes',async t=>{
  let calls=0;const session={};const c=createFriendActions({timeoutMs:10,getContext:()=>({session,check(){},services:{buddyService:{getBuddyList(){calls++;return new Promise(()=>{});}}}})});t.after(()=>c.close());
  await assert.rejects(c.load(),{retcode:1504});await assert.rejects(c.load(true),{retcode:1429});assert.equal(calls,1);
});

test('group and private aliases, reply sequences and media references cannot collide',()=>{
  const mapper=createMessageMapper({selfId:own.uin,privateMessages:true,richMedia:true});
  const incoming=mapper.fromNative(record(1));const group=mapper.fromNative(record(1,{chatType:2,peerUid:friend.uin}));
  assert.equal(incoming.message_type,'private');assert.equal(incoming.sub_type,'friend');assert.equal('group_id'in incoming,false);assert.notEqual(group.message_id,incoming.message_id);
  const sent=mapper.rememberNative(record(2,{msgSeq:'1',senderUin:own.uin,senderUid:own.uid}));
  assert.equal(mapper.lookupSequence(friend.uin,'1',1,friend.uin),incoming.message_id);assert.equal(mapper.lookupSequence(friend.uin,'1',1,own.uin),sent);
  const quoted=mapper.fromNative(record(3,{elements:[{elementType:7,replyElement:{replayMsgId:'0',replayMsgSeq:'1',senderUid:friend.uin,replyMsgTime:'1800000001'}},{elementType:1,textElement:{content:'reply'}}]}));
  assert.equal(quoted.message[0].data.id,String(incoming.message_id));
  const image=mapper.fromNative(record(4,{elements:[{elementType:2,picElement:{fileUuid:'same-file'}}]}));assert.equal(image.message[0].data.file,'private:20000001:same-file');
  const restored=createMessageMapper({selfId:own.uin,privateMessages:true,initialState:mapper.snapshot()});assert.equal(restored.lookup(incoming.message_id).chatType,1);assert.equal(restored.lookup(group.message_id).chatType,2);
  assert.equal(mapper.fromNative(record(5,{senderUin:'30000001'})),null);
});

function reads(t,options={}){
  let current=true;const mapper=createMessageMapper({selfId:own.uin,privateMessages:true,richMedia:true}),list=options.records??[record(1),record(2)];const calls=[];
  const friends={resolve:async uin=>{if(String(uin)!==friend.uin)throw Object.assign(new Error('not friend'),{retcode:1403});return friend;}};
  const ctx={account:own,mapper,friends,rememberMedia(){},flush:async()=>{},check(f){if(!current)throw Object.assign(new Error('offline'),{retcode:1503});if(f&&f.uid!==friend.uid)throw new Error('wrong friend');},services:{msgService:{
    getLatestDbMsgs(p,count){calls.push(['latest',p,count]);return options.latest?.()??{result:0,msgList:list.slice(-count)};},
    getMsgsByMsgId(p,ids){calls.push(['ids',p,ids]);return options.byId?.()??{result:0,msgList:list.filter(r=>ids.includes(r.msgId))};},
    getMsgs(p,id,count,older){calls.push(['older',p,id,count,older]);return {result:0,msgList:list.filter(r=>BigInt(r.msgId)<BigInt(id)).slice(-count)};},
  }}};
  const actions=createPrivateActions({getContext:()=>ctx,timeoutMs:options.timeoutMs??1000});t.after(()=>actions.close());return {actions,mapper,calls,list,offline(){current=false;}};
}

test('private native history and get_msg stay in the same friend conversation and preserve ID cursors',async t=>{
  const f=reads(t),result=await f.actions.call('get_friend_msg_history',{user_id:friend.uin});assert.equal(result.messages.length,2);
  const m=result.messages[1],queried=await f.actions.call('get_msg',{message_id:m.message_id});assert.equal(queried.native_message_id,m.native_message_id);assert.equal(queried.message_type,'private');
  const before=await f.actions.call('get_friend_msg_history',{user_id:friend.uin,message_id:m.message_id});assert.equal(before.messages.length,1);assert.equal(f.calls.at(-1)[4],true);
  for(const call of f.calls)assert.equal(call[1].peerUid,friend.uid);
});

test('private queries reject group IDs, other friends and wrong native peers before returning data',async t=>{
  const f=reads(t),group=f.mapper.rememberNative({...record(1),chatType:2,peerUid:friend.uin});
  await assert.rejects(f.actions.call('get_msg',{message_id:group}),{retcode:1404});
  await assert.rejects(f.actions.call('get_friend_msg_history',{user_id:friend.uin,message_id:group}),{retcode:1403});
  const g=reads(t,{byId:()=>({result:0,msgList:[record(1,{peerUid:'u_wrong'})]})}),id=g.mapper.rememberNative(record(1));await assert.rejects(g.actions.call('get_msg',{message_id:id}),{retcode:1403});
});

test('private reply hydration matches the sender as well as sequence and timestamp',async t=>{
  const quote=record(3,{elements:[{elementType:7,replyElement:{replayMsgId:'0',replayMsgSeq:'1',senderUid:friend.uin,replyMsgTime:'1800000001'}},{elementType:1,textElement:{content:'reply'}}]});
  const f=reads(t,{records:[record(1),record(2,{msgSeq:'1',senderUin:own.uin,senderUid:own.uid}),quote]});const id=f.mapper.rememberNative(quote);
  const result=await f.actions.call('get_msg',{message_id:id}),reference=f.mapper.lookup(Number(result.message[0].data.id));assert.equal(reference.msgId,record(1).msgId);assert.equal(reference.senderUin,friend.uin);
});

test('private quotes can resolve an NT sender without altering the native record',async t=>{
  const raw=record(3,{elements:[{elementType:7,replyElement:{replayMsgId:'0',replayMsgSeq:'1',senderUid:'0',senderUidStr:friend.uid,replyMsgTime:'1800000001'}},{elementType:1,textElement:{content:'reply'}}]});
  const f=reads(t,{records:[record(1),raw]}),id=f.mapper.rememberNative(raw);const result=await f.actions.call('get_msg',{message_id:id});
  assert.equal(result.message[0].type,'reply');assert.equal(f.mapper.lookup(Number(result.message[0].data.id)).senderUin,friend.uin);assert.equal(raw.elements[0].replyElement.senderUid,'0');
});

test('twenty identical private queries share one native read and reject account changes',async t=>{
  let finish;const f=reads(t,{latest:()=>new Promise(r=>finish=r)}),pending=Array.from({length:20},()=>f.actions.call('get_friend_msg_history',{user_id:friend.uin}));await new Promise(setImmediate);finish({result:0,msgList:[record(1)]});
  const results=await Promise.all(pending);assert.equal(f.calls.length,1);assert.equal(new Set(results.map(r=>r.messages[0].message_id)).size,1);
  const late=f.actions.call('get_friend_msg_history',{user_id:friend.uin});await new Promise(setImmediate);f.offline();finish({result:0,msgList:[record(1)]});await assert.rejects(late,{retcode:1503});
});

test('private sends use chat type 1 and a verified UID, reject mentions and cross-peer replies',async()=>{
  const msg=await buildGroupSegments({groupId:friend.uin,peer:{chatType:1,peerUid:friend.uid,guildId:''},message:'hello'});const calls=[];
  await sendElements({message:msg,msgService:{generateMsgUniqueId(type){calls.push(type);return '7000000000000000001';},sendMsg(id,p){calls.push(p);return {result:0};}}});assert.equal(calls[0],1);assert.equal(calls[1].peerUid,friend.uid);
  await assert.rejects(buildGroupSegments({groupId:friend.uin,peer:msg.peer,message:[{type:'at',data:{qq:'all'}}]}),{retcode:1404});
  await assert.rejects(buildGroupSegments({groupId:friend.uin,peer:msg.peer,resolveReply:async()=>record(1,{peerUid:'u_wrong'}),message:[{type:'reply',data:{id:'1'}},{type:'text',data:{text:'x'}}]}),{retcode:1404});
});

test('private media IDs stay scoped and native downloads receive the private chat type',async t=>{
  const profile=await mkdtemp(path.join(os.tmpdir(),'qqbridge-private-media-'));t.after(()=>rm(profile,{recursive:true,force:true}));
  const c=createReceivedMediaCache({profile,getMsgService:()=>({getRichMediaElement:async p=>{assert.equal(p.chatType,1);assert.equal(p.peerUid,friend.uid);await writeFile(p.filePath,Buffer.from('x'));}})});
  c.remember(record(1,{elements:[{elementType:3,elementId:'1',fileElement:{fileUuid:'fixture',fileSize:'1',fileMd5:'9dd4e461268c8034f5c8564e155c67a6',fileName:'x.txt'}}]}));
  await assert.rejects(c.read('private:20000001:fixture',()=>false),{retcode:1403});
  const result=await c.read('private:20000001:fixture',(uin,type,uid)=>uin===friend.uin&&type===1&&uid===friend.uid);assert.equal(result.base64,'eA==');c.clear();
});

test('private SDK completion in its reported cache path passes the same integrity checks',async t=>{
  const profile=await mkdtemp(path.join(os.tmpdir(),'qqbridge-private-cache-'));t.after(()=>rm(profile,{recursive:true,force:true}));const source=path.join(profile,'sdk-native-file');
  const c=createReceivedMediaCache({profile,pollMs:1,getMsgService:()=>({getRichMediaElement(){setTimeout(()=>writeFile(source,'x'),5);}})});
  c.remember(record(1,{elements:[{elementType:3,elementId:'1',fileElement:{fileUuid:'native',filePath:source,fileSize:'1',fileMd5:'9dd4e461268c8034f5c8564e155c67a6',fileName:'x.txt'}}]}));
  assert.equal((await c.read('private:20000001:native',()=>true)).base64,'eA==');assert.equal(c.status().completed,1);c.clear();
});

test('private recall notices deduplicate against the original persistent alias',async t=>{
  const f=reads(t),r=record(1,{recallTime:'1800000010',isOnlineMsg:false,elements:[{elementType:8,grayTipElement:{subElementType:1,revokeElement:{origMsgSenderUid:friend.uid}}}]}),id=f.mapper.rememberNative(record(1));
  const notices=await f.actions.notices(r);assert.equal(notices[0].notice_type,'friend_recall');assert.equal(notices[0].message_id,id);assert.deepEqual(await f.actions.notices(r),[]);
});
