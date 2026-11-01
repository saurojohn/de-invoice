#!/bin/bash
# Tier 760 — a company with more than 32 767 invoices
#
# Measured on a company of 50 000 documents: GET /invoices answered 500, so the
# list of invoices did not open, and neither did the Bilanz, the Anhang, the
# E-Bilanz and the invoice statistics. Prisma has to split a query over that many
# parents and cannot split a negated filter on a relation; any other filter on a
# relation takes one bind too many (32 768).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="t760-$(date +%s)"
BODY="{\"email\":\"$TAG@example.test\",\"password\":\"Tier760-e2e\",\"companyName\":\"$TAG GmbH\"}"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$BODY" \
  | python3 -c "import json,sys; r=json.load(sys.stdin); print(r['user']['id'], r['company']['id'])")
H=(-H "x-user-id: $U" -H "x-company-id: $C")
SQLF=$(mktemp)
cat > "$SQLF" <<SQL
insert into "Customer"(id,"companyId",type,name,address,"updatedAt") values ('$TAG-c','$C','business','Kunde $TAG','{"country":"DE"}',now());
insert into "Invoice"(id,"companyId","customerId","invoiceNumber",type,status,"issueDate","dueDate",subtotal,"totalVat",total,currency,"customerName","updatedAt")
select '$TAG-'||n,'$C','$TAG-c','INV-$TAG-'||n,'INV','sent','2025-06-01','2025-06-30',100,19,119,'EUR','Kunde $TAG',now() from generate_series(1,33000) n;
update "Invoice" set status='paid' where id in ('$TAG-1','$TAG-2');
insert into "Payment"(id,"invoiceId",amount,"paymentDate","paymentMethod") values
  ('$TAG-p1','$TAG-1',119,'2025-06-10','bank_transfer'),
  ('$TAG-p2','$TAG-2',119,'2026-02-01','bank_transfer');
insert into "Invoice"(id,"companyId","customerId","invoiceNumber",type,status,"issueDate",subtotal,"totalVat",total,currency,"customerName","referenceInvoiceId","updatedAt") values
  ('$TAG-cn1','$C','$TAG-c','CN-$TAG-1','CN','sent','2025-07-01',100,19,119,'EUR','Kunde $TAG','$TAG-3',now()),
  ('$TAG-cn2','$C','$TAG-c','CN-$TAG-2','CN','draft','2025-07-01',100,19,119,'EUR','Kunde $TAG','$TAG-4',now());
SQL
docker exec -i "$PG_CONTAINER" psql -q -U de_invoice -d de_invoice -v ON_ERROR_STOP=1 < "$SQLF" >/dev/null
rm -f "$SQLF"
get() { curl -sS -m 120 -o /tmp/t760.json -w '%{http_code}' "${H[@]}" "$API/api/v1/$1"; }

assert_eq "the list of invoices opens" "$(get "invoices?companyId=$C&pageSize=5")" "200"
# 33 000 at 119 €, less the paid two and the one a credit note covers; the draft note counts for nothing
OPEN=$(python3 -c "import json; print(json.load(open('/tmp/t760.json'))['sums']['openEur'])")
assert_close "its sum of what is open" "$OPEN" "3926643" "0.01"

assert_eq "the Bilanz opens" "$(get "accounting/bilanz?companyId=$C&year=2025")" "200"
# at 31.12.2025 the payment of February 2026 has not come: only invoice 1 is settled
FORD=$(python3 - <<'PY'
import json
def walk(o):
    if isinstance(o, dict):
        if 'Forderungen' in str(o.get('label', o.get('name', ''))) and 'amount' in o: yield o['amount']
        for v in o.values(): yield from walk(v)
    elif isinstance(o, list):
        for v in o: yield from walk(v)
print(next(walk(json.load(open('/tmp/t760.json'))), 'none'))
PY
)
assert_close "its receivables at the snapshot" "$FORD" "3926881" "0.01"
assert_eq "the Anhang opens" "$(get "accounting/anhang?companyId=$C&year=2025")" "200"
assert_eq "the E-Bilanz opens" "$(get "accounting/ebilanz?companyId=$C&year=2025")" "200"

assert_eq "the invoice statistics open" "$(get "reports/invoice-statistics?companyId=$C&year=2025")" "200"
CANCELLED=$(python3 -c "
import json
def walk(o):
    if isinstance(o, dict):
        if 'cancelledCount' in o: yield o['cancelledCount']
        for v in o.values(): yield from walk(v)
    elif isinstance(o, list):
        for v in o: yield from walk(v)
print(next(walk(json.load(open('/tmp/t760.json'))), 'none'))")
assert_eq "one invoice cancelled by its note, not two" "$CANCELLED" "1"

assert_eq "the CSV export runs" "$(get "invoices/export/csv?companyId=$C&dateFrom=2025-01-01&dateTo=2025-12-31")" "200"

docker exec "$PG_CONTAINER" psql -q -U de_invoice -d de_invoice -c "delete from \"Payment\" where id like '$TAG-%'; update \"Invoice\" set \"referenceInvoiceId\"=null where \"companyId\"='$C'; delete from \"Invoice\" where \"companyId\"='$C'; delete from \"Customer\" where id='$TAG-c';" >/dev/null
summary
