import {spawn} from 'node:child_process';
import {readFile,writeFile,realpath,mkdir,copyFile,chmod} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {constants} from 'node:fs';
import {imageInfo} from './media.mjs';
const fail=(message,retcode=1400)=>Object.assign(new Error(message),{retcode});
/** Probe and decode only a managed MP4. No caller-provided URL, protocol,
 * executable or command-line options reach FFmpeg. */
export function createVideoPreparer({maxConcurrent=2,timeoutMs=8000,getMsgService,profile}={}){
  const active=new Set();let closed=false;
  async function command(binary,args,deadline){
    if(closed)throw fail('Video preparation is closed.',1503);
    return new Promise((resolve,reject)=>{
      const child=spawn(binary,args,{windowsHide:true,stdio:['ignore','pipe','ignore'],detached:process.platform!=='win32'});let size=0,pending,done=false;const chunks=[];
      const kill=()=>{if(process.platform==='win32')spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}).on('error',()=>{});else try{process.kill(-child.pid,'SIGKILL');}catch{}child.kill('SIGKILL');};
      const cancel=()=>{pending=fail('Video preparation was cancelled.',1503);kill();};active.add(cancel);
      const timer=setTimeout(()=>{pending=fail('Video preparation timed out.',1504);kill();},Math.max(1,deadline-Date.now()));
      function finish(error,value){if(done)return;done=true;clearTimeout(timer);active.delete(cancel);error?reject(error):resolve(value);}
      child.on('error',()=>finish(fail('FFmpeg / ffprobe is unavailable.',1503)));
      child.stdout.on('data',data=>{size+=data.length;if(size>1024*1024){pending=fail('Video probe output limit exceeded.');kill();}else chunks.push(data);});
      child.on('close',code=>finish(pending??(code===0?null:fail('Invalid or unsupported MP4 video.')),Buffer.concat(chunks)));
    });
  }
  let jobs=0;
  return {
    async prepare(media){
      if(closed)throw fail('Video preparation is closed.',1503);
      if(jobs>=maxConcurrent)throw fail('Video preparation capacity exceeded.',1429);jobs++;
      try{
        const deadline=Date.now()+timeoutMs,source=await realpath(media.sourcePath),dir=path.dirname(source);
        const bytes=await readFile(source);if(bytes.length<16||bytes.length>16777216||bytes.toString('ascii',4,8)!=='ftyp')throw fail('Only managed MP4 video up to 16 MiB is supported.');
        const probe=await command('ffprobe',['-v','error','-protocol_whitelist','file','-format_whitelist','mov,mp4,m4a,3gp,3g2,mj2','-show_entries','stream=codec_type,codec_name,width,height:format=duration','-of','json',source],deadline);
        const info=JSON.parse(probe),stream=info.streams?.find(s=>s.codec_type==='video'),duration=Number(info.format?.duration);
        if(!stream||stream.codec_name!=='h264'||!Number.isFinite(duration)||duration<=0||duration>600||!Number.isInteger(stream.width)||!Number.isInteger(stream.height)||stream.width<1||stream.height<1||stream.width>4096||stream.height>4096||stream.width*stream.height>8294400)throw fail('MP4 requires H.264 video, at most 10 minutes and 4096 pixels per side.');
        const thumbnail=await command('ffmpeg',['-v','error','-nostdin','-threads','1','-protocol_whitelist','file','-format_whitelist','mov,mp4,m4a,3gp,3g2,mj2','-i',source,'-map','0:v:0','-frames:v','1','-vf','scale=640:640:force_original_aspect_ratio=decrease','-threads','1','-f','image2pipe','-vcodec','mjpeg','pipe:1'],deadline);
        if(thumbnail.length<4||thumbnail[0]!==255||thumbnail[1]!==216)throw fail('Video thumbnail generation failed.');
        const thumbPath=path.join(dir,media.sha256+'.video.jpg');await writeFile(thumbPath,thumbnail,{mode:0o600});
        const dimensions=imageInfo(thumbnail),result={...media,sourcePath:source,fileName:media.md5+'.mp4',duration:Math.ceil(duration),width:dimensions.width,height:dimensions.height,codec:0,thumbPath,thumbSize:thumbnail.length,thumbMd5:createHash('md5').update(thumbnail).digest('hex')};
        if(getMsgService){
          const service=getMsgService(),root=await realpath(profile);
          async function stage(input,downloadType,extension,expected){
            const target=await service.getRichMediaFilePathForMobileQQSend({elementType:5,elementSubType:0,md5HexStr:media.md5,fileName:media.md5+'.'+extension,downloadType,thumbSize:0,needCreate:false,isInApplicationDataPath:false});
            if(typeof target!=='string'||!path.isAbsolute(target)||!target.startsWith(root+path.sep)||path.relative(root,target).split(path.sep).includes('..'))throw fail('Native video path is outside the dedicated profile.',1403);
            await mkdir(path.dirname(target),{recursive:true,mode:0o700});if(!(await realpath(path.dirname(target))).startsWith(root+path.sep))throw fail('Invalid native video directory.',1403);
            if(input!==target)try{await copyFile(input,target,constants.COPYFILE_EXCL);}catch(error){if(error.code!=='EEXIST')throw error;}
            if(!(await realpath(target)).startsWith(root+path.sep)||createHash('md5').update(await readFile(target)).digest('hex')!==expected)throw fail('Invalid native video cache file.',1403);
            await chmod(target,0o600);
            return target;
          }
          result.sourcePath=await stage(result.sourcePath,1,'mp4',media.md5);result.thumbPath=await stage(result.thumbPath,2,'jpg',result.thumbMd5);
        }
        return result;
      }finally{jobs--;}
    },
    close(){closed=true;for(const cancel of active)cancel();},status:()=>({active:jobs,processes:active.size,capacity:maxConcurrent,closed}),
  };
}
