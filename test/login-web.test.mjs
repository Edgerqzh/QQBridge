import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomInt} from 'node:crypto';
test('local login page serves aliases and proxies only login actions without exposing API credentials',async t=>{
  const token='web-test-secret-'.padEnd(48,'x'),actions=[];
  const api=createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,'Bearer '+token);actions.push(req.url);
    req.resume();res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',data:req.url==='/get_login_state'?{stage:'awaiting_scan',online:false}:{image_base64:'fixture',expires_at:Math.floor(Date.now()/1000)+120}}));
  });api.listen(0,'127.0.0.1');await once(api,'listening');t.after(()=>new Promise(r=>api.close(r)));
  // Windows can allocate low dynamic ports that WHATWG fetch reserves for
  // other services. Use a high ephemeral port so this tests the login page.
  let port;
  for(let attempt=0;attempt<32;attempt++){
    const probe=createServer(),candidate=randomInt(32768,61000);
    const available=await new Promise((resolve,reject)=>{probe.once('error',error=>error.code==='EADDRINUSE'||error.code==='EACCES'?resolve(false):reject(error));probe.listen(candidate,'127.0.0.1',()=>resolve(true));});
    if(available){port=candidate;await new Promise(r=>probe.close(r));break;}
  }
  assert.ok(port>=32768,'A fetch-compatible high test port is required');
  const child=spawn(process.execPath,[fileURLToPath(new URL('../src/login-web.mjs',import.meta.url))],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,QQBRIDGE_TOKEN:token,QQBRIDGE_UI_PORT:String(port),QQBRIDGE_UI_API:`http://127.0.0.1:${api.address().port}`}});
  t.after(async()=>{if(child.exitCode===null){const done=once(child,'close');child.kill();await done;}});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Login website did not start')),5000);child.stdout.once('data',()=>{clearTimeout(timer);resolve();});});
  const base=`http://127.0.0.1:${port}`;
  for(const path of ['/','/login','/login/','/login.html']){const r=await fetch(base+path);assert.equal(r.status,200);assert.ok(r.headers.get('content-security-policy').includes("frame-ancestors 'none'"));assert.equal((await r.text()).includes(token),false);}
  assert.equal((await fetch(base+'/api/state')).status,200);
  assert.equal((await fetch(base+'/api/qr',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,200);
  assert.equal((await fetch(base+'/api/qr',{method:'POST',headers:{'content-type':'application/json',origin:'https://attacker.example'},body:'{}'})).status,403);
  const badHost=await new Promise((resolve,reject)=>{const req=request(base+'/api/state',{headers:{host:'attacker.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});assert.equal(badHost,403);
  assert.equal((await fetch(base+'/send_group_msg',{method:'POST'})).status,404);
  assert.deepEqual([...new Set(actions)],['/get_login_state','/get_login_qrcode']);
});
