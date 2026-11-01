#!/bin/bash
# Linux host tool. Run as root; QQ containers remain unprivileged.
set -euo pipefail
umask 077
action=${1:-}
bot=${2:-}
[[ $EUID == 0 ]] || { echo 'Run this host storage tool as root.' >&2; exit 1; }
[[ $bot =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] || { echo 'Use a stable lowercase bot ID (1-64 characters).' >&2; exit 1; }
[[ $action =~ ^(init|mount|unmount|destroy)$ ]] || { echo 'Usage: bot-storage.sh init|mount|unmount|destroy BOT_ID [CONFIRM_BOT_ID]' >&2; exit 1; }
# Keys must live outside the encrypted data tree and must not enter container env.
data_root=/srv/qqbridge/encrypted
key_root=/etc/qqbridge/keys
mount_root=/run/qqbridge/profiles
for root in "$data_root" "$key_root" "$mount_root"; do
  mkdir -p -- "$root"
  [[ $(realpath -e -- "$root") == "$root" ]] || { echo 'Storage root must not contain symlinks.' >&2; exit 1; }
  chmod 700 -- "$root"
done
cipher=$data_root/$bot
key=$key_root/$bot.key
mount=$mount_root/$bot
for item in "$cipher" "$key" "$mount"; do
  [[ ! -L $item ]] || { echo 'Symlink storage entries are forbidden.' >&2; exit 1; }
done
mounted() { mountpoint -q -- "$mount"; }
case $action in
  init)
    [[ ! -e $cipher && ! -e $key && ! -e $mount ]] || { echo 'Bot storage already exists; refusing to replace it.' >&2; exit 1; }
    command -v gocryptfs >/dev/null
    mkdir -- "$cipher" "$mount"
    # noclobber also protects against an accidental overwrite of another key.
    (set -o noclobber; openssl rand -hex 32 > "$key")
    chmod 600 -- "$key"
    gocryptfs -q -init -passfile "$key" "$cipher" >/dev/null 2>&1 || { echo 'Initialization failed; preserve the key and inspect host storage.' >&2; exit 1; }
    ;;
  mount)
    [[ -d $cipher && -f $key ]] || { echo 'Initialize this bot first.' >&2; exit 1; }
    mkdir -p -- "$mount"
    [[ $(stat -c '%a:%u' "$key") == '600:0' ]] || { echo 'Key must be root-owned with mode 0600.' >&2; exit 1; }
    if mounted; then
      [[ $(findmnt -n -o FSTYPE --target "$mount") == fuse.gocryptfs ]] || exit 1
    else
      # Root mount with allow_other allows the container's UID 1000; mode 0700
      # below restricts the decrypted view to that UID (and host root).
      gocryptfs -q -allow_other -passfile "$key" "$cipher" "$mount" >/dev/null 2>&1 || { echo 'Encrypted mount failed.' >&2; exit 1; }
      chown 1000:1000 -- "$mount"
      chmod 700 -- "$mount"
    fi
    ;;
  unmount)
    # Normal unmount refuses a busy profile. Never force/lazy-unmount a live bot.
    if mounted; then fusermount3 -u -- "$mount"; fi
    ;;
  destroy)
    [[ ${3:-} == "$bot" ]] || { echo 'Repeat the exact bot ID as the third argument to confirm deletion.' >&2; exit 1; }
    mounted && { echo 'Stop and remove the bot container, then unmount its profile first.' >&2; exit 1; }
    [[ -d $cipher && -f $key && -d $mount ]] || { echo 'Incomplete storage; refusing deletion.' >&2; exit 1; }
    [[ $(realpath -e -- "$cipher") == "$data_root/$bot" && $(realpath -e -- "$mount") == "$mount_root/$bot" ]] || exit 1
    # Refuse any nested mounts before recursive deletion.
    if findmnt -rn -o TARGET | awk -v p="$cipher" '$0 == p || index($0,p"/")==1 {found=1} END {exit !found}'; then
      echo 'Encrypted directory contains a mount; refusing deletion.' >&2; exit 1
    fi
    rmdir -- "$mount"
    rm -rf --one-file-system -- "$cipher"
    rm -- "$key"
    ;;
esac
echo "Bot storage $action completed."
