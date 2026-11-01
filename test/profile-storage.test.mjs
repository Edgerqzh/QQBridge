import test from 'node:test';
import assert from 'node:assert/strict';
import { profileFilesystem, requireEncryptedProfile } from '../src/native/profile-storage.mjs';

const mounts = `1 0 0:1 / / rw - ext4 /dev/root rw
2 1 0:2 / /profiles/bot-a rw - fuse.gocryptfs gocryptfs rw
3 2 0:3 / /profiles/bot-a/plain rw - tmpfs tmpfs rw
4 1 0:4 / /space\\040name rw - fuse.gocryptfs gocryptfs rw`;
test('encrypted profile verification selects the actual filesystem, not a path prefix', () => {
  assert.equal(profileFilesystem('/profiles/bot-a/qq-profile', mounts), 'fuse.gocryptfs');
  assert.equal(profileFilesystem('/profiles/bot-ab', mounts), 'ext4');
  assert.equal(profileFilesystem('/profiles/bot-a/plain/session', mounts), 'tmpfs');
  assert.equal(profileFilesystem('/space name/session', mounts), 'fuse.gocryptfs');
  assert.equal(profileFilesystem('/x', 'malformed'), '');
});
test('encryption enforcement rejects invalid settings and missing or unencrypted storage', async () => {
  await requireEncryptedProfile('/unused', {});
  await assert.rejects(requireEncryptedProfile('/unused', {QQBRIDGE_REQUIRE_ENCRYPTED_PROFILE:'yes'}));
  await assert.rejects(requireEncryptedProfile(process.cwd(), {QQBRIDGE_REQUIRE_ENCRYPTED_PROFILE:'1'}));
  await assert.rejects(requireEncryptedProfile('/nonexistent-qqbridge-profile', {QQBRIDGE_REQUIRE_ENCRYPTED_PROFILE:'1'}));
});
