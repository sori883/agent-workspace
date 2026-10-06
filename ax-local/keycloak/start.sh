#!/bin/bash
set -euo pipefail
KC_DB_PASSWORD="$(cat /run/postgres/db.password)"
KC_BOOTSTRAP_ADMIN_PASSWORD="$(cat /run/auth/admin.password)"
export KC_DB_PASSWORD KC_BOOTSTRAP_ADMIN_PASSWORD
exec /opt/keycloak/bin/kc.sh start
