import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createSelfCapabilities, normalizeQzoneDomain, qzoneCsrf, CUSTOM_STATUS_IDS } from '../src/native/self-capabilities.mjs';
import { PROFILE_ACTIONS, QZONE_ACTIONS } from '../src/account-capabilities.mjs';
import { createActionDispatcher } from '../src/onebot.mjs';

const account = { uin: '123456789', uid: 'u_fixture_account' };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t, options = {}) {
  const calls = [], directory = await mkdtemp(path.join(os.tmpdir(), 'qqbridge-self-'));
  let live = true;
  const profileService = {
    setNickName(value) { calls.push(['nick', value]); return { result: 0 }; },
    setLongNick(value) { calls.push(['sign', value]); return { result: 0 }; },
    setHeader(file) { calls.push(['avatar', file]); return { result: 0 }; },
    fetchUserDetailInfo(...args) { calls.push(['refresh', ...args]); return { result: 0 }; },
    getCoreAndBaseInfo(...args) { calls.push(['self', ...args]); return new Map([[account.uid, { uid: account.uid, uin: account.uin, coreInfo: { nick: 'Fixture' } }]]); },
    ...options.profileService,
  };
  const service = createSelfCapabilities({ profile: directory, enableProfileActions: true, enableQzoneCredentials: true, timeoutMs: 1500,
    getContext() { if (!live) throw Error('internal account'); return { account, check() { if (!live) throw Error('private session path'); },
      services: { msgService: { setStatus(value) { calls.push(['status', value]); return { result: 0 }; }, ...options.msgService },
        session: { getProfileService: () => profileService, getTipOffService: () => ({ getPskey(...args) { calls.push(['pskey', ...args]); return options.cookieResult ?? { result: 0, domainPskeyMap: new Map([['qzone.qq.com', 'fixture-ticket']]), skey: 'fixture-skey', A2: 'never-return-this' }; } }) } } }; }, ...options });
  t.after(async () => { service.close(); await rm(directory, { recursive: true, force: true }); });
  return { service, calls, directory, invalidate() { live = false; } };
}
const rejected = (promise, code) => assert.rejects(promise, e => e.retcode === code && /\p{Script=Han}/u.test(e.message));
const asFile = bytes => 'base64://' + bytes.toString('base64');

test('both gates default closed and are independent; disabled actions never enter native services', async t => {
  const off = await fixture(t, { enableProfileActions: false, enableQzoneCredentials: false });
  const defaults = createSelfCapabilities({ profile: off.directory, getContext() { assert.fail('Closed defaults must not access native context'); } });
  t.after(() => defaults.close());
  for (const action of [...PROFILE_ACTIONS, ...QZONE_ACTIONS]) await rejected(defaults.call(action, {}), 1404);
  for (const action of [...PROFILE_ACTIONS, ...QZONE_ACTIONS]) await rejected(off.service.call(action, {}), 1404);
  await rejected(off.service.selfInfo({ user_id: account.uin }), 1404); assert.deepEqual(off.calls, []);
  const profile = await fixture(t, { enableQzoneCredentials: false });
  assert.deepEqual(await profile.service.call('set_self_longnick', { longNick: '' }), {});
  await rejected(profile.service.call('get_cookies', { domain: 'qzone.qq.com' }), 1404);
  const cookies = await fixture(t, { enableProfileActions: false });
  assert.ok((await cookies.service.call('get_cookies', { domain: 'qzone.qq.com' })).cookies);
  await rejected(cookies.service.call('set_qq_profile', { nickname: 'Fixture' }), 1404);
});
test('profile updates include only explicitly provided fields, including signature-only fallback and clearing', async t => {
  const f = await fixture(t);
  for (const params of [{ nickname: 'New' }, { personal_note: '' }, { personal_note: '签名' }, { nickname: 'Next', personal_note: 'Note' }]) assert.deepEqual(await f.service.call('set_qq_profile', params), {});
  assert.deepEqual(f.calls, [['nick','New'],['sign',''],['sign','签名'],['nick','Next'],['sign','Note']]);
  for (const params of [{}, { unrelated: 'x' }, { nickname: '' }, { nickname: null }, { nickname: 'x'.repeat(37) }, { personal_note: 1 }, { personal_note: '\u0000' }, { personal_note: '\ud800' }]) await rejected(f.service.call('set_qq_profile', params), 1400);
  assert.equal(f.calls.length, 5);
});
test('signature aliases accept equal values and empty strings, reject conflicts and malformed values', async t => {
  const f = await fixture(t);
  for (const name of ['longNick','long_nick','longnick']) assert.deepEqual(await f.service.call('set_self_longnick', { [name]: '' }), {});
  assert.deepEqual(await f.service.call('set_self_longnick', { longNick: '同值', long_nick: '同值', longnick: '同值' }), {});
  for (const params of [{}, { longNick: null }, { longNick: 'a', long_nick: 'b' }, { longNick: 'a', longnick: false }, { longNick: 'x'.repeat(256) }]) await rejected(f.service.call('set_self_longnick', params), 1400);
  assert.equal(f.calls.length, 4);
});
test('online status accepts all known combinations and integer battery zero; rejects unknown combinations', async t => {
  const f = await fixture(t);
  for (const status of [10,30,40,50,70]) assert.deepEqual(await f.service.call('set_online_status', { status, ext_status: 0, battery_status: 0 }), {});
  for (const ext_status of CUSTOM_STATUS_IDS) await f.service.call('set_online_status', { status: 10, ext_status, battery_status: 100 });
  assert.deepEqual(f.calls[0], ['status', { status: 10, extStatus: 0, batteryStatus: 0 }]);
  for (const params of [{}, { status: '10', ext_status: 0, battery_status: 0 }, { status: 60, ext_status: 0, battery_status: 0 }, { status: 30, ext_status: 1028, battery_status: 0 }, { status: 10, ext_status: 9999, battery_status: 0 }, { status: 10, ext_status: 0, battery_status: -1 }, { status: 10, ext_status: 0, battery_status: 101 }, { status: 10, ext_status: 0, battery_status: .5 }]) await rejected(f.service.call('set_online_status', params), 1400);
});
test('domain normalization accepts only the four exact aliases and never forwards the caller domain', async t => {
  const f = await fixture(t);
  for (const name of ['user.qzone.qq.com','qzone.qq.com','h5.qzone.qq.com','mobile.qzone.qq.com']) {
    assert.equal(normalizeQzoneDomain('HTTPS://' + name.toUpperCase() + '/'), name);
    await f.service.call('get_cookies', { domain: 'https://' + name + '/' });
  }
  assert.ok(f.calls.every(call => JSON.stringify(call) === JSON.stringify(['pskey',['qzone.qq.com'],false])));
  for (const domain of ['qzone.qq.com:443','qzone.qq.com/path','user@qzone.qq.com','*.qzone.qq.com','http://qzone.qq.com','qzone.qq.com//','qzone.qq.com?x=1','qzone.qq.com#x',' qzone.qq.com','qzone..qq.com','qzone.qq.com\r\n', '', null, 42]) await rejected(f.service.call('get_cookies', { domain }), 1400);
  for (const domain of ['qun.qq.com','qq.com','evil.qzone.qq.com','qzone.qq.com.evil.com',undefined]) await rejected(f.service.call('get_cookies', { domain }), 1403);
  assert.equal(f.calls.length, 4);
});
test('credentials expose exactly four cookie names; csrf uses the domain ticket, no generic-login fallback', async t => {
  const f = await fixture(t);
  const c = await f.service.call('get_credentials', { domain: 'qzone.qq.com' });
  assert.deepEqual(Object.keys(c), ['cookies','csrf_token']);
  const parts = Object.fromEntries(c.cookies.split('; ').map(part => part.split('=')));
  assert.deepEqual(parts, { uin: 'o123456789', p_uin: 'o123456789', skey: 'fixture-skey', p_skey: 'fixture-ticket' });
  assert.equal(c.csrf_token, qzoneCsrf('fixture-ticket')); assert.equal(qzoneCsrf('abc'),193485963);
  assert.equal(JSON.stringify(c).includes('never-return-this'), false);
  const absent = await fixture(t, { cookieResult: { result: 0, domainPskeyMap: new Map([['qzone.qq.com','abc']]), A2: 'forbidden' } });
  assert.equal((await absent.service.call('get_cookies', { domain: 'qzone.qq.com' })).cookies, 'uin=o123456789; p_uin=o123456789; skey=; p_skey=abc');
  const wrong = await fixture(t, { cookieResult: { result: 0, domainPskeyMap: new Map([['qun.qq.com','wrong-domain']]), p_skey: 'wrong-field', A2: 'not-a-ticket' } });
  await rejected(wrong.service.call('get_cookies', { domain: 'qzone.qq.com' }), 1500);
  assert.deepEqual(await readdir(f.directory), []);
});
test('cookie values reject separators, controls, Unicode and oversized data', async t => {
  for (const value of ['x; uin=evil','x,y','x\r\nSet-Cookie:y','x y','中文','"quoted"','x'.repeat(4097),'']) {
    const f = await fixture(t, { cookieResult: { result: 0, domainPskeyMap: new Map([['qzone.qq.com',value]]) } });
    await rejected(f.service.call('get_cookies', { domain: 'qzone.qq.com' }), 1500);
  }
});
test('self reads verify identity and no_cache refresh, returning no extra fields', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.service.selfInfo({ user_id: account.uin, no_cache: true }), { user_id: 123456789, nickname: 'Fixture', nick: 'Fixture' });
  assert.deepEqual(f.calls[0], ['refresh','qqbridge.self',[account.uid],1,[1]]);
  await rejected(f.service.selfInfo({ user_id: '987654321' }), 1403);
  await rejected(f.service.selfInfo({ user_id: account.uin, no_cache: 1 }), 1400);
  const wrong = await fixture(t, { profileService: { getCoreAndBaseInfo() { return new Map([[account.uid,{ uid: 'other', coreInfo: { nick: 'Other' } }]]); } } });
  await rejected(wrong.service.selfInfo({ user_id: account.uin }), 1500);
});
test('native policy failure reports only a safe numeric code and Chinese reason; thrown diagnostics never escape', async t => {
  const f = await fixture(t, { profileService: { setLongNick() { return { result: 1207, errMsg: '次数限制 PRIVATE_SECRET /private/path' }; } } });
  await assert.rejects(f.service.call('set_self_longnick',{longNick:'x'}),e => e.retcode===1403 && e.message.includes('1207') && !/PRIVATE|path/.test(e.message));
  const nativeError = await fixture(t,{ profileService:{setLongNick(){throw Object.assign(Error('SECRET'),{retcode:1403,publicMessage:'秘密路径 SECRET'});}}});
  await assert.rejects(nativeError.service.call('set_self_longnick',{longNick:'x'}), e => e.retcode===1500 && !/SECRET|秘密/.test(e.message));
  const malformed = await fixture(t,{ profileService:{setLongNick(){return undefined;}}});
  await rejected(malformed.service.call('set_self_longnick',{longNick:'x'}),1500);
});
test('multi-field writes preflight all methods and treat partial application as an uncertain result', async t => {
  const f=await fixture(t,{profileService:{setLongNick(){return {result:1207,errMsg:'频繁'};}}});
  await rejected(f.service.call('set_qq_profile',{nickname:'Changed',personal_note:'x'}),1500);
  assert.deepEqual(f.calls,[['nick','Changed']]);
  const missing=await fixture(t,{profileService:{setLongNick:undefined}});
  await rejected(missing.service.call('set_qq_profile',{nickname:'Changed',personal_note:'x'}),1404);assert.deepEqual(missing.calls,[]);
});
test('post-dispatch timeout is 1500 with exactly one call; read-only preflight timeout is 1504',async t=>{
  const wait=deferred();let count=0;
  const f=await fixture(t,{timeoutMs:8,profileService:{setLongNick(){count++;return wait.promise;}}});
  await rejected(f.service.call('set_self_longnick',{longNick:'x'}),1500);wait.resolve({result:0});
  await new Promise(r=>setTimeout(r,20));assert.equal(count,1);
  const read=deferred();const g=await fixture(t,{timeoutMs:8,profileService:{getCoreAndBaseInfo(){return read.promise;}}});
  await rejected(g.service.selfInfo({user_id:account.uin}),1504);read.resolve(new Map());assert.deepEqual(g.calls,[]);
});
test('avatar accepts only canonical bounded PNG/JPEG and verifies complete decoding before native dispatch',async t=>{
  const f=await fixture(t);const png=await sharp({create:{width:32,height:32,channels:3,background:'#4466aa'}}).png().toBuffer();
  assert.deepEqual(await f.service.call('set_qq_avatar',{file:asFile(png)}),{});assert.equal(f.calls.length,1);
  await assert.rejects(readFile(f.calls[0][1]),{code:'ENOENT'});
  const huge=await sharp({create:{width:5000,height:1,channels:3,background:'blue'}}).png().toBuffer();
  const jpeg=await sharp(png).jpeg().toBuffer();
  for(const file of ['https://example.com/avatar.png','C:\\private\\avatar.png','file:///avatar','base64://','base64://Zh==','base64://AA A=','base64://'+'A'.repeat(5592412),asFile(Buffer.from('GIF89a invalid')),asFile(huge),asFile(jpeg.subarray(0,40)),asFile(png.subarray(0,28))]) await rejected(f.service.call('set_qq_avatar',{file}),1400);
  assert.equal(f.calls.length,1);
  assert.deepEqual(await f.service.call('set_qq_avatar',{file:asFile(jpeg)}),{});assert.equal(f.calls.length,2);
});
test('avatar preflight deadline prevents a later native write; a timed-out dispatched avatar keeps input until settlement',async t=>{
  const png=await sharp({create:{width:32,height:32,channels:3,background:'blue'}}).png().toBuffer();
  const before=await fixture(t,{timeoutMs:1});await rejected(before.service.call('set_qq_avatar',{file:asFile(png)}),1504);
  await new Promise(r=>setTimeout(r,180));assert.deepEqual(before.calls,[]);
  const wait=deferred();let sentFile;
  const after=await fixture(t,{timeoutMs:1500,profileService:{setHeader(file){sentFile=file;return wait.promise;}}});
  await rejected(after.service.call('set_qq_avatar',{file:asFile(png)}),1500);assert.ok(sentFile);assert.ok((await readFile(sentFile)).equals(png));
  wait.resolve({result:0});await new Promise(r=>setTimeout(r,30));await assert.rejects(readFile(sentFile),{code:'ENOENT'});
});
test('session loss and close never deliver stale credentials or dispatch a delayed write',async t=>{
  const f=await fixture(t);f.invalidate();await rejected(f.service.call('get_cookies',{domain:'qzone.qq.com'}),1403);
  assert.deepEqual(f.calls,[]);f.service.close();await rejected(f.service.call('set_self_longnick',{longNick:'x'}),1403);
});
test('dispatcher preserves success shape, closed gates, safe errors and unknown-outcome timeout',async t=>{
  const f=await fixture(t);const dispatch=createActionDispatcher({backend:{status:()=>({online:true}),call:(a,p)=>f.service.call(a,p)}});
  assert.deepEqual(await dispatch({action:'set_qq_profile',params:{personal_note:''},echo:7}),{status:'ok',retcode:0,data:{},echo:7});
  assert.equal((await dispatch({action:'set_qq_profile',params:{}})).retcode,1400);
  const hang=createActionDispatcher({requestTimeoutMs:5,backend:{status:()=>({online:true}),call:()=>new Promise(()=>{})}});
  const keepAlive=setTimeout(()=>{},100);try{const r=await hang({action:'set_self_longnick',params:{longNick:'x'}});assert.equal(r.retcode,1500);assert.match(r.message,/未确认/);}finally{clearTimeout(keepAlive)}
  const off=await fixture(t,{enableProfileActions:false,enableQzoneCredentials:false});
  const offline=createActionDispatcher({backend:{status:()=>({online:false}),call:(a,p)=>off.service.call(a,p)}});
  for(const action of [...PROFILE_ACTIONS,...QZONE_ACTIONS])assert.equal((await offline({action})).retcode,1404);
});
