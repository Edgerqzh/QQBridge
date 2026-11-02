import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const build = JSON.parse(await readFile(new URL('../src/native/windows/build.json',import.meta.url),'utf8'));
const hosts = new Set(['qqdl.gtimg.cn','dldir1.qq.com','dldir1v6.qq.com','im.qq.com']);
function checked(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !hosts.has(url.hostname) || url.username || url.password || url.port && url.port !== '443') throw new Error('Invalid official QQ URL.');
  return url;
}
async function request(value, options = {}) {
  let url = checked(value);
  for (let i=0;i<5;i++) {
    const response = await fetch(url,{...options,redirect:'manual',signal:AbortSignal.timeout(300000)});
    if ([301,302,303,307,308].includes(response.status)) {
      const next = response.headers.get('location'); await response.body?.cancel();
      if (!next) throw new Error('Empty official redirect.');
      url=checked(new URL(next,url)); if(response.status===303)options={method:'GET'}; continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Official QQ download returned HTTP ${response.status}.`); }
    return response;
  }
  throw new Error('Too many official redirects.');
}
async function digest(file) {
  const hash=createHash('sha256'); for await(const bytes of createReadStream(file))hash.update(bytes); return hash.digest('hex');
}
export async function verifyWindowsApp(directory) {
  const app=path.resolve(directory), metadata=JSON.parse(await readFile(path.join(app,'package.json'),'utf8'));
  if(metadata.version!==build.qq_version || metadata.platform!=='win32' || metadata.eleArch!=='x64' || await digest(path.join(app,'wrapper.node'))!==build.wrapper_sha256) throw new Error('QQ directory differs from the pinned Windows x64 build.');
  return app;
}
async function main(args) {
  const options={};
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--help') { console.log('Prepare official Windows QQ without installation. Use --existing-app APP, or --destination NEW_DIRECTORY --extractor 7Z_EXE [--package-file VERIFIED_INSTALLER].'); return; }
    if(!['--existing-app','--destination','--extractor','--package-file'].includes(args[i]) || !args[i+1])throw new Error('Invalid preparation arguments.');
    options[args[i].slice(2)]=args[++i];
  }
  if(options['existing-app']) { console.log(JSON.stringify({reused_read_only:true,app_directory:await verifyWindowsApp(options['existing-app']),qq_version:build.qq_version})); return; }
  if(process.platform!=='win32'||!options.destination||!options.extractor)throw new Error('On Windows, provide a new destination and an existing 7-Zip executable.');
  const destination=path.resolve(options.destination), extractor=path.resolve(options.extractor);
  if(destination===path.parse(destination).root)throw new Error('Use a dedicated cache directory.');
  await mkdir(path.dirname(destination),{recursive:true}); await mkdir(destination); // Never mix or overwrite cached installations.
  let installer=options['package-file']?path.resolve(options['package-file']):path.join(destination,'QQ-installer.exe');
  if(!options['package-file']) {
    const source=checked(build.qq_installer_url);
    const response=await request('https://im.qq.com/http2rpc/gotrpc/noauth/trpc.qqntv2.urlsign.UrlSign/GetSign',{
      method:'POST',headers:{'content-type':'application/json','x-oidb':JSON.stringify({uint32_command:'0x9b8e',uint32_service_type:1})},body:JSON.stringify({url:source.href}),
    });
    let data='',bytes=0;
    for await(const chunk of response.body){bytes+=chunk.length;if(bytes>1024*1024)throw new Error('Official signing response is too large.');data+=Buffer.from(chunk).toString('utf8');}
    const signed=JSON.parse(data); if(signed.retcode!==0||typeof signed.data?.url!=='string')throw new Error('Official download signing failed.');
    const url=checked(signed.data.url);if(url.origin!==source.origin||url.pathname!==source.pathname)throw new Error('Signed URL changed package identity.');
    const download=await request(url);let total=0;
    await pipeline(download.body,new Transform({transform(chunk,encoding,next){total+=chunk.length;next(total>800*1024*1024?new Error('QQ package exceeded its size limit.'):null,chunk);}}),createWriteStream(installer+'.partial',{flags:'wx',mode:0o600}));
    await rename(installer+'.partial',installer);
  }
  if(await digest(installer)!==build.qq_installer_sha256)throw new Error('QQ installer SHA-256 mismatch. Nothing was executed or extracted.');
  const extracted=path.join(destination,'extracted');await mkdir(extracted);
  await new Promise((resolve,reject)=>{
    const child=spawn(extractor,['x',installer,'-o'+extracted,'-y','-bso0','-bsp0'],{windowsHide:true,stdio:'ignore'});
    const timer=setTimeout(()=>{child.kill();reject(new Error('QQ extraction timed out.'));},120000);
    child.once('error',()=>{clearTimeout(timer);reject(new Error('Cannot start the provided extractor.'));});
    child.once('close',code=>{clearTimeout(timer);code===0?resolve():reject(new Error('QQ extraction failed.'));});
  });
  const app=await verifyWindowsApp(path.join(extracted,'Files','versions',build.qq_version,'resources','app'));
  const receipt={qq_version:build.qq_version,app_directory:app,source:build.qq_installer_url,sha256:build.qq_installer_sha256,installer_not_executed:true};
  await writeFile(path.join(destination,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600}); console.log(JSON.stringify(receipt));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
