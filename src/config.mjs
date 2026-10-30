import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function port(value, fallback, name) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name} must be an integer from 1 to 65535`);
  return n;
}

export function readConfig(env = process.env) {
  const token = env.QQBRIDGE_TOKEN;
  const bridgeToken = env.QQBRIDGE_BRIDGE_TOKEN;
  for (const [name, value] of [['QQBRIDGE_TOKEN', token], ['QQBRIDGE_BRIDGE_TOKEN', bridgeToken]]) {
    if (typeof value !== 'string' || value.length < 32 || /replace-with|random-secret|[\r\n]/.test(value)) {
      throw new Error(`${name} is missing or insecure. Run npm run init first.`);
    }
  }
  if (token === bridgeToken) throw new Error('API and internal bridge must use different tokens');
  const config = {
    token, bridgeToken,
    host: env.QQBRIDGE_HOST || '127.0.0.1',
    port: port(env.QQBRIDGE_PORT, 5700, 'QQBRIDGE_PORT'),
    bridgeHost: env.QQBRIDGE_BRIDGE_HOST || '127.0.0.1',
    bridgePort: port(env.QQBRIDGE_BRIDGE_PORT, 5711, 'QQBRIDGE_BRIDGE_PORT'),
    driver: env.QQBRIDGE_DRIVER || '',
    reverseUrl: env.QQBRIDGE_REVERSE_WS_URL || '',
    reverseToken: env.QQBRIDGE_REVERSE_WS_TOKEN || '',
  };
  if (!['127.0.0.1', '::1', 'localhost'].includes(config.bridgeHost)) {
    throw new Error('The internal bridge must bind to loopback. Run native runtime and gateway in the same network namespace.');
  }
  if (config.port === config.bridgePort) throw new Error('API port and bridge port must differ');
  if (config.reverseUrl && (config.reverseToken.length < 32 || /[\r\n]/.test(config.reverseToken))) throw new Error('QQBRIDGE_REVERSE_WS_TOKEN must have at least 32 characters when reverse WebSocket is enabled');
  if (config.reverseUrl && [token, bridgeToken].includes(config.reverseToken)) throw new Error('Reverse WebSocket must use its own separate token');
  return config;
}

export async function initializeConfig(directory = process.cwd()) {
  const file = resolve(directory, '.env');
  const content = [
    '# Local secrets. Keep this file out of source control.',
    `QQBRIDGE_TOKEN=${randomBytes(32).toString('hex')}`,
    `QQBRIDGE_BRIDGE_TOKEN=${randomBytes(32).toString('hex')}`,
    'QQBRIDGE_HOST=127.0.0.1', 'QQBRIDGE_PORT=5700',
    'QQBRIDGE_BRIDGE_HOST=127.0.0.1', 'QQBRIDGE_BRIDGE_PORT=5711',
    'QQBRIDGE_DRIVER=', 'QQBRIDGE_QQ_APP=', 'QQBRIDGE_QQ_PROFILE=',
    'QQBRIDGE_LOGIN_UIN=', 'QQBRIDGE_ALLOWED_GROUPS=', 'QQBRIDGE_EXPERIMENTAL_RICH_MEDIA=0', 'QQBRIDGE_FORCE_QR=0', 'QQBRIDGE_FFMPEG_PATH=',
    'QQBRIDGE_REVERSE_WS_URL=', 'QQBRIDGE_REVERSE_WS_TOKEN=', '',
  ].join('\n');
  await writeFile(file, content, { flag: 'wx', mode: 0o600 });
  return file;
}
