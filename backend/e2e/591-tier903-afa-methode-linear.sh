#!/bin/bash
# Tier 903 — the AfA method is the one computed: linear
#
# Measured: POST /assets took any word up to 20 characters as `afaMethode`
# ("degressiv", "abc", …); the AfA was computed linear all the same (afa.ts
# knows no other method), and the Steuerberater package wrote „degressiv“
# beside linear figures in its Anlagenverzeichnis.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-591-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier903-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
field() { python3 -c "import json,sys;print(json.loads(sys.argv[1]).get(sys.argv[2]))" "$BODY" "$1"; }
assert_contains() { [[ "$2" == *"$3"* ]] && pass "$1" || fail "$1 — got: ${2:0:300}"; }
q="companyId=$C"
asset() { AS POST "/api/v1/assets?$q" "{\"type\":\"Maschine\",\"bezeichnung\":\"Presse 591\",\"anschaffungsDatum\":\"2026-01-01\",\"anschaffungsKosten\":6000,\"nutzungsdauerMonate\":60,\"restwert\":0${1:+,\"afaMethode\":\"$1\"}}"; }

asset degressiv
assert_eq "afaMethode „degressiv“: refused (was: stored, the AfA computed linear)" "$STATUS" "400"
assert_contains "…says the AfA computed is the linear one" "$BODY" "lineare AfA"
asset abc
assert_eq "afaMethode „abc“: refused" "$STATUS" "400"
asset linear
assert_eq "„linear“: created" "$STATUS/$(field afaMethode)" "201/linear"
A=$(field id)
asset
assert_eq "no method: created, linear" "$STATUS/$(field afaMethode)" "201/linear"
AS PATCH "/api/v1/assets/$A?$q" '{"afaMethode":"degressiv"}'
assert_eq "changed to „degressiv“: refused" "$STATUS" "400"
AS PATCH "/api/v1/assets/$A?$q" '{"notiz":"geprüft"}'
assert_eq "…a note can be changed" "$STATUS" "200"

summary
