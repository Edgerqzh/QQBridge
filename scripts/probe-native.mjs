#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Enumerate exported names only. Never initialize a QQ session or call account APIs. */
function inspectModule(modulePath) {
  return new Promise(resolve => {
    const script = `
      try {
        const api = require(process.argv[1]);
        const result = Object.getOwnPropertyNames(api).map(name => {
          const descriptor = Object.getOwnPropertyDescriptor(api, name);
          const value = descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
          return {name, type: typeof value, static: typeof value === 'function' ? Object.getOwnPropertyNames(value).filter(key => !['length','name','arguments','caller','prototype'].includes(key)) : [], prototype: typeof value === 'function' && value.prototype ? Object.getOwnPropertyNames(value.prototype) : []};
        });
        process.stdout.write('QQBRIDGE_PROBE=' + JSON.stringify({ok:true,exports:result}) + '\\n');
        process.exit(0);
      } catch (error) {
        process.stdout.write('QQBRIDGE_PROBE=' + JSON.stringify({ok:false,code:error.code,message:error.message}) + '\\n');
        process.exit(1);
      }
    `;
    const nativeDirs = [path.dirname(modulePath), path.resolve(path.dirname(modulePath),'../..')];
    const child = spawn(process.execPath, ['-e', script, modulePath], {
      cwd: path.dirname(modulePath),
      windowsHide: true,
      env: {
        ...process.env,
        PATH: [...nativeDirs,process.env.PATH ?? ''].join(path.delimiter),
        ...(process.platform === 'linux' ? { LD_LIBRARY_PATH:[...nativeDirs,process.env.LD_LIBRARY_PATH ?? ''].join(':') } : {})
      },
      stdio: ['ignore','pipe','pipe']
    });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => child.kill(), 10000);
    child.stdout.on('data', chunk => { if (stdout.length < 262144) stdout += chunk; });
    child.stderr.on('data', chunk => { if (stderr.length < 8192) stderr += chunk; });
    child.on('error', error => { clearTimeout(timeout); resolve({ok:false,code:error.code,message:error.message}); });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout);
      const line = stdout.split(/\r?\n/).find(line => line.startsWith('QQBRIDGE_PROBE='));
      try { resolve(line ? { ...JSON.parse(line.slice('QQBRIDGE_PROBE='.length)), exitCode, signal, stderr } : {ok:false,exitCode,signal,message:'Module probe returned no parseable result',stderr}); }
      catch { resolve({ok:false,exitCode,signal,message:'Module probe returned no parseable result',stderr}); }
    });
  });
}

export async function probeNative(appDir) {
  const modulePath = path.resolve(appDir, 'wrapper.node');
  if (!existsSync(modulePath)) return {ok:false,code:'MODULE_MISSING',modulePath};
  let qqVersion = null;
  try { qqVersion = JSON.parse(readFileSync(path.join(appDir,'package.json'),'utf8')).version; } catch {}
  return { modulePath, qqVersion, bytes:statSync(modulePath).size, platform:process.platform, arch:process.arch, node:process.version, modules:process.versions.modules, napi:process.versions.napi, ...await inspectModule(modulePath) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const appDir = process.argv[2];
  if (!appDir) {
    process.stderr.write('Usage: node scripts/probe-native.mjs <QQ resources/app directory>\n');
    process.exitCode = 2;
  } else {
    const report = await probeNative(appDir);
    process.stdout.write(`${JSON.stringify(report,null,2)}\n`);
    if (!report.ok) process.exitCode = 1;
  }
}
