import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageWorker } from '../src/native/image-worker-client.mjs';
import { imageInfo } from '../src/native/media.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==','base64');
test('isolated image work enforces concurrency, generates JPEG thumbnails and closes cleanly', async t => {
  const worker = createImageWorker({ maxJobs: 1 }); t.after(() => worker.close());
  const first = worker.prepare(png);
  await assert.rejects(worker.prepare(png), { retcode: 1503 });
  const thumbnails = await first;
  assert.deepEqual([...thumbnails.keys()], [198,720]);
  for (const bytes of thumbnails.values()) assert.deepEqual(imageInfo(bytes), { extension: 'jpg', type: 1000, height: 1, width: 1 });
  assert.equal(worker.status().active, 0);
  worker.close(); await assert.rejects(worker.prepare(png), { retcode: 1503 });
});
test('image decoding failures release worker slots for a later valid image', async t => {
  const worker = createImageWorker({ maxJobs: 1 }); t.after(() => worker.close());
  for (let i = 0; i < 3; i++) {
    await assert.rejects(worker.prepare(Buffer.from('invalid image')), { retcode: 1503 });
    assert.equal(worker.status().active, 0);
  }
  assert.equal((await worker.prepare(png)).size, 2);
  const active = worker.prepare(png); worker.close();
  await assert.rejects(active, { retcode: 1503 });
  assert.equal(worker.status().active, 0);
});
