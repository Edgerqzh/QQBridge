import test from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { createGateway } from '../src/gateway.mjs';

const TOKEN = 'integration-test-token-not-a-real-credential';
class TestBackend extends EventEmitter {
  online = true;
  calls = [];
  status() { return { online: this.online, good: true, secret: 'do-not-expose' }; }
  async call(action, params) {
    this.calls.push({ action, params });
    if (action === 'send_group_msg') return { message_id: 12345 };
    if (action === 'hang') return new Promise(() => {});
    if (action === 'explode') throw new Error('SECRET INTERNAL PATH');
    const error = new Error('unsupported action');
    error.retcode = 1404;
    throw error;
  }
}

async function setup(t, options = {}) {
  const backend = new TestBackend();
  const gateway = createGateway({ backend, token: TOKEN, heartbeatMs: 0, ...options });
  const address = await gateway.start();
  t.after(() => gateway.close());
  const base = `http://127.0.0.1:${address.port}`;
  const api = (path, init = {}) => fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...init.headers },
  });
  const connect = async (path = '/onebot/v11') => {
    const client = new WebSocket(`ws://127.0.0.1:${address.port}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    t.after(() => client.terminate());
    await once(client, 'open');
    return client;
  };
  return { backend, gateway, address, base, api, connect };
}

test('HTTP requires the exact bearer credential; health contains no backend secrets', async t => {
  const { base } = await setup(t);
  const missing = await fetch(`${base}/get_status`);
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get('www-authenticate'), 'Bearer');
  const wrong = await fetch(`${base}/get_status`, { headers: { Authorization: 'Bearer wrong' } });
  assert.equal(wrong.status, 401);
  const health = await fetch(`${base}/health`).then(r => r.json());
  assert.deepEqual(health, { service: 'QQBridge', online: true, good: true });
  assert.ok(!JSON.stringify(health).includes('do-not-expose'));
});

test('HTTP exposes version/status and dispatches JSON to the real backend contract', async t => {
  const { api, backend } = await setup(t);
  const version = await api('/get_version_info').then(r => r.json());
  assert.equal(version.data.protocol_version, 'v11');
  assert.equal(version.retcode, 0);
  const params = { group_id: '12345678', message: [{ type: 'text', data: { text: 'test' } }] };
  const result = await api('/send_group_msg', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) }).then(r => r.json());
  assert.deepEqual(result, { status: 'ok', retcode: 0, data: { message_id: 12345 } });
  assert.deepEqual(backend.calls, [{ action: 'send_group_msg', params }]);
  const root = await api('/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'get_status', echo: { request: 8 } }) }).then(r => r.json());
  assert.deepEqual(root.echo, { request: 8 });
  assert.deepEqual(root.data, { online: true, good: true });
});

test('offline QQ never reports a successful send or calls the transport', async t => {
  const { api, backend } = await setup(t);
  backend.online = false;
  const result = await api('/send_group_msg', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ group_id: '12345678', message: 'test' }) }).then(r => r.json());
  assert.equal(result.status, 'failed');
  assert.equal(result.retcode, 1503);
  assert.equal(result.data, null);
  assert.equal(backend.calls.length, 0);
  const status = await api('/get_status').then(r => r.json());
  assert.equal(status.data.online, false);
});

test('HTTP rejects oversized bodies, malformed JSON, array params, and unsupported methods', async t => {
  const { api, backend } = await setup(t, { maxBodyBytes: 96 });
  const oversize = await api('/send_group_msg', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'a'.repeat(128) }) });
  assert.equal(oversize.status, 413);
  const invalid = await api('/send_group_msg', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(invalid.status, 400);
  const array = await api('/send_group_msg', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[]' }).then(r => r.json());
  assert.equal(array.retcode, 1400);
  const nullParams = await api('/send_group_msg', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'null' }).then(r => r.json());
  assert.equal(nullParams.retcode, 1400);
  const method = await api('/get_status', { method: 'DELETE' });
  assert.equal(method.status, 405);
  const content = await api('/send_group_msg', { method: 'POST', body: '{}' });
  assert.equal(content.status, 415);
  assert.equal(backend.calls.length, 0);
});

test('backend errors are sanitized, domain errors retained, and timeout reports uncertain delivery', async t => {
  const { api } = await setup(t, { requestTimeoutMs: 100 });
  const unknown = await api('/unknown').then(r => r.json());
  assert.equal(unknown.retcode, 1404);
  assert.equal(unknown.message, 'unsupported action');
  const internal = await api('/explode').then(r => r.json());
  assert.equal(internal.retcode, 1500);
  assert.ok(!JSON.stringify(internal).includes('SECRET'));
  const timeout = await api('/hang').then(r => r.json());
  assert.equal(timeout.retcode, 1504);
  assert.match(timeout.message, /outcome is unknown/);
});

test('WebSocket authenticates before upgrade', async t => {
  const { address } = await setup(t);
  const client = new WebSocket(`ws://127.0.0.1:${address.port}/onebot/v11`);
  const error = await new Promise(resolve => {
    client.once('error', resolve);
    client.once('unexpected-response', (_, response) => {
      assert.equal(response.statusCode, 401);
      response.resume();
      client.terminate();
    });
  });
  assert.ok(error);
});

test('WebSocket preserves echo, pushes backend events, and survives malformed frames', async t => {
  const { backend, connect } = await setup(t);
  const client = await connect();
  let next = once(client, 'message');
  client.send(JSON.stringify({ action: 'send_group_msg', params: { group_id: '12345678', message: 'test' }, echo: 'request-42' }));
  let [raw] = await next;
  assert.deepEqual(JSON.parse(raw), { status: 'ok', retcode: 0, data: { message_id: 12345 }, echo: 'request-42' });
  const event = { time: 1, self_id: 123, post_type: 'message', message_type: 'group', group_id: 456, message: [{ type: 'text', data: { text: 'hello' } }] };
  next = once(client, 'message');
  backend.emit('event', event);
  [raw] = await next;
  assert.deepEqual(JSON.parse(raw), event);
  next = once(client, 'message');
  client.send('{invalid');
  [raw] = await next;
  assert.equal(JSON.parse(raw).retcode, 1400);
  next = once(client, 'message');
  client.send(JSON.stringify({ action: 'get_status', echo: 0 }));
  [raw] = await next;
  assert.equal(JSON.parse(raw).echo, 0);
  assert.equal(JSON.parse(raw).status, 'ok');
});

test('gateway shutdown closes sockets and removes the backend event listener', async t => {
  const { backend, gateway, connect } = await setup(t);
  const client = await connect();
  const disconnected = once(client, 'close');
  await gateway.close();
  await disconnected;
  assert.equal(backend.listenerCount('event'), 0);
  await assert.rejects(gateway.start(), /closed/);
});

test('standard WebSocket paths isolate API traffic from events', async t => {
  const { backend, connect } = await setup(t);
  const apiOnly = await connect('/api/');
  const eventsOnly = await connect('/event');
  const combined = await connect('/');
  const apiFrames = [];
  apiOnly.on('message', raw => apiFrames.push(JSON.parse(raw)));
  const event = { time: 10, self_id: 123, post_type: 'notice', notice_type: 'group_increase' };
  let eventFrame = once(eventsOnly, 'message');
  let combinedFrame = once(combined, 'message');
  backend.emit('event', event);
  assert.deepEqual(JSON.parse((await eventFrame)[0]), event);
  assert.deepEqual(JSON.parse((await combinedFrame)[0]), event);
  const apiFrame = once(apiOnly, 'message');
  apiOnly.send(JSON.stringify({ action: 'get_status', echo: 'api-only' }));
  assert.equal(JSON.parse((await apiFrame)[0]).echo, 'api-only');
  assert.equal(apiFrames.length, 1);
  assert.equal(apiFrames[0].status, 'ok');
  combinedFrame = once(combined, 'message');
  combined.send(JSON.stringify({ action: 'get_status', echo: 'combined' }));
  assert.equal(JSON.parse((await combinedFrame)[0]).echo, 'combined');
});

test('known QQ identity is included in lifecycle and heartbeat events', async t => {
  const { backend, address } = await setup(t, { heartbeatMs: 30 });
  backend.status = () => ({ online: true, good: true, self_id: '12345678' });
  const client = new WebSocket(`ws://127.0.0.1:${address.port}/event`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  t.after(() => client.terminate());
  const frames = [];
  const completed = new Promise(resolve => client.on('message', raw => {
    const frame = JSON.parse(raw);
    frames.push(frame);
    if (frame.meta_event_type === 'heartbeat') resolve();
  }));
  await completed;
  assert.equal(frames[0].meta_event_type, 'lifecycle');
  assert.equal(frames[0].sub_type, 'connect');
  assert.equal(frames[0].self_id, 12345678);
  const heartbeat = frames.find(frame => frame.meta_event_type === 'heartbeat');
  assert.equal(heartbeat.self_id, 12345678);
  assert.equal(heartbeat.interval, 30);
  assert.deepEqual(heartbeat.status, { online: true, good: true });
});
