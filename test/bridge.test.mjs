import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { BridgeBackend } from '../src/bridge-backend.mjs';
import { connectRuntime } from '../src/runtime.mjs';

const token = 'test-only-internal-bridge-token-123456789';
async function setup(t, options = {}) {
  const backend = new BridgeBackend({ token, port: 0, heartbeatMs: 10000, ...options });
  await backend.start();
  t.after(() => backend.close());
  return { backend, url: `ws://127.0.0.1:${backend.address().port}/bridge` };
}

test('native recovery requests stop one worker once and preserve the gateway for reconnection', async t => {
  const {backend,url}=await setup(t);let callbacks,stops=0;const requests=[];
  const createDriver=async cb=>{callbacks=cb;return {actions:['get_login_info'],start:async()=>{},stop:async()=>{stops++;},status:()=>({online:true,good:true,self_id:12345}),call:async()=>({user_id:12345})};};
  const runtime=await connectRuntime({url,token,createDriver,onRestart:r=>requests.push(r)});t.after(()=>runtime.stop());
  callbacks.requestRestart({mode:'automatic',reason:'msf_disconnected'});callbacks.requestRestart({mode:'automatic'});
  const deadline=Date.now()+1000;while(!requests.length&&Date.now()<deadline)await new Promise(r=>setTimeout(r,2));
  assert.equal(stops,1);assert.equal(requests.length,1);
  const closeDeadline=Date.now()+1000;while(backend.status().bridge_connected&&Date.now()<closeDeadline)await new Promise(r=>setTimeout(r,2));
  assert.equal(backend.status().bridge_connected,false);
  const next=await connectRuntime({url,token,createDriver});t.after(()=>next.stop());assert.equal((await backend.call('get_login_info')).user_id,12345);
});

test('media-sized payloads cross IPC in both directions without the old one MiB cutoff', async t => {
  const { backend, url } = await setup(t);
  const runtime = await connectRuntime({ url, token, createDriver: async () => ({
    actions: ['fixture_media'], start: async () => {}, stop: async () => {},
    status: () => ({ online: true, good: true, self_id: 12345 }),
    call: async (_action, params) => ({ base64: params.base64 }),
  }) });
  t.after(() => runtime.stop());
  const base64 = Buffer.alloc(1024 * 1024, 42).toString('base64');
  assert.equal((await backend.call('fixture_media', { base64 })).base64, base64);
});

test('disconnected bridge refuses actions instead of inventing QQ results', async t => {
  const { backend } = await setup(t);
  assert.deepEqual(backend.status(), { online: false, good: false, self_id: 0, nickname: '', bridge_connected: false, capabilities: [] });
  await assert.rejects(backend.call('send_group_msg', {}), { retcode: 1503 });
});

test('internal bridge rejects missing authentication and browser origin', async t => {
  const { url } = await setup(t);
  for (const headers of [{}, { Authorization: `Bearer ${token}`, Origin: 'https://example.com' }]) {
    const ws = new WebSocket(url, { headers });
    ws.on('error', () => {});
    const [, res] = await once(ws, 'unexpected-response');
    assert.equal(res.statusCode, 401);
    ws.terminate();
  }
});

test('null native status resets offline and cannot crash the gateway', async t => {
  const { backend, url } = await setup(t);
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  t.after(() => ws.terminate());
  await once(ws, 'open');
  const ready = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'hello', protocol: 1, actions: [], status: null }));
  await ready;
  assert.equal(backend.status().online, false);
  const changed = once(backend, 'status');
  ws.send(JSON.stringify({ type: 'status', status: null })); await changed;
  assert.equal(backend.status().online, false);
});

test('runtime handles a null IPC frame and stops its driver', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  server.on('connection', ws => ws.once('message', () => ws.send('null')));
  let stopped = false;
  await assert.rejects(connectRuntime({
    url: `ws://127.0.0.1:${server.address().port}/bridge`, token,
    createDriver: async () => ({ actions: [], start: async () => {}, stop: async () => { stopped = true; }, call: async () => {}, status: () => ({}) }),
  }), /Invalid bridge frame/);
  assert.equal(stopped, true);
});

test('runtime roundtrip preserves result, native failure and live event identity', async t => {
  const { backend, url } = await setup(t);
  let callbacks; let stopped = false;
  const runtime = await connectRuntime({ url, token, createDriver: async cb => {
    callbacks = cb;
    return {
      actions: ['get_login_info', 'send_group_msg'],
      start: async () => {}, stop: async () => { stopped = true; },
      status: () => ({ online: true, good: true, self_id: 12345 }),
      call: async (action, params) => {
        if (action === 'get_login_info') return { user_id: 12345, nickname: 'test account fixture' };
        throw Object.assign(new Error(`Rejected fixture group ${params.group_id}`), { retcode: 1400 });
      },
    };
  } });
  t.after(() => runtime.stop());
  assert.equal(backend.status().online, true);
  assert.equal((await backend.call('get_login_info')).user_id, 12345);
  await assert.rejects(backend.call('send_group_msg', { group_id: 555 }), { retcode: 1400 });
  await assert.rejects(backend.call('get_friend_list'), { retcode: 1404 });
  const event = { post_type: 'message', message_type: 'group', self_id: 12345, time: 100, message: [{ type: 'text', data: { text: 'fixture' } }] };
  const received = once(backend, 'event'); callbacks.emitEvent(event);
  assert.deepEqual((await received)[0], event);
  const disconnected = once(backend, 'status'); await runtime.stop(); await disconnected;
  assert.equal(stopped, true); assert.equal(backend.status().online, false);
});

test('native disconnect rejects an in-flight send and never retries it', async t => {
  const { backend, url } = await setup(t);
  let called;
  const calledPromise = new Promise(resolve => { called = resolve; });
  let count = 0;
  const runtime = await connectRuntime({ url, token, createDriver: async () => ({
    actions: ['send_group_msg'], start: async () => {}, stop: async () => {},
    status: () => ({ online: true, good: true, self_id: 12345 }),
    call: async () => { count++; called(); return new Promise(() => {}); },
  }) });
  const pending = assert.rejects(backend.call('send_group_msg', { group_id: 123 }), /disconnected.*unknown/i);
  await calledPromise; await runtime.stop(); await pending;
  assert.equal(count, 1); assert.equal(backend.pending.size, 0);
});

test('native timeout removes pending work without claiming delivery failure or retrying', async t => {
  const { backend, url } = await setup(t, { callTimeoutMs: 30 });
  const runtime = await connectRuntime({ url, token, createDriver: async () => ({
    actions: ['send_group_msg'], start: async () => {}, stop: async () => {},
    status: () => ({ online: true, good: true, self_id: 12345 }), call: async () => new Promise(() => {}),
  }) });
  t.after(() => runtime.stop());
  await assert.rejects(backend.call('send_group_msg'), { retcode: 1504 });
  assert.equal(backend.pending.size, 0);
});
