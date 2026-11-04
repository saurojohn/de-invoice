#!/bin/bash
# Tier 794 — the number the next invoice gets can be set; saving the settings
# page keeps the company's other settings
#
# The owner, 04.11.2026: „现在能设置发票号码数字几号开始吗？" It could not: a
# company's first invoice was 000001, and one coming from other software could
# not go on at its own count. Now „Nächste Rechnungsnummer" on the settings
# page (GET/PUT /companies/:id/invoice-number): above the highest number used,
# never below (no number out of order or twice, § 14 Abs. 4 Satz 1 Nr. 4 UStG);
# the numbers left out are a gap (UStAE 14.5 Abs. 10), the audit trail says
# who left it. A deleted first draft gives the number set back, not 000001.
#
# Found on the way: PUT /companies/:id wrote `settings` as it came — the three
# preferences of the settings page — over the whole Company.settings JSON, so
# every save of that page dropped the DATEV Berater-/Mandantennummer, the
# Anlage flags, the Hebesatz, the KSt prepayments… (measured).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-496-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
Y=$(date +%Y); P=$((Y - 1))
company() { # suffix → "user company customer"
  local u c k body
  body="{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier794-e2e\",\"companyName\":\"$TAG $1 GmbH\"}"
  curl -sS -o "$D/reg" -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$body"
  u=$(python3 -c "import json;print(json.load(open('$D/reg'))['user']['id'])"); c=$(python3 -c "import json;print(json.load(open('$D/reg'))['user']['companyId'])")
  fixture_issuer "$c" DE811111111
  body="{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"contact\":{\"email\":\"k-$1-$TAG@example.test\"},\"address\":{\"street\":\"a\",\"city\":\"Köln\",\"postalCode\":\"50667\",\"country\":\"DE\"}}"
  curl -sS -o "$D/k" -X POST "$API/api/v1/customers?companyId=$c" -H "x-user-id: $u" -H "x-company-id: $c" -H "Content-Type: application/json" -d "$body"
  k=$(python3 -c "import json;print(json.load(open('$D/k'))['id'])")
  echo "$u $c $k"
}
invoice() { # user company customer [type] → the new document's number
  local body="{\"customerId\":\"$3\",\"type\":\"${4:-INV}\",\"issueDate\":\"$(date +%F)\",\"items\":[{\"description\":\"x\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
  curl -sS -X POST "$API/api/v1/invoices?companyId=$2" -H "x-user-id: $1" -H "x-company-id: $2" -H "Content-Type: application/json" -d "$body" \
    | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('invoiceNumber') or d)"
}
peek() { # user company → "invoiceNumber/minimum"
  curl -sS "$API/api/v1/companies/$2/invoice-number" -H "x-user-id: $1" -H "x-company-id: $2" \
    | python3 -c "import json,sys;d=json.load(sys.stdin);print(f\"{d.get('invoiceNumber')}/{d.get('minimum')}\")"
}
setnext() { # user company value → status (body in $D/s)
  local body="{\"next\":$3}"
  curl -sS -o "$D/s" -w '%{http_code}' -X PUT "$API/api/v1/companies/$2/invoice-number" -H "x-user-id: $1" -H "x-company-id: $2" -H "Content-Type: application/json" -d "$body"
}
drop() { # user company number → status of deleting that draft
  local i; i=$(q "select id from \"Invoice\" where \"companyId\"='$2' and \"invoiceNumber\"='$3'")
  curl -sS -o /dev/null -w '%{http_code}' -X DELETE "$API/api/v1/invoices/$i?companyId=$2" -H "x-user-id: $1" -H "x-company-id: $2"
}

note "=== saving the settings page keeps the company's other settings ==="
read -r U C K < <(company a)
B='{"beraterNr":"12345","mandantenNr":"678"}'
curl -sS -o /dev/null -X PUT "$API/api/v1/companies/$C/datev-config" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" -d "$B"
B='{"anlageV":true}'
curl -sS -o /dev/null -X PATCH "$API/api/v1/companies/$C/feature-flags" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" -d "$B"
B="{\"name\":\"$TAG a GmbH\",\"settings\":{\"defaultCurrency\":\"EUR\",\"defaultLanguage\":\"en\",\"defaultPrinter\":\"\"}}"
st=$(curl -sS -o /dev/null -w '%{http_code}' -X PUT "$API/api/v1/companies/$C" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" -d "$B")
assert_eq "the settings page saves" "$st" "200"
assert_eq "the DATEV Beraternummer is kept (was gone)" "$(q "select settings->'datev'->>'beraterNr' from \"Company\" where id='$C'")" "12345"
assert_eq "the Anlage V flag is kept (was gone)" "$(q "select settings->>'anlageV' from \"Company\" where id='$C'")" "true"
assert_eq "…and the preference sent is saved" "$(q "select settings->>'defaultLanguage' from \"Company\" where id='$C'")" "en"

note "=== the next invoice number of a new company, and set to 1000 ==="
assert_eq "a new company: 000001 next, from 1 on" "$(peek $U $C)" "INV-$Y-000001/1"
assert_eq "set to 1000" "$(setnext $U $C 1000)" "200"
assert_eq "…the answer says what comes next" "$(python3 -c "import json;print(json.load(open('$D/s'))['invoiceNumber'])")" "INV-$Y-001000"
assert_eq "the next invoice is INV-$Y-001000" "$(invoice $U $C $K)" "INV-$Y-001000"
assert_eq "…then 001001" "$(invoice $U $C $K)" "INV-$Y-001001"
assert_eq "what comes next now, and the lowest that can be set" "$(peek $U $C)" "INV-$Y-001002/1002"
assert_eq "the change is in the audit trail" "$(q "select count(*) from \"AuditLog\" where \"companyId\"='$C' and action='company.invoice_number.next_set'")" "1"

note "=== never below a number used, only whole numbers ==="
assert_eq "500, below 1001: refused" "$(setnext $U $C 500)" "400"
assert_eq "…saying the lowest" "$(file_contains "mindestens 1002" "$D/s" && echo yes)" "yes"
assert_eq "1001, used: refused" "$(setnext $U $C 1001)" "400"
assert_eq "a string: refused" "$(setnext $U $C '"2000"')" "400"
assert_eq "a fraction: refused" "$(setnext $U $C 2000.5)" "400"
assert_eq "0: refused" "$(setnext $U $C 0)" "400"
assert_eq "…the next number is unchanged" "$(peek $U $C)" "INV-$Y-001002/1002"
assert_eq "a deleted draft gives its number back" "$(drop $U $C INV-$Y-001001)/$(invoice $U $C $K)" "200/INV-$Y-001001"
assert_eq "set the settings page again: the start set is kept" "$(curl -sS -o /dev/null -w '%{http_code}' -X PUT "$API/api/v1/companies/$C" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" -d "$B")/$(q "select settings->'invoiceNumberStart'->>'all' from \"Company\" where id='$C'")" "200/1000"

note "=== a deleted first draft gives the number set back, not 000001 ==="
read -r U2 C2 K2 < <(company b)
setnext $U2 $C2 1000 >/dev/null
assert_eq "a quote has a range of its own: AN-$Y-000001, not 001000" "$(invoice $U2 $C2 $K2 QU)" "AN-$Y-000001"
N=$(invoice $U2 $C2 $K2)
assert_eq "the first draft is 001000" "$N" "INV-$Y-001000"
assert_eq "deleted" "$(drop $U2 $C2 "$N")" "200"
assert_eq "the next is 001000 again (not 000001)" "$(invoice $U2 $C2 $K2)" "INV-$Y-001000"

note "=== a range per year: this year's ==="
read -r U3 C3 K3 < <(company c)
B='{"invoiceNumberContinuous":false}'
curl -sS -o /dev/null -X PUT "$API/api/v1/companies/$C3" -H "x-user-id: $U3" -H "x-company-id: $C3" -H "Content-Type: application/json" -d "$B"
q "insert into \"Invoice\"(id,\"companyId\",\"customerId\",\"invoiceNumber\",\"sequencePrefix\",\"sequenceYear\",\"sequenceNumber\",type,status,\"issueDate\",\"dueDate\",subtotal,\"totalVat\",total,currency,language,\"templateType\",\"createdAt\",\"updatedAt\")
   values (gen_random_uuid()::text,'$C3','$K3','INV-$P-000080','INV',$P,80,'INV','paid',timestamp '$P-06-01',timestamp '$P-07-01',100,19,119,'EUR','de-DE','standard',now(),now())" >/dev/null
assert_eq "last year's 80 do not count: 50 can be set" "$(setnext $U3 $C3 50)" "200"
assert_eq "the next invoice is INV-$Y-000050" "$(invoice $U3 $C3 $K3)" "INV-$Y-000050"

note "=== another company's range is not touched ==="
assert_eq "company a goes on at 001002" "$(peek $U $C)" "INV-$Y-001002/1002"

summary
