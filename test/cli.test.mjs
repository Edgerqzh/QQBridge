import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('CLI starts the real gateway and exposes truthful offline status', async t => {
  const port = await freePort(); let bridgePort = await freePort();
  while (bridgePort === port) bridgePort = await freePort();
  const token = 'cli-test-api-token-'.padEnd(40, 'x');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), 'start'], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, QQBRIDGE_TOKEN: token, QQBRIDGE_BRIDGE_TOKEN: 'cli-test-bridge-token-'.padEnd(40, 'y'),
      QQBRIDGE_HOST: '127.0.0.1', QQBRIDGE_PORT: String(port), QQBRIDGE_BRIDGE_HOST: '127.0.0.1', QQBRIDGE_BRIDGE_PORT: String(bridgePort),
      QQBRIDGE_REVERSE_WS_URL: '', QQBRIDGE_REVERSE_WS_TOKEN: '', QQBRIDGE_DRIVER: '',
    },
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'close'); child.kill(); await done; }
  });
  let logs = '';
  child.stderr.on('data', chunk => { logs += chunk.toString(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CLI failed to start promptly')), 5000);
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`CLI exited before ready: ${code}`)); });
    child.stdout.on('data', chunk => {
      logs += chunk.toString();
      if (logs.includes('QQ native runtime: disconnected')) { clearTimeout(timer); resolve(); }
    });
  });
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal((await health.json()).online, false);
  const status = await fetch(`http://127.0.0.1:${port}/get_status`, { headers: { Authorization: `Bearer ${token}` } });
  assert.deepEqual((await status.json()).data, { online: false, good: false });
  const failedSend = await fetch(`http://127.0.0.1:${port}/send_group_msg`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ group_id: 10001, message: 'offline test; must not send' }),
  });
  const result = await failedSend.json();
  assert.equal(result.status, 'failed'); assert.equal(result.retcode, 1503);
  assert.ok(!logs.includes(token));
});
