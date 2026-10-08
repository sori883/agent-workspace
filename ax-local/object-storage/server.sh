#!/bin/sh
set -eu
for name in root.access-key root.secret-key; do
  test -s "/run/local-secrets/$name"
  cp "/run/local-secrets/$name" "/run/rustfs-secrets/$name"
  chmod 0400 "/run/rustfs-secrets/$name"
done
chown -R 10001:10001 /run/rustfs-secrets
exec su -p -s /bin/sh rustfs -c 'exec /entrypoint.sh rustfs'
