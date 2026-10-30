import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const token=process.env.QQBRIDGE_TOKEN;
if(!token||token.length<32)throw new Error('Run npm run init, then start the login website with the same .env as the gateway.');
const port=Number(process.env.QQBRIDGE_UI_PORT||5702);
const backend=new URL(process.env.QQBRIDGE_UI_API||'http://127.0.0.1:5700');
if(!['127.0.0.1','localhost','[::1]'].includes(backend.hostname)||backend.protocol!=='http:')throw new Error('The login website requires a local HTTP gateway.');
let qrPending;
async function call(action,params={}) {
  const response=await fetch(new URL('/'+action,backend),{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(params),signal:AbortSignal.timeout(13000)});
  return response.json();
}
const files={'/':['login.html','text/html'],'/login':['login.html','text/html'],'/login.html':['login.html','text/html'],'/index.html':['login.html','text/html'],'/login.js':['login.js','text/javascript'],'/login.css':['login.css','text/css']};
const server=createServer(async(req,res)=>{
  const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
    'Content-Security-Policy':"default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'"};
  const send=(status,data)=>{res.writeHead(status,{...headers,'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
  const host=req.headers.host;
  if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(host)||!['same-origin','none',undefined].includes(req.headers['sec-fetch-site']))return send(403,{error:'请直接从本机打开登录页面。'});
  if(req.headers.origin&&req.headers.origin!==`http://${host}`)return send(403,{error:'请求来源无效。'});
  let pathname;try{pathname=new URL(req.url,'http://localhost').pathname.replace(/\/+$/,'')||'/';}catch{return send(400,{error:'请求无效。'});}
  try{
    if(req.method==='GET'&&files[pathname]){
      const [file,type]=files[pathname];const body=await readFile(new URL('./web/'+file,import.meta.url));
      res.writeHead(200,{...headers,'content-type':type+'; charset=utf-8'});res.end(body);return;
    }
    if(req.method==='GET'&&pathname==='/api/state'){
      const r=await call('get_login_state');if(r.status!=='ok')return send(503,{error:'QQ 服务未连接，正在等待启动。'});
      const d=r.data;return send(200,{stage:d.stage,online:d.online,authenticated:d.authenticated,scan_confirmed:d.scan_confirmed,
        session_ready:d.session_ready,restore_pending:d.remembered_login?.configured===true&&!d.account_selected&&['connecting','connected','remembered_account_loading'].includes(d.stage),nickname:d.nickname,self_id:d.self_id,qr_failure:d.qr_failure,recovery:d.recovery});
    }
    if(req.method==='POST'&&pathname==='/api/qr'){
      if(req.headers['content-type']!=='application/json')return send(415,{error:'请求格式无效。'});
      // No user-provided action, URL or credentials are forwarded.
      const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>1024)return send(413,{error:'请求过大。'});chunks.push(chunk);}
      let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{return send(400,{error:'请求格式无效。'});}
      if(body.remember_login!==undefined&&typeof body.remember_login!=='boolean')return send(400,{error:'登录设置无效。'});
      const state=await call('get_login_state');
      if(state.status==='ok'&&(state.data.account_selected||state.data.session_ready||state.data.remembered_login?.configured&&['connecting','connected','remembered_account_loading'].includes(state.data.stage)))return send(409,{error:'正在恢复或完成账号登录，请稍候。'});
      if(!qrPending)qrPending=call('get_login_qrcode',{refresh:true,remember_login:body.remember_login??true}).finally(()=>qrPending=null);
      const r=await qrPending;if(r.status!=='ok')return send(503,{error:r.retcode===1409?'账号正在登录，请在手机完成确认。':'暂时无法生成新二维码，请检查 QQ 服务状态。'});
      const q=r.data;if(typeof q.image_base64!=='string'||q.image_base64.length>1400000||q.expires_at*1000<=Date.now()+10000)return send(503,{error:'未取得有效新码，请刷新重试。'});
      return send(200,{image:'data:image/png;base64,'+q.image_base64,expires_at:q.expires_at,generated_at:Date.now()});
    }
    send(404,{error:'页面不存在。'});
  }catch{send(503,{error:'连接 QQ 服务失败，请稍后重试。'});}
});
server.requestTimeout=15000;server.headersTimeout=10000;
server.listen(port,'127.0.0.1',()=>console.log(`QQBridge login website: http://127.0.0.1:${port}/login`));
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>server.close());
