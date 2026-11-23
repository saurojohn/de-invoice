#!/bin/bash
# Tier 944 — what an edit or an import of bills got past
#
# 1. The Skonto of a bank payment is locked by a marker in its notes
#    ([skonto-voucher:…]); the voucher's Storno finds it by the marker. An edit
#    of the notes replaced them whole: marker gone, lock gone — the Skonto
#    could be deleted on its own (its input-tax correction gone, the bank
#    voucher still there). A marker could be typed in, too.
# 2. The day of payment is no part of the UStVA (the input tax is the
#    invoice's) but of the EÜR (§ 11 EStG): a payment dated into closed books
#    was taken (create and edit); a bill whose invoice month was submitted
#    could not be marked paid at all.
# 3. The CSV import wrote a row on its own past the closing of the books, and
#    took any text as the status („bezahlt“) — such a bill was in no report.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-631-$(date +%s%N | cut -c1-13)"
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT

company() { # name [settings json]
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier944-e2e\",\"companyName\":\"$TAG $1\"}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
  fixture_issuer "$C"
  [[ -n "${2:-}" ]] && curl -sS -o /dev/null -X PUT "$API/api/v1/companies/$C?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" -d "$2"
}
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
P() { python3 -c "import sys,json;d=json.loads(sys.argv[1]);print(eval(sys.argv[2]))" "$BODY" "$1"; }
vst() { AS GET "/api/v1/ustva/compute?companyId=$C&year=$1&month=$2"; P "'%.2f' % d['vorsteuerSum']"; }
submit() { # year month
  AS GET "/api/v1/ustva/compute?companyId=$C&year=$1&month=$2"
  local data; data=$(python3 -c "import sys,json;d=json.loads(sys.argv[1]);d['status']='submitted';print(json.dumps(d))" "$BODY")
  AS POST "/api/v1/ustva/filings?companyId=$C" "$data"
}

note "=== 1. the Skonto's marker ==="
company Skonto '{"rechtsform":"GmbH","besteuerungsart":"soll"}'
[[ -n "${C:-}" ]] && pass "fixture: a GmbH" || { fail "register"; summary; exit 1; }
AS POST "/api/v1/suppliers?companyId=$C" "{\"name\":\"$TAG Lieferant\",\"address\":{\"street\":\"a\",\"city\":\"b\",\"postalCode\":\"10115\",\"country\":\"DE\"}}"
SUP=$(json_field "$BODY" id)
AS POST "/api/v1/ustva/expenses?companyId=$C" "{\"supplierId\":\"$SUP\",\"invoiceNumber\":\"ER-1\",\"description\":\"Ware\",\"invoiceDate\":\"2026-06-01\",\"netAmount\":1000,\"vatRate\":0.19,\"vatAmount\":190,\"grossAmount\":1190}"
ER=$(json_field "$BODY" id)
cat > "$W/sk.mt940" <<'X'
:1:F01BANKBICAXXX0000000000
:20:ST452
:25:DE89370400440532013000
:28C:1/1
:60F:C260601EUR5000,00
:61:2606080608D1166,20NTRFNONREF//ER-1 abzgl. 2% Skonto
Lieferant
:62F:C260608EUR3833,80
-
X
UP=$(curl -sS -X POST -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/bank-statements/import?companyId=$C" \
  -F "file=@$W/sk.mt940;type=text/plain" --form-string "companyId=$C" --form-string "userId=$U")
SID=$(json_field "$UP" id)
T=$(echo "$UP" | python3 -c "import sys,json;print(json.load(sys.stdin)['transactions'][0]['id'])" 2>/dev/null)
AS POST "/api/v1/bank-statements/$SID/transactions/$T/book-expense?companyId=$C" "{\"expenseId\":\"$ER\",\"skonto\":true}"
V=$(json_field "$BODY" voucherId)
assert_eq "the bank payment of 1 166,20 with 2 % Skonto: June's input tax 190 − 3,80" "$(vst 2026 6)" "186.20"
AS GET "/api/v1/expenses?companyId=$C"
SK=$(P "[e['id'] for e in d['data'] if float(e['grossAmount']) < 0][0]")
AS PUT "/api/v1/expenses/$SK?companyId=$C" '{"notes":"Skonto laut Bank"}'
AS GET "/api/v1/expenses/$SK?companyId=$C"
assert_eq "the notes edited: the text is the user's, the marker stays (was gone)" \
  "$(P "d['notes'] == 'Skonto laut Bank [skonto-voucher:$V]'")" "True"
AS DELETE "/api/v1/ustva/expenses/$SK?companyId=$C"
assert_eq "…so the Skonto cannot be deleted on its own (was 200)" "$STATUS" "400"
AS POST "/api/v1/accounting/vouchers/$V/reversal?companyId=$C" '{"reason":"falsch gebucht"}'
AS GET "/api/v1/expenses?companyId=$C"
assert_eq "the voucher's Storno finds it and takes it back" "$(P "len([e for e in d['data'] if float(e['grossAmount']) < 0])")" "0"
assert_eq "…June: the whole 190 again" "$(vst 2026 6)" "190.00"
AS POST "/api/v1/ustva/expenses?companyId=$C" "{\"description\":\"Porto\",\"invoiceDate\":\"2026-06-02\",\"netAmount\":10,\"vatRate\":0.19,\"vatAmount\":1.9,\"grossAmount\":11.9,\"paidAt\":\"2026-06-02\",\"notes\":\"Notiz [skonto-voucher:$V]\"}"
assert_eq "a marker typed in is not taken (it would lock the bill and hand it to that voucher's Storno)" "$(P "d['notes']")" "Notiz"

note "=== 2. the day of payment ==="
company Zahldatum '{"rechtsform":"Einzelunternehmen","besteuerungsart":"soll","gewinnermittlung":"euer"}'
AS POST "/api/v1/expenses?companyId=$C" '{"description":"Software Okt","invoiceDate":"2026-10-15","netAmount":100,"vatRate":0.19,"vatAmount":19,"grossAmount":119}'
E1=$(json_field "$BODY" id)
submit 2026 10
assert_eq "October submitted" "$STATUS" "201"
AS PUT "/api/v1/expenses/$E1?companyId=$C" '{"paidAt":"2026-11-05"}'
assert_eq "an October bill paid on 05.11.: the date of payment is taken (was refused for the submitted October)" "$STATUS" "200"
AS PUT "/api/v1/expenses/$E1?companyId=$C" '{"paidAt":"2026-11-05","description":"Software Oktober"}'
assert_eq "…its text is October's return's: still refused" "$STATUS" "400"
AS PUT "/api/v1/accounting/books-closing?companyId=$C" '{"closedUntil":"2025-12-31"}'
assert_eq "the books closed to 31.12.2025" "$STATUS" "200"
AS POST "/api/v1/expenses?companyId=$C" '{"description":"Vorkasse Material","invoiceDate":"2026-01-05","netAmount":1000,"vatRate":0.19,"vatAmount":190,"grossAmount":1190,"paidAt":"2025-12-20"}'
assert_eq "books closed to 31.12.2025: a bill paid on 20.12.2025 is refused (was in the EÜR 2025)" \
  "$STATUS/$(P "'Festschreibung' in str(d.get('message'))")" "400/True"
AS POST "/api/v1/ustva/expenses?companyId=$C" '{"description":"Vorkasse Material","invoiceDate":"2026-01-05","netAmount":1000,"vatRate":0.19,"vatAmount":190,"grossAmount":1190,"paidAt":"2025-12-20"}'
assert_eq "…on the other way in, too" "$STATUS" "400"
AS POST "/api/v1/expenses?companyId=$C" '{"description":"Miete Jan","invoiceDate":"2026-01-10","netAmount":500,"vatRate":0.19,"vatAmount":95,"grossAmount":595}'
E3=$(json_field "$BODY" id)
AS PUT "/api/v1/expenses/$E3?companyId=$C" '{"paidAt":"2025-12-30"}'
assert_eq "…and a payment dated back into 2025 (was taken)" "$STATUS" "400"
AS GET "/api/v1/accounting/euer?companyId=$C&year=2025"
assert_eq "the EÜR 2025 has no expense" "$(P "float(d['totals']['ausgabenTotal'])")" "0.0"

note "=== 3. the CSV import ==="
csv() { AS POST "/api/v1/expenses/import?companyId=$C" "{\"rows\":[$1]}"; }
row() { # number date [status]
  echo "{\"description\":\"Posten $1\",\"invoiceDate\":\"$2\",\"invoiceNumber\":\"$1\",\"supplierName\":\"$TAG Host GmbH\",\"netAmount\":\"200\",\"vatRate\":\"0.19\",\"vatAmount\":\"38\",\"grossAmount\":\"238\"${3:+,\"status\":\"$3\"}}"
}
csv "$(row A-1 15.06.2025)"
assert_eq "a row dated into the closed 2025 is reported, not imported (was imported)" \
  "$(P "(d['imported'], 'Festschreibung' in d['errors'][0]['error'] if d['errors'] else None)")" "(0, True)"
csv "$(row H-1 10.11.2026 bezahlt),$(row H-2 11.11.2026 Deductible),$(row H-3 12.11.2026)"
assert_eq "a status „bezahlt“ is reported (was stored — the bill in no report)" \
  "$(P "(d['imported'], [e['row'] for e in d['errors']], 'Zahldatum' in d['errors'][0]['error'])")" "(2, [2], True)"
AS GET "/api/v1/expenses?companyId=$C"
assert_eq "…„Deductible“ is deductible, none is booked" \
  "$(P "sorted((e['invoiceNumber'], e['status']) for e in d['data'] if (e.get('invoiceNumber') or '').startswith('H-'))")" \
  "[('H-2', 'deductible'), ('H-3', 'booked')]"

summary
