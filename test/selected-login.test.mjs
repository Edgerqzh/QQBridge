import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {readSelectedLogin,saveSelectedLogin} from '../src/native/selected-login.mjs';
test('remembered selection restores only the selected identity and supports clearing',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'qqbridge-login-'));assert.equal(path.dirname(root),path.resolve(os.tmpdir()));t.after(()=>rm(root,{recursive:true,force:true}));
  assert.equal(await readSelectedLogin(root),'');await saveSelectedLogin(root,'123456789');assert.equal(await readSelectedLogin(root),'123456789');
  await saveSelectedLogin(root,null);assert.equal(await readSelectedLogin(root),'');
  await writeFile(path.join(root,'selected-account.json'),JSON.stringify({uin:'../123'}));await assert.rejects(readSelectedLogin(root));
});
