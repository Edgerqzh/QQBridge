#!/bin/sh
# Dedicated storage container only. The application gets no FUSE capabilities.
set -eu
umask 077
test -s /run/secrets/profile-key || { echo 'Storage key is missing.' >&2; exit 1; }
test -c /dev/fuse || { echo 'FUSE device is unavailable.' >&2; exit 1; }
mkdir -p /cipher /mount
if ! test -f /cipher/gocryptfs.conf; then
  test -z "$(ls -A /cipher)" || { echo 'Uninitialized nonempty cipher directory.' >&2; exit 1; }
  gocryptfs -q -init -passfile /run/secrets/profile-key /cipher >/dev/null 2>&1 || { echo 'Storage initialization failed.' >&2; exit 1; }
fi
gocryptfs -fg -q -nosyslog -allow_other -passfile /run/secrets/profile-key /cipher /mount >/dev/null 2>&1 &
storage_pid=$!
stop() { kill -TERM "$storage_pid" 2>/dev/null || true; }
trap stop TERM INT
ready=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if test "$(findmnt -rn -o FSTYPE --target /mount | tail -n 1)" = fuse.gocryptfs; then ready=1; break; fi
  kill -0 "$storage_pid" 2>/dev/null || break
  sleep 1
done
if test "$ready" != 1; then stop; wait "$storage_pid" || true; echo 'Encrypted storage mount failed.' >&2; exit 1; fi
chown 1000:1000 /mount
chmod 700 /mount
echo 'Encrypted storage mounted.'
set +e
wait "$storage_pid"
code=$?
# wait may be interrupted by the signal trap before the daemon exits.
if kill -0 "$storage_pid" 2>/dev/null; then wait "$storage_pid"; code=$?; fi
exit "$code"
