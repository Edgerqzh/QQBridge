import { WebSocket } from 'ws';

/** Run inside a compatible QQ host. A real driver must provide the QQ operations. */
export async function connectRuntime({ url, token, createDriver, handshakeTimeoutMs = 5000 }) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || endpoint.pathname !== '/bridge') throw new Error('Runtime IPC must use a loopback ws:// URL ending in /bridge');
  if (!token) throw new Error('Bridge token is required');
  let ws; let ready = false; let closed = false; let timer; let currentStatus = {};
  const send = (frame) => { if (ready && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame)); };
  const driver = await createDriver({
    emitEvent: (event) => send({ type: 'event', event }),
    emitStatus: (status) => { currentStatus = status; send({ type: 'status', status }); },
  });
  if (!driver || !Array.isArray(driver.actions) || typeof driver.start !== 'function' || typeof driver.call !== 'function' || typeof driver.stop !== 'function' || typeof driver.status !== 'function') throw new Error('Invalid QQ driver contract');
  let stopping;
  async function stop() {
    if (stopping) return stopping;
    closed = true; ready = false; clearTimeout(timer);
    stopping = Promise.resolve().then(() => driver.stop()).finally(() => ws?.terminate());
    return stopping;
  }
  try {
    await driver.start();
    currentStatus = driver.status();
    ws = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${token}` }, maxPayload: 24 * 1024 * 1024, perMessageDeflate: false });
    ws.on('error', () => {});
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Bridge handshake timed out')), handshakeTimeoutMs);
      const fail = () => reject(new Error('Bridge connection closed before ready'));
      ws.once('close', fail);
      ws.once('error', () => reject(new Error('Unable to connect to internal bridge')));
      ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: 1, actions: driver.actions, status: currentStatus })));
      ws.on('message', async (bytes, binary) => {
        let frame;
        try { if (binary) throw new Error(); frame = JSON.parse(bytes.toString()); } catch { ws.close(1007, 'Invalid JSON'); return; }
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
          ws.close(1008, 'Object required');
          if (!ready) reject(new Error('Invalid bridge frame'));
          return;
        }
        if (!ready) {
          if (frame.type !== 'ready' || frame.protocol !== 1) return reject(new Error('Unsupported bridge reply'));
          clearTimeout(timer); ready = true; ws.off('close', fail); resolve();
          send({ type: 'status', status: currentStatus });
          return;
        }
        if (closed || frame.type !== 'call' || typeof frame.id !== 'string') return;
        try {
          if (!driver.actions.includes(frame.action)) throw Object.assign(new Error('Unsupported native action'), { retcode: 1404 });
          const data = await driver.call(frame.action, frame.params ?? {});
          send({ type: 'result', id: frame.id, ok: true, data });
        } catch (err) {
          const exposed = Number.isInteger(err?.retcode) && err.retcode > 0;
          send({ type: 'result', id: frame.id, ok: false, error: { retcode: exposed ? err.retcode : 1500, message: exposed ? (err.publicMessage || err.message || 'Native action failed') : 'Native action failed' } });
        }
      });
    });
    ws.once('close', () => { stop().catch(() => {}); });
    return { stop, driver };
  } catch (err) { await stop().catch(() => {}); throw err; }
}
