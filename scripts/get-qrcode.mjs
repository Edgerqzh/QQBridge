#!/usr/bin/env node
import { mkdir, lstat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import path from 'node:path';

const MAX_PNG_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 1536 * 1024;
const TIMEOUT_MS = 15000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function endpointFromEnvironment(env) {
  let host = env.QQBRIDGE_HOST || '127.0.0.1';
  if (host === '0.0.0.0') host = '127.0.0.1';
  if (host === '::' || host === '[::]') host = '::1';
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!isIP(host) && !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host)) {
    throw new Error('QQBRIDGE_HOST 必须是有效的 IP 地址或主机名。');
  }
  const port = env.QQBRIDGE_PORT === undefined ? 5700 : Number(env.QQBRIDGE_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('QQBRIDGE_PORT 必须为 1 到 65535 的整数。');
  const token = env.QQBRIDGE_TOKEN;
  if (typeof token !== 'string' || token.length < 32 || /replace-with|random-secret|[\r\n]/.test(token)) {
    throw new Error('QQBRIDGE_TOKEN 缺失或无效；请先运行 npm run init，并检查本地 .env。');
  }
  return { endpoint: new URL(`http://${isIP(host) === 6 ? `[${host}]` : host}:${port}/get_login_qrcode`), token };
}

async function readResponse(response) {
  const declaredSize = Number(response.headers.get('content-length') || 0);
  if (declaredSize > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error('二维码接口响应超过允许大小。');
  }
  const chunks = []; let bytes = 0;
  if (!response.body) throw new Error('二维码接口返回了空响应。');
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_RESPONSE_BYTES) throw new Error('二维码接口响应超过允许大小。');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('二维码接口没有返回有效的 JSON。'); }
}

function decodePNG(value) {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(MAX_PNG_BYTES / 3) * 4 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error('二维码必须为有效的 PNG base64，图片不得超过 1 MiB。');
  }
  const image = Buffer.from(value, 'base64');
  if (image.length > MAX_PNG_BYTES || image.length < PNG_SIGNATURE.length || !image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) || image.toString('base64') !== value) {
    throw new Error('二维码未通过 PNG 签名或大小校验，未保存图片。');
  }
  return image;
}

function apiError(response, payload) {
  const retcode = Number.isInteger(payload?.retcode) ? payload.retcode : undefined;
  if (response.status === 401 || retcode === 1401) return new Error('API 令牌鉴权失败，请检查本地 .env 的 QQBRIDGE_TOKEN。');
  if (retcode === 1503) return new Error('QQ 原生运行时尚未连接；请先启动网关和实验驱动，再获取二维码。');
  if (retcode === 1404) return new Error('当前驱动尚未提供 get_login_qrcode，请检查实验驱动配置。');
  if (retcode === 1504) return new Error('QQ 驱动获取二维码超时，请检查驱动状态后重新执行。');
  return new Error(`二维码接口未成功（HTTP ${response.status}${retcode === undefined ? '' : `，retcode ${retcode}`}）。`);
}

async function rejectSymlink(file) {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error('二维码输出路径不能是符号链接。');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

try {
  const { endpoint, token } = endpointFromEnvironment(process.env);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 401) throw apiError(response);
  const payload = await readResponse(response);
  if (!response.ok || payload?.status !== 'ok' || payload?.retcode !== 0) throw apiError(response, payload);
  const image = decodePNG(payload.data?.image_base64);
  const projectRoot = fileURLToPath(new URL('../', import.meta.url));
  const dataDirectory = path.join(projectRoot, 'data');
  const output = path.join(dataDirectory, 'login-qr.png');
  await rejectSymlink(dataDirectory);
  await mkdir(dataDirectory, { recursive: true });
  await rejectSymlink(output);
  await writeFile(output, image, { mode: 0o600 });
  console.log(`二维码已保存：${output}`);
  console.log('请由账号持有人使用手机 QQ 扫码；二维码过期后重新执行 npm run qrcode 刷新。');
  console.log('此命令只获取二维码，不会额外轮询、确认登录或发送消息。');
} catch (error) {
  let message;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') message = '二维码请求在 15 秒内未完成，请检查网关和驱动状态。';
  else if (error instanceof TypeError && error.message === 'fetch failed') message = '无法连接 QQBridge 网关，请先运行 npm start 并检查监听配置。';
  else if (error.code) message = `二维码图片未保存，文件操作失败（${error.code}）。`;
  else message = error.message;
  // Only locally generated messages are shown; response bodies and credentials are never logged.
  console.error(`QQBridge 二维码：${message}`);
  process.exitCode = 1;
}
