#!/bin/bash
# Tier 561 — the proxy configuration is one Caddy accepts
#
# infra/prod/Caddyfile was written by hand and never run through Caddy.
# Measured with the image the compose file names (caddy:2-alpine, v2.11):
#   "parsing caddyfile tokens for 'reverse_proxy': unrecognized subdirective
#    timeout" — and behind that a `rate_limit` directive stock Caddy does not
# have, a reverse_proxy with three matchers, a `{path.1}` placeholder, and in
# the staging file an `on_demand_tls { ask "<a sentence>" }`. The proxy would
# not have started; the first deployment would have had no site.
# Both files are rewritten; this validates them with that image.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
IMG="caddy:2-alpine"
PROD="$SCRIPT_DIR/../../infra/prod"
if ! docker image inspect "$IMG" >/dev/null 2>&1 && ! docker pull -q "$IMG" >/dev/null 2>&1; then
  note "SKIP: the $IMG image is not available here"; summary; exit 0
fi
for f in Caddyfile Caddyfile.staging; do
  OUT=$(docker run --rm -v "$PROD/$f:/etc/caddy/Caddyfile:ro" "$IMG" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1)
  grep -q "Valid configuration" <<<"$OUT" && pass "$f: Caddy accepts it" || fail "$f: $(grep '"level":"error"' <<<"$OUT" | head -1 | cut -c1-300)"
done
# the way the compose file starts it
OUT=$(docker run --rm -v "$PROD/Caddyfile:/etc/caddy/Caddyfile:ro" "$IMG" caddy validate --config /etc/caddy/Caddyfile --adapter "" 2>&1)
grep -q "Valid configuration" <<<"$OUT" && pass "…also with the arguments in docker-compose.yml" || fail "compose arguments: $(tail -1 <<<"$OUT" | cut -c1-200)"
JSON=$(docker run --rm -v "$PROD/Caddyfile:/etc/caddy/Caddyfile:ro" "$IMG" caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile 2>/dev/null)
assert_eq "/metrics is answered by the proxy, not forwarded" "$(python3 -c "
import json,sys
def walk(o):
    if isinstance(o,dict):
        m=o.get('match') or []
        if any('/metrics' in (x.get('path') or []) for x in m if isinstance(x,dict)):
            yield json.dumps(o)
        for v in o.values(): yield from walk(v)
    elif isinstance(o,list):
        for v in o: yield from walk(v)
r=list(walk(json.loads(sys.stdin.read())))
print(len(r)>0 and all('static_response' in x and 'reverse_proxy' not in x for x in r))" <<<"$JSON")" "True"
assert_eq "no client-controlled X-Forwarded-For is written into the request" "$(grep -c 'X-Forwarded-For' "$PROD/Caddyfile" | tr -d ' ')/$(grep -c 'header_up X-Forwarded' "$PROD/Caddyfile" | tr -d ' ')" "1/0"
# Tier 562: the backup container gets the variables its image reads. With
# PGHOST / PGDATABASE it stopped at start ("You need to set the POSTGRES_DB …")
# and no dump was ever written.
C="$PROD/docker-compose.yml"
assert_eq "the backup container is told its database the way the image expects" "$(grep -c '^      POSTGRES_HOST: postgres$' "$C")/$(grep -c '^      PGHOST:\|^      PGDATABASE:' "$C")" "1/0"
# Tier 563: the backup image's PostgreSQL version is the server's. Untagged it
# was pg_dump 18 against a 16 server; its dumps do not load cleanly there.
PGV=$(grep -o 'image: postgres:[0-9]*' "$C" | head -1 | grep -o '[0-9]*$')
assert_eq "the backup image is pinned to the server's PostgreSQL version ($PGV)" "$(grep -c "image: prodrigestivill/postgres-backup-local:$PGV\$" "$C")" "1"
assert_eq "the compose project has a fixed name (the volume names follow from it)" "$(grep -c '^name: de-invoice-prod$' "$C")" "1"
bash -n "$PROD/restore.sh" && pass "restore.sh parses" || fail "restore.sh has a syntax error"
assert_eq "…and the docs send a restore through it, not through a pipe into the live database" "$(grep -c 'bash infra/prod/restore.sh' "$PROD/README.md" | awk '{print ($1>=2)}')/$(grep -c 'docker exec -i de-invoice-postgres psql' "$PROD/README.md")" "1/0"
# Tier 569: the backend image carries the official XRechnung validator —
# its files come in as a named build context, Java from the image itself.
assert_eq "the compose file hands the validator's files to the backend build" "$(grep -A1 'additional_contexts:' "$C" | grep -c 'kosit: ../kosit')" "1"
assert_eq "…and the image has a Java runtime and a place for them" "$(grep -c 'openjdk-17-jre-headless' "$SCRIPT_DIR/../Dockerfile")/$(grep -c '^COPY --from=kosit / /infra/kosit/' "$SCRIPT_DIR/../Dockerfile")" "1/1"
# Tier 580: the image runs the compiled program, and something builds it.
DF="$SCRIPT_DIR/../Dockerfile"
assert_eq "the backend image compiles the program and starts the result (was ts-node)" "$(grep -c '^RUN npx tsc -p tsconfig.json' "$DF")/$(grep -c '^CMD \["node", "--enable-source-maps", "dist/main.js"\]$' "$DF")/$(grep -c '^CMD.*ts-node' "$DF")" "1/1/0"
assert_eq "…without the development packages" "$(grep -c '^RUN npm prune --omit=dev' "$DF")/$(grep -c '^COPY --from=build .*/app/dist ./dist' "$DF")" "1/1"
WF="$SCRIPT_DIR/../../.github/workflows/docker-build.yml"
assert_eq "a workflow builds both images when their ingredients change, and pushes nothing" "$(grep -c "backend/Dockerfile'\|frontend/Dockerfile'\|backend/package-lock.json'\|frontend/package-lock.json'" "$WF")/$(grep -c 'push: false' "$WF")/$(grep -c "kosit=./infra/kosit" "$WF")" "4/1/1"
summary
