#!/bin/bash
# Tier 427 — AfA is counted in calendar months, by one implementation
#
# § 7 Abs. 1 EStG: AfA runs pro rata temporis by month — the month of
# acquisition counts in full, and so does the month of disposal. The day of
# the month never matters. It did: the month count added a month only when the
# later date's day-of-month was at least the earlier one's. Measured:
#   asset A  6 000 € / 60 months, bought 10.01.2025, sold 05.06.2026
#            → 17 months of AfA instead of 18 (Jan 2025 – Jun 2026), Buchwert
#              at disposal 4 300 € instead of 4 200 €
#   asset B  3 600 € / 36 months, bought 31.03.2026 (→ Mar 2026 – Feb 2029)
#            → 2029 AfA 300 € instead of 200 €: three months charged although
#              only January and February were left
# Anlage V had a second copy of the calculation, and the two disagreed: for
# asset B's last year the register said 300 € and Anlage V 200 €.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-216-$(date +%s%N | cut -c1-13)"

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier427-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path body
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
afa() { AS GET "/api/v1/assets/booking-status?companyId=$C&year=$1"; P "[a['computedAfA'] for a in d if a['bezeichnung']=='$2'][0]"; }

AS POST "/api/v1/assets?companyId=$C" '{"type":"Betriebsausstattung","bezeichnung":"A","anschaffungsDatum":"2025-01-10","anschaffungsKosten":6000,"nutzungsdauerMonate":60}'
A=$(json_field "$BODY" id)
AS POST "/api/v1/assets?companyId=$C" '{"type":"Betriebsausstattung","bezeichnung":"B","anschaffungsDatum":"2026-03-31","anschaffungsKosten":3600,"nutzungsdauerMonate":36}'
B=$(json_field "$BODY" id)
[[ -n "$A" && -n "$B" ]] && pass "fixture: two assets, 100 €/month each" || { fail "assets"; summary; exit 1; }

note "=== 1. the year of acquisition and the years in between ==="
assert_eq "A 2025: 12 months" "$(afa 2025 A)" "1200"
assert_eq "B 2026: Mar–Dec = 10 months" "$(afa 2026 B)" "1000"
assert_eq "B 2027: the full year" "$(afa 2027 B)" "1200"

note "=== 2. the last year of the useful life ==="
assert_eq "B 2029: Jan + Feb only (was 300 — three months)" "$(afa 2029 B)" "200"
assert_eq "B 2030: nothing left" "$(afa 2030 B)" "0"

note "=== 3. disposal: the month of the sale counts ==="
AS POST "/api/v1/assets/$A/dispose?companyId=$C" '{"verkauftAm":"2026-06-05","verkaufsPreis":4000}'
assert_eq "disposal recorded" "$STATUS" "201"
assert_eq "A 2026: Jan–Jun = 6 months" "$(afa 2026 A)" "600"
# The Buchwert at disposal is in the Berater package's Anlagenverzeichnis CSV.
curl -sS -o /tmp/t427.zip -H "x-user-id: $U" -H "x-company-id: $C" \
  "$API/api/v1/accounting/berater-packager?companyId=$C&year=2026"
BW=$(python3 - /tmp/t427.zip <<'PY'
import sys, zipfile, io, csv
z = zipfile.ZipFile(sys.argv[1])
name = [n for n in z.namelist() if 'nlagen' in n and n.endswith('.csv')][0]
rows = list(csv.reader(io.StringIO(z.read(name).decode('utf-8-sig')), delimiter=';'))
hi = next(i for i, r in enumerate(rows) if 'Bezeichnung' in r)
hdr = rows[hi]
out = []
for r in rows[hi + 1:]:
    if not r or len(r) < len(hdr): continue
    d = dict(zip(hdr, r))
    label = next((v for k, v in d.items() if 'ezeichnung' in k), '')
    bw = next((v for k, v in d.items() if 'Buchwert' in k), '')
    if label in ('A', 'B'): out.append(f"{label}:{bw}")
print(' '.join(sorted(out)) or '<no rows>')
PY
)
assert_eq "Buchwert: A 6000 − 18 × 100 (was 4.300,00), B 3600 − 10 × 100" "$BW" "A:4.200,00 B:2.600,00"

note "=== 4. Anlage V uses the same calculation ==="
# Anlage V only reports land and buildings, so the check needs one: same
# dates as B, 36 months, 100 €/month. The two implementations disagreed on
# exactly this asset — the register 300 €, Anlage V 200 €.
AS POST "/api/v1/assets?companyId=$C" '{"type":"Gebaeude","bezeichnung":"V","anschaffungsDatum":"2026-03-31","anschaffungsKosten":3600,"nutzungsdauerMonate":36}'
assert_eq "fixture: a building" "$STATUS" "201"
assert_eq "the register says 200 for 2029" "$(afa 2029 V)" "200"
AS GET "/api/v1/accounting/anlage-v?companyId=$C&year=2029"
assert_eq "Anlage V says the same 200 (the register used to say 300)" \
  "$(P "abs(sum(w['amount'] for w in d['werbungskosten'] if 'AfA' in w['label']))")" "200"

summary; exit $?
