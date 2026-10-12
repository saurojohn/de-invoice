#!/bin/bash
# Tier 666 — Anlage SO: reading the form writes nothing.
#
# GET /accounting/anlage-so/v2 stored the loss carried forward as it
# computed. Measured: with a loss in the year, every call updated the
# company's row and added a line to the audit log — every time the
# accounting page was opened, and for the adviser in read-only mode too. It
# wrote the whole `settings` back from the copy it had read at its start, so
# a setting saved in between was gone.
# And because the value was stored by looking, a year nobody had opened had
# none: a loss of 2025 was not carried into 2027 unless 2026 had been
# looked at first, and a correction of 2025 did not reach 2026 until 2026
# was opened again.
#
# Now the loss carried forward is stored when rows are saved or imported —
# for that year and the later ones that have rows — as one key in one
# statement, and a year without rows carries on what came before it.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-396-$(date +%s%N | cut -c1-13)"
AS() { # method path [body] [extra header]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${4:+-H "$4"} ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
field() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1" 2>/dev/null; }
SQL() { docker exec -i "$PG_CONTAINER" psql -U de_invoice -d de_invoice -q -At -c "$1"; }
tx() { echo "{\"type\":\"krypto\",\"description\":\"$1\",\"acquisitionDate\":\"$2\",\"acquisitionCost\":$3,\"saleDate\":\"$4\",\"salePrice\":$5}"; }
put() { AS PUT "/api/v1/accounting/anlage-so/settings?companyId=$C" "{\"year\":$1,\"transactions\":[$2],\"wiederkehrendeBezuege\":0,\"werbungskosten\":0}"; }
v2() { AS GET "/api/v1/accounting/anlage-so/v2?companyId=$C&year=$1" "" "${2:-}"; }
state() { SQL "SELECT (SELECT \"updatedAt\" FROM \"Company\" WHERE id = '$C') || ' / ' || (SELECT count(*) FROM \"AuditLog\" WHERE \"companyId\" = '$C')"; }
stored() { SQL "SELECT coalesce(settings->'anlageSOLossCarryforward', '{}'::jsonb)::text FROM \"Company\" WHERE id = '$C'" | tr -d ' '; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier666-e2e\",\"companyName\":\"$TAG\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }

note "=== 1. stored when the rows are saved ==="
put 2025 "$(tx 'BTC Verlust' 2025-01-10 5000 2025-06-10 1000)"
assert_eq "a loss of 4 000 € in 2025: saved" "$STATUS" "200"
assert_eq "… and carried forward, without anyone having looked at the form (was: nothing stored)" "$(stored)" '{"2025":4000}'
AS GET "/api/v1/accounting/anlage-so/loss-carryforward?companyId=$C&year=2026"
assert_eq "2026 carries 4 000 € in and, having no sales, out (was 4 000 in, 0 out until the form was opened)" \
  "$(field "(d['priorYearLoss'], d['currentYearLoss'])")" "(4000, 4000)"

note "=== 2. reading writes nothing ==="
BEFORE=$(state)
v2 2025; v2 2026; v2 2026; v2 2027
assert_eq "the form of 2026 shows the loss carried in" "$(field "1")|$STATUS" "1|200"
v2 2026; assert_eq "… 4 000 €" "$(field "(d['vg']['priorYearLoss'], d['vg']['carryforward'])")" "(4000, 4000)"
assert_eq "five looks at the form: the company's row and its audit log as before (was: a write and a line each)" "$(state)" "$BEFORE"
curl -sS -o /dev/null "$API/api/v1/accounting/anlage-so/v2.pdf?companyId=$C&year=2026" -H "x-user-id: $U" -H "x-company-id: $C"
curl -sS -o /dev/null "$API/api/v1/accounting/berater-packager?companyId=$C&year=2026" -H "x-user-id: $U" -H "x-company-id: $C"
assert_eq "… nor does the adviser's package write" "$(state)" "$BEFORE"
v2 2026 "x-readonly: 1"
assert_eq "read-only mode: the form opens" "$STATUS" "200"
assert_eq "… and nothing is written" "$(state)|$(stored)" "$BEFORE|{\"2025\":4000}"

note "=== 3. a year nobody opened still carries ==="
v2 2028
assert_eq "2028, with 2026 and 2027 empty and never saved: 4 000 € carried in (was 0 unless each year had been opened)" \
  "$(field "d['vg']['priorYearLoss']")" "4000"

note "=== 4. a year's change reaches the years after it ==="
put 2026 "$(tx 'ETH' 2026-01-10 1000 2026-06-10 1500)"
assert_eq "2026: a gain of 500 € — set off, 3 500 € go on" "$(stored)" '{"2025":4000,"2026":3500}'
v2 2026; assert_eq "… nothing taxable in 2026" "$(field "(d['vg']['totalTaxableGain'], d['vg']['vgTotal'], d['vg']['carryforward'])")" "(0, 0, 3500)"
put 2025 "$(tx 'BTC Verlust' 2025-01-10 5000 2025-06-10 3500)"
assert_eq "2025 corrected to a loss of 1 500 €: 2026 follows at once (was: when 2026 was next opened)" "$(stored)" '{"2025":1500,"2026":1000}'
put 2025 ""
assert_eq "2025 emptied: no entry for it, and 2026 carries nothing" "$(stored)" '{"2026":0}'
v2 2026; assert_eq "… its 500 € gain stays below the limit" "$(field "(d['vg']['priorYearLoss'], d['vg']['totalTaxableGain'], d['vg']['vgTotal'])")" "(0, 500, 0)"

note "=== 5. only its own key ==="
AS PUT "/api/v1/accounting/gewst/settings?companyId=$C" '{"year":2026,"q1":0,"q2":0,"q3":0,"q4":0,"hebesatz":410}'
assert_eq "fixture: a Hebesatz saved" "$STATUS" "200"
put 2026 "$(tx 'ETH Verlust' 2026-01-10 3000 2026-06-10 1000)"
assert_eq "the carryforward stored" "$(stored)" '{"2026":2000}'
assert_eq "… and the Hebesatz, and the rows, are where they were" \
  "$(SQL "SELECT (settings->>'hebesatz') || '|' || jsonb_array_length(settings->'anlageSO'->'2026'->'transactions') FROM \"Company\" WHERE id = '$C'")" "410|1"

# entries left from the time when a look at an empty year stored what it carried
SQL "UPDATE \"Company\" SET settings = jsonb_set(settings, '{anlageSOLossCarryforward}', '{\"2026\":2000,\"2027\":4000,\"2028\":4000}'::jsonb) WHERE id = '$C'" >/dev/null
put 2026 "$(tx 'ETH Verlust' 2026-01-10 3000 2026-06-10 2500)"
assert_eq "a save clears what an earlier look had left for the empty years after it" "$(stored)" '{"2026":500}'
v2 2029; assert_eq "… and 2029 is carried the 500 €, not the 4 000 € of old" "$(field "d['vg']['priorYearLoss']")" "500"

note "=== 6. in the code ==="
SVC="$SCRIPT_DIR/../src/modules/accounting/anlage-so-v2.service.ts"
COMPUTE=$(awk '/^  async compute\(/,/^  async getLossCarryforward\(/' "$SVC")
echo "$COMPUTE" | grep -q "\.update(\|\$executeRaw" && fail "compute() writes" || pass "compute() writes nothing"
grep -q "jsonb_set(coalesce(settings, '{}'::jsonb), '{anlageSOLossCarryforward}'" "$SVC" \
  && pass "the carryforward is one key, replaced in one statement" || fail "the carryforward is written with the whole settings"

summary
