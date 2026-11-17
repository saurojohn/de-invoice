#!/bin/bash
# Tier 851 — cash received for an invoice is in the Kassenbuch, however it is
# entered.
#
# Measured before (a probe of cross-report invariants, 17.11.2026): an invoice
# of 2,78 € paid „bar“ on the invoice page made the payment only. DATEV booked
# it on Kasse, while the Kassenbuch and the balance sheet's Kassenbestand never
# had it (619,00 instead of 621,78). A cash receipt entered in the Kassenbuch
# with its invoice made both (Tier 425); one entered on the invoice did not —
# § 146 Abs. 1 Satz 2 AO wants every cash receipt recorded.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TODAY=$(TZ=Europe/Berlin date +%F); Y=${TODAY:0:4}
YESTERDAY=$(python3 -c "import datetime;print((datetime.date.fromisoformat('$TODAY')-datetime.timedelta(days=1)).isoformat())")
TAG="e2e-544-$(date +%s%N | cut -c1-13)"
PSQL() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -qAtc "$1"; }
AS() {
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
company() { # tag
  local reg="{\"email\":\"$TAG-$1@example.test\",\"password\":\"Tier851-e2e\",\"companyName\":\"$TAG $1\"}"
  read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -d "$reg" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])")
  fixture_issuer "$C"; q="companyId=$C"
  AS POST "/api/v1/customers?$q" '{"name":"Kunde 544","type":"business","address":{"street":"S 1","postalCode":"10115","city":"Berlin","country":"DE"}}'; K=$(json_field "$BODY" id)
}
invoice() { # net → I N
  local b="{\"customerId\":\"$K\",\"issueDate\":\"$YESTERDAY\",\"items\":[{\"description\":\"Ware\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":$1,\"vatRate\":0.19}]}"
  AS POST "/api/v1/invoices?$q" "$b"; I=$(json_field "$BODY" id); N=$(json_field "$BODY" invoiceNumber)
  AS PUT "/api/v1/invoices/$I/status?$q" '{"status":"sent"}'
}
pay() { # invoice amount method day
  local b="{\"amount\":$2,\"paymentDate\":\"$4\",\"paymentMethod\":\"$3\"}"
  AS POST "/api/v1/invoices/$1/payments?$q" "$b"
}
cash() { PSQL "select coalesce(string_agg(type||' '||amount::numeric(10,2)||' '||coalesce(\"invoiceId\" = '$1', false)::text||' '||(\"paymentId\" is not null)::text, ' | ' order by \"createdAt\"), '-') from \"CashBookEntry\" where \"companyId\"='$C' and type <> 'eroeffnung'"; }
payments() { PSQL "select count(*)||' '||coalesce(sum(amount),0)::numeric(10,2) from \"Payment\" where \"invoiceId\"='$1'"; }

note "=== 1. a company that keeps its Kassenbuch here ==="
company kasse
OPEN="{\"businessDate\":\"$YESTERDAY\",\"type\":\"eroeffnung\",\"description\":\"Anfangsbestand\",\"amount\":100}"
AS POST "/api/v1/cashbook/entries?$q" "$OPEN"
assert_status 201 "fixture: the Kassenbuch opened with 100 €"
invoice 100
pay "$I" 119 cash "$TODAY"
assert_status 201 "a cash payment of 119 € entered on the invoice"
assert_eq "…the payment is there once" "$(payments "$I")" "1 119.00"
assert_eq "…and the Kassenbuch has the receipt, for that invoice and that payment (was: nothing)" "$(cash "$I")" "einnahme 119.00 true true"
AS GET "/api/v1/invoices/$I?$q"
assert_eq "…the invoice is paid" "$(json_field "$BODY" status)" "paid"
assert_eq "the Kassenbestand: 100 + 119 (was: 100)" \
  "$(PSQL "select sum(case when type in ('eroeffnung','einnahme') then amount else -amount end)::numeric(10,2) from \"CashBookEntry\" where \"companyId\"='$C'")" "219.00"

note "--- the Kassenbuch's rules hold for it ---"
invoice 50
CLOSE="{\"date\":\"$YESTERDAY\",\"physicalCount\":100}"
AS POST "/api/v1/cashbook/close-day?$q" "$CLOSE"
assert_status 201 "fixture: yesterday's Tagesabschluss"
pay "$I" 59.5 cash "$YESTERDAY"
assert_status 400 "a cash payment dated on a closed day is refused (was: 201, outside the Kassenbuch)"
assert_eq "…and no payment was made" "$(payments "$I")" "0 0.00"
pay "$I" 59.5 bank_transfer "$YESTERDAY"
assert_status 201 "a bank transfer on that day is no cash: as before"
assert_eq "…and not in the Kassenbuch" "$(PSQL "select count(*) from \"CashBookEntry\" where \"invoiceId\"='$I'")" "0"

note "--- entered in the Kassenbuch itself: one payment, one entry ---"
invoice 10
E="{\"businessDate\":\"$TODAY\",\"type\":\"einnahme\",\"description\":\"Zahlung $N\",\"amount\":11.9,\"invoiceId\":\"$I\"}"
AS POST "/api/v1/cashbook/entries?$q" "$E"
assert_status 201 "a receipt for an invoice entered in the Kassenbuch"
assert_eq "…one payment, one entry" "$(payments "$I")/$(PSQL "select count(*) from \"CashBookEntry\" where \"invoiceId\"='$I'")" "1 11.90/1"

note "=== 2. a company without a Kassenbuch here: as before ==="
company ohne
invoice 100
pay "$I" 119 cash "$TODAY"
assert_status 201 "a cash payment on the invoice"
assert_eq "…the payment, and no Kassenbuch is started for it" "$(payments "$I")/$(PSQL "select count(*) from \"CashBookEntry\" where \"companyId\"='$C'")" "1 119.00/0"

note "=== 3. the texts of the pages carry no ICU syntax ==="
# Tier 851: the page's t() replaces {name} only. „banking.syncOk“ was written as
# {count, plural, =0 {…} one {# …} other {# …}} and showed as that after every
# bank sync (de, en). The singular is a key of its own (Tier 826: key_one).
ICU=$(python3 - "$SCRIPT_DIR/../../frontend/messages" <<'PY'
import json, re, sys, os
def flat(d, p=""):
    for k, v in d.items():
        kk = f"{p}.{k}" if p else k
        if isinstance(v, dict): yield from flat(v, kk)
        else: yield kk, v
bad = [f"{l}:{k}" for l in ("de", "en", "zh") for k, v in flat(json.load(open(os.path.join(sys.argv[1], f"{l}.json"))))
       if re.search(r"\{\s*\w+\s*,\s*(plural|select|selectordinal|number|date|time)\b", str(v))]
print(" ".join(bad) or "none")
PY
)
assert_eq "no message uses {name, plural, …} (was: banking.syncOk in de and en)" "$ICU" "none"
summary
