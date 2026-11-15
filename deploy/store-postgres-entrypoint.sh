#!/bin/sh
set -eu

ready=/tmp/nocheh-stores-ready
rm -f "$ready"
docker-entrypoint.sh "$@" &
database_pid=$!
retention_pid=
schema_pid=

stop_database() {
  trap - TERM INT
  for pid in $schema_pid $retention_pid; do kill -TERM "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; done
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

# Development starts from the newest finished build when there is one: rows the
# current code wrote can fail an older image's schema checks on restart.
bootstrap=/app/dist/src/stores/bootstrap.js
applied=
if [ -n "${NOCHEH_DEV_DIST:-}" ]; then
  applied=$(cat "$NOCHEH_DEV_DIST/.dev-ready" 2>/dev/null || true)
  if [ -n "$applied" ]; then bootstrap=$NOCHEH_DEV_DIST/src/stores/bootstrap.js; fi
fi

# An inactive restore must expose PostgreSQL to its recovery coordinator without
# making restored runtime roles usable or running application initialization.
if [ ! -e /data/spool/.restore-inactive ]; then
  if ! PGHOST=127.0.0.1 PGUSER=nocheh PGDATABASE=nocheh \
    PGPASSWORD="$POSTGRES_PASSWORD" node "$bootstrap"; then
    stop_database
    exit 1
  fi
fi

touch "$ready"
# Development mounts the app's generated code at NOCHEH_DEV_DIST. Each finished
# source build can add tables, so store provisioning runs again with that code
# rather than leaving it to fail against the old schema until an image rebuild.
# A build counts as applied only once provisioning succeeds: a failed run (a
# backup holding the maintenance lock, a lock conflict) is tried again, waiting
# a little longer each time, up to 30 s.
if [ -n "${NOCHEH_DEV_DIST:-}" ] && [ ! -e /data/spool/.restore-inactive ]; then
  (
    pending=
    failures=0
    while :; do
      current=$(cat "$NOCHEH_DEV_DIST/.dev-ready" 2>/dev/null || true)
      if [ -n "$current" ] && [ "$current" != "$applied" ]; then
        if [ "$current" != "$pending" ]; then pending=$current; failures=0; fi
        if PGHOST=127.0.0.1 PGUSER=nocheh PGDATABASE=nocheh PGPASSWORD="$POSTGRES_PASSWORD" \
          node "$NOCHEH_DEV_DIST/src/stores/bootstrap.js"; then
          applied=$current
          failures=0
        else
          failures=$((failures + 1))
          echo "{\"event\":\"development_schema_update_failed\",\"attempt\":$failures}" >&2
          delay=$((failures * 2))
          if [ "$delay" -gt 30 ]; then delay=30; fi
          sleep "$delay"
        fi
      fi
      sleep 2
    done
  ) &
  schema_pid=$!
fi
# Workflow history expiry: 14 days unless the owner sets other days or 0 (off).
if [ ! -e /data/spool/.restore-inactive ]; then
  node /app/dist/src/workflows/retention.js &
  retention_pid=$!
fi
wait "$database_pid"
