import { createHash, randomUUID } from 'node:crypto';
import { realpath, stat, readFile, mkdir, unlink, writeFile, rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
const MAX=16*1024*1024;
const fail = (message, retcode = 1503) => Object.assign(new Error(message), { retcode });
/** Account-scoped metadata and bounded, deduplicated native downloads. */
export function createReceivedMediaCache({ profile, capacity = 5000, getMsgService, timeoutMs=10000, maxConcurrent=4, pollMs=50, getAccountId=()=>'' }) {
  if(!Number.isInteger(capacity)||capacity<1||!Number.isInteger(timeoutMs)||timeoutMs<1||!Number.isInteger(maxConcurrent)||maxConcurrent<1) throw new TypeError('Invalid media cache limits.');
  const entries = new Map(), jobs=new Map(); let generation=0;
  let loadedAccount=null,loadPromise=null,persistTail=Promise.resolve();
  const accountKey=()=>{const value=String(getAccountId());return /^[1-9]\d{4,11}$/.test(value)?value:null;};
  async function load(){
    const account=accountKey();if(!account)return;
    if(loadedAccount===account)return loadPromise;
    loadedAccount=account;const current=generation;
    loadPromise=(async()=>{try{const file=path.join(profile,'media-index',account+'.json');const info=await stat(file);if(info.size>8*1024*1024)return;
      const saved=JSON.parse(await readFile(file,'utf8'));if(current!==generation||account!==accountKey()||!Array.isArray(saved))return;
      for(const pair of saved.slice(-capacity)){if(!Array.isArray(pair)||pair.length!==2)continue;const [id,e]=pair;
        if(typeof id!=='string'||!e||typeof e!=='object'||typeof e.group!=='string'||!/^[1-9]\d{0,15}$/.test(e.group))continue;
        if(!entries.has(id)&&entries.size<capacity)entries.set(id,e);
      }
    }catch{}})();return loadPromise;
  }
  function persist(){const account=accountKey(),scheduledGeneration=generation;if(!account)return;
    persistTail=persistTail.catch(()=>{}).then(async()=>{if(scheduledGeneration!==generation||account!==accountKey())return;await load();if(scheduledGeneration!==generation||account!==accountKey())return;
      const snapshot=JSON.stringify([...entries]);
      const dir=path.join(profile,'media-index');await mkdir(dir,{recursive:true,mode:0o700});
      const root=await realpath(profile),resolved=await realpath(dir);if(!resolved.startsWith(root+path.sep))throw fail('Invalid media index directory.');
      const temporary=path.join(dir,account+'.'+randomUUID()+'.tmp');
      try{await writeFile(temporary,snapshot,{flag:'wx',mode:0o600});await rename(temporary,path.join(dir,account+'.json'));}
      finally{await unlink(temporary).catch(()=>{});}
    });persistTail.catch(()=>{});
  }
  const metrics={downloads:0,completed:0,failed:0,cache_hits:0};
  const inside=(root,source)=>{const relative=path.relative(root,source);return relative && relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
  async function inspect(entry) {
    if(typeof entry.source!=='string'||!path.isAbsolute(entry.source))return null;
    const root=await realpath(profile);
    const source=await realpath(entry.source).catch(error=>{if(error.code==='ENOENT')return null;throw fail('Unable to inspect cached media.');});
    if(!source)return null;
    if(!inside(root,source))throw fail('Media cache path is outside the dedicated QQ profile.',1403);
    const info=await stat(source);
    if(info.isFile()&&info.size===0)return null;
    if(!info.isFile()||info.size>MAX)throw fail('Cached media is unavailable or exceeds 16 MiB.');
    if(entry.size!==null&&info.size!==entry.size)return null;
    const bytes=await readFile(source);
    if(bytes.length>MAX)throw fail('Cached media exceeds 16 MiB.');
    if(entry.size!==null&&bytes.length!==entry.size)return null;
    if(entry.md5&&createHash('md5').update(bytes).digest('hex')!==entry.md5)return null;
    return bytes;
  }
  function check(entry,id,allowed,current,signal) {
    if(signal?.aborted||current!==generation||entries.get(id)!==entry)throw fail('Media operation was cancelled.');
    if(!allowed(entry.group))throw fail('Media group is unavailable or not allowed.',1403);
  }
  async function download(entry,id,allowed,current,signal) {
    check(entry,id,allowed,current,signal);
    const service=getMsgService?.();
    const nativeDownload=service?.getRichMediaElement ?? service?.downloadRichMedia;
    if(typeof nativeDownload!=='function')throw fail('Native media download is unavailable.');
    if(!/^[1-9]\d{0,63}$/.test(entry.msgId)||!/^\d{1,64}$/.test(entry.elementId))throw fail('Media has no usable native message/element identifier.');
    if(!entry.md5)throw fail('Native media lacks an integrity checksum.');
    const root=await realpath(profile),dir=path.join(root,'media-downloads');
    await mkdir(dir,{recursive:true,mode:0o700});
    if(!inside(root,await realpath(dir)))throw fail('Invalid download storage directory.',1403);
    const target=path.join(dir,randomUUID()+'.media');
    const candidate={...entry,source:target}; let success=false,dispatched=false,cancelled=false;
    const request={msgId:entry.msgId,peerUid:entry.peerUid,chatType:2,elementId:entry.elementId,
      downloadType:1,thumbSize:0,filePath:target,fileModelId:'',downSourceType:0,triggerType:1,downloadScene:0};
    const cancel=()=>{if(dispatched&&!cancelled&&typeof service.cancelGetRichMediaElement==='function'){cancelled=true;try{Promise.resolve(service.cancelGetRichMediaElement(request)).catch(()=>{});}catch{}}};
    signal.addEventListener('abort',cancel,{once:true});
    try {
      check(entry,id,allowed,current,signal);
      metrics.downloads++;
      dispatched=true;
      const ack=await nativeDownload.call(service,request);
      // getRichMediaElement is a void dispatch on the tested SDK. Completion
      // is established by expected size/hash, never by manufacturing an ACK.
      if(ack!==undefined&&(!ack||ack.result!==0))throw fail('QQ rejected the media download (code '+(Number.isInteger(ack?.result)?ack.result:'unknown')+').',1502);
      while(true) {
        check(entry,id,allowed,current,signal);
        const bytes=await inspect(candidate);
        if(bytes){entry.source=target;persist();success=true;metrics.completed++;return bytes;}
        await delay(pollMs,undefined,{signal}).catch(()=>{throw fail('Media download was cancelled.');});
      }
    } finally { signal.removeEventListener('abort',cancel);if(!success){cancel();await unlink(target).catch(()=>{});} }
  }
  return {
    remember(record) {
      for (const element of record.elements ?? []) {
        const value = element.picElement ?? element.fileElement ?? element.pttElement;
        if (!value || ![2,3,4].includes(element.elementType)) continue;
        const id = [value.fileUuid,value.md5HexStr,value.fileMd5].find(v=>typeof v==='string'&&v.length>0&&v.length<=512&&!/[\\/\u0000-\u001f]/.test(v));
        if (typeof id !== 'string' || !id.length || id.length > 512 || /[\\/\u0000-\u001f]/.test(id)) continue;
        const group=String(record.peerUin),old=entries.get(id);
        if(old&&old.group===group&&old.msgId===record.msgId)continue;
        if (!entries.has(id) && entries.size >= capacity) {const first=entries.keys().next().value;jobs.get(first)?.controller.abort();entries.delete(first);}
        jobs.get(id)?.controller.abort();
        const size=Number(value.fileSize),md5=value.md5HexStr||value.fileMd5;
        entries.set(id, { group, source: value.sourcePath || value.filePath, name:value.fileName, type:element.elementType,
          msgId:record.msgId,peerUid:record.peerUid||group,elementId:element.elementId,
          size:Number.isSafeInteger(size)&&size>0?size:null,md5:typeof md5==='string'&&/^[a-fA-F0-9]{32}$/.test(md5)?md5.toLowerCase():null });
      }
      persist();
    },
    async flush(){await persistTail;},
    async read(id, allowed) {
      await load();
      if (typeof id !== 'string' || !entries.has(id)) throw fail('Media identifier is unknown or expired.', 1400);
      const entry=entries.get(id),current=generation;
      check(entry,id,allowed,current);
      if(entry.size>MAX)throw fail('Media exceeds 16 MiB.',1400);
      let bytes=await inspect(entry);
      if(bytes)metrics.cache_hits++;
      else {
        let job=jobs.get(id);
        if(!job){
          if(jobs.size>=maxConcurrent)throw fail('Media download capacity exceeded.',1429);
          const controller=new AbortController();job={controller};jobs.set(id,job);
          let timer;
          const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{reject(fail('Media download timed out.',1504));controller.abort();},timeoutMs);});
          const cancelled=new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(fail('Media operation was cancelled.')),{once:true}));
          const work=download(entry,id,allowed,current,controller.signal);
          const cleanup=()=>{if(jobs.get(id)===job)jobs.delete(id);};work.then(cleanup,cleanup);
          job.promise=Promise.race([work,deadline,cancelled])
            .catch(error=>{metrics.failed++;throw error;}).finally(()=>{clearTimeout(timer);});
        }
        bytes=await job.promise;
      }
      check(entry,id,allowed,current);
      return { file_id:id,base64:bytes.toString('base64'),size:bytes.length,name:typeof entry.name==='string'?path.basename(entry.name).slice(0,240):'media.bin' };
    },
    clear(){generation++;for(const job of jobs.values())job.controller.abort();entries.clear();loadedAccount=null;loadPromise=null;},
    status(){return {...metrics,entries:entries.size,active:jobs.size,capacity:maxConcurrent};},
  };
}
