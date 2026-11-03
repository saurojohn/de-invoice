#!/bin/bash
# Tier 791 — a customer whose records keep him is refused with a reason, not a 500
#
# Deleting a customer checked invoices, time entries and projects. Three more
# tables keep a customer (the database refuses the delete): credit bookings,
# recurring invoices and SEPA mandates. Measured (the run of the suite with
# the clock in January 2027, then on the normal clock): a customer with a
# credit booking answered 500 "Foreign key constraint violated:
# CustomerCreditTransaction_customerId_fkey". Now each answers 400 with what
# to do instead.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-493-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
field() { python3 -c "import json,sys
try: print(json.load(sys.stdin).get('$1') or '')
except Exception: print('')" < "$D/out"; }
st=$(curl -sS -o "$D/out" -w '%{http_code}' -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier791-e2e\",\"companyName\":\"$TAG GmbH\"}")
U=$(python3 -c "import json;print(json.load(open('$D/out'))['user']['id'])"); C=$(python3 -c "import json;print(json.load(open('$D/out'))['user']['companyId'])")
assert_eq "fixture: a company" "$st" "201"
A=(-H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json")
req() { curl -sS -o "$D/out" -w '%{http_code}' -X "$1" "$API$2" "${A[@]}" ${3:+-d "$3"}; }
customer() { req POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG $1\",\"type\":\"business\",\"contact\":{\"email\":\"$1-$TAG@example.test\"},\"address\":{\"street\":\"a\",\"city\":\"Köln\",\"postalCode\":\"50667\",\"country\":\"DE\"}}" >/dev/null; field id; }

note "=== a credit booking ==="
K=$(customer guthaben)
q "insert into \"CustomerCreditTransaction\" (id, \"companyId\", \"customerId\", amount, \"balanceAfter\", type, description, \"createdById\", \"createdAt\") values (gen_random_uuid()::text, '$C', '$K', 50, 50, 'overpayment', '$TAG', '$U', now())" >/dev/null
st=$(req DELETE "/api/v1/customers/$K?companyId=$C")
assert_eq "delete: 400 with the reason (was 500)" "$st/$(field message)" "400/Kunde hat 1 Guthabenbuchung(en) und kann nicht gelöscht werden. Archivieren Sie den Kunden stattdessen."
assert_eq "…the customer and the booking are kept" "$(q "select count(*) from \"Customer\" where id='$K'")/$(q "select count(*) from \"CustomerCreditTransaction\" where \"customerId\"='$K'")" "1/1"

note "=== a recurring invoice ==="
K=$(customer serie)
st=$(req POST "/api/v1/recurring-invoices?companyId=$C" "{\"name\":\"$TAG Abo\",\"customerId\":\"$K\",\"interval\":\"monthly\",\"startDate\":\"$(date -v+1m +%Y-%m-%d 2>/dev/null || date -d '+1 month' +%Y-%m-%d)\",\"items\":[{\"description\":\"Hosting\",\"quantity\":1,\"unitPrice\":100,\"vatRate\":0.19}]}")
assert_eq "fixture: a recurring invoice" "$st" "201"
st=$(req DELETE "/api/v1/customers/$K?companyId=$C")
assert_eq "delete: 400 with the reason (was 500)" "$st/$(field message)" "400/Kunde hat 1 Serienrechnung(en) und kann nicht gelöscht werden. Löschen Sie zuerst die Serienrechnungen — oder archivieren Sie den Kunden."

note "=== a SEPA mandate ==="
K=$(customer mandat)
st=$(req POST "/api/v1/payments/mandates?companyId=$C" "{\"companyId\":\"$C\",\"customerId\":\"$K\",\"dateOfSignature\":\"$(date +%Y-%m-%d)\",\"iban\":\"DE89370400440532013000\",\"debitorName\":\"$TAG\"}")
assert_eq "fixture: a mandate" "$st" "201"
st=$(req DELETE "/api/v1/customers/$K?companyId=$C")
assert_eq "delete: 400 with the reason (was 500)" "$st/$(field message)" "400/Kunde hat 1 SEPA-Mandat(e) und kann nicht gelöscht werden. Archivieren Sie den Kunden stattdessen."

note "=== a customer with none of them ==="
K=$(customer leer)
st=$(req DELETE "/api/v1/customers/$K?companyId=$C")
assert_eq "is deleted" "$st/$(q "select count(*) from \"Customer\" where id='$K'")" "200/0"

summary
