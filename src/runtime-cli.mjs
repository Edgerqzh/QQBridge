import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readConfig } from './config.mjs';
import { connectRuntime } from './runtime.mjs';

try {
  const config = readConfig();
  if (!config.driver) throw new Error('QQBRIDGE_DRIVER is not configured. For the experimental Linux QR driver use scripts/run-native-runtime.sh. Message APIs are not implemented yet.');
  const module = await import(pathToFileURL(resolve(config.driver)).href);
  const host = config.bridgeHost.includes(':') ? `[${config.bridgeHost}]` : config.bridgeHost;
  const runtime = await connectRuntime({ url: `ws://${host}:${config.bridgePort}/bridge`, token: config.bridgeToken, createDriver: module.createDriver });
  console.log('Native runtime connected. QQ online status is reported by the driver.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => runtime.stop().then(() => process.exit(0)));
} catch (err) { console.error(`QQBridge runtime: ${err.message}`); process.exitCode = 1; }
