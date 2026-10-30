import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { readConfig, initializeConfig } from '../src/config.mjs';

test('init generates separate secrets and refuses to overwrite them', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'qqbridge-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = await initializeConfig(dir); const initial = await readFile(file, 'utf8');
  const config = readConfig(parseEnv(initial));
  assert.equal(config.token.length, 64); assert.notEqual(config.token, config.bridgeToken);
  await assert.rejects(initializeConfig(dir), { code: 'EEXIST' });
  assert.equal(await readFile(file, 'utf8'), initial);
});

test('config rejects insecure defaults, invalid ports and exposed IPC', () => {
  const env = { QQBRIDGE_TOKEN: 'a'.repeat(40), QQBRIDGE_BRIDGE_TOKEN: 'b'.repeat(40) };
  assert.throws(() => readConfig({}), /missing/);
  assert.throws(() => readConfig({ ...env, QQBRIDGE_BRIDGE_TOKEN: env.QQBRIDGE_TOKEN }), /different/);
  assert.throws(() => readConfig({ ...env, QQBRIDGE_PORT: '5700.1' }), /integer/);
  assert.throws(() => readConfig({ ...env, QQBRIDGE_BRIDGE_HOST: '0.0.0.0' }), /loopback/);
  assert.equal(readConfig(env).host, '127.0.0.1');
  assert.throws(() => readConfig({ ...env, QQBRIDGE_REVERSE_WS_URL: 'ws://localhost:8080/' }), /at least 32/);
  assert.throws(() => readConfig({ ...env, QQBRIDGE_REVERSE_WS_URL: 'ws://localhost:8080/', QQBRIDGE_REVERSE_WS_TOKEN: env.QQBRIDGE_TOKEN }), /separate/);
});
