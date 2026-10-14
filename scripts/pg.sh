#!/usr/bin/env bash
# Project-local Postgres cluster manager for Tabsend (Chunk 4a).
#
# We run a throwaway, project-local pg_ctl cluster (NOT `brew services`) so the
# database is isolated to this repo, easy to reset, and never clashes with a
# system Postgres. Data lives in .pgdata/ (gitignored) on a non-default port so
# a system Postgres on 5432 is left untouched.
#
# Usage:
#   scripts/pg.sh init     # create the cluster (once)
#   scripts/pg.sh start     # start it
#   scripts/pg.sh stop      # stop it
#   scripts/pg.sh createdb  # create the tabsend_test database
#   scripts/pg.sh status
#   scripts/pg.sh url       # print the TABSEND_TEST_PG_URL to export
#   scripts/pg.sh nuke      # stop + delete the cluster entirely
set -euo pipefail

# macOS + Homebrew Postgres 17 aborts with "postmaster became multithreaded
# during startup" unless a concrete locale is set; C is safe and deterministic.
export LC_ALL="${LC_ALL:-C}"

PGBIN="${TABSEND_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGDATA="$ROOT/.pgdata"
PGPORT="${TABSEND_PG_PORT:-55432}"
PGUSER="postgres"
TESTDB="tabsend_test"
URL="postgres://$PGUSER@127.0.0.1:$PGPORT/$TESTDB"

case "${1:-}" in
  init)
    if [ -d "$PGDATA" ]; then echo "cluster already exists at $PGDATA"; exit 0; fi
    "$PGBIN/initdb" --locale=C -E UTF-8 -U "$PGUSER" "$PGDATA"
    {
      echo "unix_socket_directories = '$PGDATA'"
      echo "port = $PGPORT"
      echo "listen_addresses = '127.0.0.1'"
    } >> "$PGDATA/postgresql.conf"
    echo "initialized $PGDATA on port $PGPORT"
    ;;
  start)
    "$PGBIN/pg_ctl" -D "$PGDATA" -l "$PGDATA/server.log" -w start
    ;;
  stop)
    "$PGBIN/pg_ctl" -D "$PGDATA" -m fast stop
    ;;
  status)
    "$PGBIN/pg_ctl" -D "$PGDATA" status || true
    ;;
  createdb)
    "$PGBIN/createdb" -h 127.0.0.1 -p "$PGPORT" -U "$PGUSER" "$TESTDB" 2>/dev/null \
      && echo "created database $TESTDB" \
      || echo "database $TESTDB already exists"
    ;;
  url)
    echo "$URL"
    ;;
  nuke)
    "$PGBIN/pg_ctl" -D "$PGDATA" -m immediate stop 2>/dev/null || true
    rm -rf "$PGDATA"
    echo "removed $PGDATA"
    ;;
  *)
    echo "usage: scripts/pg.sh {init|start|stop|status|createdb|url|nuke}" >&2
    exit 1
    ;;
esac
