#!/usr/bin/env node
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.mjs';
import { createRestartBudget } from '../src/native/recovery.mjs';

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const children = new Map();
const startupAbort = new AbortController();
let stopping = false, stopPromise;
let retryTimer;
const restartBudget = createRestartBudget();

function stopChild(child, signal) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, signal); }
  catch { try { child.kill(signal); } catch {} }
}
function shutdown(reason, exitCode) {
  if (stopping) return stopPromise;
  stopping = true; clearTimeout(retryTimer); startupAbort.abort(); process.exitCode = exitCode;
  console.log(`QQBridge container stopping: ${reason}`);
  stopPromise = (async () => {
    const active = [...children.values()];
    for (const entry of active) stopChild(entry.process, 'SIGTERM');
    const force = setTimeout(() => { for (const entry of active) stopChild(entry.process, 'SIGKILL'); }, 5000);
    try { await Promise.all(active.map(entry => entry.closed)); }
    finally { clearTimeout(force); }
  })();
  return stopPromise;
}
function launch(name, command, args, environment = process.env) {
  if (stopping) throw new Error('Container is stopping.');
  const child = spawn(command, args, {
    cwd: directory, env: environment, stdio: 'inherit', detached: true,
  });
  const closed = new Promise(resolve => {
    child.once('close', (code, signal) => {
      children.delete(name); resolve();
      if (!stopping && name === 'native runtime') {
        // Once a fresh-QR fallback worker itself fails, keep the gateway alive
        // and offline. Exiting the container would reset this restart budget.
        if (environment.QQBRIDGE_RECOVERY_MANUAL && code !== 75) {
          console.log('Native recovery stopped; check configuration and restart the service.');
          return;
        }
        const next = code === 76 ? { manual: true, delayMs: 0 } : restartBudget.next();
        console.log(next.manual ? 'Native recovery requires a fresh QR login.' : `Native recovery scheduled in ${next.delayMs} ms.`);
        retryTimer = setTimeout(() => { if (!stopping) launchNative(next.manual, code === 76 ? 'authentication_required' : next.manual ? 'retry_limit' : ''); }, next.delayMs);
        return;
      }
      if (!stopping) void shutdown(`${name} exited${signal ? ` (${signal})` : ''}`, Number.isInteger(code) && code !== 0 ? code : 1);
    });
  });
  children.set(name, { process: child, closed });
  child.once('error', () => { if (!stopping) void shutdown(`could not start ${name}`, 1); });
  return child;
}
function launchNative(manual = false, reason = '') {
  const environment = manual ? { ...process.env, QQBRIDGE_FORCE_QR: '1', QQBRIDGE_LOGIN_UIN: '', QQBRIDGE_RECOVERY_MANUAL: reason } : process.env;
  return launch('native runtime', 'sh', ['scripts/run-native-runtime.sh'], environment);
}
async function waitForBridge(host, port, signal) {
  const deadline = Date.now() + 10000;
  while (!signal.aborted && Date.now() < deadline) {
    const connected = await new Promise(resolve => {
      const socket = net.createConnection({ host, port });
      let finished = false;
      const finish = value => { if (finished) return; finished = true; signal.removeEventListener('abort', abort); socket.destroy(); resolve(value); };
      const abort = () => finish(false);
      socket.setTimeout(400, () => finish(false));
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    if (connected) return;
    if (signal.aborted) break;
    await new Promise(resolve => {
      const timer = setTimeout(done, 100);
      function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
      signal.addEventListener('abort', done, { once: true });
    });
  }
  throw new Error('Internal gateway did not become ready.');
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void shutdown(signal, 0); });

try {
  if (process.platform !== 'linux') throw new Error('The native container supervisor requires Linux.');
  const config = readConfig();
  launch('gateway', process.execPath, ['src/cli.mjs', 'start']);
  await waitForBridge(config.bridgeHost, config.bridgePort, startupAbort.signal);
  if (!stopping) {
    launchNative();
    console.log('Gateway and native runtime started. Waiting for QQ login; no messages are sent automatically.');
  }
} catch {
  await shutdown('startup failed; check configuration and native runtime logs', 1);
}
