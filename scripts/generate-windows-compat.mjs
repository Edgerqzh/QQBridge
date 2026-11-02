import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../src/native/windows/', import.meta.url));
const destination = path.resolve(process.argv[2] || 'data/native-win');
if (destination === path.parse(destination).root) throw new Error('Use a dedicated build directory.');
const names = JSON.parse(await readFile(path.join(source, 'host-imports.json'), 'utf8'));
if (names.length !== 99 || new Set(names).size !== 99 || names.some(n => typeof n !== 'string' || !/^[A-Za-z0-9_?@$]+$/.test(n))) throw new Error('Invalid pinned Windows host imports.');
const stopping = names.indexOf('?IsEnvironmentStopping@node@@YA_NPEAVIsolate@v8@@@Z');
const registration = names.indexOf('qq_magic_napi_register');
if (stopping < 0 || registration < 0) throw new Error('Missing lifecycle imports.');
await mkdir(destination, { recursive: true });
await copyFile(path.join(source, 'compat.c'), path.join(destination, 'compat.c'));
await writeFile(path.join(destination, 'host-imports.h'), `#define QQBRIDGE_IMPORT_COUNT ${names.length}\n#define QQBRIDGE_STOPPING_INDEX ${stopping}\n#define QQBRIDGE_REGISTER_INDEX ${registration}\nstatic const char* names[]={${names.map(n => JSON.stringify(n)).join(',')}};\n`);
await writeFile(path.join(destination, 'forward.asm'), 'EXTERN qqbridge_targets:QWORD\n.code\n' + names.map((_, i) => `qqbridge_forward_${i} PROC\n jmp QWORD PTR [qqbridge_targets+${i * 8}]\nqqbridge_forward_${i} ENDP\n`).join('') + 'END\n');
await writeFile(path.join(destination, 'compat.def'), 'LIBRARY QQNT\nEXPORTS\n' + names.map((name, i) => `${name}=qqbridge_forward_${i}\n`).join(''));
console.log('Windows compatibility sources generated.');
