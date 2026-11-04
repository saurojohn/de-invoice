#!/bin/bash
# Tier 793 — the number range continues over the years, if the company wants
#
# Each document type was numbered in a range per year: INV-2026-000042, then
# INV-2027-000001 on 1 January. The owner, 04.11.2026: „如果可以的话实现发票号码
# 一直延续下去". § 14 Abs. 4 Satz 1 Nr. 4 UStG asks for a number that is given
# once; UStAE 14.5 Abs. 10/11 allow one or several ranges, ranges per period,
# and gaps. So both are allowed. A company's numbers now continue over the
# years (Company.invoiceNumberContinuous, default true; the year stays in the
# number), or start each year at 1 when it chooses so on the settings page.
# Switching either way gives no number twice.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-495-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
Y=$(date +%Y); P=$((Y - 1))
company() { # suffix → "user company customer"
  local u c k
  curl -sS -o "$D/reg" -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier793-e2e\",\"companyName\":\"$TAG $1 GmbH\"}"
  u=$(python3 -c "import json;print(json.load(open('$D/reg'))['user']['id'])"); c=$(python3 -c "import json;print(json.load(open('$D/reg'))['user']['companyId'])")
  fixture_issuer "$c" DE811111111
  curl -sS -o "$D/k" -X POST "$API/api/v1/customers?companyId=$c" -H "x-user-id: $u" -H "x-company-id: $c" -H "Content-Type: application/json" \
    -d "{\"name\":\"$TAG Kunde\",\"type\":\"business\",\"contact\":{\"email\":\"k-$1-$TAG@example.test\"},\"address\":{\"street\":\"a\",\"city\":\"Köln\",\"postalCode\":\"50667\",\"country\":\"DE\"}}"
  k=$(python3 -c "import json;print(json.load(open('$D/k'))['id'])")
  # last year's book: five invoices, the last INV-$P-000005
  q "insert into \"Invoice\"(id,\"companyId\",\"customerId\",\"invoiceNumber\",\"sequencePrefix\",\"sequenceYear\",\"sequenceNumber\",type,status,\"issueDate\",\"dueDate\",subtotal,\"totalVat\",total,currency,language,\"templateType\",\"createdAt\",\"updatedAt\")
     select gen_random_uuid()::text,'$c','$k','INV-$P-'||lpad(n::text,6,'0'),'INV',$P,n,'INV','paid',timestamp '$P-06-01',timestamp '$P-07-01',100,19,119,'EUR','de-DE','standard',now(),now() from generate_series(1,5) n" >/dev/null
  echo "$u $c $k"
}
invoice() { # user company customer → the new invoice's number
  curl -sS -X POST "$API/api/v1/invoices?companyId=$2" -H "x-user-id: $1" -H "x-company-id: $2" -H "Content-Type: application/json" \
    -d "{\"customerId\":\"$3\",\"issueDate\":\"$(date +%F)\",\"items\":[{\"description\":\"x\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}" \
    | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('invoiceNumber') or d)"
}
mode() { # user company true|false → status
  curl -sS -o "$D/m" -w '%{http_code}' -X PUT "$API/api/v1/companies/$2" -H "x-user-id: $1" -H "x-company-id: $2" -H "Content-Type: application/json" -d "{\"invoiceNumberContinuous\":$3}"
}

note "=== a new company: the count continues over the years ==="
read -r U C K < <(company a)
assert_eq "the setting of a new company: continuous" "$(q "select \"invoiceNumberContinuous\" from \"Company\" where id='$C'")" "t"
assert_eq "the first invoice of $Y follows INV-$P-000005 (was INV-$Y-000001)" "$(invoice $U $C $K)" "INV-$Y-000006"
assert_eq "…and the next" "$(invoice $U $C $K)" "INV-$Y-000007"

note "=== switched to a range per year, and back ==="
assert_eq "the settings take the choice" "$(mode $U $C false)/$(q "select \"invoiceNumberContinuous\" from \"Company\" where id='$C'")" "200/f"
assert_eq "per year now: the year's range goes on above what the year has (no 000001 a second time)" "$(invoice $U $C $K)" "INV-$Y-000008"
mode $U $C true >/dev/null
assert_eq "continuous again: past the numbers given meanwhile" "$(invoice $U $C $K)" "INV-$Y-000009"
assert_eq "no number twice in the company" "$(q "select count(*) - count(distinct \"invoiceNumber\") from \"Invoice\" where \"companyId\"='$C'")" "0"
st=$(mode $U $C '"ja"')
assert_eq "a value that is no true / false: 400" "$st" "400"

note "=== a deleted draft gives its number back, in the continuing range too ==="
N=$(invoice $U $C $K)
I=$(q "select id from \"Invoice\" where \"companyId\"='$C' and \"invoiceNumber\"='$N'")
st=$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE "$API/api/v1/invoices/$I?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C")
assert_eq "the draft $N is deleted" "$st" "200"
assert_eq "…the next invoice takes its number" "$(invoice $U $C $K)" "$N"

note "=== a company that starts each year anew ==="
read -r U2 C2 K2 < <(company b)
mode $U2 $C2 false >/dev/null
assert_eq "its first invoice of $Y is 000001 again" "$(invoice $U2 $C2 $K2)" "INV-$Y-000001"

summary
