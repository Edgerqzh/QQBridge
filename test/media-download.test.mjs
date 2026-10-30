import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';
import {createReceivedMediaCache} from '../src/native/media-cache.mjs';
const bytes=Buffer.from('download fixture with integrity');
const md5=createHash('md5').update(bytes).digest('hex');
const record=(id='fixture',overrides={})=>({chatType:2,peerUin:'10001',peerUid:'10001',msgId:'7774366730634512345',elements:[{elementType:3,elementId:'1',fileElement:{fileUuid:id,fileName:'fixture.txt',fileSize:String(bytes.length),fileMd5:md5,...overrides}}]});
async function root(t){const p=await mkdtemp(path.join(os.tmpdir(),'qqbridge-download-'));assert.equal(path.dirname(p),path.resolve(os.tmpdir()));t.after(()=>rm(p,{recursive:true,force:true}));return p;}
test('twenty simultaneous cache misses deduplicate one native download and never return partial bytes',async t=>{
  const profile=await root(t);let calls=0;
  const cache=createReceivedMediaCache({profile,pollMs:1,getMsgService:()=>({async downloadRichMedia(p){calls++;assert.equal(p.msgId,'7774366730634512345');assert.equal(p.elementId,'1');
    await writeFile(p.filePath,bytes.subarray(0,3));setTimeout(()=>writeFile(p.filePath,bytes),15);return {result:0};}})});
  cache.remember(record());
  const results=await Promise.all(Array.from({length:20},()=>cache.read('fixture',()=>true)));
  assert.equal(calls,1);for(const result of results)assert.deepEqual(Buffer.from(result.base64,'base64'),bytes);
  await cache.read('fixture',()=>true);assert.equal(calls,1);assert.equal(cache.status().active,0);cache.clear();
});
test('native rejection is explicit and a new request can recover',async t=>{
  const profile=await root(t);let reject=true;
  const cache=createReceivedMediaCache({profile,getMsgService:()=>({async downloadRichMedia(p){if(reject)return {result:42};await writeFile(p.filePath,bytes);return {result:0};}})});
  cache.remember(record());await assert.rejects(cache.read('fixture',()=>true),e=>e.retcode===1502);
  reject=false;assert.equal((await cache.read('fixture',()=>true)).size,bytes.length);cache.clear();
});
test('hung SDK downloads time out without releasing native concurrency or silently retrying',async t=>{
  const profile=await root(t);let complete,calls=0;
  const cache=createReceivedMediaCache({profile,timeoutMs:10,maxConcurrent:1,getMsgService:()=>({downloadRichMedia(){calls++;return new Promise(resolve=>complete=resolve);}})});
  cache.remember(record());cache.remember(record('second'));
  await assert.rejects(cache.read('fixture',()=>true),e=>e.retcode===1504);
  await assert.rejects(cache.read('fixture',()=>true));assert.equal(calls,1);
  await assert.rejects(cache.read('second',()=>true),e=>e.retcode===1429);
  complete({result:0});await delay(5);assert.equal(cache.status().active,0);cache.clear();
});
test('wrong checksums never become cached successes and account clear revokes pending reads',async t=>{
  const profile=await root(t);
  const cache=createReceivedMediaCache({profile,timeoutMs:20,pollMs:1,getMsgService:()=>({async downloadRichMedia(p){await writeFile(p.filePath,Buffer.alloc(bytes.length));return {result:0};}})});
  cache.remember(record());await assert.rejects(cache.read('fixture',()=>true),e=>e.retcode===1504);
  cache.remember(record('pending'));const promise=cache.read('pending',()=>true);const rejected=assert.rejects(promise,e=>e.retcode===1503);
  await delay(2);cache.clear();await rejected;await delay(2);assert.equal(cache.status().entries,0);
});
test('permission revocation and missing native identities cannot trigger new downloads',async t=>{
  const profile=await root(t);let calls=0;
  const cache=createReceivedMediaCache({profile,getMsgService:()=>({downloadRichMedia(){calls++;return {result:0};}})});
  cache.remember(record());await assert.rejects(cache.read('fixture',()=>false),e=>e.retcode===1403);
  const invalid=record('bad');delete invalid.msgId;cache.remember(invalid);await assert.rejects(cache.read('bad',()=>true));
  assert.equal(calls,0);cache.clear();
});
test('persistent media metadata survives restart without crossing account boundaries',async t=>{
  const profile=await root(t);let calls=0;const options={profile,getAccountId:()=> '123456789',getMsgService:()=>({async downloadRichMedia(p){calls++;await writeFile(p.filePath,bytes);return {result:0};}})};
  const first=createReceivedMediaCache(options);first.remember(record());await first.read('fixture',()=>true);await first.flush();first.clear();
  const second=createReceivedMediaCache(options);assert.equal((await second.read('fixture',()=>true)).size,bytes.length);assert.equal(calls,1);
  const other=createReceivedMediaCache({...options,getAccountId:()=> '987654321'});await assert.rejects(other.read('fixture',()=>true),e=>e.retcode===1400);
  second.clear();other.clear();
});
test('void native dispatch waits for verified bytes and cancellation is forwarded on timeout',async t=>{
  const profile=await root(t);let cancelled=0;
  const service={getRichMediaElement(p){setTimeout(()=>writeFile(p.filePath,bytes),5);},cancelGetRichMediaElement(){cancelled++;}};
  const c=createReceivedMediaCache({profile,getMsgService:()=>service,pollMs:1,timeoutMs:100});
  c.remember(record());assert.equal((await c.read('fixture',()=>true)).size,bytes.length);assert.equal(cancelled,0);c.clear();
  const stalled=createReceivedMediaCache({profile,getMsgService:()=>({getRichMediaElement(){},cancelGetRichMediaElement(){cancelled++;}}),pollMs:1,timeoutMs:10});
  stalled.remember(record('stalled'));await assert.rejects(stalled.read('stalled',()=>true),e=>e.retcode===1504);assert.equal(cancelled,1);stalled.clear();
});
test('clearing an account during queued persistence cannot erase its committed index',async t=>{
  const profile=await root(t),options={profile,getAccountId:()=> '123456789'};
  const first=createReceivedMediaCache(options);first.remember(record());await first.flush();
  first.remember(record('uncommitted'));first.clear();await first.flush();
  const restored=createReceivedMediaCache(options);
  await assert.rejects(restored.read('uncommitted',()=>true),e=>e.retcode===1400);
  // The committed ID still exists, reaching the missing-native-service check.
  await assert.rejects(restored.read('fixture',()=>true),e=>e.retcode===1503);
  restored.clear();
});
