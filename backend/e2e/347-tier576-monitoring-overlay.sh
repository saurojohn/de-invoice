#!/bin/bash
# Tier 576 — the monitoring overlays can be added to the production stack
#
# infra/prod/monitoring.yml and docker-compose.observability.yml are used as
# `-f docker-compose.yml -f <overlay>`. Measured with `docker compose config`:
#   - both declared the network as `name: deinvoicenet, external: true`; merged
#     with the main file the app's own network became an external one nothing
#     creates — adding an overlay kept the whole stack from starting;
#   - the observability overlay published Prometheus (no login) on 9090 and
#     Grafana on 3001 on every interface (Docker's published ports pass ufw);
#   - Grafana's admin password defaulted to "admin".
# Nothing is started or downloaded here: the files are only resolved.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
PROD="$SCRIPT_DIR/../../infra/prod"
if ! docker compose version >/dev/null 2>&1; then
  note "SKIP: docker compose is not available here"; summary; exit 0
fi
D=$(mktemp -d)
printf 'POSTGRES_PASSWORD=x\nJWT_SECRET=x\nFRONTEND_URL=https://rechnung.example.test\n' > "$D/env"
cp "$D/env" "$D/env-grafana"; echo 'GRAFANA_ADMIN_PASSWORD=ein-gesetztes-passwort' >> "$D/env-grafana"
resolve() { # env-file overlay → exit code; output in $D/cfg(.err)
  docker compose --env-file "$1" -f "$PROD/docker-compose.yml" -f "$PROD/$2" config --format json > "$D/cfg" 2> "$D/cfg.err"
}
cfg() { python3 -c "import sys,json;d=json.load(open(sys.argv[1]));print(eval(sys.argv[2]))" "$D/cfg" "$1" 2>/dev/null; }

for overlay in monitoring.yml docker-compose.observability.yml; do
  note "=== docker-compose.yml + $overlay ==="
  resolve "$D/env" "$overlay"
  assert_eq "without GRAFANA_ADMIN_PASSWORD it does not resolve — and says why" "$?/$(grep -c 'GRAFANA_ADMIN_PASSWORD is required' "$D/cfg.err")" "1/1"
  resolve "$D/env-grafana" "$overlay"
  assert_eq "with it: resolves" "$?" "0"
  assert_eq "the network is the stack's own, not an external one" "$(cfg "d['networks']['deinvoicenet'].get('external', False), d['networks']['deinvoicenet']['name']")" "(False, 'de-invoice-prod_deinvoicenet')"
  assert_eq "the app and the monitoring services are on that one network" "$(cfg "sorted(set(n for s in d['services'].values() for n in (s.get('networks') or [])))")" "['deinvoicenet']"
  assert_eq "Grafana gets the password that was set" "$(cfg "d['services']['grafana']['environment']['GF_SECURITY_ADMIN_PASSWORD']")" "ein-gesetztes-passwort"
  # every published port of a monitoring service is bound to localhost
  assert_eq "nothing of the overlay is published beyond localhost" "$(cfg "sorted(n + ':' + str(p.get('published')) for n, s in d['services'].items() if n != 'caddy' for p in (s.get('ports') or []) if p.get('host_ip') != '127.0.0.1')")" "[]"
  assert_eq "…and Prometheus and Grafana are published there" "$(cfg "[d['services'][n]['ports'][0]['host_ip'] + ':' + str(d['services'][n]['ports'][0]['published']) for n in ('prometheus', 'grafana')]")" "['127.0.0.1:9090', '127.0.0.1:3001']"
done
note "=== both overlays together ==="
docker compose --env-file "$D/env-grafana" -f "$PROD/docker-compose.yml" -f "$PROD/monitoring.yml" -f "$PROD/docker-compose.observability.yml" config --format json > "$D/cfg" 2> "$D/cfg.err"
assert_eq "resolve as one stack" "$?/$(cfg "d['networks']['deinvoicenet'].get('external', False)")" "0/False"
note "=== the stack without an overlay is as before ==="
docker compose --env-file "$D/env" -f "$PROD/docker-compose.yml" config --format json > "$D/cfg" 2> "$D/cfg.err"
assert_eq "resolves without a Grafana password, and only the proxy is published to the outside" "$?/$(cfg "sorted(set(n for n, s in d['services'].items() for p in (s.get('ports') or []) if p.get('host_ip') != '127.0.0.1'))")" "0/['caddy']"
rm -rf "$D"
summary
