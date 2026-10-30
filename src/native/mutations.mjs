const fail=(message,retcode=1503)=>Object.assign(new Error(message),{retcode});

/** Mutations are never retried or merged. A timed-out native operation keeps
 * its key and concurrency slot until the underlying operation settles. */
export function createMutationRunner({timeoutMs=8000,maxConcurrent=4}={}){
  const active=new Set();let closed=false;
  return {
    async run(key,operation){
      if(closed)throw fail('Management service is closed.');
      if(active.has(key)||active.size>=maxConcurrent)throw fail('A management operation is already pending.',1429);
      active.add(key);const deadline=Date.now()+timeoutMs;let invoked=false,timer;
      const check=()=>{if(closed||Date.now()>=deadline)throw fail('Management operation expired before dispatch.',1504);};
      const work=Promise.resolve().then(()=>operation({check,invoke(fn){check();invoked=true;return fn();}}))
        .catch(error=>{if(Number.isInteger(error?.retcode))throw error;throw fail(invoked?'QQ management outcome is unknown. Do not retry automatically.':'Management preflight failed.',invoked?1504:1503);})
        .finally(()=>active.delete(key));
      try{return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail(invoked?'QQ management timed out; outcome is unknown. Do not retry automatically.':'Management preflight timed out; no mutation was dispatched.',1504)),timeoutMs);})]);}
      finally{clearTimeout(timer);}
    },
    status:()=>({active:active.size,limit:maxConcurrent}),
    close(){closed=true;},
  };
}
export function requireAck(result){
  if(!result||result.result!==0)throw fail('QQ rejected the management operation'+(Number.isInteger(result?.result)?' (code '+result.result+')':'')+'.',1500);
}
export function strictBoolean(value,fallback,label){
  if(value===undefined)return fallback;
  if(typeof value!=='boolean')throw fail(`${label} must be a boolean.`,1400);
  return value;
}
export function boundedText(value,fallback,max,label){
  if(value===undefined)value=fallback;
  if(typeof value!=='string'||[...value].length>max||/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value))throw fail(`${label} must be a string of at most ${max} characters.`,1400);
  return value;
}
