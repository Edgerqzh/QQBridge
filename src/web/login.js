const el=id=>document.getElementById(id);
let expires=0,busy=false,online=false,started=false,lastStage='';
function clearQR(message){el('qr').hidden=true;el('qr').removeAttribute('src');el('placeholder').hidden=false;el('placeholder-text').textContent=message;expires=0;}
async function fresh(){
 if(busy||online)return;busy=true;el('refresh').disabled=true;clearQR('正在获取新二维码…');
 try{const r=await fetch('/api/qr',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({remember_login:el('remember').checked})});const d=await r.json();if(!r.ok)throw Error(d.error);
  expires=d.expires_at*1000;el('qr').src=d.image;el('qr').hidden=false;el('placeholder').hidden=true;
  el('title').textContent='用手机 QQ 扫码';el('subtitle').textContent='扫码后，请在手机上确认登录。';el('pill').textContent='等待扫码';el('hint').textContent='新码已生成，状态会自动更新。';
 }catch(e){clearQR('暂时无法获取二维码');el('hint').textContent=e.message;}finally{busy=false;el('refresh').disabled=online;}
}
async function poll(){
 try{const r=await fetch('/api/state');const d=await r.json();if(!r.ok)throw Error(d.error);
  online=d.online===true;
  if(online){clearQR('');el('placeholder').hidden=true;el('success').hidden=false;el('title').textContent='QQ 已成功连接';el('subtitle').textContent='可以关闭此页，连接会继续运行。';el('pill').textContent='已在线';el('refresh').disabled=true;el('remember').disabled=true;el('account').hidden=false;el('account').textContent=d.nickname?`${d.nickname} · ${d.self_id}`:`QQ ${d.self_id}`;el('hint').textContent='登录完成。';}
  else if(d.restore_pending){el('title').textContent='正在恢复本机登录';el('subtitle').textContent='正在连接已保存的账号，请稍候。';el('refresh').disabled=true;}
  else if(d.scan_confirmed||d.stage==='qr_scanned'||d.authenticated){el('title').textContent='请在手机上完成确认';el('pill').textContent='正在登录';if(d.scan_confirmed){clearQR('正在建立连接…');el('refresh').disabled=true;}}
  else if(['qr_session_expired','qr_polling_failed','login_failed','account_login_failed'].includes(d.stage)){clearQR('二维码已失效');el('title').textContent='请获取新二维码';el('hint').textContent='旧码已停止显示，请点击下方按钮生成新码。';el('refresh').disabled=false;}
  else if(!started){started=true;await fresh();}
  lastStage=d.stage;
 }catch(e){clearQR('正在等待 QQ 服务');el('pill').textContent='服务未连接';el('title').textContent='正在连接本机服务';el('hint').textContent=e.message;started=false;el('refresh').disabled=busy;}
 finally{setTimeout(poll,2000);}
}
el('refresh').addEventListener('click',()=>{started=true;fresh();});
setInterval(()=>{if(online){el('clock').textContent='连接正常';return;}if(expires){const n=Math.max(0,Math.ceil((expires-Date.now())/1000));el('clock').textContent=`${n} 秒后失效`;if(!n&&!busy&&!['qr_scanned'].includes(lastStage)){clearQR('二维码已失效');fresh();}}else el('clock').textContent='实时状态';},1000);
poll();
