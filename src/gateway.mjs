import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { createActionDispatcher, failure, publicStatus } from './onebot.mjs';

function json(response, statusCode, value, close = false) {
  if (response.writableEnded || response.destroyed) return;
  const serialized = JSON.stringify(value);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(close ? { Connection: 'close' } : {}),
  });
  response.end(serialized);
}

function wireError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function websocketMode(pathname) {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/' || path === '/onebot/v11') return 'combined';
  if (path === '/api') return 'api';
  if (path === '/event') return 'event';
  return undefined;
}

function selfId(backend) {
  try {
    const value = backend.status()?.self_id;
    const id = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    return Number.isSafeInteger(id) && id > 0 ? id : undefined;
  } catch { return undefined; }
}

function httpStatus(result) {
  return result.status === 'failed' && result.retcode >= 1400 && result.retcode <= 1599 ? result.retcode - 1000 : 200;
}

function readJson(request, maxBodyBytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => finish(wireError(408, 'request body timed out')), timeoutMs);
    timer.unref?.();
    const finish = (error, value) => {
      clearTimeout(timer);
      request.removeListener('data', onData);
      request.removeListener('end', onEnd);
      request.removeListener('error', onError);
      request.removeListener('aborted', onAborted);
      error ? reject(error) : resolve(value);
    };
    const onError = () => finish(wireError(400, 'request body could not be read'));
    const onAborted = () => finish(wireError(400, 'request was aborted'));
    const onData = chunk => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        finish(wireError(413, 'request body exceeds limit'));
        request.resume();
      } else chunks.push(chunk);
    };
    const onEnd = () => {
      try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { finish(wireError(400, 'request body must be valid JSON')); }
    };
    request.on('data', onData);
    request.on('end', onEnd);
    request.on('error', onError);
    request.on('aborted', onAborted);
  });
}

/** HTTP actions and a forward WebSocket endpoint. The caller owns the backend. */
export function createGateway({
  backend, token, host = '127.0.0.1', port = 0, heartbeatMs = 15000,
  maxBodyBytes = 1048576, requestTimeoutMs = 15000,
  appName = 'QQBridge', appVersion = '0.1.0',
} = {}) {
  if (typeof token !== 'string' || token.length === 0 || /[\r\n]/.test(token)) throw new TypeError('a nonempty bearer token is required');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('port must be between 0 and 65535');
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) throw new TypeError('maxBodyBytes must be a positive integer');
  if (!Number.isFinite(heartbeatMs) || heartbeatMs < 0) throw new TypeError('heartbeatMs must be nonnegative');
  if (typeof backend?.on !== 'function' || typeof backend?.off !== 'function') throw new TypeError('backend must be an EventEmitter');
  const dispatch = createActionDispatcher({ backend, requestTimeoutMs, appName, appVersion });
  const tokenDigest = createHash('sha256').update(token).digest();
  const authorized = request => {
    const match = /^Bearer ([^\r\n]+)$/i.exec(request.headers.authorization ?? '');
    return !!match && timingSafeEqual(createHash('sha256').update(match[1]).digest(), tokenDigest);
  };
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxBodyBytes, perMessageDeflate: false });
  let started = false;
  let starting;
  let closed = false;
  let heartbeat;
  const server = createServer(async (request, response) => {
    let url;
    try { url = new URL(request.url, 'http://localhost'); }
    catch { json(response, 400, failure(1400, 'invalid request URL'), true); return; }
    if (url.pathname === '/health' && request.method === 'GET') {
      json(response, 200, { service: appName, ...publicStatus(backend) });
      return;
    }
    if (!authorized(request)) {
      response.setHeader('WWW-Authenticate', 'Bearer');
      json(response, 401, failure(1401, 'unauthorized'), true);
      return;
    }
    if (request.method !== 'GET' && request.method !== 'POST') {
      response.setHeader('Allow', 'GET, POST');
      json(response, 405, failure(1405, 'method not allowed'), true);
      return;
    }
    const match = /^\/([a-z][a-z0-9_]{0,63})\/?$/.exec(url.pathname);
    if (!match && !(url.pathname === '/' && request.method === 'POST')) {
      json(response, 404, failure(1404, 'endpoint not found'));
      return;
    }
    try {
      let call;
      if (request.method === 'POST') {
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
          json(response, 415, failure(1415, 'Content-Type must be application/json'), true);
          return;
        }
        const declaredSize = Number(request.headers['content-length']);
        if (Number.isFinite(declaredSize) && declaredSize > maxBodyBytes) {
          json(response, 413, failure(1413, 'request body exceeds limit'), true);
          return;
        }
        const body = await readJson(request, maxBodyBytes, requestTimeoutMs);
        call = match ? { action: match[1], params: body } : body;
      } else {
        const params = Object.create(null);
        for (const [key, value] of url.searchParams) {
          if (Object.hasOwn(params, key)) throw wireError(400, 'duplicate query parameters are not supported');
          params[key] = value;
        }
        call = { action: match[1], params };
      }
      const result = await dispatch(call);
      json(response, httpStatus(result), result);
    } catch (error) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
      json(response, status, failure(1000 + status, status === 500 ? 'request failed' : error.message), true);
    }
  });
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = Math.min(requestTimeoutMs, 10000);
  server.keepAliveTimeout = 5000;
  server.on('upgrade', (request, socket, head) => {
    let pathname;
    try { pathname = new URL(request.url, 'http://localhost').pathname; }
    catch { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return; }
    if (!authorized(request)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer\r\nConnection: close\r\n\r\n');
      return;
    }
    const mode = websocketMode(pathname);
    if (!mode) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, ws => {
      ws.onebotMode = mode;
      wss.emit('connection', ws, request);
    });
  });
  const send = (client, value) => {
    if (client.readyState !== WebSocket.OPEN) return;
    if (client.bufferedAmount > maxBodyBytes * 4) { client.close(1013, 'client is too slow'); return; }
    try { client.send(JSON.stringify(value), error => { if (error) client.terminate(); }); }
    catch { client.terminate(); }
  };
  const broadcast = event => { for (const client of wss.clients) if (client.onebotMode !== 'api') send(client, event); };
  const onEvent = event => {
    if (event && typeof event === 'object' && !Array.isArray(event)) broadcast(event);
  };
  wss.on('connection', client => {
    client.on('error', () => {});
    const id = selfId(backend);
    if (client.onebotMode !== 'api' && id !== undefined) {
      send(client, { time: Math.floor(Date.now() / 1000), self_id: id, post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect' });
    }
    client.on('message', async (raw, isBinary) => {
      if (client.onebotMode === 'event') return;
      if (isBinary) { send(client, failure(1400, 'binary frames are not supported')); return; }
      let request;
      try { request = JSON.parse(raw.toString('utf8')); }
      catch { send(client, failure(1400, 'message must be valid JSON')); return; }
      send(client, await dispatch(request));
    });
  });

  return {
    start() {
      if (closed) return Promise.reject(new Error('gateway is closed'));
      if (starting) return starting;
      starting = new Promise((resolve, reject) => {
        const onError = error => { server.off('listening', onListening); starting = undefined; reject(error); };
        const onListening = () => {
          server.off('error', onError);
          started = true;
          backend.on('event', onEvent);
          if (heartbeatMs > 0) {
            heartbeat = setInterval(() => {
              const id = selfId(backend);
              // An unknown QQ identity is never replaced with a fake account ID.
              if (id !== undefined) broadcast({ time: Math.floor(Date.now() / 1000), self_id: id, post_type: 'meta_event', meta_event_type: 'heartbeat', status: publicStatus(backend), interval: heartbeatMs });
            }, heartbeatMs);
            heartbeat.unref?.();
          }
          resolve(server.address());
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
      return starting;
    },
    async close() {
      if (closed) return;
      closed = true;
      await starting?.catch(() => {});
      clearInterval(heartbeat);
      backend.off('event', onEvent);
      for (const client of wss.clients) client.terminate();
      wss.close();
      if (started) {
        await new Promise((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
          server.closeAllConnections();
        });
      }
    },
    address() { return server.address(); },
  };
}
