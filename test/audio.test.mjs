import test from 'node:test';
import assert from 'node:assert/strict';
import {createAudioTranscoder} from '../src/native/audio.mjs';
import {spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createMediaStore} from '../src/native/media.mjs';
import {buildGroupSegments} from '../src/native/segments.mjs';
import {fixtureWav} from './fixtures/audio-fixture.mjs';
test('real codec converts WAV to SILK and back to a valid playable WAV',async t=>{
  const c=createAudioTranscoder();t.after(()=>c.close());
  const encoded=await c.convert(fixtureWav(),'silk');
  assert.ok(encoded.bytes.subarray(0,16).toString('ascii').includes('#!SILK_V3'));
  const decoded=await c.convert(encoded.bytes,'wav');
  assert.equal(decoded.bytes.toString('ascii',0,4),'RIFF');
  assert.ok(decoded.duration_ms>=80&&decoded.duration_ms<=120);
  assert.equal(c.status().active,0);
});
test('audio timeout kills the isolated worker and permits a subsequent conversion',async t=>{
  const c=createAudioTranscoder();t.after(()=>c.close());
  await assert.rejects(c.convert(fixtureWav(),'silk',{timeoutMs:1}),e=>e.retcode===1504);
  assert.ok((await c.convert(fixtureWav(),'silk')).bytes.length>0);
});
test('audio overload, unsupported format, cancellation and shutdown are bounded',async()=>{
  const c=createAudioTranscoder({maxConcurrent:1});
  const controller=new AbortController();
  const first=c.convert(fixtureWav(),'silk',{signal:controller.signal});
  const rejected=assert.rejects(first,e=>e.retcode===1503);
  await assert.rejects(c.convert(fixtureWav(),'silk'),e=>e.retcode===1429);
  controller.abort();await rejected;
  await assert.rejects(c.convert(fixtureWav(),'shell'),e=>e.retcode===1404);
  c.close();await assert.rejects(c.convert(fixtureWav()),e=>e.retcode===1503);
});
test('invalid audio fails without poisoning the next worker',async t=>{
  const c=createAudioTranscoder();t.after(()=>c.close());
  await assert.rejects(c.convert(Buffer.from('invalid audio')),e=>[1400,1503].includes(e.retcode));
  assert.ok((await c.convert(fixtureWav(),'wav')).bytes.length>44);
});
test('record sending prepares WAV as SILK and derives duration from actual audio',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'qqbridge-record-'));assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));t.after(()=>rm(directory,{recursive:true,force:true}));
  const c=createAudioTranscoder();t.after(()=>c.close());
  const mediaStore=createMediaStore({directory,convertAudio:bytes=>c.convert(bytes,'silk')});
  const result=await buildGroupSegments({groupId:'10001',mediaStore,message:[{type:'record',data:{file:'base64://'+fixtureWav().toString('base64')}}]});
  assert.equal(result.elements[0].pttElement.duration,1);assert.ok(result.elements[0].pttElement.fileName.endsWith('.silk'));
});
const ffmpegAvailable=spawnSync(process.env.QQBRIDGE_FFMPEG_PATH||'ffmpeg',['-version'],{windowsHide:true,stdio:'ignore',timeout:2000}).status===0;
test('FFmpeg converts real MP3 and Ogg audio through SILK and WAV',{skip:!ffmpegAvailable},async t=>{
  const c=createAudioTranscoder();t.after(()=>c.close());
  for(const format of ['mp3','ogg']){
    const encoded=await c.convert(fixtureWav(),format);
    assert.ok(encoded.bytes.length>0);
    const silk=await c.convert(encoded.bytes,'silk');
    assert.ok(silk.bytes.subarray(0,16).toString('ascii').includes('#!SILK_V3'));
    const wav=await c.convert(silk.bytes,'wav');assert.equal(wav.bytes.toString('ascii',0,4),'RIFF');
  }
  const frame=Buffer.alloc(32);frame[0]=0x3c;const amr=Buffer.concat([Buffer.from('#!AMR\n'),...Array.from({length:5},()=>frame)]);
  assert.ok((await c.convert(amr,'silk')).bytes.length>0);
});
