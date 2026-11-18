#!/bin/bash
# Tier 864 — the containers' own logs are rotated
#
# Security audit (18.11.2026), item 14. Docker's json-file driver kept every
# container's stdout without end — Caddy's access log (each visitor's address
# and pages), the backend's warnings (addresses, e-mail addresses) — for as
# long as the container lived, and until the disk was full. Loki (31 days)
# only ever saw a copy. Now every service of the production compose file
# rotates: at most 5 files of 10 MB.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
PROD="$SCRIPT_DIR/../../infra/prod"
if ! docker compose version >/dev/null 2>&1; then
  note "SKIP: docker compose is not available here"; summary; exit 0
fi
D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
printf 'POSTGRES_PASSWORD=x\nJWT_SECRET=x\nFRONTEND_URL=https://rechnung.example.test\nFINTS_PIN_ENC_KEY=x0123456789abcdef0123456789abcdef\nSETUP_TOKEN=x\n' > "$D/env"
docker compose --env-file "$D/env" -f "$PROD/docker-compose.yml" --profile offsite config --format json > "$D/cfg" 2> "$D/err"
assert_eq "the compose file resolves (with the off-site profile)" "$?" "0"
# (the check in a heredoc: a {…, …} inside "$( … )" is brace-expanded by bash)
ROTATED=$(python3 - "$D/cfg" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))['services']
want = {'driver': 'json-file', 'options': {'max-size': '10m', 'max-file': '5'}}
bad = [n for n, s in sorted(d.items()) if (s.get('logging') or {}) != want]
print(len(d), 'services,', 'none without' if not bad else 'without: ' + ' '.join(bad))
PY
)
assert_eq "every service rotates its log: json-file, 10 MB, 5 files (was: no limit)" "$ROTATED" "6 services, none without"

# the monitoring overlays too (Prometheus, Grafana, Loki, Promtail, …)
echo 'GRAFANA_ADMIN_PASSWORD=x' >> "$D/env"
docker compose --env-file "$D/env" -f "$PROD/docker-compose.yml" -f "$PROD/monitoring.yml" -f "$PROD/docker-compose.observability.yml" config --format json > "$D/cfg" 2> "$D/err"
assert_eq "with both overlays: resolves" "$?" "0"
ROTATED=$(python3 - "$D/cfg" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))['services']
want = {'driver': 'json-file', 'options': {'max-size': '10m', 'max-file': '5'}}
bad = [n for n, s in sorted(d.items()) if (s.get('logging') or {}) != want]
print('none without' if not bad else 'without: ' + ' '.join(bad))
PY
)
assert_eq "…every service of the overlays rotates its log too" "$ROTATED" "none without"
summary
