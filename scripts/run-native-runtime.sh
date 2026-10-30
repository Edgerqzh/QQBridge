#!/bin/sh
# Experimental official QQ login runtime; never installs or modifies QQ.
set -eu
umask 077
qqbridge_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
qqbridge_build="$qqbridge_root/data/native"
if [ "$(uname -s)" != Linux ]; then
  printf '%s\n' 'QQBridge native runtime currently supports Linux only.' >&2
  exit 2
fi
command -v cc >/dev/null 2>&1 || { printf '%s\n' 'A C compiler (cc) is required.' >&2; exit 2; }
mkdir -p "$qqbridge_build"
cc -shared -fPIC -O2 -o "$qqbridge_build/napi-shim.so" "$qqbridge_root/src/native/napi-shim.c" -ldl
cd "$qqbridge_root"
export QQBRIDGE_DRIVER="${QQBRIDGE_DRIVER:-$qqbridge_root/src/native/linux-driver.mjs}"
export LD_PRELOAD="$qqbridge_build/napi-shim.so:libgnutls.so.30${LD_PRELOAD:+:$LD_PRELOAD}"
exec node --env-file-if-exists=.env "$qqbridge_root/src/runtime-cli.mjs"
