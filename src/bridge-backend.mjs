import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

function error(message, retcode = 1503) { return Object.assign(new Error(message), { retcode }); }
function authorized(header, token) {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header || '');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function normalizeStatus(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) value = {};
  const selfId = Number.isSafeInteger(value.self_id) && value.self_id > 0 ? value.self_id : 0;
  const online = value.online === true && selfId > 0;
  return {
    online,
    good: online && value.good === true,
    self_id: selfId,
    nickname: typeof value.nickname === 'string' ? value.nickname.slice(0, 256) : '',
  };
}

/** Authenticated IPC between a QQ-hosted runtime and the public OneBot gateway. */
export class BridgeBackend extends EventEmitter {
  constructor({ token, host = '127.0.0.1', port = 5711, callTimeoutMs = 15000, handshakeTimeoutMs = 5000, heartbeatMs = 15000, maxPending = 256 }) {
    super();
    if (typeof token !== 'string' || !token) throw new Error('Bridge token is required');
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('Bridge must bind to loopback');
    Object.assign(this, { token, host, port, callTimeoutMs, handshakeTimeoutMs, heartbeatMs, maxPending });
    this.peer = null; this.pending = new Map(); this.actions = new Set(); this.state = normalizeStatus();
    this.server = createServer((_req, res) => { res.writeHead(404); res.end(); });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 24 * 1024 * 1024, perMessageDeflate: false });
    this.server.on('upgrade', (req, socket, head) => {
      if (req.url !== '/bridge' || req.headers.origin || !authorized(req.headers.authorization, this.token)) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
      }
      if (this.peer) { socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws));
    });
  }
  status() { return { ...this.state, bridge_connected: Boolean(this.peer?.ready), capabilities: [...this.actions] }; }
  attach(ws) {
    const peer = { ws, ready: false, alive: true };
    this.peer = peer;
    const handshake = setTimeout(() => ws.terminate(), this.handshakeTimeoutMs);
    handshake.unref();
    ws.on('error', () => {});
    ws.on('pong', () => { peer.alive = true; });
    ws.on('message', (bytes, binary) => {
      if (binary) return ws.close(1003, 'JSON text required');
      let frame;
      try { frame = JSON.parse(bytes.toString()); } catch { return ws.close(1007, 'Invalid JSON'); }
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return ws.close(1008, 'Object required');
      if (!peer.ready) {
        if (frame.type !== 'hello' || frame.protocol !== 1 || !Array.isArray(frame.actions) || frame.actions.length > 512 || frame.actions.some(a => typeof a !== 'string' || !/^[a-z][a-z0-9_]{0,95}$/.test(a))) {
          return ws.close(1008, 'Unsupported bridge handshake');
        }
        clearTimeout(handshake); peer.ready = true;
        this.actions = new Set(frame.actions); this.updateStatus(frame.status);
        ws.send(JSON.stringify({ type: 'ready', protocol: 1 }));
        return;
      }
      if (frame.type === 'status') { this.updateStatus(frame.status); return; }
      if (frame.type === 'result') {
        const pending = this.pending.get(frame.id);
        if (!pending) return;
        this.pending.delete(frame.id); clearTimeout(pending.timer);
        if (frame.ok === true) pending.resolve(frame.data ?? null);
        else pending.reject(error(typeof frame.error?.message === 'string' ? frame.error.message : 'Native runtime action failed', Number.isInteger(frame.error?.retcode) && frame.error.retcode !== 0 ? frame.error.retcode : 1500));
        return;
      }
      if (frame.type === 'event' && this.state.online) {
        const event = frame.event;
        if (event && typeof event === 'object' && !Array.isArray(event) && ['message', 'message_sent', 'notice', 'request'].includes(event.post_type) && Number.isFinite(event.time) && event.self_id === this.state.self_id && event.self_id > 0) {
          this.emit('event', event);
        }
      }
    });
    ws.on('close', () => {
      clearTimeout(handshake);
      if (this.peer !== peer) return;
      this.peer = null; this.actions.clear(); this.updateStatus({});
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error('Native runtime disconnected; delivery may be unknown. Do not automatically resend.')); }
      this.pending.clear();
    });
  }
  updateStatus(status) { this.state = normalizeStatus(status); this.emit('status', this.status()); }
  async call(action, params = {}) {
    if (!this.peer?.ready || this.peer.ws.readyState !== WebSocket.OPEN) throw error('QQ native runtime is not connected');
    if (!this.actions.has(action)) throw error(`Native runtime does not implement ${action}`, 1404);
    if (this.pending.size >= this.maxPending) throw error('Too many pending native calls', 1429);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(error('Native action timed out; delivery may be unknown. Do not automatically resend.', 1504));
      }, this.callTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.peer.ws.send(JSON.stringify({ type: 'call', id, action, params }), (err) => {
        if (!err) return;
        clearTimeout(timer); this.pending.delete(id); reject(error('Failed to send native action'));
      });
    });
  }
  async start() {
    await new Promise((resolve, reject) => {
      const fail = (err) => { this.server.off('listening', listen); reject(err); };
      const listen = () => { this.server.off('error', fail); resolve(); };
      this.server.once('error', fail); this.server.once('listening', listen); this.server.listen(this.port, this.host);
    });
    this.heartbeat = setInterval(() => {
      const peer = this.peer;
      if (!peer) return;
      if (!peer.alive) return peer.ws.terminate();
      peer.alive = false; peer.ws.ping();
    }, this.heartbeatMs);
    this.heartbeat.unref();
    return this.server.address();
  }
  address() { return this.server.address(); }
  async close() {
    clearInterval(this.heartbeat);
    for (const ws of this.wss.clients) ws.terminate();
    await new Promise(resolve => this.wss.close(resolve));
    if (this.server.listening) await new Promise(resolve => this.server.close(resolve));
  }
}
