import { realpath, readFile } from 'node:fs/promises';
import path from 'node:path';

const unescapeMount = value => value.replace(/\\(040|011|012|134)/g, (_, code) => String.fromCharCode(parseInt(code, 8)));

// Match the deepest mount, including a plaintext mount nested inside an encrypted one.
export function profileFilesystem(profile, mountinfo) {
  let match = null;
  for (const line of mountinfo.split('\n')) {
    const [left, right] = line.split(' - ');
    if (!right) continue;
    const fields = left.split(' '), mount = unescapeMount(fields[4] || '');
    if (!mount.startsWith('/')) continue;
    const relative = path.posix.relative(mount, profile);
    if (relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) continue;
    if (!match || mount.length >= match.mount.length) match = { mount, type: right.split(' ')[0] };
  }
  return match?.type ?? '';
}

export async function requireEncryptedProfile(profile, env = process.env) {
  const setting = env.QQBRIDGE_REQUIRE_ENCRYPTED_PROFILE;
  if (setting === undefined || setting === '' || setting === '0') return;
  if (setting !== '1') throw new Error('QQBRIDGE_REQUIRE_ENCRYPTED_PROFILE must be 0 or 1.');
  if (process.platform !== 'linux') throw new Error('Encrypted profile verification requires Linux.');
  // Missing/unmounted storage must fail before native code can create plaintext files.
  let candidate = path.resolve(profile), resolved;
  // A new bot has no qq-profile subdirectory yet. Verify its nearest existing
  // parent so native initialization can create it only on encrypted storage.
  for (;;) {
    try { resolved = await realpath(candidate); break; }
    catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(candidate) === candidate) throw error;
      candidate = path.dirname(candidate);
    }
  }
  const type = profileFilesystem(resolved, await readFile('/proc/self/mountinfo', 'utf8'));
  if (type !== 'fuse.gocryptfs') throw new Error('The QQ profile must be mounted from gocryptfs before startup.');
}
