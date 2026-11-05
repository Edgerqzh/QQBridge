import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fail = () => Object.assign(new Error('Image worker failed or exceeded its resource limits.'), { retcode: 1503 });
export function createImageWorker({ timeoutMs = 8000, maxJobs = 2 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || !Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 4) throw new TypeError('Invalid image worker limits.');
  const children = new Set();
  let closed = false;
  return {
    prepareAvatar(bytes) { return this.prepare(bytes, 'avatar'); },
    prepare(bytes, mode = 'thumbnails') {
      if (!['thumbnails', 'avatar'].includes(mode)) return Promise.reject(fail());
      if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 16 * 1024 * 1024) return Promise.reject(fail());
      if (mode === 'avatar' && bytes.length > 6 * 1024 * 1024) return Promise.reject(fail());
      if (closed || children.size >= maxJobs) return Promise.reject(fail());
      const env = { ...process.env };
      // Let sharp load its own DLLs, rather than the QQ SDK's DLLs.
      const qqApp = env.QQBRIDGE_QQ_APP;
      if (qqApp && process.platform === 'win32') {
        env.PATH = (env.PATH || env.Path || '').split(path.delimiter).filter(p => path.resolve(p).toLowerCase() !== path.resolve(qqApp).toLowerCase()).join(path.delimiter);
        delete env.Path;
      }
      delete env.NODE_OPTIONS;
      delete env.NODE_PATH;
      for (const key of Object.keys(env)) if (key.startsWith('QQBRIDGE_')) delete env[key];
      const child = spawn(process.execPath, ['--max-old-space-size=256', fileURLToPath(new URL('./image-worker.mjs', import.meta.url))], {
        env, windowsHide: true, stdio: ['pipe','pipe','ignore'],
      });
      children.add(child);
      return new Promise((resolve, reject) => {
        let settled = false, total = 0;
        const output = [];
        const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
        const timer = setTimeout(() => { finish(fail()); child.kill(); }, timeoutMs);
        child.once('error', () => finish(fail()));
        child.stdin.on('error', () => { finish(fail()); child.kill(); });
        child.stdout.on('data', chunk => {
          total += chunk.length;
          if (total > (mode === 'avatar' ? 8 * 1024 * 1024 + 1024 : 3 * 1024 * 1024)) { finish(fail()); child.kill(); }
          else if (!settled) output.push(chunk);
        });
        child.once('close', code => {
          children.delete(child);
          if (settled) return;
          if (closed || code !== 0) return finish(fail());
          try {
            const data = JSON.parse(Buffer.concat(output).toString('utf8'));
            if (mode === 'avatar') {
              if (!['png', 'jpeg'].includes(data.format) || !Number.isInteger(data.width) || !Number.isInteger(data.height) ||
                  data.width < 1 || data.height < 1 || data.width > 1024 || data.height > 1024 ||
                  typeof data.data !== 'string' || data.data.length > 8 * 1024 * 1024) throw new Error();
              const bytes = Buffer.from(data.data, 'base64');
              if (!bytes.length || bytes.length > 6 * 1024 * 1024 || bytes.toString('base64') !== data.data ||
                  data.format === 'png' && !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
                  data.format === 'jpeg' && (bytes[0] !== 255 || bytes[1] !== 216)) throw new Error();
              return finish(null, { bytes, extension: data.format === 'jpeg' ? 'jpg' : 'png', width: data.width, height: data.height });
            }
            const result = new Map();
            for (const side of [198,720]) {
              if (typeof data[side] !== 'string' || data[side].length > 2 * 1024 * 1024) throw new Error();
              const image = Buffer.from(data[side], 'base64');
              if (image[0] !== 255 || image[1] !== 216 || image.toString('base64') !== data[side]) throw new Error();
              result.set(side,image);
            }
            finish(null,result);
          } catch { finish(fail()); }
        });
        child.stdin.end(JSON.stringify({ data: bytes.toString('base64'), mode }));
      });
    },
    status: () => ({ active: children.size, limit: maxJobs, closed }),
    close() { closed = true; for (const child of children) child.kill(); },
  };
}
