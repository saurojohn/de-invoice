#!/bin/bash
# Tier 764 — the sums of the invoice list come from the database
#
# Each opening of the list read all documents with their payments and credit
# notes into the process for two numbers. With 50 000 of them, five users at once
# ended it (exit 137 in a container of 1 GiB). The SQL has to say what the code
# said: in euros at the invoice's rate, what a payment left open, nothing for a
# draft, a cancelled invoice, a Proforma or one a credit note covers.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="t764-$(date +%s)"
BODY="{\"email\":\"$TAG@example.test\",\"password\":\"Tier764-e2e\",\"companyName\":\"$TAG GmbH\"}"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$BODY" \
  | python3 -c "import json,sys; r=json.load(sys.stdin); print(r['user']['id'], r['company']['id'])")
H=(-H "x-user-id: $U" -H "x-company-id: $C")
SQLF=$(mktemp)
ROW() { # id number type status date total eurTotal customer [reference]
  printf "insert into \"Invoice\"(id,\"companyId\",\"customerId\",\"invoiceNumber\",type,status,\"issueDate\",subtotal,\"totalVat\",total,\"eurTotal\",currency,\"customerName\",\"referenceInvoiceId\",\"updatedAt\") values ('$TAG-$1','$C','$TAG-$8','$2','$3','$4','$5',0,0,$6,$7,'EUR','x',%s,now());\n" "${9:-null}" >> "$SQLF"
}
cat > "$SQLF" <<SQL
insert into "Customer"(id,"companyId",type,name,address,"updatedAt") values
  ('$TAG-a','$C','business','Alpha $TAG','{"country":"DE"}',now()),
  ('$TAG-b','$C','business','Beta $TAG','{"country":"DE"}',now());
SQL
ROW eur   A-1 INV sent      2026-02-01 100    null   a   # open 100
ROW usd   A-2 INV sent      2026-03-01 200    100    b   # 200 USD at 0,5: open 100 EUR
ROW part  A-3 INV sent      2026-04-01 300    null   a   # 120 paid: open 180
ROW over  A-4 INV sent      2026-04-01 50     null   a   # 80 paid: nothing open, not -30
ROW paid  A-5 INV paid      2026-05-01 70     null   b
ROW draft A-6 INV draft     2026-05-01 1000   null   a   # counts in the total, not as open
ROW canc  A-7 INV cancelled 2026-05-01 2000   null   a
ROW stor  A-8 INV sent      2026-06-01 400    null   b   # covered by a credit note
ROW cn    C-1 CN  sent      2026-06-02 400    null   b   "'$TAG-stor'"
ROW half  A-9 INV sent      2026-06-03 500    null   b   # a credit note for part of it
ROW cn2   C-2 CN  sent      2026-06-04 100    null   b   "'$TAG-half'"
ROW dcn   A-0 INV sent      2026-06-05 60     null   a   # a draft credit note counts for nothing
ROW cn3   C-3 CN  draft     2026-06-06 60     null   a   "'$TAG-dcn'"
ROW pi    P-1 PI  sent      2026-06-07 900    null   a   # a Proforma is no claim
ROW quote Q-1 QU  draft     2026-06-08 7000   null   a   # nor in this list
cat >> "$SQLF" <<SQL
insert into "Payment"(id,"invoiceId",amount,"paymentDate","paymentMethod") values
  ('$TAG-p1','$TAG-part',120,'2026-04-10','bank_transfer'),
  ('$TAG-p2','$TAG-over',80,'2026-04-10','bank_transfer'),
  ('$TAG-p3','$TAG-paid',70,'2026-05-10','bank_transfer');
SQL
docker exec -i "$PG_CONTAINER" psql -q -U de_invoice -d de_invoice -v ON_ERROR_STOP=1 < "$SQLF" >/dev/null
rm -f "$SQLF"
sums() { curl -sS -m 30 "${H[@]}" "$API/api/v1/invoices?companyId=$C&pageSize=1&$1" | python3 -c "import json,sys; s=json.load(sys.stdin)['sums']; print(s['totalEur'], s['openEur'])"; }

# total: every row but the quote, the 200 USD as 100 EUR. Open: 100 + 100 + 180 + 500 + 60.
assert_eq "everything"              "$(sums '')"                            "6040 940"
assert_eq "the unpaid"              "$(sums 'status=sent')"                 "2910 940"
assert_eq "two statuses"            "$(sums 'status=paid,draft')"           "1130 0"
assert_eq "one type"                "$(sums 'type=CN')"                     "560 0"
assert_eq "a Proforma owes nothing" "$(sums 'type=PI')"                     "900 0"
assert_eq "a quote is listed when asked for" "$(sums 'type=QU')"            "7000 0"
assert_eq "one customer"            "$(sums "customerId=$TAG-b")"           "1570 600"
assert_eq "from a date"             "$(sums 'dateFrom=2026-06-01')"         "2420 560"
assert_eq "to a date"               "$(sums 'dateTo=2026-03-31')"           "200 200"
assert_eq "by number"               "$(sums 'search=A-2')"                  "100 100"
assert_eq "by customer"             "$(sums "search=Alpha")"                "4470 340"
assert_eq "nothing found"           "$(sums 'search=zzzznichts')"           "0 0"
assert_eq "together"                "$(sums "status=sent&search=Beta&dateFrom=2026-06-01")" "1400 500"

docker exec "$PG_CONTAINER" psql -q -U de_invoice -d de_invoice -c "delete from \"Payment\" where id like '$TAG-%'; update \"Invoice\" set \"referenceInvoiceId\"=null where \"companyId\"='$C'; delete from \"Invoice\" where \"companyId\"='$C'; delete from \"Customer\" where \"companyId\"='$C';" >/dev/null
summary
