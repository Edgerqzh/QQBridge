#!/usr/bin/env node
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.mjs';

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const children = new Map();
const startupAbort = new AbortController();
let stopping = false, stopPromise;

function stopChild(child, signal) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, signal); }
  catch { try { child.kill(signal); } catch {} }
}
function shutdown(reason, exitCode) {
  if (stopping) return stopPromise;
  stopping = true; startupAbort.abort(); process.exitCode = exitCode;
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
function launch(name, command, args) {
  if (stopping) throw new Error('Container is stopping.');
  const child = spawn(command, args, {
    cwd: directory, env: process.env, stdio: 'inherit', detached: true,
  });
  const closed = new Promise(resolve => {
    child.once('close', (code, signal) => {
      children.delete(name); resolve();
      if (!stopping) void shutdown(`${name} exited${signal ? ` (${signal})` : ''}`, Number.isInteger(code) && code !== 0 ? code : 1);
    });
  });
  children.set(name, { process: child, closed });
  child.once('error', () => { if (!stopping) void shutdown(`could not start ${name}`, 1); });
  return child;
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
    launch('native runtime', 'sh', ['scripts/run-native-runtime.sh']);
    console.log('Gateway and native runtime started. Waiting for QQ login; no messages are sent automatically.');
  }
} catch {
  await shutdown('startup failed; check configuration and native runtime logs', 1);
}
