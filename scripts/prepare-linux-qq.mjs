#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, link, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const METADATA_URL = 'https://qq-web.cdn-go.cn/im.qq.com_new/latest/rainbow/pcConfig.json';
const SIGN_URL = 'https://im.qq.com/http2rpc/gotrpc/noauth/trpc.qqntv2.urlsign.UrlSign/GetSign';
const OFFICIAL_HOSTS = new Set(['qq-web.cdn-go.cn','im.qq.com','qqdl.gtimg.cn','dldir1.qq.com','down.qq.com']);
const MAX_BYTES = 700 * 1024 * 1024;
const HELP = `Download the official Linux QQ .deb without installing or starting QQ.
Usage: node scripts/prepare-linux-qq.mjs [--destination data/qq] [--arch x64|arm64]
       [--extract] [--max-mib-per-second 16] [--timeout-seconds 300]
--extract uses dpkg-deb on Linux to extract into <destination>/extracted.
Existing package, extraction directory, or receipt files are never overwritten.
SHA-256 is recorded for reproducibility; no official digest is available for verification.
`;

function checkedUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !OFFICIAL_HOSTS.has(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('Download URL must be HTTPS on an approved official QQ download host.');
  }
  return url;
}

async function request(url, { signal, ...options } = {}) {
  for (let redirects = 0; redirects <= 4; redirects++) {
    const target = checkedUrl(url);
    const response = await fetch(target, { ...options, signal, redirect:'manual' });
    if ([301,302,303,307,308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Official download returned an empty redirect.');
      url = checkedUrl(new URL(location,target).href);
      if (response.status === 303) options = {method:'GET'};
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Official QQ server returned HTTP ${response.status}.`); }
    return response;
  }
  throw new Error('Too many official download redirects.');
}

async function requestJson(url, options = {}) {
  const response = await request(url,{...options,signal:AbortSignal.timeout(20000)});
  const chunks=[]; let bytes=0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new Error('QQ metadata exceeded 1 MiB.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function parseArgs(args) {
  const result={destination:'data/qq',arch:process.arch==='arm64'?'arm64':'x64',extract:false,maxMibPerSecond:16,timeoutSeconds:300};
  for (let index=0; index<args.length; index++) {
    const arg=args[index];
    if (arg==='--help' || arg==='-h') return {help:true};
    if (arg==='--extract') { result.extract=true; continue; }
    const key={'--destination':'destination','--arch':'arch','--max-mib-per-second':'maxMibPerSecond','--timeout-seconds':'timeoutSeconds'}[arg];
    if (!key || !args[index+1] || args[index+1].startsWith('--')) throw new Error(`Unknown option or missing value: ${arg}`);
    result[key]=args[++index];
  }
  if (!['x64','arm64'].includes(result.arch)) throw new Error('--arch must be x64 or arm64.');
  result.maxMibPerSecond=Number(result.maxMibPerSecond); result.timeoutSeconds=Number(result.timeoutSeconds);
  if (!Number.isFinite(result.maxMibPerSecond) || result.maxMibPerSecond<0.25 || result.maxMibPerSecond>1024) throw new Error('--max-mib-per-second must be 0.25..1024.');
  if (!Number.isInteger(result.timeoutSeconds) || result.timeoutSeconds<30 || result.timeoutSeconds>3600) throw new Error('--timeout-seconds must be 30..3600.');
  if (result.extract && process.platform!=='linux') throw new Error('--extract requires Linux and dpkg-deb.');
  return result;
}

async function extractDeb(packagePath, destination) {
  await mkdir(destination); // Fail rather than mix files into an existing extraction.
  await new Promise((resolve,reject)=>{
    const child=spawn('dpkg-deb',['-x',packagePath,destination],{stdio:['ignore','ignore','pipe'],windowsHide:true});
    let stderr='';
    const timer=setTimeout(()=>child.kill(),120000);
    child.stderr.on('data',chunk=>{if(stderr.length<2048) stderr+=chunk;});
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',(code,signal)=>{clearTimeout(timer);code===0?resolve():reject(new Error(`dpkg-deb failed (${signal??code}): ${stderr.trim()}`));});
  });
}

export async function prepareLinuxQQ(options) {
  const destination=path.resolve(options.destination);
  const metadata=await requestJson(METADATA_URL);
  const version=metadata.Linux?.version;
  const download=metadata.Linux?.[options.arch==='arm64'?'armDownloadUrl':'x64DownloadUrl']?.deb;
  if (typeof version!=='string' || typeof download!=='string') throw new Error('Official QQ metadata lacks the requested Linux package.');
  const source=checkedUrl(download);
  const filename=path.posix.basename(source.pathname);
  if (!/^QQ_[a-zA-Z0-9_.-]+\.deb$/.test(filename)) throw new Error('Unexpected official QQ package filename.');
  const signed=await requestJson(SIGN_URL,{
    method:'POST',headers:{'content-type':'application/json','x-oidb':JSON.stringify({uint32_command:'0x9b8e',uint32_service_type:1})},
    body:JSON.stringify({url:source.href})
  });
  if (signed.retcode!==0 || typeof signed.data?.url!=='string') throw new Error('Official QQ download signing failed.');
  const signedUrl=checkedUrl(signed.data.url);
  if (signedUrl.origin!==source.origin || signedUrl.pathname!==source.pathname) throw new Error('Official signing response changed the package identity.');
  await mkdir(destination,{recursive:true});
  const packagePath=path.join(destination,filename);
  const tempPath=path.join(destination,`.qqbridge-${randomUUID()}.partial`);
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(new Error('QQ package download timed out.')),options.timeoutSeconds*1000);
  let handle, bytes=0, previousProgress=0;
  const digest=createHash('sha256'), start=Date.now();
  try {
    const response=await request(signedUrl,{signal:controller.signal});
    const declaredSize=Number(response.headers.get('content-length')??0);
    if (declaredSize>MAX_BYTES) { await response.body?.cancel(); throw new Error('QQ package exceeds the 700 MiB limit.'); }
    handle=await open(tempPath,'wx');
    for await (const chunk of response.body) {
      bytes+=chunk.length;
      if (bytes>MAX_BYTES) throw new Error('QQ package exceeds the 700 MiB limit.');
      await handle.writeFile(chunk); digest.update(chunk);
      const targetElapsed=bytes/(options.maxMibPerSecond*1024*1024)*1000;
      const wait=targetElapsed-(Date.now()-start);
      if (wait>1) await delay(wait,undefined,{signal:controller.signal});
      if (bytes-previousProgress>=25*1024*1024) {
        process.stderr.write(`Downloaded ${Math.floor(bytes/1024/1024)} MiB\n`); previousProgress=bytes;
      }
    }
    if (!bytes || (declaredSize>0 && bytes!==declaredSize)) throw new Error('QQ package download length is incomplete.');
    await handle.close(); handle=null;
    // Same-directory hard link is exclusive and atomic without duplicating the package.
    await link(tempPath,packagePath);
    const receipt={version,arch:options.arch,filename,sourceUrl:source.origin+source.pathname,downloadedAt:new Date().toISOString(),bytes,sha256:digest.digest('hex'),officialDigestVerified:false};
    await writeFile(`${packagePath}.receipt.json`,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
    if (options.extract) await extractDeb(packagePath,path.join(destination,'extracted'));
    return {...receipt,packagePath,extractedTo:options.extract?path.join(destination,'extracted'):null};
  } finally {
    clearTimeout(timer); await handle?.close().catch(()=>{}); await unlink(tempPath).catch(()=>{});
  }
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const options=parseArgs(process.argv.slice(2));
    if (options.help) process.stdout.write(HELP);
    else process.stdout.write(JSON.stringify(await prepareLinuxQQ(options),null,2)+'\n');
  } catch (error) {
    process.stderr.write(`QQ preparation failed: ${String(error.message).replace(/https?:\/\/\S+/g,'[URL hidden]')}\n`);
    process.exitCode=1;
  }
}
