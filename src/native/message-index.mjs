import { mkdir, open, readFile, rename, realpath, lstat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const fail = () => Object.assign(new Error('Message ID persistence is unavailable; no new message ID can be confirmed.'), { retcode: 1503 });
const MAX_BYTES = 8 * 1024 * 1024;

/** Single-writer account index. Bodies remain in QQ's own database. A corrupt
 * index fails closed: resetting its high-water mark could reuse exposed IDs. */
export function createMessageIndex({ profile, accountId, snapshot }) {
  if (typeof profile !== 'string' || !/^[1-9]\d{4,11}$/.test(accountId) || typeof snapshot !== 'function') throw new TypeError('Invalid message index configuration.');
  const directory = path.join(profile, 'message-index');
  const file = path.join(directory, accountId + '.json');
  let revision = 0, savedRevision = 0, pending = null, failed = false;

  async function checkDirectory() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const root = await realpath(profile), resolved = await realpath(directory);
    const relative = path.relative(root, resolved);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw fail();
  }
  return {
    async load() {
      try {
        await checkDirectory();
        let info;
        try { info = await lstat(file); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) throw fail();
        const bytes = await readFile(file);
        if (bytes.length > MAX_BYTES) throw fail();
        const data = JSON.parse(bytes.toString('utf8'));
        if (data.account_id !== accountId || !data.state) throw fail();
        return data.state;
      } catch { failed = true; throw fail(); }
    },
    changed() { revision++; },
    status() { return { dirty: revision !== savedRevision, failed, entries_limit: 5000 }; },
    async flush() {
      if (pending) return pending;
      pending = (async () => {
        while (savedRevision !== revision) {
          const current = revision;
          const bytes = JSON.stringify({ account_id: accountId, state: snapshot() });
          if (Buffer.byteLength(bytes) > MAX_BYTES) throw fail();
          await checkDirectory();
          const temporary = path.join(directory, accountId + '.' + randomUUID() + '.tmp');
          try {
            const handle = await open(temporary, 'wx', 0o600);
            try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
            await rename(temporary, file);
            // File sync + atomic replace prevents truncated snapshots; syncing
            // the directory additionally makes the rename durable on Linux.
            if (process.platform !== 'win32') {
              const dir = await open(directory, 'r');
              try { await dir.sync(); } finally { await dir.close(); }
            }
            savedRevision = current; failed = false;
          } finally { await unlink(temporary).catch(() => {}); }
        }
      })().catch(() => { failed = true; throw fail(); }).finally(() => { pending = null; });
      return pending;
    },
  };
}
