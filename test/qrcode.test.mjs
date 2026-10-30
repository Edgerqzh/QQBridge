import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const TOKEN = 'qrcode-test-only-credential-not-a-real-secret';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

async function fixture(t, handler) {
  const directory = await mkdtemp(path.join(tmpdir(), 'qqbridge-qr-'));
  await mkdir(path.join(directory, 'scripts'));
  const script = path.join(directory, 'scripts', 'get-qrcode.mjs');
  await copyFile(fileURLToPath(new URL('../scripts/get-qrcode.mjs', import.meta.url)), script);
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const run = () => execFileAsync(process.execPath, [script], {
    env: { ...process.env, QQBRIDGE_HOST: '127.0.0.1', QQBRIDGE_PORT: String(server.address().port), QQBRIDGE_TOKEN: TOKEN },
    timeout: 19000,
  });
  return { directory, output: path.join(directory, 'data', 'login-qr.png'), run };
}

test('qrcode CLI authenticates, saves a verified PNG and keeps credentials out of output', async t => {
  let request;
  const { output, run } = await fixture(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    request = { method: req.method, url: req.url, authorization: req.headers.authorization, body };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { image_base64: PNG.toString('base64') } }));
  });
  const { stdout, stderr } = await run();
  assert.deepEqual(request, { method: 'POST', url: '/get_login_qrcode', authorization: `Bearer ${TOKEN}`, body: '{}' });
  assert.deepEqual(await readFile(output), PNG);
  assert.ok(stdout.includes(output));
  assert.equal(stderr, '');
  assert.ok(!stdout.includes(TOKEN));
  assert.ok(!stdout.includes(PNG.toString('base64')));
});

test('qrcode CLI preserves an existing image on native failure or invalid PNG', async t => {
  let payload = { status: 'failed', retcode: 1503, data: null };
  const { directory, output, run } = await fixture(t, (_req, res) => {
    res.writeHead(payload.retcode === 1503 ? 503 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await mkdir(path.join(directory, 'data'));
  await writeFile(output, PNG);
  for (const value of [null, 'bm90IGFuIGltYWdl', PNG.toString('base64').slice(0, -1), 'AAAA'.repeat(400000)]) {
    payload = value === null ? { status: 'failed', retcode: 1503, data: null } : { status: 'ok', retcode: 0, data: { image_base64: value } };
    await assert.rejects(run(), error => {
      assert.equal(error.code, 1);
      assert.ok(!error.stderr.includes(TOKEN));
      return true;
    });
    assert.deepEqual(await readFile(output), PNG);
  }
});
