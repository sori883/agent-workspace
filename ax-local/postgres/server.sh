#!/bin/sh
set -eu
mkdir -p /run/postgres-tls
cp /run/local-secrets/server.crt /run/postgres-tls/server.crt
cp /run/local-secrets/server.key /run/postgres-tls/server.key
chown -R postgres:postgres /run/postgres-tls
chmod 700 /run/postgres-tls
chmod 600 /run/postgres-tls/*
exec /usr/local/bin/docker-entrypoint.sh postgres \
  -c ssl=on \
  -c ssl_cert_file=/run/postgres-tls/server.crt \
  -c ssl_key_file=/run/postgres-tls/server.key \
  -c hba_file=/etc/postgresql/pg_hba.conf \
  -c password_encryption=scram-sha-256
