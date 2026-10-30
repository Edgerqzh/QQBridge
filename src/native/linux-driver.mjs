import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createDriverCore, parseAllowedGroups } from './driver-core.mjs';
import {readSelectedLogin,saveSelectedLogin} from './selected-login.mjs';

/** Production loader for the single verified official Linux QQ native build. */
export async function createDriver({ emitEvent, emitStatus, requestRestart }) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('The experimental native driver requires Linux x64.');
  const appDir = path.resolve(process.env.QQBRIDGE_QQ_APP || 'data/qq/extracted/opt/QQ/resources/app');
  const profile = path.resolve(process.env.QQBRIDGE_QQ_PROFILE || 'data/qq-profile');
  if (profile === path.parse(profile).root) throw new Error('QQBRIDGE_QQ_PROFILE must be a dedicated profile directory.');
  const metadata = JSON.parse(await readFile(path.join(appDir, 'package.json'), 'utf8'));
  if (metadata.version !== '3.2.34-53644' || metadata.platform !== 'linux' || metadata.eleArch !== 'x64' || !metadata.appid?.linux) {
    throw new Error('Experimental native support requires the tested Linux QQ 3.2.34-53644 x64 build.');
  }
  const allowedGroups = parseAllowedGroups(process.env.QQBRIDGE_ALLOWED_GROUPS);
  const loginUin = process.env.QQBRIDGE_LOGIN_UIN || (process.env.QQBRIDGE_FORCE_QR === '1' ? '' : await readSelectedLogin(profile));
  const require = createRequire(import.meta.url);
  let native;
  try { native = require(path.join(appDir, 'wrapper.node')); }
  catch { throw new Error('Unable to load QQ native module. Start with scripts/run-native-runtime.sh and required Linux libraries.'); }
  if (typeof native.NodeIQQNTWrapperEngine?.get !== 'function' || typeof native.NodeIKernelLoginService?.get !== 'function' || typeof native.NodeIQQNTStartupSessionWrapper?.create !== 'function' || typeof native.NodeIQQNTWrapperSession?.getNTWrapperSession !== 'function') {
    throw new Error('The QQ native module does not expose the required verified interfaces.');
  }
  return createDriverCore({
    native, metadata, profile, emitEvent, emitStatus, allowedGroups, loginUin, requestRestart,
    forceQr: process.env.QQBRIDGE_FORCE_QR === '1', manualRecoveryReason: process.env.QQBRIDGE_RECOVERY_MANUAL || '',
    experimentalRichMedia: process.env.QQBRIDGE_EXPERIMENTAL_RICH_MEDIA === '1',
    persistSelectedAccount: uin => saveSelectedLogin(profile,uin),
    async prepareProfile() {
      await mkdir(profile, { recursive: true, mode: 0o700 });
      let machineId;
      try { machineId = (await readFile(path.join(profile, 'machine-id'), 'utf8')).trim(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!machineId) {
        const generated = randomUUID();
        try { await writeFile(path.join(profile, 'machine-id'), generated + '\n', { flag: 'wx', mode: 0o600 }); machineId = generated; }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          machineId = (await readFile(path.join(profile, 'machine-id'), 'utf8')).trim();
        }
      }
      if (!machineId || machineId.length > 256 || /[\u0000-\u001f\u007f]/.test(machineId)) throw new Error('The QQ profile machine ID is invalid.');
      for (const folder of ['db', 'tmp']) await mkdir(path.join(profile, folder), { recursive: true, mode: 0o700 });
      return machineId;
    },
  });
}
