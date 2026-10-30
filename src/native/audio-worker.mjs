import { spawn } from 'node:child_process';
import { encode, decode, isSilk, getDuration, getWavFileInfo } from 'silk-wasm';
const MAX_PCM = 24000 * 2 * 600;
function wav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ',8);
  header.writeUInt32LE(16,16); header.writeUInt16LE(1,20); header.writeUInt16LE(1,22);
  header.writeUInt32LE(24000,24); header.writeUInt32LE(48000,28); header.writeUInt16LE(2,32);
  header.writeUInt16LE(16,34); header.write('data',36); header.writeUInt32LE(pcm.length,40);
  return Buffer.concat([header,pcm]);
}
async function ffmpeg(input, raw, format) {
  const output = format === 'pcm' ? ['-f','s16le'] : format === 'mp3' ? ['-codec:a','libmp3lame','-f','mp3'] : ['-codec:a','libopus','-f','ogg'];
  const args = ['-nostdin','-hide_banner','-loglevel','error','-protocol_whitelist','pipe',
    ...(raw ? ['-f','s16le','-ar','24000','-ac','1'] : ['-format_whitelist','wav,mp3,ogg,matroska,webm,amr,flac,mov,aac']),
    '-i','pipe:0','-map','0:a:0','-vn','-sn','-dn','-threads','1','-ac','1','-ar','24000', ...output,'pipe:1'];
  return new Promise((resolve,reject) => {
    const child = spawn(process.env.QQBRIDGE_FFMPEG_PATH || 'ffmpeg', args, { windowsHide:true, stdio:['pipe','pipe','pipe'] });
    const chunks=[]; let size=0;
    child.on('error', () => reject(Object.assign(new Error('FFmpeg is unavailable.'),{retcode:1503})));
    child.stdin.on('error', () => {}); child.stderr.resume();
    child.stdout.on('data', chunk => { size+=chunk.length; if(size>MAX_PCM){ child.kill('SIGKILL'); reject(new Error('Decoded audio exceeds ten minutes.')); } else chunks.push(chunk); });
    child.on('close', code => code===0 ? resolve(Buffer.concat(chunks)) : reject(new Error('Audio decoding or encoding failed.')));
    child.stdin.end(input);
  });
}
try {
  const chunks=[]; let size=0;
  for await (const chunk of process.stdin) { size+=chunk.length; if(size>16*1024*1024) throw new Error('Audio input exceeds 16 MiB.'); chunks.push(chunk); }
  const input=Uint8Array.from(Buffer.concat(chunks)), format=process.argv[2];
  let pcm, output, duration;
  if(isSilk(input)) {
    duration=getDuration(input);
    if(!Number.isFinite(duration)||duration<=0||duration>600000) throw new Error('Invalid SILK duration.');
    if(format==='silk') output=input;
    else pcm=Buffer.from((await decode(input,24000)).data);
  } else {
    // The portable fast path also permits WAV/SILK regression tests without FFmpeg.
    let info; try { info=getWavFileInfo(input); } catch {}
    if(info?.fmt?.formatCode===1 && info.fmt.numberOfChannels===1 && info.fmt.sampleRate===24000 && info.fmt.bitsPerSample===16) {
      const part=info.chunkInfo.find(part=>part.chunkId==='data');
      if(part && part.dataOffset+part.dataLength<=input.length) pcm=input.subarray(part.dataOffset,part.dataOffset+part.dataLength);
    }
    pcm ??= await ffmpeg(input,false,'pcm');
  }
  if(pcm) {
    if(!pcm.length||pcm.length>MAX_PCM||pcm.length%2) throw new Error('Invalid or excessive PCM output.');
    duration=pcm.length/48;
    output=format==='silk' ? Buffer.from((await encode(pcm,24000)).data) : format==='wav' ? wav(pcm) : await ffmpeg(pcm,true,format);
  }
  if(!output?.length||output.length>16*1024*1024) throw new Error('Audio output is empty or exceeds 16 MiB.');
  process.send?.({ok:true,duration_ms:duration,format});
  process.stdout.end(output);
} catch(error) {
  process.send?.({ok:false,retcode:error.retcode===1503?1503:1400}); process.exitCode=1;
} finally { process.disconnect?.(); }
