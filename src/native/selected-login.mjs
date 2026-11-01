import {readFile,open,rename,unlink,stat,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
const valid=uin=>typeof uin==='string'&&/^[1-9]\d{4,11}$/.test(uin);
export async function readSelectedLogin(profile){
  const file=path.join(profile,'selected-account.json');
  try{if((await stat(file)).size>1024)throw Error('Invalid saved login selection.');const data=JSON.parse(await readFile(file,'utf8'));if(!valid(data.uin))throw Error('Invalid saved login selection.');return data.uin;}
  catch(error){if(error.code==='ENOENT')return '';throw error;}
}
export async function saveSelectedLogin(profile,uin){
  const file=path.join(profile,'selected-account.json');
  if(uin===null){await unlink(file).catch(error=>{if(error.code!=='ENOENT')throw error;});return;}
  if(!valid(uin))throw TypeError('Invalid selected login identity.');
  await mkdir(profile,{recursive:true,mode:0o700});const temporary=file+'.'+randomUUID()+'.tmp';
  try{
    const handle=await open(temporary,'wx',0o600);
    try{await handle.writeFile(JSON.stringify({uin})+'\n');await handle.sync();}finally{await handle.close();}
    await rename(temporary,file);
    if(process.platform==='linux'){const directory=await open(profile,'r');try{await directory.sync();}finally{await directory.close();}}
  }
  finally{await unlink(temporary).catch(()=>{});}
}
