import { realpath, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
const fail = (message, retcode = 1503) => Object.assign(new Error(message), { retcode });
/** Private path metadata is bounded, account-scoped, and never sent as an event. */
export function createReceivedMediaCache({ profile, capacity = 5000 }) {
  const entries = new Map();
  return {
    remember(record) {
      for (const element of record.elements ?? []) {
        const value = element.picElement ?? element.fileElement ?? element.pttElement;
        if (!value || ![2,3,4].includes(element.elementType)) continue;
        const id = value.fileUuid || value.md5HexStr || value.fileMd5;
        if (typeof id !== 'string' || !id.length || id.length > 512 || /[\\/\u0000-\u001f]/.test(id)) continue;
        if (!entries.has(id) && entries.size >= capacity) entries.delete(entries.keys().next().value);
        entries.set(id, { group: String(record.peerUin), source: value.sourcePath || value.filePath,
          name: value.fileName, type: element.elementType });
      }
    },
    async read(id, allowed) {
      if (typeof id !== 'string' || !entries.has(id)) throw fail('Media identifier is unknown or expired.', 1400);
      const entry = entries.get(id);
      if (!allowed(entry.group)) throw fail('Media group is unavailable or not allowed.', 1403);
      if (typeof entry.source !== 'string' || !path.isAbsolute(entry.source)) throw fail('QQ has not cached this media locally.');
      const root = await realpath(profile), source = await realpath(entry.source).catch(() => { throw fail('QQ has not cached this media locally.'); });
      const relative = path.relative(root, source);
      if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw fail('Media cache path is outside the dedicated QQ profile.', 1403);
      const info = await stat(source);
      if (!info.isFile() || info.size < 1 || info.size > 16*1024*1024) throw fail('Cached media is unavailable or exceeds 16 MiB.');
      const bytes = await readFile(source);
      if (bytes.length > 16*1024*1024) throw fail('Cached media exceeds 16 MiB.');
      return { file_id: id, base64: bytes.toString('base64'), size: bytes.length,
        name: typeof entry.name === 'string' ? path.basename(entry.name).slice(0,240) : 'media.bin' };
    },
    clear() { entries.clear(); },
  };
}
