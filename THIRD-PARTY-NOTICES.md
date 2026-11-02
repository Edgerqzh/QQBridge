# Third-party components in Windows distributions

QQBridge's original code is covered by the MIT license in `LICENSE`. Bundled
components retain their own licenses and notices. The Windows archive contains
the unmodified Node runtime, production npm packages and the project's own host
and compatibility library. It does not contain the QQ client or account data.

## Node.js

Node.js 24.21.0 is distributed with its complete upstream license in
`licenses/node-LICENSE.txt`, including notices for components bundled in Node.
Corresponding source: https://nodejs.org/dist/v24.21.0/node-v24.21.0.tar.gz

## npm packages

`licenses/dependencies.json` in the Windows archive lists the versions, license
declarations, upstream repositories and copied notice files of the packages
actually shipped. Their original notices also remain in `node_modules`.
`licenses/npm/` provides separate copies of the license and notice files.

The silk-wasm 3.7.1 wrapper uses MIT. Its embedded SILK codec's original
Skype BSD-style notice is additionally preserved in `licenses/SILK-SDK.txt`.
The codec wrapper's Russell notice is in `licenses/SILK-codec-wrapper.txt`.
The pinned source and codec are available at
https://github.com/idranme/silk-wasm/tree/v3.7.1/binding/libSilkCodec/silk .

## Image libraries

The Windows package includes sharp 0.35.5 and the unmodified
`@img/sharp-win32-x64` 0.35.5 binaries. Sharp is Apache-2.0; its native package
also declares LGPL-3.0-or-later for the included image libraries. The upstream
native package README lists the individual libraries and applicable licenses;
it is copied to `licenses/npm/img-sharp-win32-x64/README.md`. Their exact
versions are copied to that directory's `versions.json`.

The full GNU GPLv3 and LGPLv3 texts are included in `licenses/`. The LGPL image
libraries are separate DLLs under `node_modules/@img/sharp-win32-x64/lib/` and
are not patched by QQBridge. Corresponding source and build instructions are
available through the upstream versioned repositories:

- sharp 0.35.5: https://github.com/lovell/sharp/tree/v0.35.5
- Native dependency packaging 1.3.4: https://github.com/lovell/sharp-libvips/tree/v1.3.4
- Windows image-library build recipes 8.18.7, including dependency source URLs,
  versions and patches: https://github.com/libvips/build-win64-mxe/tree/v8.18.7
- libvips 8.18.7 source: https://github.com/libvips/libvips/releases/tag/v8.18.7

These upstream source repositories and the dependency recipes describe how to
rebuild the image-library DLLs. QQBridge's image worker loads them through the
ordinary sharp module; replacement libraries must preserve the expected ABI.

## License text sources

- GPLv3: https://www.gnu.org/licenses/gpl-3.0.txt
- LGPLv3: https://www.gnu.org/licenses/lgpl-3.0.txt
- The GNU license texts are reproduced from the GNU project's GCC mirror at
  https://github.com/gcc-mirror/gcc/tree/releases/gcc-14.2.0
  (`COPYING3` and `COPYING3.LIB`).
- Other license texts are copied without modification from the installed,
  lockfile-pinned packages. Package-specific copyright notices are preserved.
