#!/bin/sh
# Run on the Linux Docker host, before starting the storage Compose project.
set -eu
bot=${1:-}
case "$bot" in ''|*[!a-z0-9_-]*|-*|_*) echo 'Invalid bot ID.' >&2; exit 1;; esac
test "${#bot}" -le 64 || exit 1
test "$(id -u)" = 0 || { echo 'Run on the Docker host as root.' >&2; exit 1; }
root=/mnt/qqbridge-encrypted
mkdir -p "$root"
test "$(realpath -e "$root")" = "$root" || exit 1
if ! mountpoint -q "$root"; then mount --bind "$root" "$root"; fi
mount --make-rshared "$root"
test ! -L "$root/$bot" || exit 1
mkdir -p "$root/$bot"
echo 'Shared storage mount parent prepared.'
