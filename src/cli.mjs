import { readConfig, initializeConfig } from './config.mjs';
import { collectDiagnostics } from './doctor.mjs';
import { BridgeBackend } from './bridge-backend.mjs';
import { createGateway } from './gateway.mjs';
import { createReverseWebSocket } from './reverse-ws.mjs';

async function main() {
  const command = process.argv[2] || 'start';
  if (command === 'init') {
    await initializeConfig();
    console.log('Created .env with separate random API and bridge tokens. Existing files are never overwritten.');
    return;
  }
  if (command === 'doctor') {
    console.log(JSON.stringify(await collectDiagnostics(), null, 2));
    return;
  }
  if (command !== 'start') throw new Error('Usage: node src/cli.mjs start|init|doctor');
  const config = readConfig();
  const backend = new BridgeBackend({ token: config.bridgeToken, host: config.bridgeHost, port: config.bridgePort });
  const gateway = createGateway({ backend, token: config.token, host: config.host, port: config.port, appVersion: '0.2.0-dev.1' });
  const reverse = config.reverseUrl ? createReverseWebSocket({ backend, url: config.reverseUrl, token: config.reverseToken }) : null;
  try {
    await backend.start(); await gateway.start(); await reverse?.start();
  } catch (err) { await reverse?.close().catch(() => {}); await gateway.close().catch(() => {}); await backend.close().catch(() => {}); throw err; }
  console.log(`QQBridge API: http://${config.host}:${config.port}`);
  console.log(`OneBot WebSocket: ws://${config.host}:${config.port}/onebot/v11`);
  console.log('QQ native runtime: disconnected. QQ login and message delivery are not available until a verified driver is connected.');
  if (reverse) console.log('Reverse WebSocket enabled; waiting for a real QQ account identity.');
  backend.on('status', (status) => console.log(`QQ runtime: ${status.bridge_connected ? 'connected' : 'disconnected'}, QQ online: ${status.online}`));
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return; stopping = true;
    await reverse?.close(); await gateway.close(); await backend.close();
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown().catch(err => { console.error(err.message); process.exitCode = 1; }));
}

main().catch(err => {
  console.error(`QQBridge: ${err.code === 'EEXIST' ? '.env already exists; it was not overwritten.' : err.message}`);
  process.exitCode = 1;
});
