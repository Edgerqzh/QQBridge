import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay, setImmediate as turn } from 'node:timers/promises';
import { createMessageMapper } from '../src/native/messages.mjs';
import { createNoticeMapper } from '../src/native/notices.mjs';
import { createRecoveryController, createRestartBudget } from '../src/native/recovery.mjs';

const account = { uin: '10000001', uid: 'u_self' }, group = '20000001';
const identities = new Map([['u_self', account.uin], ['u_member', '30000001'], ['u_admin', '30000002']]);
const base = extra => ({ chatType: 2, peerUin: group, peerUid: group, msgId: '7000000000000000001', msgSeq: '17',
  msgTime: String(Math.floor(Date.now()/1000)), recallTime: '1800000000', isImportMsg: false, isOnlineMsg: true, ...extra });
const revoke = extra => base({ isOnlineMsg: false, elements: [{ elementType: 8, grayTipElement: { subElementType: 1,
  revokeElement: { operatorUid: 'u_admin', origMsgSenderUid: 'u_member', isSelfOperate: false } } }], ...extra });
const change = (memberUid, adminUid, memberAdd, extra = {}) => base({ elements: [{ elementType: 8,
  grayTipElement: { subElementType: 4, groupElement: { type: 999, memberUid, adminUid, memberAdd } } }], ...extra });
async function waitFor(predicate) { const deadline=Date.now()+1500;while(!predicate()){if(Date.now()>deadline)throw new Error('Recovery condition timed out.');await delay(2);} }
function fixture(t, options = {}) {
  let mapper = options.mapper ?? createMessageMapper({ selfId: account.uin, richMedia: true });
  let members = new Set(['u_self', 'u_member', 'u_admin']), online = true, permitted = true;
  const calls = [];
  const notice = createNoticeMapper({ account, mapper, timeoutMs: options.timeoutMs ?? 50,
    isObservedMember: options.isObservedMember,
    allowed: () => permitted,
    checkCurrent() { if (!online) throw new Error('account changed'); },
    getServices: () => ({ groupService: {
      getUinByUids(ids) { calls.push(['identity', ids]); return options.identity?.(ids) ?? { errCode: 0, uins: new Map(ids.map(id => [id, identities.get(id)])) }; },
      getAllMemberList(g, force) { assert.equal(g, group); assert.equal(force, true); calls.push(['members']); return options.members?.() ?? { errCode: 0, result: { finish: true, infos: new Map([...members].map(uid => [uid, { uid }])) } }; },
    } }),
  });
  t.after(() => notice.close());
  return { mapper, notice, calls, members(value) { members = new Set(value); }, offline() { online=false; }, deny() { permitted=false; } };
}

test('recall notices preserve the exact original message alias and distinguish sender/operator', async t => {
  const f = fixture(t), original = f.mapper.rememberNative(base({}));
  const events = await f.notice.fromRecord(revoke());
  assert.deepEqual(events, [{ time: 1800000000, self_id: 10000001, post_type: 'notice', notice_type: 'group_recall',
    group_id: 20000001, user_id: 30000001, operator_id: 30000002, message_id: original }]);
  assert.deepEqual(await f.notice.fromRecord(revoke()), []);
  const restored = createMessageMapper({ selfId: account.uin, initialState: f.mapper.snapshot() });
  const next = fixture(t, { mapper: restored });
  assert.deepEqual(await next.notice.fromRecord(revoke()), []);
  assert.equal(next.calls.length, 0);
});

test('recall requires a timestamp and structured identities, never infers operator from self flags', async t => {
  const f = fixture(t, { identity: () => ({ errCode: 7, uins: new Map() }) });
  assert.deepEqual(await f.notice.fromRecord(revoke()), []);
  const g = fixture(t);
  for (const record of [revoke({ recallTime: '0' }), revoke({ isImportMsg: true }), revoke({ chatType: 1 })]) assert.deepEqual(await g.notice.fromRecord(record), []);
  g.deny(); assert.deepEqual(await g.notice.fromRecord(revoke()), []);
  assert.equal(g.calls.length, 0);
});

test('explicit invite and approved joins use structured fields without relying on enum guesses', async t => {
  const f=fixture(t);
  const invite = await f.notice.fromRecord(change('u_member','u_admin',{ otherInviteOther: { invited: { uid:'u_member' } } }));
  assert.equal(invite[0].notice_type,'group_increase');assert.equal(invite[0].sub_type,'invite');assert.equal(invite[0].operator_id,30000002);
  assert.deepEqual(await f.notice.fromRecord(change('u_member','u_admin',{ otherInviteOther:{} })),[]);
  const approved=await f.notice.fromRecord(change('u_member','',{ inviter:{uid:''}, otherAdd:{ uid:'u_member' } },{msgId:'7000000000000000002'}));
  assert.equal(approved[0].sub_type,'approve');assert.equal(approved[0].operator_id,0);
});

test('departures require complete before and after snapshots; leaving and kicks remain distinct', async t => {
  for(const [member,operator,subtype] of [['u_member','','leave'],['u_member','u_admin','kick'],['u_self','u_admin','kick_me']]){
    const f=fixture(t);await f.notice.prime(group);f.members(['u_admin']);
    const result=await f.notice.fromRecord(change(member,operator,null));
    assert.equal(result[0].notice_type,'group_decrease');assert.equal(result[0].sub_type,subtype);
    assert.equal(result[0].operator_id,subtype==='leave'?30000001:30000002);
    assert.deepEqual(await f.notice.fromRecord(change(member,operator,null)),[]);
  }
});

test('snapshot initialization, unchanged members, mute, old records and unknown variants do not emit joins/leaves', async t => {
  const f=fixture(t);await f.notice.prime(group);assert.equal(f.notice.status().emitted,0);
  assert.deepEqual(await f.notice.fromRecord(change('u_member','u_admin',null)),[]);
  assert.deepEqual(await f.notice.fromRecord(change('u_member','u_admin',{})),[]);
  assert.deepEqual(await f.notice.fromRecord(change('u_member','u_admin',null,{msgTime:'1000000000'})),[]);
  const incomplete=fixture(t,{members:()=>({errCode:0,result:{finish:false,infos:new Map()}})});
  await incomplete.notice.prime(group);assert.deepEqual(await incomplete.notice.fromRecord(change('u_member','u_admin',null)),[]);
  assert.equal(incomplete.notice.status().tracked_groups,0);
});

test('confirmed removal of the current QQ from the group avoids further unauthorized member reads', async t => {
  let reads=0;const f=fixture(t,{isObservedMember:()=>false,members:()=>{reads++;if(reads>1)throw new Error('must not query a departed group');return {errCode:0,result:{finish:true,infos:new Map([['u_self',{uid:'u_self'}]])}};}});
  await f.notice.prime(group);const result=await f.notice.fromRecord(change('u_self','u_admin',null));
  assert.equal(result[0].sub_type,'kick_me');assert.equal(reads,1);
});

test('metadata timeouts keep native slots occupied and never publish unresolved recalls', async t => {
  const f=fixture(t,{timeoutMs:5,identity:()=>new Promise(()=>{})});
  for(let i=0;i<4;i++) assert.deepEqual(await f.notice.fromRecord(revoke({msgId:String(7000000000000000000n+BigInt(i))})),[]);
  assert.equal(f.notice.status().active,4);
  assert.deepEqual(await f.notice.fromRecord(revoke()),[]);
});

test('account changes and permission withdrawal reject late metadata before marking a notice', async t => {
  let finish;const f=fixture(t,{identity:()=>new Promise(resolve=>{finish=resolve;})});
  const pending=f.notice.fromRecord(revoke());await turn();f.offline();finish({errCode:0,uins:identities});
  await assert.rejects(pending,/account changed/);
  assert.equal(f.mapper.hasNotice(`recall:${group}:7000000000000000001`),false);
});

test('short disconnects recover without requesting a worker restart', async t => {
  const requests=[];const c=createRecoveryController({requestRestart:r=>requests.push(r),graceMs:20,canRestore:()=>true});t.after(()=>c.stop());
  c.observe({online:true});c.observe({online:false,sessionReady:true});assert.equal(c.status().phase,'waiting');
  await delay(5);c.observe({online:true});await delay(30);assert.equal(requests.length,0);assert.equal(c.status().phase,'online');
});

test('sustained disconnects coalesce into one restart and repeated updates do not postpone it', async t => {
  const requests=[];const c=createRecoveryController({requestRestart:r=>requests.push(r),graceMs:10,canRestore:()=>true});t.after(()=>c.stop());
  c.observe({online:true});for(let i=0;i<20;i++)c.observe({online:false,reason:'msf_disconnected'});
  await waitFor(()=>requests.length===1);assert.deepEqual(requests,[{mode:'automatic',reason:'msf_disconnected'}]);
  c.observe({online:false});await delay(20);assert.equal(requests.length,1);
});

test('revoked authentication and unremembered sessions require manual login; stop cancels recovery', async () => {
  const requests=[];const c=createRecoveryController({requestRestart:r=>requests.push(r),graceMs:5});
  c.observe({online:true});c.observe({online:false});await delay(15);await turn();
  assert.equal(requests[0].mode,'manual');c.stop();
  const d=createRecoveryController({requestRestart:r=>requests.push(r),graceMs:5,canRestore:()=>true});
  d.authenticationRequired('kicked_offline');await turn();assert.equal(requests[1].mode,'manual');d.stop();
  const e=createRecoveryController({requestRestart:r=>requests.push(r),graceMs:5});e.observe({online:true});e.observe({online:false});e.stop();await delay(15);assert.equal(requests.length,2);
});

test('supervisor restart budgets back off, stop at the limit and recover after the rolling window', () => {
  let now=0;const b=createRestartBudget({now:()=>now});
  assert.deepEqual(Array.from({length:6},()=>b.next().delayMs),[1000,2000,4000,8000,16000,30000]);
  assert.equal(b.next().manual,true);now=600001;assert.equal(b.next().delayMs,1000);
});
