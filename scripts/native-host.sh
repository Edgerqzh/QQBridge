#!/bin/sh
# Experimental export probe only: this does not log in or start a QQ session.
set -eu
umask 077
if [ "$#" -ne 1 ]; then
  printf '%s\n' 'Usage: sh scripts/native-host.sh /path/to/QQ/resources/app' >&2
  exit 2
fi
qqbridge_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
qqbridge_app=$(CDPATH= cd -- "$1" && pwd)
qqbridge_build="$qqbridge_root/data/native"
if [ ! -f "$qqbridge_app/wrapper.node" ]; then
  printf '%s\n' 'QQBridge: wrapper.node not found in the supplied app directory.' >&2
  exit 2
fi
if [ "$(uname -s)" != Linux ]; then
  printf '%s\n' 'QQBridge: this experiment currently supports Linux only.' >&2
  exit 2
fi
command -v cc >/dev/null 2>&1 || { printf '%s\n' 'QQBridge: a C compiler (cc) is required.' >&2; exit 2; }
command -v node >/dev/null 2>&1 || { printf '%s\n' 'QQBridge: Node.js is required.' >&2; exit 2; }
mkdir -p "$qqbridge_build"
cc -shared -fPIC -O2 -o "$qqbridge_build/napi-shim.so" "$qqbridge_root/src/native/napi-shim.c" -ldl
LD_PRELOAD="$qqbridge_build/napi-shim.so:libgnutls.so.30${LD_PRELOAD:+:$LD_PRELOAD}" \
  node "$qqbridge_root/scripts/probe-native.mjs" "$qqbridge_app"
