import { mkdir, copyFile, chmod, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
const fail = message => Object.assign(new Error(message), { retcode: 1503 });

/** Stage pictures at the native SDK's own Ori/Thumb locations. */
export async function prepareNativePicture({ msgService, profile, media }) {
  if (typeof msgService?.getRichMediaFilePathForMobileQQSend !== 'function') throw fail('Native picture path preparation is unavailable.');
  const root = await realpath(profile);
  async function stage(source, downloadType, thumbSize) {
    const target = await msgService.getRichMediaFilePathForMobileQQSend({
      elementType: 2, elementSubType: 0, md5HexStr: media.md5,
      fileName: media.md5 + '.' + media.extension, downloadType, thumbSize,
      needCreate: false, isInApplicationDataPath: false,
    });
    if (typeof target !== 'string' || !path.isAbsolute(target)) throw fail('Native picture storage path is unavailable.');
    const relative = path.relative(root, target);
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw fail('Native picture storage path is outside this profile.');
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const parent = await realpath(path.dirname(target));
    if (!parent.startsWith(root + path.sep)) throw fail('Invalid native picture storage directory.');
    try { await copyFile(source, target, constants.COPYFILE_EXCL); await chmod(target, 0o600); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!(await realpath(target)).startsWith(root + path.sep)) throw fail('Invalid native picture storage file.');
    return target;
  }
  const sourcePath = await stage(media.sourcePath, 1, 0);
  const thumbPaths = new Map();
  for (const size of [198,720]) thumbPaths.set(size, await stage(media.thumbPaths.get(size), 2, size));
  return { ...media, fileName: media.md5 + '.' + media.extension, sourcePath, thumbPaths };
}
