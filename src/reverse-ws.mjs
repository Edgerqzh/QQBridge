import { WebSocket } from 'ws';
import { createActionDispatcher, failure, publicStatus } from './onebot.mjs';

function identity(backend) {
  try {
    const raw = backend.status()?.self_id;
    const id = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw;
    return Number.isSafeInteger(id) && id > 0 ? id : undefined;
  } catch { return undefined; }
}

/** Explicitly configured outbound OneBot connection. It never stores offline events. */
export function createReverseWebSocket({
  backend, url, token, reconnectMs = 1000, heartbeatMs = 15000,
  requestTimeoutMs = 15000, maxBufferedBytes = 4 * 1024 * 1024,
  maxPayloadBytes = 24 * 1024 * 1024, maxConcurrentCalls = 32,
} = {}) {
  if (typeof url !== 'string' || !url.trim()) throw new TypeError('an explicit reverse WebSocket URL is required');
  const endpoint = new URL(url);
  if (!['ws:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) {
    throw new TypeError('reverse WebSocket URL must use ws/wss without credentials or a fragment');
  }
  if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw new TypeError('a nonempty bearer token is required');
  if (!Number.isInteger(reconnectMs) || reconnectMs < 1) throw new TypeError('reconnectMs must be a positive integer');
  if (!Number.isFinite(heartbeatMs) || heartbeatMs < 0) throw new TypeError('heartbeatMs must be nonnegative');
  for (const [name, value] of Object.entries({ maxBufferedBytes, maxPayloadBytes, maxConcurrentCalls })) {
    if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  }
  if (typeof backend?.on !== 'function' || typeof backend?.off !== 'function') throw new TypeError('backend must be an EventEmitter');
  const dispatch = createActionDispatcher({ backend, requestTimeoutMs });
  let started = false;
  let closed = false;
  let socket;
  let socketIdentity;
  let reconnectTimer;
  let pollTimer;
  let heartbeatTimer;

  function clearReconnect() { clearTimeout(reconnectTimer); reconnectTimer = undefined; }
  function active(client) { return started && !closed && socket === client; }
  function send(client, frame) {
    if (!active(client) || client.readyState !== WebSocket.OPEN) return false;
    let payload;
    try { payload = JSON.stringify(frame); } catch { return false; }
    if (typeof payload !== 'string') return false;
    const bytes = Buffer.byteLength(payload);
    if (bytes > maxBufferedBytes || client.bufferedAmount + bytes > maxBufferedBytes) {
      client.terminate();
      return false;
    }
    try {
      client.send(payload, error => { if (error) client.terminate(); });
      return true;
    } catch { client.terminate(); return false; }
  }
  function scheduleReconnect() {
    if (!started || closed || reconnectTimer || socket || identity(backend) === undefined) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = undefined; reconcile(); }, reconnectMs);
    reconnectTimer.unref?.();
  }
  function connect(id) {
    let client;
    try {
      client = new WebSocket(endpoint, {
        headers: { Authorization: `Bearer ${token}`, 'X-Self-ID': String(id), 'X-Client-Role': 'Universal' },
        maxPayload: maxPayloadBytes,
        perMessageDeflate: false,
        handshakeTimeout: Math.max(reconnectMs, 1000),
      });
    } catch { scheduleReconnect(); return; }
    socket = client;
    socketIdentity = id;
    let alive = true;
    let inFlight = 0;
    client.on('error', () => {});
    client.on('pong', () => { alive = true; });
    client.on('open', () => {
      if (!active(client) || identity(backend) !== id) { client.terminate(); return; }
      send(client, { time: Math.floor(Date.now() / 1000), self_id: id, post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect' });
      heartbeatTimer = setInterval(() => {
        if (!active(client)) return;
        if (identity(backend) !== id) { reconcile(); return; }
        if (!alive) { client.terminate(); return; }
        alive = false;
        try { client.ping(); } catch { client.terminate(); return; }
        if (heartbeatMs > 0) send(client, { time: Math.floor(Date.now() / 1000), self_id: id, post_type: 'meta_event', meta_event_type: 'heartbeat', status: publicStatus(backend), interval: heartbeatMs });
      }, heartbeatMs > 0 ? heartbeatMs : 15000);
      heartbeatTimer.unref?.();
    });
    client.on('message', async (raw, binary) => {
      if (!active(client) || identity(backend) !== id) return;
      if (binary) { send(client, failure(1400, 'binary frames are not supported')); return; }
      let request;
      try { request = JSON.parse(raw.toString('utf8')); }
      catch { send(client, failure(1400, 'message must be valid JSON')); return; }
      if (inFlight >= maxConcurrentCalls) { send(client, failure(1429, 'too many concurrent actions', request?.echo)); return; }
      inFlight += 1;
      try {
        const result = await dispatch(request);
        // A completed call belongs only to the socket that received it.
        if (active(client) && identity(backend) === id) send(client, result);
      } finally { inFlight -= 1; }
    });
    client.on('close', () => {
      if (socket !== client) return;
      clearInterval(heartbeatTimer); heartbeatTimer = undefined;
      socket = undefined; socketIdentity = undefined;
      scheduleReconnect();
    });
  }
  function reconcile() {
    if (!started || closed) return;
    const desired = identity(backend);
    if (socket) {
      if (desired !== socketIdentity) {
        clearInterval(heartbeatTimer); heartbeatTimer = undefined;
        // close is observed before replacement, preventing overlapping peers.
        socket.terminate();
      }
      return;
    }
    if (desired === undefined) { clearReconnect(); return; }
    if (!reconnectTimer) connect(desired);
  }
  const onEvent = event => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return;
    if (socket && event.self_id === socketIdentity && identity(backend) === socketIdentity) send(socket, event);
  };

  return {
    async start() {
      if (closed) throw new Error('reverse WebSocket is closed');
      if (started) return;
      started = true;
      backend.on('status', reconcile);
      backend.on('event', onEvent);
      pollTimer = setInterval(reconcile, Math.max(25, reconnectMs));
      pollTimer.unref?.();
      reconcile();
    },
    async close() {
      if (closed) return;
      closed = true; started = false;
      clearReconnect(); clearInterval(pollTimer); clearInterval(heartbeatTimer);
      backend.off('status', reconcile);
      backend.off('event', onEvent);
      const client = socket;
      socket = undefined; socketIdentity = undefined;
      if (client && client.readyState !== WebSocket.CLOSED) {
        await new Promise(resolve => { client.once('close', resolve); client.terminate(); });
      }
    },
    status() { return { connected: socket?.readyState === WebSocket.OPEN, waiting_for_identity: identity(backend) === undefined }; },
  };
}
