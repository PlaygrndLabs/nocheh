#!/bin/sh
set -eu

ready=/tmp/nocheh-stores-ready
rm -f "$ready"
docker-entrypoint.sh "$@" &
database_pid=$!

stop_database() {
  trap - TERM INT
  kill -TERM "$database_pid" 2>/dev/null || true
  wait "$database_pid" 2>/dev/null || true
}
trap stop_database TERM INT

attempt=0
until pg_isready -h 127.0.0.1 -U nocheh -d nocheh >/dev/null 2>&1; do
  if ! kill -0 "$database_pid" 2>/dev/null; then
    wait "$database_pid"
    exit 1
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 300 ]; then
    stop_database
    exit 1
  fi
  sleep 0.1
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
wait "$database_pid"
