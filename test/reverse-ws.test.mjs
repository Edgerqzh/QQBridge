import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { WebSocketServer } from 'ws';
import { createReverseWebSocket } from '../src/reverse-ws.mjs';

const TOKEN = 'reverse-test-token-not-a-real-credential';
class TestBackend extends EventEmitter {
  selfId = 12345678;
  calls = [];
  status() { return { self_id: this.selfId, online: this.selfId > 0, good: true }; }
  async call(action, params) { this.calls.push({ action, params }); return { message_id: 9988 }; }
  setIdentity(id) { this.selfId = id; this.emit('status', this.status()); }
}

function waitUntil(predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { clearInterval(interval); reject(new Error('condition did not become true')); }, timeoutMs);
    const interval = setInterval(() => { if (predicate()) { clearInterval(interval); clearTimeout(timeout); resolve(); } }, 5);
  });
}

async function setup(t, options = {}) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(wss, 'listening');
  const backend = new TestBackend();
  const connections = [];
  wss.on('connection', (client, request) => {
    const connection = { client, headers: request.headers, frames: [] };
    connections.push(connection);
    client.on('message', raw => connection.frames.push(JSON.parse(raw)));
  });
  const reverse = createReverseWebSocket({ backend, url: `ws://127.0.0.1:${wss.address().port}/onebot/v11`, token: TOKEN, reconnectMs: 30, heartbeatMs: 0, ...options });
  t.after(async () => {
    await reverse.close();
    for (const client of wss.clients) client.terminate();
    await new Promise(resolve => wss.close(resolve));
  });
  return { backend, wss, reverse, connections };
}

test('reverse connection requires explicit valid URL and rejects embedded credentials/fragments', () => {
  const backend = new TestBackend();
  for (const url of [undefined, '', 'http://localhost/', 'ws://name:secret@localhost/', 'ws://localhost/#secret']) {
    assert.throws(() => createReverseWebSocket({ backend, token: TOKEN, url }));
  }
});

test('waits for a real QQ identity, then supplies OneBot headers and lifecycle', async t => {
  const { backend, reverse, connections } = await setup(t);
  backend.selfId = 0;
  await reverse.start();
  assert.deepEqual(reverse.status(), { connected: false, waiting_for_identity: true });
  backend.setIdentity(34567890);
  await waitUntil(() => connections[0]?.frames.length > 0);
  assert.equal(connections.length, 1);
  assert.equal(connections[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(connections[0].headers['x-self-id'], '34567890');
  assert.equal(connections[0].headers['x-client-role'], 'Universal');
  assert.equal(connections[0].frames[0].meta_event_type, 'lifecycle');
  assert.equal(connections[0].frames[0].self_id, 34567890);
});

test('dispatches received actions with echo and forwards events/heartbeats', async t => {
  const { backend, reverse, connections } = await setup(t, { heartbeatMs: 40 });
  await reverse.start();
  await waitUntil(() => connections[0]?.frames.length > 0);
  const peer = connections[0];
  peer.client.send(JSON.stringify({ action: 'send_group_msg', params: { group_id: '23456789', message: 'test' }, echo: { id: 9 } }));
  await waitUntil(() => peer.frames.some(frame => frame.echo?.id === 9));
  const result = peer.frames.find(frame => frame.echo?.id === 9);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.data, { message_id: 9988 });
  assert.equal(backend.calls.length, 1);
  const event = { time: 20, self_id: backend.selfId, post_type: 'message', message_type: 'group', message_id: 91 };
  backend.emit('event', event);
  await waitUntil(() => peer.frames.some(frame => frame.message_id === 91));
  await waitUntil(() => peer.frames.some(frame => frame.meta_event_type === 'heartbeat'));
  const heartbeat = peer.frames.find(frame => frame.meta_event_type === 'heartbeat');
  assert.equal(heartbeat.self_id, backend.selfId);
  assert.equal(heartbeat.interval, 40);
});

test('reconnects without replaying disconnected events or retrying received actions', async t => {
  const { backend, reverse, connections } = await setup(t);
  await reverse.start();
  await waitUntil(() => connections[0]?.frames.length > 0);
  const first = connections[0];
  let complete;
  backend.call = async (action, params) => {
    backend.calls.push({ action, params });
    return new Promise(resolve => { complete = resolve; });
  };
  first.client.send(JSON.stringify({ action: 'send_group_msg', params: { message: 'one call only' }, echo: 'old-socket' }));
  await waitUntil(() => backend.calls.length === 1);
  const closed = once(first.client, 'close');
  first.client.terminate();
  await closed;
  backend.emit('event', { self_id: backend.selfId, post_type: 'message', message_id: 777 });
  await waitUntil(() => connections[1]?.frames.length > 0);
  complete({ message_id: 333 });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(backend.calls.length, 1);
  assert.ok(!connections[1].frames.some(frame => frame.echo === 'old-socket' || frame.message_id === 777));
});

test('identity change closes the old peer before replacement and updates headers', async t => {
  const { backend, reverse, connections, wss } = await setup(t);
  let peak = 0;
  wss.on('connection', () => { peak = Math.max(peak, wss.clients.size); });
  await reverse.start();
  await waitUntil(() => connections[0]?.frames.length > 0);
  backend.setIdentity(87654321);
  await waitUntil(() => connections[1]?.frames.length > 0);
  assert.equal(connections[1].headers['x-self-id'], '87654321');
  assert.equal(connections[1].frames[0].self_id, 87654321);
  assert.equal(peak, 1);
  backend.setIdentity(0);
  await waitUntil(() => wss.clients.size === 0);
  assert.equal(reverse.status().waiting_for_identity, true);
});

test('oversized outbound event drops the connection instead of buffering without limit', async t => {
  const { backend, reverse, connections } = await setup(t, { maxBufferedBytes: 512 });
  await reverse.start();
  await waitUntil(() => connections[0]?.frames.length > 0);
  const closed = once(connections[0].client, 'close');
  backend.emit('event', { self_id: backend.selfId, post_type: 'message', message: 'x'.repeat(1024) });
  await closed;
  assert.ok(!connections[0].frames.some(frame => frame.message));
});

test('close removes subscriptions and prevents reconnect', async t => {
  const { backend, reverse, connections } = await setup(t);
  await reverse.start();
  await waitUntil(() => connections[0]?.frames.length > 0);
  await reverse.close();
  assert.equal(backend.listenerCount('event'), 0);
  assert.equal(backend.listenerCount('status'), 0);
  backend.setIdentity(98765432);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(connections.length, 1);
  await assert.rejects(reverse.start(), /closed/);
});
