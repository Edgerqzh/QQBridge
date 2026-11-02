import { readdir, readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const destination = path.resolve(process.argv[2] || '.');
const modules = path.join(destination, 'node_modules');
const output = path.join(destination, 'licenses');
const packages = [];
for (const entry of await readdir(modules, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
  if (entry.name.startsWith('@')) {
    for (const child of await readdir(path.join(modules, entry.name), { withFileTypes: true })) {
      if (child.isDirectory()) packages.push(path.join(modules, entry.name, child.name));
    }
  } else packages.push(path.join(modules, entry.name));
}
const inventory = [];
for (const directory of packages.sort()) {
  const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const name = metadata.name;
  if (typeof name !== 'string' || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) throw new Error('Invalid package name.');
  const target = path.join(output, 'npm', name.replace(/^@/, '').replace('/', '-'));
  await mkdir(target, { recursive: true });
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const notice = /^(?:licen[cs]e|copying|notice|third[-_]party[-_]notices)(?:[.-].*)?$/i.test(entry.name);
    const nativeMetadata = name === '@img/sharp-win32-x64' && ['README.md', 'versions.json'].includes(entry.name);
    if (!entry.isFile() || !notice && !nativeMetadata) continue;
    await copyFile(path.join(directory, entry.name), path.join(target, entry.name));
    files.push(path.relative(destination, path.join(target, entry.name)).split(path.sep).join('/'));
  }
  if (!files.length) throw new Error(`No license or notice found for ${name}.`);
  inventory.push({ name, version: metadata.version, license: metadata.license,
    repository: typeof metadata.repository === 'string' ? metadata.repository : metadata.repository?.url,
    files });
}
await writeFile(path.join(output, 'dependencies.json'), JSON.stringify(inventory, null, 2) + '\n');
console.log(`Collected license notices for ${inventory.length} production packages.`);
