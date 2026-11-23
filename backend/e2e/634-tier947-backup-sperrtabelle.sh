#!/bin/bash
# Tier 947 — the nightly backup and the number of sequences
#
# pg_dump reads every sequence in one transaction and holds a lock on each
# until it ends; the shared lock table has room for
# max_locks_per_transaction × (max_connections + max_prepared_transactions)
# — 64 × 100 = 6 400 by default. The invoice numbers are a sequence per
# company, document type and year (invoice-number.ts). Measured on the test
# database (19 225 companies, 14 372 sequences): pg_dump „out of shared
# memory — You might need to increase max_locks_per_transaction“, the backup
# failed (specs 42 and 144). The production compose file kept the default:
# some 600 companies numbering by year would have stopped its backups.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
COMPOSE="$SCRIPT_DIR/../../infra/prod/docker-compose.yml"

note "=== the production database's setting ==="
SETTING=$(python3 - "$COMPOSE" <<'PY'
import re, sys
text = open(sys.argv[1]).read()
# the postgres service: from "  postgres:" to the next service at the same depth
m = re.search(r'^  postgres:\n(.*?)(?=^  [A-Za-z0-9_-]+:\n)', text, re.S | re.M)
block = m.group(1) if m else ''
cmd = re.search(r'^    command:\s*(.+)$', block, re.M)
val = re.search(r'max_locks_per_transaction=(\d+)', cmd.group(1)) if cmd else None
print(val.group(1) if val else 'none')
PY
)
assert_eq "docker-compose.yml starts Postgres with max_locks_per_transaction (was the default 64)" \
  "$(python3 -c "print('$SETTING'.isdigit() and int('$SETTING') >= 1024)")" "True"

IMG="postgres:16-alpine"
if docker image inspect "$IMG" >/dev/null 2>&1; then
  # a throwaway server started the way the compose file starts it
  NAME="t947-pg-$$"
  trap 'docker rm -f "$NAME" >/dev/null 2>&1' EXIT
  docker run -d --rm --pull=never --name "$NAME" -e POSTGRES_PASSWORD=probe-only "$IMG" postgres -c "max_locks_per_transaction=$SETTING" >/dev/null
  GOT=""
  for _ in $(seq 1 40); do
    GOT=$(docker exec "$NAME" psql -U postgres -Atc "show max_locks_per_transaction" 2>/dev/null)
    [[ -n "$GOT" ]] && break
    sleep 1
  done
  assert_eq "…and $IMG runs with it, started that way" "$GOT" "$SETTING"
else
  note "SKIP: the $IMG image is not here"
fi

note "=== the test database: room for what pg_dump locks ==="
read -r RELS ROOM < <(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc \
  "select (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','S','p','m','v')),
          current_setting('max_locks_per_transaction')::int * (current_setting('max_connections')::int + current_setting('max_prepared_transactions')::int)" | tr '|' ' ')
assert_eq "its tables and sequences ($RELS) fit the lock table ($ROOM) — else the backup specs fail" \
  "$(python3 -c "print(int('${RELS:-0}') < int('${ROOM:-0}') * 0.9)")" "True"

summary
