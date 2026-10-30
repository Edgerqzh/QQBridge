import { access, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { constants } from 'node:fs';

async function exists(file) { try { await access(file, constants.R_OK); return true; } catch { return false; } }

export async function discoverQQ(env = process.env, platform = process.platform) {
  const candidates = [];
  if (env.QQBRIDGE_QQ_APP) candidates.push(resolve(env.QQBRIDGE_QQ_APP));
  if (platform === 'win32') {
    for (const base of [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)) {
      const versions = join(base, 'Tencent', 'QQNT', 'versions');
      for (const version of await readdir(versions).catch(() => [])) candidates.push(join(versions, version, 'resources', 'app'));
    }
  } else {
    candidates.push(resolve('data/qq/extracted/opt/QQ/resources/app'), '/opt/QQ/resources/app', '/opt/qq/resources/app', '/usr/lib/qq/resources/app');
  }
  const apps = [];
  for (const directory of [...new Set(candidates)]) {
    try {
      const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      apps.push({ directory, version: pkg.version ?? null, platform: pkg.platform ?? null, architecture: pkg.eleArch ?? null, bytecodeShell: pkg.isByteCodeShell === true, wrapperPresent: await exists(join(directory, 'wrapper.node')), main: pkg.main ?? null });
    } catch { /* Not an installed QQ resources directory. */ }
  }
  return apps;
}

export async function collectDiagnostics(env = process.env) {
  const apps = await discoverQQ(env);
  return {
    project: 'QQBridge', stage: 'gateway-and-experimental-linux-qr; account/message session NOT verified',
    environment: { platform: process.platform, architecture: process.arch, node: process.version, nodeModuleABI: process.versions.modules },
    installedQQ: apps,
    nativeDriverConfigured: Boolean(env.QQBRIDGE_DRIVER),
    nativeDriverFilePresent: env.QQBRIDGE_DRIVER ? await exists(resolve(env.QQBRIDGE_DRIVER)) : false,
    qqLoginVerified: false,
    qqMessageReceiveVerified: false,
    qqMessageSendVerified: false,
    nextStep: apps.length ? 'Probe the exact client build in a compatible isolated host; implement and verify a native driver.' : 'Provide a Linux QQ resources/app directory via QQBRIDGE_QQ_APP for isolated native probing.',
  };
}
