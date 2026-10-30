const fail = (message, retcode = 1503) => Object.assign(new Error(message), { retcode });
const validUin = value => typeof value === 'string' && /^[1-9]\d{4,11}$/.test(value) && Number.isSafeInteger(Number(value));
const validUid = value => typeof value === 'string' && /^u_[A-Za-z0-9_-]{1,126}$/.test(value);

/** Full native buddy snapshots, paired with getBuddyList acknowledgement.
 * The catalog is account/session bound and is never written to our index. */
export function createFriendActions({ getContext, allowedUsers, timeoutMs = 8000 }) {
  let catalog = null, owner = null, pending = null, closed = false, nativeBusy = false;
  const copy = friend => ({ ...friend });
  function context() {
    if (closed) throw fail('Friend service stopped.');
    const next = getContext(); next.check();
    if (owner !== next.session) { reject('Friend session changed.'); catalog = null; owner = next.session; }
    return next;
  }
  function reject(message, retcode) { const p=pending;if(!p)return;pending=null;clearTimeout(p.timer);p.reject(fail(message,retcode)); }
  function finish() {
    const p=pending;if(!p||!p.ack||!p.snapshot)return;
    try{p.context.check();}catch{reject('Friend session changed.');return;}
    pending=null;clearTimeout(p.timer);p.resolve();
  }
  function update(categories) {
    const invalid=()=>{catalog=null;reject('QQ returned an incomplete or invalid friend snapshot.');return false;};
    if(closed)return false;
    if(!Array.isArray(categories)||categories.length>10000)return invalid();
    let current;try{current=context();}catch{return false;}
    const next=new Map(),uids=new Set();
    for(const category of categories){
      if(!Array.isArray(category?.buddyList)||category.buddyList.length!==category.categroyMbCount)return invalid();
      for(const buddy of category.buddyList){
        if(!validUin(buddy?.uin)||!validUid(buddy.uid)||next.has(buddy.uin)||uids.has(buddy.uid)||next.size>=10000)return invalid();
        const core=buddy.coreInfo??{},base=buddy.baseInfo??{};
        if(core.uid!==undefined&&core.uid!==buddy.uid||core.uin!==undefined&&core.uin!==buddy.uin)return invalid();
        next.set(buddy.uin,{user_id:Number(buddy.uin),uin:buddy.uin,uid:buddy.uid,nickname:typeof core.nick==='string'?core.nick.slice(0,256):'',remark:typeof core.remark==='string'?core.remark.slice(0,256):'',age:Number.isInteger(base.age)&&base.age>=0&&base.age<=150?base.age:0,sex:'unknown'});uids.add(buddy.uid);
      }
    }
    current.check();catalog=next;
    if(pending){pending.snapshot=true;finish();}return true;
  }
  async function load(refresh = false) {
    const current=context();
    if(pending)return pending.promise;
    if(catalog&&!refresh)return;
    if(nativeBusy)throw fail('A previous native friend request is still pending.',1429);
    let resolve,rejectPromise;const promise=new Promise((yes,no)=>{resolve=yes;rejectPromise=no;});
    const p={promise,resolve,reject:rejectPromise,context:current,ack:false,snapshot:false,timer:null};pending=p;
    p.timer=setTimeout(()=>reject('Friend list notification timed out.',1504),timeoutMs);
    nativeBusy=true;
    try{Promise.resolve(current.services.buddyService.getBuddyList(true)).then(result=>{
      nativeBusy=false;
      if(pending!==p)return;try{current.check();}catch{reject('Friend session changed.');return;}
      if(result?.result!==0){reject('QQ rejected the friend list request.');return;}p.ack=true;finish();
    },()=>{nativeBusy=false;if(pending===p)reject('Friend list request failed.');});}catch{nativeBusy=false;reject('Friend service is unavailable.');}
    return promise;
  }
  function lookup(value) {
    context();const id=typeof value==='number'&&Number.isSafeInteger(value)?String(value):value;
    if(!validUin(id)||allowedUsers&&!allowedUsers.has(id))return null;
    const friend=catalog?.get(id);return friend?copy(friend):null;
  }
  return {
    update, load, lookup,
    async resolve(value,{refresh=false}={}) { const id=typeof value==='number'&&Number.isSafeInteger(value)?String(value):value;if(!validUin(id))throw fail('user_id must be a valid QQ number.',1400);if(allowedUsers&&!allowedUsers.has(id))throw fail('User is outside the private allowlist.',1403);await load(refresh);const friend=lookup(id);if(!friend)throw fail('Target is not a current allowed friend.',1403);return friend; },
    async list() { await load(true);return [...catalog.values()].filter(f=>!allowedUsers||allowedUsers.has(f.uin)).map(f=>({user_id:f.user_id,nickname:f.nickname,remark:f.remark})); },
    async info(value) { const f=await this.resolve(value,{refresh:true});return {user_id:f.user_id,nickname:f.nickname,remark:f.remark,sex:f.sex,age:f.age}; },
    invalidate() {catalog=null;owner=null;reject('Friend catalog must be refreshed.');},
    status:()=>({loaded:catalog!==null,count:catalog?.size??0,pending:pending!==null,native_pending:nativeBusy}),
    close(){closed=true;catalog=null;reject('Friend service stopped.');},
  };
}
