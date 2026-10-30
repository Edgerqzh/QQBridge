import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const fail = message => Object.assign(new Error(message), { retcode: 1400 });
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function imageInfo(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii',12,16) === 'IHDR') {
    let offset = 8, data = false, end = false;
    while (offset + 12 <= bytes.length) {
      const size = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
      if (size > bytes.length - offset - 12 || crc32(bytes.subarray(offset + 4, offset + 8 + size)) !== bytes.readUInt32BE(offset + 8 + size)) throw fail('PNG chunk integrity check failed.');
      if (offset === 8 && size !== 13) throw fail('Invalid PNG header.');
      if (type === 'IDAT') data = true;
      offset += size + 12;
      if (type === 'IEND') { end = size === 0 && offset === bytes.length; break; }
    }
    if (!data || !end) throw fail('PNG is truncated or lacks image data.');
    return { extension: 'png', type: 1001, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes[0] === 255 && bytes[1] === 216) {
    let at = 2;
    while (at + 4 <= bytes.length) {
      if (bytes[at++] !== 255) break;
      while (bytes[at] === 255) at++;
      const marker = bytes[at++];
      if (marker === 217 || marker === 218) break;
      const length = bytes.readUInt16BE(at);
      if (length < 2 || at + length > bytes.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length >= 7)
        return { extension: 'jpg', type: 1000, height: bytes.readUInt16BE(at + 3), width: bytes.readUInt16BE(at + 5) };
      at += length;
    }
  }
  throw fail('Only PNG and JPEG images with readable dimensions are supported.');
}
export function createMediaStore({ directory, maxBytes = 16 * 1024 * 1024 }) {
  const root = path.resolve(directory);
  return {
    async prepare(file, kind, name) {
      if (typeof file !== 'string') throw fail('Media file must be base64:// data or a managed media identifier.');
      await mkdir(root, { recursive: true, mode: 0o700 });
      let bytes;
      if (file.startsWith('base64://')) {
        const encoded = file.slice(9);
        if (!encoded || encoded.length > Math.ceil(maxBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw fail('Invalid or oversized base64 media.');
        bytes = Buffer.from(encoded, 'base64');
      } else if (/^qqbridge:\/\/[a-f0-9]{64}$/.test(file)) {
        let resolved;
        for (const suffix of ['', '.png', '.jpg']) {
          try { resolved = await realpath(path.join(root, file.slice(11) + suffix)); break; } catch {}
        }
        if (!resolved) throw fail('Managed media does not exist.');
        if (path.dirname(resolved) !== await realpath(root)) throw fail('Invalid managed media path.');
        bytes = await readFile(resolved);
      } else throw fail('Remote URLs and arbitrary local paths are not accepted; use base64:// media.');
      if (!bytes.length || bytes.length > maxBytes) throw fail('Media must contain 1 to 16777216 bytes.');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const md5 = createHash('md5').update(bytes).digest('hex');
      const info = kind === 'image' ? imageInfo(bytes) : {};
      if (kind === 'image' && (!info.width || !info.height || info.width > 30000 || info.height > 30000 || info.width * info.height > 40000000)) throw fail('Invalid image dimensions.');
      if (kind === 'record') {
        const header = bytes.subarray(0, 16).toString('ascii');
        if (header.startsWith('#!AMR\n')) { info.extension = 'amr'; info.format = 1; }
        else if (header.startsWith('#!SILK_V3') || header.startsWith('\x02#!SILK_V3')) { info.extension = 'silk'; info.format = 1; }
        else throw fail('Voice requires AMR or SILK audio; MP3/WAV transcoding is not implemented.');
      }
      const fileName = name ?? `${sha256.slice(0,16)}.${info.extension ?? 'bin'}`;
      if (typeof fileName !== 'string' || !fileName.length || Buffer.byteLength(fileName) > 240 || /[\\/\u0000-\u001f\u007f]/.test(fileName) || ['.', '..'].includes(fileName)) throw fail('Invalid media filename.');
      const sourcePath = path.join(root, sha256 + (kind === 'image' ? '.' + info.extension : ''));
      try { await writeFile(sourcePath, bytes, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      return { fileName, sourcePath, size: String(bytes.length), md5, sha256,
        sha1: createHash('sha1').update(bytes).digest('hex'),
        md5Ten: createHash('md5').update(bytes.subarray(0, 10*1024*1024)).digest('hex'), ...info };
    },
  };
}
