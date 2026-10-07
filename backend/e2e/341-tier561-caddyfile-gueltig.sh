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
summary
