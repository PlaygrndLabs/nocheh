#!/bin/sh
set -eu

ready=/tmp/nocheh-stores-ready
rm -f "$ready"
docker-entrypoint.sh "$@" &
database_pid=$!
retention_pid=

stop_database() {
  trap - TERM INT
  if [ -n "$retention_pid" ]; then kill -TERM "$retention_pid" 2>/dev/null || true; wait "$retention_pid" 2>/dev/null || true; fi
  kill -TERM "$database_pid" 2>/dev/null || true
  wait "$database_pid" 2>/dev/null || true
}
trap stop_database TERM INT

until pg_isready -h 127.0.0.1 -U nocheh -d nocheh >/dev/null 2>&1; do
  if ! kill -0 "$database_pid" 2>/dev/null; then
    wait "$database_pid"
    exit 1
  fi
  # WAL replay on an existing volume can outlast a fixed startup deadline.
  # Keep the database alive while its own process is making recovery possible.
  sleep 1
done

# An inactive restore must expose PostgreSQL to its recovery coordinator without
# making restored runtime roles usable or running application initialization.
if [ ! -e /data/spool/.restore-inactive ]; then
  if ! PGHOST=127.0.0.1 PGUSER=nocheh PGDATABASE=nocheh \
    PGPASSWORD="$POSTGRES_PASSWORD" node /app/dist/src/stores/bootstrap.js; then
    stop_database
    exit 1
  fi
fi

touch "$ready"
# Optional workflow telemetry expiry; off unless the owner configures days.
if [ ! -e /data/spool/.restore-inactive ]; then
  node /app/dist/src/workflows/retention.js &
  retention_pid=$!
fi
wait "$database_pid"
