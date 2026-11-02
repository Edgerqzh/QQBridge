import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createDriverCore } from './driver-core.mjs';
import { parseAllowedGroups } from './driver-core.mjs';
import { readSelectedLogin, saveSelectedLogin } from './selected-login.mjs';
import { requireEncryptedProfile } from './profile-storage.mjs';

let loaded = false;
/** Experimental Windows adapter; acceptance is tracked separately from Linux. */
export async function createDriver({ emitEvent, emitStatus, requestRestart }) {
  const build = JSON.parse(await readFile(new URL('./windows/build.json', import.meta.url), 'utf8'));
  if (process.platform !== 'win32' || process.arch !== 'x64' || process.versions.node !== build.node_version) throw new Error('Windows research driver requires Windows x64 and the pinned Node version.');
  if (loaded) throw new Error('Only one Windows native driver is allowed per process.');
  if (!process.env.QQBRIDGE_QQ_APP || !process.env.QQBRIDGE_QQ_PROFILE || !process.env.QQBRIDGE_WINDOWS_COMPAT) throw new Error('Configure an extracted QQ app, a dedicated profile and the Windows compatibility library.');
  const app = path.resolve(process.env.QQBRIDGE_QQ_APP), profile = path.resolve(process.env.QQBRIDGE_QQ_PROFILE);
  if (profile === path.parse(profile).root) throw new Error('A dedicated QQ profile is required.');
  await requireEncryptedProfile(profile);
  const metadata = JSON.parse(await readFile(path.join(app, 'package.json'), 'utf8'));
  if (metadata.version !== build.qq_version || metadata.platform !== 'win32' || metadata.eleArch !== 'x64') throw new Error('Unsupported official Windows QQ build.');
  const digest = createHash('sha256').update(await readFile(path.join(app, 'wrapper.node'))).digest('hex');
  if (digest !== build.wrapper_sha256) throw new Error('Windows QQ native module does not match the researched official package.');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  process.chdir(profile);
  const compatibility = { exports: {} };
  process.dlopen(compatibility, path.resolve(process.env.QQBRIDGE_WINDOWS_COMPAT));
  if (typeof compatibility.exports.close !== 'function') throw new Error('Invalid Windows compatibility library.');
  if (typeof compatibility.exports.pump !== 'function') throw new Error('Windows message pump is unavailable.');
  const pump = setInterval(() => { if (compatibility.exports.pump() === false) requestRestart({ mode: 'automatic', reason: 'windows_message_loop_quit' }); }, 10);
  pump.unref();
  const native = createRequire(import.meta.url)(path.join(app, 'wrapper.node'));
  loaded = true;
  process.once('exit', () => compatibility.exports.close());
  const loginUin = process.env.QQBRIDGE_LOGIN_UIN || (process.env.QQBRIDGE_FORCE_QR === '1' ? '' : await readSelectedLogin(profile));
  const core = createDriverCore({ native, metadata, profile, emitEvent, emitStatus, loginUin,
    requestRestart(request) { try { writeFileSync(path.join(profile, 'last-recovery.json'), JSON.stringify({ mode: request.mode, reason: request.reason })); } catch {} requestRestart(request); },
    platformConfig: { type: 1, appId: build.login_app_id, qua: 'V1_WIN_NQ_9.9.36_53644_GW_B', osName: 'Windows', abortPollingAfterLogin: false,
      onAuthenticationEvent(type, args, account) {
        const describe = (value, depth = 0) => {
          if (typeof value === 'boolean') return value;
          if (typeof value === 'number') return Math.abs(value) < 10000 ? value : 'number';
          if (typeof value === 'string') return { type: 'string', other_device: /另一|其他设备|another|elsewhere/i.test(value), windows: /Windows/i.test(value), empty: value.length === 0 };
          if (!value || typeof value !== 'object' || depth > 2) return typeof value;
          if (Array.isArray(value)) return value.slice(0, 8).map(v => describe(v, depth + 1));
          const fields = {};
          for (const key of Object.keys(value).filter(k => /^[a-zA-Z][a-zA-Z0-9]{0,39}$/.test(k)).slice(0, 24)) {
            fields[key] = /(?:uin|uid)$/i.test(key) ? { matches_account: String(value[key]) === account[/uin$/i.test(key) ? 'uin' : 'uid'] } : describe(value[key], depth + 1);
          }
          return fields;
        };
        writeFileSync(path.join(profile, 'last-auth-event.json'), JSON.stringify({ type, arguments: args.map(v => describe(v)) }));
      },
    },
    forceQr: process.env.QQBRIDGE_FORCE_QR === '1', manualRecoveryReason: process.env.QQBRIDGE_RECOVERY_MANUAL || '',
    allowedGroups: parseAllowedGroups(process.env.QQBRIDGE_ALLOWED_GROUPS), allowedUsers: parseAllowedGroups(process.env.QQBRIDGE_ALLOWED_USERS, 'QQBRIDGE_ALLOWED_USERS'),
    experimentalRichMedia: process.env.QQBRIDGE_EXPERIMENTAL_RICH_MEDIA === '1',
    persistSelectedAccount: uin => saveSelectedLogin(profile, uin),
    async prepareProfile() {
      await mkdir(profile, { recursive: true, mode: 0o700 });
      const file = path.join(profile, 'machine-id');
      let machineId;
      try { machineId = (await readFile(file, 'utf8')).trim(); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        machineId = native.NodeIKernelLoginService.get().getMachineGuid();
        if (typeof machineId !== 'string' || !/^[a-f0-9]{32}$/i.test(machineId)) throw new Error('Windows QQ did not provide a valid device identifier.');
        await writeFile(file, machineId + '\n', { flag: 'wx', mode: 0o600 });
      }
      if (!/^[a-f0-9]{32}$/i.test(machineId)) throw new Error('Invalid Windows profile machine ID.');
      for (const folder of ['db','tmp']) await mkdir(path.join(profile, folder), { recursive: true, mode: 0o700 });
      return machineId;
    },
  });
  return { ...core, async stop() { try { await core.stop(); } finally { clearInterval(pump); compatibility.exports.close(); } } };
}
