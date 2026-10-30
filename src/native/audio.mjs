import { fork, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const fail=(message,retcode)=>Object.assign(new Error(message),{retcode});
export function createAudioTranscoder({ maxConcurrent=2, timeoutMs=12000 }={}) {
  if(!Number.isInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>8||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>12000)throw new TypeError('Invalid audio limits.');
  const active=new Set(); let closed=false;
  return {
    convert(bytes,format='silk',options={}) {
      if(closed) return Promise.reject(fail('Audio converter is stopped.',1503));
      if(!['silk','wav','mp3','ogg'].includes(format)) return Promise.reject(fail('Unsupported audio output format.',1404));
      if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>16*1024*1024) return Promise.reject(fail('Audio input requires 1 to 16777216 bytes.',1400));
      if(active.size>=maxConcurrent) return Promise.reject(fail('Audio conversion capacity exceeded.',1429));
      const deadline=options.timeoutMs??timeoutMs;
      if(!Number.isInteger(deadline)||deadline<1||deadline>12000) return Promise.reject(fail('Invalid audio deadline.',1400));
      return new Promise((resolve,reject)=>{
        const child=fork(fileURLToPath(new URL('./audio-worker.mjs',import.meta.url)),[format],{
          windowsHide:true,detached:process.platform!=='win32',execArgv:['--max-old-space-size=128'],stdio:['pipe','pipe','pipe','ipc'],
        });
        let finished=false,metadata,size=0,pendingError; const chunks=[];
        const kill=()=>{ if(process.platform==='win32') spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}).on('error',()=>{});
          else try{process.kill(-child.pid,'SIGKILL');}catch{} child.kill('SIGKILL'); };
        const finish=(error,result)=>{ if(finished)return; finished=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);active.delete(cancel);error?reject(error):resolve(result); };
        const cancel=()=>{pendingError=fail('Audio conversion was cancelled.',1503);kill();};
        const abort=()=>cancel(); active.add(cancel);
        const timer=setTimeout(()=>{pendingError=fail('Audio conversion timed out.',1504);kill();},deadline);
        options.signal?.addEventListener('abort',abort,{once:true});
        child.on('error',()=>finish(fail('Audio worker could not start.',1503)));
        child.on('message',value=>{metadata=value;}); child.stdin.on('error',()=>{});child.stderr.resume();
        child.stdout.on('data',chunk=>{size+=chunk.length;if(size>16*1024*1024){pendingError=fail('Audio output limit exceeded.',1400);kill();}else chunks.push(chunk);});
        child.on('close',code=>{if(pendingError){finish(pendingError);return;}if(code!==0||metadata?.ok!==true)finish(fail(metadata?.retcode===1503?'FFmpeg is unavailable.':'Audio conversion failed.',metadata?.retcode??1400));
          else finish(null,{bytes:Buffer.concat(chunks),format,duration_ms:metadata.duration_ms});});
        child.stdin.end(bytes);
        if(options.signal?.aborted) cancel();
      });
    },
    close(){closed=true;for(const cancel of [...active])cancel();},
    status(){return {active:active.size,capacity:maxConcurrent,closed};},
  };
}
