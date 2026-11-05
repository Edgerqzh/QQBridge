import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createImageWorker } from '../src/native/image-worker-client.mjs';
import { createSelfCapabilities } from '../src/native/self-capabilities.mjs';
import { animatedAvatarGif as gif } from './fixtures/avatar-fixture.mjs';

const png = () => sharp({ create: { width: 32, height: 16, channels: 3, background: '#3388bb' } }).png().toBuffer();
async function worker(t) { const w = createImageWorker(); t.after(() => w.close()); return w; }
async function inspect(result) {
  const meta = await sharp(result.bytes).metadata();
  assert.ok(meta.width >= 1 && meta.height >= 1 && meta.width <= 1024 && meta.height <= 1024);
  assert.equal(meta.width, result.width); assert.equal(meta.height, result.height);
  assert.ok(!meta.pages || meta.pages === 1);
  assert.equal(result.extension, meta.format === 'jpeg' ? 'jpg' : 'png');
  await sharp(result.bytes).raw().toBuffer();
  return meta;
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}

test('all four supported opaque formats normalize to a single JPEG without enlarging small images', async t => {
  const w = await worker(t), input = await png();
  const formats = [input, await sharp(input).jpeg().toBuffer(), gif, await sharp(input).webp().toBuffer()];
  for (const bytes of formats) {
    const result = await w.prepareAvatar(bytes), meta = await inspect(result);
    assert.equal(meta.format, 'jpeg');
    assert.equal(meta.width, bytes === gif ? 1 : 32); assert.equal(meta.height, bytes === gif ? 1 : 16);
    assert.notDeepEqual(result.bytes, bytes);
  }
});

test('animated GIF and animated WebP decode only their first frame', async t => {
  const w = await worker(t);
  const webp = await sharp(gif, { animated: true }).webp({ lossless: true }).toBuffer();
  for (const bytes of [gif, webp]) {
    assert.equal((await sharp(bytes, { animated: true }).metadata()).pages, 2);
    const result = await w.prepareAvatar(bytes); await inspect(result);
    const rgb = await sharp(result.bytes).removeAlpha().raw().toBuffer();
    assert.ok(rgb[0] > 240 && rgb[1] < 15 && rgb[2] < 15, 'output should be the red first frame, not the blue second frame');
  }
});

test('actual transparency selects PNG while an opaque alpha channel still selects JPEG', async t => {
  const w = await worker(t);
  const transparent = await sharp(Buffer.from([255,0,0,0, 0,255,0,255]), { raw: { width: 2, height: 1, channels: 4 } }).png().toBuffer();
  for (const input of [transparent, await sharp(transparent).webp({ lossless: true }).toBuffer()]) {
    const result = await w.prepareAvatar(input); const meta = await inspect(result);
    assert.equal(meta.format, 'png'); assert.equal(meta.hasAlpha, true);
    const decoded = await sharp(result.bytes).ensureAlpha().raw().toBuffer();
    assert.equal(decoded[3], 0); assert.equal(decoded[7], 255);
  }
  const opaqueAlpha = await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 30, g: 100, b: 200, alpha: 1 } } }).png().toBuffer();
  assert.equal((await inspect(await w.prepareAvatar(opaqueAlpha))).format, 'jpeg');
});

test('large transparent output crosses the worker pipe above three MiB without truncation', async t => {
  const w = await worker(t);
  const input = await sharp(randomBytes(1024 * 1024 * 4), { raw: { width: 1024, height: 1024, channels: 4 } }).png({ compressionLevel: 0 }).toBuffer();
  const result = await w.prepareAvatar(input);
  assert.ok(result.bytes.length > 3 * 1024 * 1024);
  assert.equal((await inspect(result)).format, 'png');
  const decoded = await sharp(result.bytes).raw().toBuffer(), original = await sharp(input).raw().toBuffer();
  assert.deepEqual(decoded, original);
  assert.equal(w.status().active, 0);
});

test('large phone dimensions are accepted, auto-oriented and scaled proportionally to a 1024 long edge', async t => {
  const w = await worker(t);
  const input = await sharp({ create: { width: 5000, height: 2500, channels: 3, background: '#5588aa' } }).webp().toBuffer();
  const output = await w.prepareAvatar(input); const meta = await inspect(output);
  assert.equal(meta.width, 1024); assert.equal(meta.height, 512);
  const portrait = await sharp({ create: { width: 1600, height: 800, channels: 3, background: 'green' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const rotated = await inspect(await w.prepareAvatar(portrait));
  assert.equal(rotated.width, 512); assert.equal(rotated.height, 1024); assert.equal(rotated.orientation, undefined);
});

test('valid inputs larger than four MiB reach setHeader only as a normalized JPEG and temporary files are cleaned', async t => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'qqbridge-avatar-large-')); t.after(() => rm(profile, { recursive: true, force: true }));
  const input = await sharp(randomBytes(1500 * 1000 * 3), { raw: { width: 1500, height: 1000, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
  assert.ok(input.length > 4 * 1024 * 1024 && input.length <= 6 * 1024 * 1024);
  let count = 0, uploaded, filename;
  const actions = createSelfCapabilities({ profile, enableProfileActions: true, getContext: () => ({ check() {}, services: { session: { getProfileService: () => ({ async setHeader(file) { count++; filename = file; uploaded = await readFile(file); return { result: 0 }; } }) } } }) });
  t.after(() => actions.close());
  assert.deepEqual(await actions.call('set_qq_avatar', { file: 'base64://' + input.toString('base64') }), {});
  assert.equal(count, 1); assert.equal(path.extname(filename), '.jpg');
  const meta = await sharp(uploaded).metadata(); assert.equal(meta.format, 'jpeg'); assert.equal(meta.width, 1024); assert.equal(meta.height, 683);
  assert.notDeepEqual(input, uploaded); await assert.rejects(readFile(filename), { code: 'ENOENT' });
  assert.deepEqual(await readdir(path.join(profile, 'tmp', 'avatars')), []);
});

test('pixel bombs, disallowed formats, malformed images and inputs above six MiB never call setHeader', async t => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'qqbridge-avatar-reject-')); t.after(() => rm(profile, { recursive: true, force: true }));
  let count = 0;
  const actions = createSelfCapabilities({ profile, enableProfileActions: true, getContext: () => ({ check() {}, services: { session: { getProfileService: () => ({ setHeader() { count++; return { result: 0 }; } }) } } }) });
  t.after(() => actions.close());
  const input = await png(), bomb = Buffer.from(input); bomb.writeUInt32BE(10000, 16); bomb.writeUInt32BE(4001, 20); bomb.writeUInt32BE(crc32(bomb.subarray(12, 29)), 29);
  const tiff = await sharp(input).tiff().toBuffer();
  const jpeg = await sharp(input).jpeg().toBuffer(), webp = await sharp(input).webp().toBuffer();
  for (const bytes of [bomb, tiff, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'), Buffer.alloc(6 * 1024 * 1024 + 1), input.subarray(0, 28), jpeg.subarray(0, jpeg.length - 30), gif.subarray(0, 22), webp.subarray(0, 24)]) {
    await assert.rejects(actions.call('set_qq_avatar', { file: 'base64://' + bytes.toString('base64') }), e => e.retcode === 1400 && ['PNG', 'JPEG', 'GIF', 'WebP'].every(f => e.message.includes(f)));
  }
  assert.equal(count, 0);
});
