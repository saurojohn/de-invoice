#!/bin/bash
# Tier 581 — one expense for an invoice with several VAT rates
#
# An Expense had one rate, so an invoice with 19 % and 7 % was two expenses
# under one number (by hand with "confirmDuplicate", or two by the e-invoice
# import). Now POST / PUT /expenses take `taxLines` — one line per rate — and
# the expense's amounts are their sums. Everything that needs the split reads
# the lines: the UStVA (Vorsteuer by rate), DATEV (one row and key per rate),
# the bank booking (a Vorsteuer line per rate), Skonto (a credit note with
# the same rates).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-349-$(date +%s%N | cut -c1-13)"
Y=2026
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
REG="{\"email\":\"$TAG@example.test\",\"password\":\"Tier581-e2e\",\"companyName\":\"$TAG GmbH\"}"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$REG" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
py() { echo "$BODY" | python3 -c "import sys,json;d=json.load(sys.stdin);$1" 2>/dev/null; }
rows() { q "select coalesce(string_agg(\"vatRate\"::numeric(4,2)||'/'||\"netAmount\"::numeric(12,2)||'/'||\"vatAmount\"::numeric(12,2), ',' order by position), '-') from \"ExpenseTaxLine\" where \"expenseId\"='$1'"; }
totals() { q "select \"netAmount\"::numeric(12,2)||'/'||\"vatAmount\"::numeric(12,2)||'/'||\"grossAmount\"::numeric(12,2)||'/'||\"vatRate\"::numeric(4,2) from \"Expense\" where id='$1'"; }
vorsteuer() { AS GET "/api/v1/ustva/compute?companyId=$C&year=$Y&month=6"; py 'v=d["vorsteuer"];print(v["from19"], v["from7"], v["total"])'; }

AS POST "/api/v1/suppliers?companyId=$C" '{"name":"'$TAG' Lieferant","address":{"street":"a","city":"b","postalCode":"1","country":"DE"},"bankInfo":{"iban":"DE89370400440532013000","bic":"COBADEFFXXX"}}'
S=$(json_field "$BODY" id)
LINES='[{"vatRate":0.19,"netAmount":200,"vatAmount":38},{"vatRate":0.07,"netAmount":107.14,"vatAmount":7.5}]'
mk() { # number extra-json → $ID (and STATUS / BODY; not to be called in a subshell)
  AS POST "/api/v1/expenses?companyId=$C" '{"supplierId":"'$S'","invoiceNumber":"'$1'","description":"Papier und Bücher","invoiceDate":"'$Y'-06-01"'"$2"'}'
  ID=$(json_field "$BODY" id)
}

note "=== 1. one expense, two rates ==="
mk ER-MIX ',"taxLines":'"$LINES"; E=$ID
assert_eq "POST /expenses with taxLines" "$STATUS" "201"
assert_eq "…the amounts are the lines' sums, the rate that of the largest line" "$(totals "$E")" "307.14/45.50/352.64/0.19"
assert_eq "…the lines are stored" "$(rows "$E")" "0.19/200.00/38.00,0.07/107.14/7.50"
assert_eq "…and come back with the expense" "$(py 'print([(float(l["vatRate"]), float(l["netAmount"]), float(l["vatAmount"])) for l in d["taxLines"]])')" "[(0.19, 200.0, 38.0), (0.07, 107.14, 7.5)]"
AS GET "/api/v1/expenses?companyId=$C"
assert_eq "the list carries them" "$(py 'print([len(e["taxLines"]) for e in d["data"]])')" "[2]"
AS GET "/api/v1/ustva/expenses?companyId=$C&year=$Y&month=6"
assert_eq "…the UStVA page's list too" "$(py 'print([len(e["taxLines"]) for e in d])')" "[2]"

note "=== 2. what is refused ==="
N0=$(q "select count(*) from \"Expense\" where \"companyId\"='$C'")
no() { mk "ER-NO-$RANDOM" "$2"; assert_eq "$1: 400" "$STATUS" "400"; }
no "the same rate twice" ',"taxLines":[{"vatRate":0.19,"netAmount":100,"vatAmount":19},{"vatRate":0.19,"netAmount":50,"vatAmount":9.5}]'
no "a line with more VAT than its rate gives" ',"taxLines":[{"vatRate":0.19,"netAmount":100,"vatAmount":19},{"vatRate":0.07,"netAmount":100,"vatAmount":19}]'
no "totals that are not the lines' sums" ',"grossAmount":500,"taxLines":'"$LINES"
# (Tier 587: "lines on a § 13b expense" stood here as a POST with isReverseCharge —
# a property POST /expenses does not know, so the 400 came from the DTO and
# proved nothing. The real cases are in section 7d.)
no "a line without amounts" ',"taxLines":[{"vatRate":0.19},{"vatRate":0.07,"netAmount":10,"vatAmount":0.7}]'
no "a negative line" ',"taxLines":[{"vatRate":0.19,"netAmount":-100,"vatAmount":-19},{"vatRate":0.07,"netAmount":10,"vatAmount":0.7}]'
no "lines that are not a list" ',"taxLines":"19"'
no "an empty list" ',"taxLines":[]'
no "nine lines" ',"taxLines":[{"vatRate":0.01,"netAmount":1,"vatAmount":0.01},{"vatRate":0.02,"netAmount":1,"vatAmount":0.02},{"vatRate":0.03,"netAmount":1,"vatAmount":0.03},{"vatRate":0.04,"netAmount":1,"vatAmount":0.04},{"vatRate":0.05,"netAmount":1,"vatAmount":0.05},{"vatRate":0.06,"netAmount":1,"vatAmount":0.06},{"vatRate":0.07,"netAmount":1,"vatAmount":0.07},{"vatRate":0.08,"netAmount":1,"vatAmount":0.08},{"vatRate":0.09,"netAmount":1,"vatAmount":0.09}]'
assert_eq "none of them left an expense" "$(q "select count(*) from \"Expense\" where \"companyId\"='$C'")" "$N0"
mk ER-ONE ',"taxLines":[{"vatRate":0.07,"netAmount":100,"vatAmount":7}]'; ONE=$ID
assert_eq "a single line is an ordinary one-rate expense: no rows" "$STATUS/$(totals "$ONE")/$(rows "$ONE")" "201/100.00/7.00/107.00/0.07/-"
mk GS-MIX ',"creditNote":true,"taxLines":[{"vatRate":0.19,"netAmount":10,"vatAmount":1.9},{"vatRate":0.07,"netAmount":10,"vatAmount":0.7}]'; CN=$ID
assert_eq "a credit note with two rates is stored negative, lines too" "$STATUS/$(totals "$CN")/$(rows "$CN")" "201/-20.00/-2.60/-22.60/0.19/0.19/-10.00/-1.90,0.07/-10.00/-0.70"

note "=== 3. the UStVA takes each line by its rate ==="
# ER-MIX 38 + 7.50, ER-ONE 7 (7 %), GS-MIX −1.90 − 0.70
assert_eq "Vorsteuer 19 % / 7 % / total (was: all of an invoice under one rate)" "$(vorsteuer)" "36.1 13.8 49.9"

note "=== 4. DATEV: one row and key per rate ==="
D=$(mktemp -d)
curl -sS -o "$D/d.csv" -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/reports/datev-export?companyId=$C&startDate=$Y-01-01&endDate=$Y-12-31"
assert_eq "ER-MIX: 238,00 with key 9 and 114,64 with key 8" "$(datev_rows "$D/d.csv" | awk -F'\t' '$1 == "ER-MIX" { printf "%s:%s ", $5, $7 }')" "238.00:9 114.64:8 "
KRED=$(datev_rows "$D/d.csv" | awk -F'\t' '$1 == "ER-MIX" { print $3; exit }')
assert_eq "the Kreditor is owed all three documents: 352,64 + 107,00 − 22,60" "$(datev_balance "$D/d.csv" "$KRED")" "-437.04"

note "=== 5. the bank pays it: a Vorsteuer line per rate ==="
MT="$D/s.mt940"
{
  printf '%s\n' ':1:F01BANKBICAXXX0000000000' ':20:ST581' ':25:DE89370400440532013000' ':28C:1/1' ':60F:C260601EUR5000,00'
  printf '%s\n' ':61:2606100610D352,64NTRFNONREF//ER-MIX' 'Lieferant'
  printf '%s\n' ':61:2606110611D345,59NTRFNONREF//ER-SK mit Skonto' 'Lieferant'
  printf '%s\n' ':61:2606120612C22,60NTRFNONREF//Erstattung GS-MIX' 'Lieferant'
  printf '%s\n' ':62F:C260612EUR4324,37' '-'
} > "$MT"
UP=$(curl -sS -X POST -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/bank-statements/import?companyId=$C" \
  -F "file=@$MT;type=text/plain" -F "companyId=$C" -F "userId=$U")
SID=$(json_field "$UP" id)
T=(); while IFS= read -r line; do T+=("$line"); done < <(echo "$UP" | python3 -c "import sys,json;d=json.load(sys.stdin);[print(t['id']) for t in sorted(d['transactions'],key=lambda t:t['valueDate']) if float(t['amount'])<0]")
[[ ${#T[@]} -eq 2 ]] && pass "fixture: two debits imported" || { fail "import: $UP"; summary; exit 1; }
# as the page sends it: the expense's (one) rate and its whole VAT
AS POST "/api/v1/bank-statements/$SID/transactions/${T[0]}/book-expense?companyId=$C" '{"expenseId":"'$E'","supplierId":"'$S'","vatRate":0.19,"vatAmount":45.5}'
assert_eq "352,64 against ER-MIX" "$STATUS" "201"
V=$(json_field "$BODY" voucherId)
AS GET "/api/v1/accounting/vouchers/$V?companyId=$C"
assert_eq "the voucher: cost and Vorsteuer per rate, balanced (was one Vorsteuer line of 45,50 at 19 %)" \
  "$(py 'L=d["lines"];f=lambda k:round(sum(float(l[k]) for l in L),2);print(len(L), f("debit"), f("credit"), sorted((round(float(l["vatRate"]),2), round(float(l["vatAmount"]),2)) for l in L if l.get("vatAmount") and float(l["vatAmount"])>0))')" "5 352.64 352.64 [(0.07, 7.5), (0.19, 38.0)]"
assert_eq "ER-MIX is paid" "$(q "select \"paidAt\"::date from \"Expense\" where id='$E'")" "$Y-06-10"

note "=== 6. Skonto on an invoice with two rates ==="
mk ER-SK ',"taxLines":'"$LINES"; SK=$ID
AS POST "/api/v1/bank-statements/$SID/transactions/${T[1]}/book-expense?companyId=$C" '{"expenseId":"'$SK'","supplierId":"'$S'","vatRate":0.19,"vatAmount":45.5,"skonto":true}'
assert_eq "345,59 against 352,64 with Skonto" "$STATUS" "201"
NOTE=$(q "select id from \"Expense\" where \"companyId\"='$C' and \"invoiceNumber\"='ER-SK-SKONTO'")
assert_eq "the Skonto credit note: 7,05 in all, each rate its share" "$(totals "$NOTE")/$(rows "$NOTE")" "-6.14/-0.91/-7.05/0.19/0.19/-4.00/-0.76,0.07/-2.14/-0.15"
V2=$(json_field "$BODY" voucherId)
AS GET "/api/v1/accounting/vouchers/$V2?companyId=$C"
assert_eq "…the payment's voucher carries the Vorsteuer of what was paid" \
  "$(py 'L=d["lines"];f=lambda k:round(sum(float(l[k]) for l in L),2);print(f("debit"), f("credit"), sorted((round(float(l["vatRate"]),2), round(float(l["vatAmount"]),2)) for l in L if l.get("vatAmount") and float(l["vatAmount"])>0))')" "345.59 345.59 [(0.07, 7.35), (0.19, 37.24)]"
# + ER-SK 38 / 7.50 and its Skonto −0.76 / −0.15 on top of section 3
assert_eq "the UStVA follows: 19 % / 7 % / total" "$(vorsteuer)" "73.34 21.15 94.49"

note "=== 6b. the refund of a credit note with two rates ==="
REFUND=$(echo "$UP" | python3 -c "import sys,json;d=json.load(sys.stdin);print([t['id'] for t in d['transactions'] if float(t['amount'])>0][0])")
AS POST "/api/v1/bank-statements/$SID/transactions/$REFUND/book-expense?companyId=$C" '{"expenseId":"'$CN'","supplierId":"'$S'"}'
assert_eq "22,60 coming in against GS-MIX" "$STATUS" "201"
V3=$(json_field "$BODY" voucherId)
AS GET "/api/v1/accounting/vouchers/$V3?companyId=$C"
assert_eq "…Bank an Aufwand / Vorsteuer, per rate, balanced" \
  "$(py 'L=d["lines"];f=lambda k:round(sum(float(l[k]) for l in L),2);print(len(L), f("debit"), f("credit"), sorted(round(float(l["credit"]),2) for l in L if l.get("vatAmount") and float(l["vatAmount"])>0))')" "5 22.6 22.6 [0.7, 1.9]"

note "=== 7. correcting it ==="
mk ER-EDIT ',"taxLines":'"$LINES"; ED=$ID
AS PUT "/api/v1/expenses/$ED?companyId=$C" '{"netAmount":500}'
assert_eq "one net amount for an expense with two rates: refused, nothing changed" "$STATUS/$(totals "$ED")" "400/307.14/45.50/352.64/0.19"
AS PUT "/api/v1/expenses/$ED?companyId=$C" '{"description":"nur der Text"}'
assert_eq "the text alone can be changed; the lines stay" "$STATUS/$(rows "$ED")" "200/0.19/200.00/38.00,0.07/107.14/7.50"
AS PUT "/api/v1/expenses/$ED?companyId=$C" '{"taxLines":[{"vatRate":0.19,"netAmount":100,"vatAmount":19},{"vatRate":0.07,"netAmount":300,"vatAmount":21},{"vatRate":0,"netAmount":50,"vatAmount":0}]}'
assert_eq "new lines: totals and rate follow (7 % is now the largest)" "$STATUS/$(totals "$ED")/$(rows "$ED")" "200/450.00/40.00/490.00/0.07/0.19/100.00/19.00,0.07/300.00/21.00,0.00/50.00/0.00"
AS PUT "/api/v1/expenses/$ED?companyId=$C" '{"creditNote":true}'
assert_eq "made a credit note: every line turns" "$STATUS/$(totals "$ED")/$(rows "$ED")" "200/-450.00/-40.00/-490.00/0.07/0.19/-100.00/-19.00,0.07/-300.00/-21.00,0.00/-50.00/0.00"
AS PUT "/api/v1/expenses/$ED?companyId=$C" '{"creditNote":false,"taxLines":[],"netAmount":100,"vatRate":0.19}'
assert_eq "back to one rate: the rows are gone" "$STATUS/$(totals "$ED")/$(rows "$ED")" "200/100.00/19.00/119.00/0.19/-"
AS PUT "/api/v1/expenses/$E?companyId=$C" '{"taxLines":[{"vatRate":0.19,"netAmount":1,"vatAmount":0.19},{"vatRate":0.07,"netAmount":1,"vatAmount":0.07}]}'
assert_eq "a paid expense keeps its lines (locked like any other change)" "$STATUS/$(rows "$E")" "400/0.19/200.00/38.00,0.07/107.14/7.50"

note "=== 7b. the audit trail has the lines, before and after ==="
# ExpenseTaxLine rows are written nested in their expense and have no audit
# rows of their own (spec 196 exempts the model for that reason).
audit() { q "select coalesce(jsonb_array_length(\"$2\"->'taxLines'),-1) from \"AuditLog\" where \"companyId\"='$C' and \"entityType\"='Expense' and \"entityId\"='$ED' and action like '%$1%' order by seq $3 limit 1"; }
assert_eq "created: the two lines are in the record" "$(audit creat newData asc)" "2"
assert_eq "the change to three lines: two before, three after" "$(q "select coalesce(jsonb_array_length(\"oldData\"->'taxLines'),-1)||'/'||coalesce(jsonb_array_length(\"newData\"->'taxLines'),-1) from \"AuditLog\" where \"companyId\"='$C' and \"entityType\"='Expense' and \"entityId\"='$ED' and jsonb_array_length(coalesce(\"newData\"->'taxLines','[]'::jsonb))=3 order by seq asc limit 1")" "2/3"
assert_eq "back to one rate: three before, none after" "$(audit updat oldData desc)/$(audit updat newData desc)" "3/0"
AS GET "/api/v1/audit-logs/verify?companyId=$C"
assert_eq "…and the chain verifies" "$(py 'print(d.get("ok"))')" "True"

note "=== 7c. the UStVA page's own route (Tier 582) ==="
AS POST "/api/v1/ustva/expenses?companyId=$C" '{"supplierId":"'$S'","invoiceNumber":"ER-USTVA","description":"von der UStVA-Seite","invoiceDate":"'$Y'-07-01","netAmount":300,"vatAmount":45,"grossAmount":345,"vatRate":0.19,"taxLines":[{"vatRate":0.19,"netAmount":200,"vatAmount":38},{"vatRate":0.07,"netAmount":100,"vatAmount":7}]}'
UE=$(json_field "$BODY" id)
assert_eq "POST /ustva/expenses with taxLines (were dropped: one rate, 45 € at 19 %)" "$STATUS/$(totals "$UE")/$(rows "$UE")" "201/300.00/45.00/345.00/0.19/0.19/200.00/38.00,0.07/100.00/7.00"
AS POST "/api/v1/ustva/expenses?companyId=$C" '{"description":"13b mit Zeilen","invoiceDate":"'$Y'-07-01","netAmount":300,"isReverseCharge":true,"taxLines":[{"vatRate":0.19,"netAmount":200,"vatAmount":38},{"vatRate":0.07,"netAmount":100,"vatAmount":7}]}'
assert_eq "…not on a § 13b expense" "$STATUS" "400"
AS PUT "/api/v1/ustva/expenses/$UE?companyId=$C" '{"taxLines":[],"netAmount":200,"vatRate":0.19,"vatAmount":38,"grossAmount":238}'
assert_eq "PUT /ustva/expenses/:id takes them away again" "$STATUS/$(totals "$UE")/$(rows "$UE")" "200/200.00/38.00/238.00/0.19/-"

note "=== 7d. § 13b and several rates exclude each other, both ways (Tier 587) ==="
mk ER-13B-A ',"taxLines":'"$LINES"; M1=$ID
AS PUT "/api/v1/expenses/$M1?companyId=$C" '{"isReverseCharge":true}'
assert_eq "§ 13b on an expense with VAT lines: 400 (was 200)" "$STATUS/$(q "select \"isReverseCharge\" from \"Expense\" where id='$M1'")/$(rows "$M1")" "400/f/0.19/200.00/38.00,0.07/107.14/7.50"
AS PUT "/api/v1/expenses/$M1?companyId=$C" '{"isIntraEU":true}'
assert_eq "…the same for an intra-community acquisition" "$STATUS/$(q "select \"isIntraEU\" from \"Expense\" where id='$M1'")" "400/f"
AS PUT "/api/v1/expenses/$M1?companyId=$C" '{"isReverseCharge":true,"taxLines":[],"netAmount":307.14,"vatRate":0,"vatAmount":0,"grossAmount":307.14}'
assert_eq "with the lines removed in the same request it is accepted" "$STATUS/$(q "select \"isReverseCharge\" from \"Expense\" where id='$M1'")/$(rows "$M1")" "200/t/-"
mk ER-13B-B ',"netAmount":100,"vatRate":0,"vatAmount":0,"grossAmount":100'; M2=$ID
AS PUT "/api/v1/expenses/$M2?companyId=$C" '{"isReverseCharge":true}'
AS PUT "/api/v1/expenses/$M2?companyId=$C" '{"taxLines":'"$LINES"'}'
assert_eq "lines on a § 13b expense: 400" "$STATUS/$(rows "$M2")" "400/-"

note "=== 8. deleting it takes the lines along; another company sees none ==="
AS DELETE "/api/v1/ustva/expenses/$ED?companyId=$C"
mk ER-DEL ',"taxLines":'"$LINES"; DEL=$ID
AS DELETE "/api/v1/ustva/expenses/$DEL?companyId=$C"
assert_eq "deleted with its lines" "$STATUS/$(q "select count(*) from \"ExpenseTaxLine\" where \"expenseId\"='$DEL'")" "200/0"
assert_eq "every line belongs to this company" "$(q "select count(*) from \"ExpenseTaxLine\" l join \"Expense\" e on e.id=l.\"expenseId\" where e.\"companyId\"='$C' and l.\"companyId\"<>e.\"companyId\"")" "0"
REG2="{\"email\":\"$TAG-b@example.test\",\"password\":\"Tier581-e2e\",\"companyName\":\"$TAG B GmbH\"}"
read -r U2 C2 < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$REG2" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
assert_eq "another company cannot change them" "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$API/api/v1/expenses/$SK?companyId=$C2" -H "x-user-id: $U2" -H "x-company-id: $C2" -H "Content-Type: application/json" -d '{"taxLines":[]}')/$(rows "$SK")" "404/0.19/200.00/38.00,0.07/107.14/7.50"
rm -rf "$D"
summary
