import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {createAudioTranscoder} from '../src/native/audio.mjs';
import {createReceivedMediaCache} from '../src/native/media-cache.mjs';
import {fixtureWav} from './fixtures/audio-fixture.mjs';
test('stability: twenty real WAV/SILK round trips leave no active workers',async t=>{
  const c=createAudioTranscoder();t.after(()=>c.close());
  for(let i=0;i<20;i++){
    const silk=await c.convert(fixtureWav(),'silk');const wav=await c.convert(silk.bytes,'wav');
    assert.equal(wav.bytes.toString('ascii',0,4),'RIFF');assert.equal(c.status().active,0);
  }
});
test('stability: one hundred downloads recover after injected failures and release every slot',async t=>{
  const profile=await mkdtemp(path.join(os.tmpdir(),'qqbridge-soak-'));assert.equal(path.dirname(profile),path.resolve(os.tmpdir()));t.after(()=>rm(profile,{recursive:true,force:true}));
  const bytes=Buffer.from('stability content'),md5=createHash('md5').update(bytes).digest('hex');let reject=false,calls=0;
  const c=createReceivedMediaCache({profile,getMsgService:()=>({async downloadRichMedia(p){calls++;if(reject){reject=false;return {result:42};}await writeFile(p.filePath,bytes);return {result:0};}})});
  for(let i=0;i<100;i++){
    c.remember({peerUin:'10001',msgId:String(7770000000000000000n+BigInt(i)),elements:[{elementType:3,elementId:'1',fileElement:{fileUuid:String(i),fileName:'fixture.txt',fileSize:String(bytes.length),fileMd5:md5}}]});
    if(i%10===0){reject=true;await assert.rejects(c.read(String(i),()=>true),e=>e.retcode===1502);}
    assert.equal((await c.read(String(i),()=>true)).size,bytes.length);assert.equal(c.status().active,0);
  }
  assert.equal(calls,110);assert.equal(c.status().completed,100);c.clear();
});
