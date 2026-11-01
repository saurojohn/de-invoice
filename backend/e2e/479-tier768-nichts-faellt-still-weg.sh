#!/bin/bash
# Tiers 768 to 773 — nothing falls off the end without a word
#
# A list with a limit and a page that treats it as everything. Above the limit
# nothing failed and every figure looked right:
#   - /customers gives 200 at most; three forms asked 500, and the 201st customer
#     could not be chosen for a recurring invoice, a time entry or a SEPA mandate
#   - the time page's sums were those of the newest 2 000 entries
#   - a time sheet for a customer ended at the 5 000th entry
#   - the Anlage SO import took the first 500 purchases, the same ones every time
#   - the audit log's CSV, the GoBD export, ended at the newest 10 000 rows
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="t768-$(date +%s)"
BODY="{\"email\":\"$TAG@example.test\",\"password\":\"Tier768-e2e\",\"companyName\":\"$TAG GmbH\"}"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$BODY" \
  | python3 -c "import json,sys; r=json.load(sys.stdin); print(r['user']['id'], r['company']['id'])")
H=(-H "x-user-id: $U" -H "x-company-id: $C")
get() { curl -sS -m 60 "${H[@]}" "$API/api/v1/$1"; }
py() { python3 -c "import json,sys; r=json.load(sys.stdin); print($1)"; }
SQLF=$(mktemp)
cat > "$SQLF" <<SQL
insert into "Customer"(id,"companyId",type,name,address,"updatedAt")
  select '$TAG-c'||n,'$C','business','Kunde '||lpad(n::text,4,'0'),'{"country":"DE"}',now() from generate_series(1,205) n;
insert into "Supplier"(id,"companyId",name,address,"updatedAt")
  select '$TAG-s'||n,'$C','Lieferant '||n,'{"country":"DE"}',now() from generate_series(1,510) n;
-- 5 001 entries of an hour. The oldest 300 are open and billable at 60 €, and lie behind the newest 2 000.
insert into "TimeEntry"(id,"companyId",date,minutes,description,billable,"hourlyRate","customerId","updatedAt")
  select '$TAG-t'||n,'$C',date '2026-06-01'-n,60,'Arbeit',n>4701,case when n>4701 then 60 end,'$TAG-c1',now() from generate_series(1,5001) n;
insert into "Expense"(id,"companyId","invoiceNumber",description,"invoiceDate","netAmount","vatRate","vatAmount","grossAmount",category,"updatedAt")
  select '$TAG-e'||n,'$C','K-'||n,'Bitcoin','2025-01-01'::date+(n%300),100,0,0,100,'krypto',now() from generate_series(1,510) n;
insert into "AuditLog"(id,"companyId",action) select '$TAG-a'||n,'$C','test.row' from generate_series(1,10500) n;
insert into "Invoice"(id,"companyId","customerId","invoiceNumber",type,status,"issueDate",subtotal,"totalVat",total,currency,"customerName","updatedAt") values
  ('$TAG-i1','$C','$TAG-c205','R-1','INV','paid','2026-01-01',100,19,119,'EUR','x',now()),
  ('$TAG-i2','$C','$TAG-c205','R-2','INV','paid','2026-02-01',100,19,119,'EUR','x',now());
insert into "Payment"(id,"invoiceId",amount,"paymentDate","paymentMethod") values
  ('$TAG-p1','$TAG-i1',119,'2026-01-10','bank_transfer'),
  ('$TAG-p2','$TAG-i2',119,'2026-02-10','bank_transfer');
SQL
docker exec -i "$PG_CONTAINER" psql -q -U de_invoice -d de_invoice -v ON_ERROR_STOP=1 < "$SQLF" >/dev/null
rm -f "$SQLF"

# Tier 768
assert_eq "the list still gives 200" "$(get "customers?companyId=$C&pageSize=500" | py "len(r['data'])")" "200"
OPTS=$(get "customers/options?companyId=$C")
assert_eq "the options are all of them" "$(printf '%s' "$OPTS" | py "len(r)")" "205"
assert_eq "the last by name among them" "$(printf '%s' "$OPTS" | py "r[-1]['name']")" "Kunde 0205"
# Tier 769
TIME=$(get "time-entries?companyId=$C")
assert_eq "the page holds the newest 2 000" "$(printf '%s' "$TIME" | py "len(r['data'])")" "2000"
assert_eq "and says how many there are" "$(printf '%s' "$TIME" | py "r['total']")" "5001"
assert_eq "the hours are all of them" "$(printf '%s' "$TIME" | py "r['summary']['minutes']")" "300060"
assert_eq "what is open lies behind the page" "$(printf '%s' "$TIME" | py "r['summary']['openBillableMinutes']")" "18000"
assert_eq "and is what gets invoiced" "$(printf '%s' "$TIME" | py "r['summary']['openAmount']")" "18000"
code=$(curl -sS -m 60 -o /tmp/t768.json -w '%{http_code}' "${H[@]}" "$API/api/v1/time-entries/timesheet.pdf?companyId=$C&customerId=$TAG-c1")
assert_eq "a time sheet too long is refused, not cut" "$code" "400"
assert_eq "and says why" "$(py "r['message']" < /tmp/t768.json)" "Der Stundennachweis umfasst mehr als 5 000 Einträge. Bitte grenzen Sie den Zeitraum ein."
# Tier 770
IMP=$(curl -sS -m 60 -X POST "${H[@]}" -H "Content-Type: application/json" -d '{}' "$API/api/v1/accounting/anlage-so/import-from-expenses?companyId=$C&year=2025")
assert_eq "all purchases reach the Anlage SO" "$(printf '%s' "$IMP" | py "len(r['transactions'])")" "510"
# Tier 771
curl -sS -m 60 "${H[@]}" "$API/api/v1/audit-logs/export.csv?companyId=$C" -o /tmp/t768.csv
ROWS=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "select count(*) from \"AuditLog\" where \"companyId\"='$C'")
assert_eq "the audit CSV holds every row" "$(( $(wc -l < /tmp/t768.csv | tr -d ' ') ))" "$ROWS"
assert_eq "with its header" "$(head -1 /tmp/t768.csv | cut -c4-14)" "Zeitstempel"
# Tier 772
assert_eq "a customer's payments in one answer" "$(get "customers/$TAG-c205/payments?companyId=$C" | py "[(p['invoiceNumber'], p['amount']) for p in r]")" "[('R-2', '119'), ('R-1', '119')]"
assert_eq "every supplier in the list" "$(get "suppliers?companyId=$C" | py "len(r['data'] if isinstance(r, dict) else r)")" "510"

# Tier 773
docker exec "$PG_CONTAINER" psql -q -U de_invoice -d de_invoice -c "insert into \"Product\"(id,\"companyId\",name,\"basePrice\",\"trackInventory\",\"updatedAt\") select '$TAG-pr'||n,'$C','Artikel '||lpad(n::text,3,'0'),1,n%2=0,now() from generate_series(1,120) n; update \"Expense\" set \"paidAt\"=now(), \"invoiceDate\"='2025-01-02' where id like '$TAG-e%' and id <> '$TAG-e7'; update \"Expense\" set \"invoiceDate\"='2020-01-01' where id='$TAG-e7'" >/dev/null
assert_eq "every tracked product has its stock page" "$(get "inventory/tracked?companyId=$C" | py "len(r)")" "60"
assert_eq "an old unpaid expense is offered to the bank" "$(get "expenses?companyId=$C&unpaid=true" | py "[e['invoiceNumber'] for e in r['data']]")" "['K-7']"

Q="delete from \"Product\" where \"companyId\"='$C'; delete from \"Payment\" where id like '$TAG-%'; delete from \"Invoice\" where \"companyId\"='$C'; delete from \"TimeEntry\" where \"companyId\"='$C'; delete from \"Expense\" where \"companyId\"='$C'; delete from \"Supplier\" where \"companyId\"='$C'; delete from \"Customer\" where \"companyId\"='$C'; delete from \"AuditLog\" where \"companyId\"='$C';"
docker exec "$PG_CONTAINER" psql -q -U de_invoice -d de_invoice -c "$Q" >/dev/null
rm -f /tmp/t768.json /tmp/t768.csv
summary
