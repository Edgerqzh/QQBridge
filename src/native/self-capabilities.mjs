import { mkdir, mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { PROFILE_ACTIONS, QZONE_ACTIONS } from '../account-capabilities.mjs';
import { createImageWorker } from './image-worker-client.mjs';
import { imageInfo } from './media.mjs';

const safeErrors = new WeakSet();
function fail(retcode, message) {
  const error = Object.assign(new Error(message), { retcode, publicMessage: message });
  safeErrors.add(error); return error;
}
const own = (object, key) => Object.hasOwn(object, key);
const allowedDomains = new Set(['user.qzone.qq.com', 'qzone.qq.com', 'h5.qzone.qq.com', 'mobile.qzone.qq.com']);
export const CUSTOM_STATUS_IDS = Object.freeze([1000,1011,1016,1018,1021,1027,1028,1030,1032,1051,1052,1056,1058,1059,1060,1061,1062,1063,1070,1071,1201,1300,1401,2001,2003,2006,2012,2013,2014,2015,2019,2023,2025,2026,2037,2050,2053]);

export function normalizeQzoneDomain(domain) {
  if (domain === undefined) throw fail(1403, '必须指定允许的空间域名');
  if (typeof domain !== 'string') throw fail(1400, '空间域名格式不正确');
  const normalized = domain.toLowerCase().replace(/^https:\/\//, '').replace(/\/$/, '');
  if (normalized.length > 253 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(normalized)) throw fail(1400, '空间域名格式不正确');
  if (!allowedDomains.has(normalized)) throw fail(1403, '不允许获取该域名的凭证');
  return normalized;
}
function text(value, label, max, allowEmpty = true) {
  if (typeof value !== 'string' || !value.isWellFormed() || [...value].length > max ||
      !allowEmpty && !value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw fail(1400, `${label}格式或长度不正确`);
  return value;
}
function signature(p) {
  const values = ['longNick', 'long_nick', 'longnick'].filter(key => own(p, key)).map(key => text(p[key], '签名', 255));
  if (!values.length || values.some(value => value !== values[0])) throw fail(1400, '签名参数缺失或别名的值不一致');
  return values[0];
}
function onlineStatus(p) {
  const { status, ext_status, battery_status } = p;
  if (![status, ext_status, battery_status].every(Number.isSafeInteger) || battery_status < 0 || battery_status > 100 ||
      !(ext_status === 0 && [10,30,40,50,70].includes(status) || status === 10 && CUSTOM_STATUS_IDS.includes(ext_status))) throw fail(1400, '在线状态组合或电量不正确');
  return { status, extStatus: ext_status, batteryStatus: battery_status };
}
function avatarBytes(file) {
  if (typeof file !== 'string' || !file.startsWith('base64://')) throw fail(1400, '头像只接受 Base64 图片');
  const data = file.slice(9), limit = 4 * 1024 * 1024;
  if (!data || data.length > Math.ceil(limit / 3) * 4 || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw fail(1400, '头像编码或大小不正确');
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > limit || bytes.toString('base64') !== data) throw fail(1400, '头像编码或大小不正确');
  let info;
  try { info = imageInfo(bytes); } catch { throw fail(1400, '头像必须是完整的 PNG 或 JPEG 图片'); }
  if (!Number.isInteger(info.width) || !Number.isInteger(info.height) || info.width < 1 || info.height < 1 || info.width > 4096 || info.height > 4096 || info.width * info.height > 16777216) throw fail(1400, '头像像素超过允许范围');
  return { bytes, info };
}
function ack(result, partial = false) {
  if (result?.result === 0) return;
  const code = Number.isSafeInteger(result?.result) && Math.abs(result.result) <= 2147483648 ? result.result : null;
  const reason = typeof result?.errMsg === 'string' ? result.errMsg : '';
  const policy = /频繁|次数|审核|风控|限制|拒绝|权限|limit|denied|policy|review|frequen/i.test(reason);
  const suffix = code === null ? '' : `（原生错误码 ${code}）`;
  throw fail(partial ? 1500 : policy ? 1403 : 1500, (partial ? '部分资料可能已修改，请核实后再操作' : policy ? 'QQ 限制或拒绝了此次操作' : 'QQ 未确认操作成功，请勿盲目重试') + suffix);
}
const cookieValue = (value, empty = false) => typeof value === 'string' && value.length <= 4096 &&
  (empty && value === '' || /^[\x21-\x7e]+$/.test(value) && !/[;,\\"']/.test(value));
export function qzoneCsrf(value) { let hash = 5381; for (let i = 0; i < value.length; i++) hash = (hash * 33 + value.charCodeAt(i)) >>> 0; return hash & 0x7fffffff; }

/** Account-bound capabilities. Credentials are returned directly, never cached or journaled. */
export function createSelfCapabilities({ getContext, profile, enableProfileActions = false, enableQzoneCredentials = false, timeoutMs = 8000 }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('Invalid account action timeout');
  const images = createImageWorker({ timeoutMs });
  let closed = false;
  const context = () => {
    try { if (closed) throw Error(); const c = getContext(); c.check(); return c; }
    catch { throw fail(1403, '当前账号未登录或会话不可用'); }
  };
  function method(c, service, name) {
    if (typeof c.services.session?.[service] !== 'function') throw fail(1404, '当前原生版本未实现此能力');
    const object = c.services.session[service]();
    if (typeof object?.[name] !== 'function') throw fail(1404, '当前原生版本未实现此能力');
    return object[name].bind(object);
  }
  function run(operation) {
    let invoked = false, expired = false, timer;
    const deadline = Date.now() + timeoutMs;
    const check = () => { if (expired || closed || Date.now() >= deadline) throw fail(invoked ? 1500 : 1504, invoked ? '操作结果未确认，请勿盲目重试' : '准备超时或已取消，未执行修改'); };
    const work = Promise.resolve().then(() => operation({ check, invoke(fn) { check(); invoked = true; return fn(); } }))
      .catch(error => { if (safeErrors.has(error)) throw error; throw fail(1500, invoked ? '操作结果未确认，请勿盲目重试' : '无法完成账号操作'); });
    return Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => { expired = true; reject(fail(invoked ? 1500 : 1504, invoked ? '操作超时，结果未确认，请勿盲目重试' : '准备超时，未执行修改')); }, timeoutMs); })]).finally(() => clearTimeout(timer));
  }
  return {
    close() { closed = true; images.close(); },
    async selfInfo(p) {
      if (!enableProfileActions) throw fail(1404, 'QQ 资料动作未启用');
      if (p.no_cache !== undefined && typeof p.no_cache !== 'boolean') throw fail(1400, 'no_cache 必须是布尔值');
      return run(async op => {
        const c = context();
        if (String(p.user_id) !== c.account.uin) throw fail(1403, '只允许查询当前账号资料');
        if (p.no_cache === true) {
          const refresh = method(c, 'getProfileService', 'fetchUserDetailInfo');
          const result = await refresh('qqbridge.self', [c.account.uid], 1, [1]); op.check(); c.check(); ack(result);
        }
        const read = method(c, 'getProfileService', 'getCoreAndBaseInfo');
        const data = await read('qqbridge.self', [c.account.uid]); op.check(); c.check();
        const row = data instanceof Map ? data.get(c.account.uid) : null;
        if (!row || row.uid !== undefined && row.uid !== c.account.uid || row.uin !== undefined && row.uin !== c.account.uin || typeof row.coreInfo?.nick !== 'string') throw fail(1500, '未获取到当前账号资料');
        return { user_id: Number(c.account.uin), nickname: row.coreInfo.nick.slice(0, 256), nick: row.coreInfo.nick.slice(0, 256) };
      });
    },
    async call(action, p) {
      if (PROFILE_ACTIONS.includes(action)) {
        if (!enableProfileActions) throw fail(1404, 'QQ 资料动作未启用');
        let updates, status, avatar;
        if (action === 'set_qq_profile') {
          updates = [];
          if (own(p, 'nickname')) updates.push(['setNickName', text(p.nickname, '昵称', 36, false)]);
          if (own(p, 'personal_note')) updates.push(['setLongNick', text(p.personal_note, '签名', 255)]);
          if (!updates.length) throw fail(1400, '至少提供昵称或签名');
        } else if (action === 'set_self_longnick') updates = [['setLongNick', signature(p)]];
        else if (action === 'set_online_status') status = onlineStatus(p);
        else avatar = avatarBytes(p.file);
        return run(async op => {
          const c = context();
          if (updates) {
            // Resolve all required methods before the first write. Missing fields never enter the SDK.
            const steps = updates.map(([name, value]) => [method(c, 'getProfileService', name), value]);
            let applied = false;
            for (const [fn, value] of steps) { op.check(); c.check(); const result = await op.invoke(() => fn(value)); op.check(); c.check(); ack(result, applied); applied = true; }
          } else if (status) {
            if (typeof c.services.msgService?.setStatus !== 'function') throw fail(1404, '当前原生版本未实现在线状态修改');
            const result = await op.invoke(() => c.services.msgService.setStatus(status)); op.check(); c.check(); ack(result);
          } else {
            const setHeader = method(c, 'getProfileService', 'setHeader');
            let directory;
            try {
              let decoded;
              try { decoded = await images.inspect(avatar.bytes); } catch { throw fail(1400, '头像图片不完整或无法解码'); }
              op.check(); c.check();
              if (decoded.width !== avatar.info.width || decoded.height !== avatar.info.height) throw fail(1400, '头像图片尺寸不一致');
              const parent = path.join(profile, 'tmp', 'avatars'); await mkdir(parent, { recursive: true, mode: 0o700 }); op.check(); c.check();
              directory = await mkdtemp(path.join(parent, 'upload-'));
              const file = path.join(directory, 'avatar.' + avatar.info.extension);
              await writeFile(file, avatar.bytes, { flag: 'wx', mode: 0o600 }); op.check(); c.check();
              const result = await op.invoke(() => setHeader(file)); op.check(); c.check(); ack(result);
            } finally {
              // Wait for the native promise to settle before deleting its input, even after caller timeout.
              if (directory) { await unlink(path.join(directory, 'avatar.' + avatar.info.extension)).catch(() => {}); await rmdir(directory).catch(() => {}); }
            }
          }
          return {};
        });
      }
      if (QZONE_ACTIONS.includes(action)) {
        if (!enableQzoneCredentials) throw fail(1404, '空间凭证动作未启用');
        normalizeQzoneDomain(p.domain);
        return run(async op => {
          const c = context(), getPskey = method(c, 'getTipOffService', 'getPskey');
          const raw = await getPskey(['qzone.qq.com'], false); op.check(); c.check(); ack(raw);
          const key = raw.domainPskeyMap instanceof Map ? raw.domainPskeyMap.get('qzone.qq.com') : null;
          const skey = raw.skey === undefined ? '' : raw.skey;
          if (!cookieValue(key) || !cookieValue(skey, true) || !/^[1-9]\d{4,11}$/.test(c.account.uin)) throw fail(1500, '空间凭证不可用或格式异常');
          const uin = 'o' + c.account.uin;
          const cookies = `uin=${uin}; p_uin=${uin}; skey=${skey}; p_skey=${key}`;
          return action === 'get_credentials' ? { cookies, csrf_token: qzoneCsrf(key) } : { cookies };
        });
      }
      throw fail(1404, '未实现此账号动作');
    },
  };
}
