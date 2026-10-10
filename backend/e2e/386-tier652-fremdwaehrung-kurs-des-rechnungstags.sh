#!/bin/bash
# Tier 652 — an invoice in a foreign currency is converted at the rate of its
# own day, and never 1 : 1 for want of a rate
#
# Reconciled by hand with the real ECB reference rates (10.10.2026): USD
# 1,1206 on 09.10., 1,1539 on 15.09., 1,1535 on 03.08.; SEK 11,1675.
#   - A company one hour old issued 10 000 USD + 19 %: booked as 10 000 € and
#     1 900 € of VAT. No rate had been fetched yet (the nightly run does it),
#     and without one the rate was 1.
#   - 10 000 SEK: booked as 10 000 €. The nightly run fetches seven
#     currencies; any other was 1 : 1 for good. They were 895,46 €.
#   - An invoice dated 15.09. and typed in on 10.10.: converted at 1,1206, the
#     latest rate, not 1,1539 — 48,93 € too much VAT on 1 900 USD.
#   - A credit note of 1 190 USD on a USD invoice was created in EUR, without
#     a rate: 1 000 € and 190 € of VAT left the UStVA instead of 892,38 € and
#     169,55 €.
#   - A draft switched from EUR to USD kept its euro figures.
# Now: the ECB reference rate of the invoice's day (the last one published on
# or before it), for any currency the ECB quotes; a rate entered by hand (the
# BMF's monthly average of § 16 Abs. 6 UStG, a bank's rate); and where there
# is neither, the invoice is refused with the reason.
#
# CI has no way out to the ECB: EXCHANGE_RATES_MOCK=1 gives USD 1.0850,
# CHF 0.9248, GBP 0.8520 for every day and nothing for other currencies. The
# request to the ECB itself is tried in section 6 against a server of this
# spec's own that answers as the ECB does.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-386-$(date +%s%N | cut -c1-13)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"; [[ -n "${FAKE_PID:-}" ]] && kill "$FAKE_PID" 2>/dev/null' EXIT
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
F() { python3 -c "
import sys, json
try: d = json.load(sys.stdin)
except Exception: print(''); sys.exit()
v = d.get('$1') if isinstance(d, dict) else None
print('' if v is None else v)" <<< "$BODY"; }
ROW() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -F'|' -c \
  "select currency, \"exchangeRate\", coalesce(\"exchangeRateSource\",'-'), \"eurSubtotal\", \"eurTotalVat\", \"eurTotal\" from \"Invoice\" where id='$1'"; }
TODAY=$(TZ=Europe/Berlin date +%F); YEAR=${TODAY:0:4}; MONTH=$((10#${TODAY:5:2}))
MOCK=${EXCHANGE_RATES_MOCK:-}
[[ "$MOCK" == "1" ]] || { note "EXCHANGE_RATES_MOCK is not 1 — sections 1–5 need the fixed rates and are skipped"; }

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier652-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company registered a moment ago — no rates fetched for it" || { fail "register"; summary; exit 1; }
fixture_issuer "$C" "DE123456789"
AS POST "/api/v1/customers?companyId=$C" '{"name":"Importhaus Nord GmbH","type":"business","address":{"street":"Hafenweg 3","postalCode":"20457","city":"Hamburg","country":"DE"}}'; K=$(F id)
inv() { # currency price [extra json fields]
  AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"'$K'","issueDate":"'$TODAY'","dueDate":"2099-12-31","currency":"'$1'","items":[{"description":"Lederwaren","quantity":1,"unit":"Stk","unitPrice":'$2',"vatRate":0.19}]'"${3:+,$3}"'}'
}

if [[ "$MOCK" == "1" ]]; then
note "=== 1. the first invoice of a new company ==="
inv USD 10000; I1=$(F id)
assert_eq "10 000 USD + 19 %: created" "$STATUS" "201"
assert_eq "… at the rate of its day, not 1 : 1 (was USD|1|-|10000|1900|11900)" "$(ROW "$I1")" "USD|1.085000|ecb:$TODAY|9216.5899|1751.1521|10967.7419"
assert_eq "the answer says where the rate is from" "$(F exchangeRateSource)" "ecb:$TODAY"
AS PUT "/api/v1/invoices/$I1/status?companyId=$C" '{"status":"sent"}'
assert_eq "issued" "$STATUS" "200"

note "=== 2. a currency without a rate ==="
N0=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tAc "select count(*) from \"Invoice\" where \"companyId\"='$C'")
inv SEK 10000
assert_eq "10 000 SEK without a rate: refused (was booked as 10 000 €)" "$STATUS" "400"
echo "$BODY" | grep -q "keinen Referenzkurs" && echo "$BODY" | grep -q "von Hand eintragen" \
  && pass "… and the answer says what to do" || fail "the refusal does not say what to do: $BODY"
assert_eq "nothing was created" "$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tAc "select count(*) from \"Invoice\" where \"companyId\"='$C'")" "$N0"
inv SEK 10000 '"exchangeRate":11.1675'; I2=$(F id)
assert_eq "with the rate entered by hand: created" "$STATUS" "201"
assert_eq "10 000 SEK at 11,1675 = 895,46 € net, 170,14 € VAT" "$(ROW "$I2")" "SEK|11.167500|manual|895.4556|170.1366|1065.5921"
assert_eq "no number was lost to the refusal" "$(F invoiceNumber | sed 's/.*-0*//')" "2"
inv Dollar 100
assert_eq "\"Dollar\" is not a currency code" "$STATUS" "400"
inv USD 100 '"exchangeRate":-1'
assert_eq "a negative rate is refused" "$STATUS" "400"
inv USD 100 '"exchangeRate":true'
assert_eq "true is not a rate" "$STATUS" "400"
inv usd 1000 '"exchangeRate":0'; I3=$(F id)
assert_eq "0 asks for the ECB's rate; the code is stored in capitals" "$(ROW "$I3")" "USD|1.085000|ecb:$TODAY|921.6590|175.1152|1096.7742"
inv EUR 1000; I4=$(F id)
assert_eq "an EUR invoice: rate 1, no source, its own amounts" "$(ROW "$I4")" "EUR|1.000000|-|1000.0000|190.0000|1190.0000"

note "=== 3. a draft that changes ==="
AS PUT "/api/v1/invoices/$I4?companyId=$C" '{"currency":"USD"}'
assert_eq "the EUR draft becomes a USD draft" "$STATUS" "200"
assert_eq "… and its euro figures follow (were 1000 / 190 / 1190)" "$(ROW "$I4")" "USD|1.085000|ecb:$TODAY|921.6590|175.1152|1096.7742"
AS PUT "/api/v1/invoices/$I4?companyId=$C" '{"exchangeRate":1.25}'
assert_eq "a rate entered on the draft" "$(ROW "$I4")" "USD|1.250000|manual|800.0000|152.0000|952.0000"
AS PUT "/api/v1/invoices/$I4?companyId=$C" '{"items":[{"description":"Lederwaren","quantity":2,"unit":"Stk","unitPrice":1000,"vatRate":0.19}]}'
assert_eq "new lines keep the rate entered by hand" "$(ROW "$I4")" "USD|1.250000|manual|1600.0000|304.0000|1904.0000"
AS PUT "/api/v1/invoices/$I4?companyId=$C" '{"exchangeRate":0}'
assert_eq "0 goes back to the ECB's" "$(ROW "$I4")" "USD|1.085000|ecb:$TODAY|1843.3180|350.2304|2193.5484"
AS PUT "/api/v1/invoices/$I4?companyId=$C" '{"currency":"SEK"}'
assert_eq "a change to a currency without a rate is refused" "$STATUS" "400"
assert_eq "… and the draft is as it was" "$(ROW "$I4")" "USD|1.085000|ecb:$TODAY|1843.3180|350.2304|2193.5484"
AS PUT "/api/v1/invoices/$I4?companyId=$C" '{"currency":"EUR"}'
assert_eq "back to EUR" "$(ROW "$I4")" "EUR|1.000000|-|2000.0000|380.0000|2380.0000"

note "=== 4. a credit note ==="
AS POST "/api/v1/invoices/$I1/credit-note?companyId=$C" '{"amount":1190,"reason":"Preisnachlass"}'; CN=$(F id)
assert_eq "1 190 USD credited on the USD invoice" "$STATUS" "201"
assert_eq "… in USD, at the invoice's rate (was EUR, no rate: −1000 / −190 €)" "$(ROW "$CN")" "USD|1.085000|ecb:$TODAY|-921.6590|-175.1152|-1096.7742"
AS GET "/api/v1/ustva/compute?companyId=$C&year=$YEAR&month=$MONTH"
KZ81=$(python3 -c "
import sys, json
k = [x for x in json.load(sys.stdin)['kennzahlen'] if x['kz'] == '81'][0]
print('%.2f|%.2f' % (k['value'], k['tax']))" <<< "$BODY")
# I1 9216.59 / 1751.15; its credit note −921.66 / −175.12 (drafts are not counted)
assert_eq "UStVA Kz 81: 9 216,59 − 921,66 net, 1 751,15 − 175,12 VAT" "$KZ81" "8294.93|1576.04"

note "=== 5. a recurring invoice ==="
tpl() { AS POST "/api/v1/recurring-invoices?companyId=$C" '{"name":"'$1' Abo","customerId":"'$K'","interval":"monthly","startDate":"'$TODAY'","currency":"'$1'","items":[{"description":"Abo","quantity":1,"unitPrice":100,"vatRate":0.19}],"sendEmail":false}'; }
tpl USD; T1=$(F id)
AS POST "/api/v1/recurring-invoices/$T1/run?companyId=$C" ''
assert_eq "a USD template runs" "$STATUS" "201"
assert_eq "… at the rate of the day" "$(ROW "$(F invoiceId)")" "USD|1.085000|ecb:$TODAY|92.1659|17.5115|109.6774"
tpl SEK; T2=$(F id)
N1=$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tAc "select count(*) from \"Invoice\" where \"companyId\"='$C'")
AS POST "/api/v1/recurring-invoices/$T2/run?companyId=$C" ''
assert_eq "a SEK template: the run is refused (it booked 100 SEK as 100 €)" "$STATUS" "400"
assert_eq "… and no invoice was written" "$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tAc "select count(*) from \"Invoice\" where \"companyId\"='$C'")" "$N1"
fi

note "=== 6. the request to the ECB ==="
# A server that answers as data-api.ecb.europa.eu does (the columns and the
# rows were read from it on 10.10.2026): rows for the days in the window, an
# empty body for a series without a rate in these days (RUB), 404 for a series
# that does not exist.
cat > "$TMP/fake_ecb.py" <<'PY'
import http.server, sys, urllib.parse
HEAD = 'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS,OBS_CONF'
RATES = {'USD': [('2026-09-10', '1.1616'), ('2026-09-11', '1.1592'), ('2026-09-14', '1.1551'), ('2026-09-15', '1.1539'),
                 ('2026-10-08', '1.1190'), ('2026-10-09', '1.1206')],
         'SEK': [('2026-10-08', '11.194'), ('2026-10-09', '11.1675')], 'RUB': []}
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
        ccy = u.path.rsplit('/', 1)[-1].split('.')[1]
        if ccy == 'ERR': self.send_response(500); self.end_headers(); return
        if ccy not in RATES: self.send_response(404); self.end_headers(); self.wfile.write(b'{"title":"Not Found"}'); return
        a, b = q['startPeriod'][0], q['endPeriod'][0]
        rows = [(d, v) for d, v in RATES[ccy] if a <= d <= b]
        body = '' if not rows else HEAD + '\n' + '\n'.join('EXR.D.%s.EUR.SP00.A,D,%s,EUR,SP00,A,%s,%s,A,F' % (ccy, ccy, d, v) for d, v in rows) + '\n'
        self.send_response(200); self.send_header('Content-Type', 'text/csv'); self.end_headers(); self.wfile.write(body.encode())
s = http.server.HTTPServer(('127.0.0.1', 0), H)
print(s.server_address[1], flush=True)
s.serve_forever()
PY
python3 "$TMP/fake_ecb.py" > "$TMP/port" & FAKE_PID=$!
for _ in $(seq 1 50); do [[ -s "$TMP/port" ]] && break; sleep 0.1; done
PORT=$(cat "$TMP/port")
cat > "$SCRIPT_DIR/../.tier652-probe.ts" <<'TS'
import { ExchangeRateService } from './src/modules/exchange-rate/exchange-rate.service'
async function main() {
  // no cached snapshot for the company
  const prisma = { company: { findUnique: async () => ({ settings: {} }) } }
  const svc = new ExchangeRateService(prisma as any, {} as any)
  const out: string[] = []
  const one = async (label: string, f: () => Promise<any>) => {
    try { const r = await f(); out.push(`${label}=${r === null ? 'null' : `${r.rate}@${r.date ?? r.source}`}`) }
    catch (e: any) { out.push(`${label}=ERR ${e?.status ?? ''} ${String(e?.message).slice(0, 60)}`) }
  }
  await one('tue', () => svc.ecbRateOn('USD', '2026-09-15'))
  await one('sun', () => svc.ecbRateOn('USD', '2026-09-13'))
  await one('sek', () => svc.ecbRateOn('sek', '2026-10-09'))
  await one('rub', () => svc.ecbRateOn('RUB', '2026-10-09'))
  await one('xxx', () => svc.ecbRateOn('XXX', '2026-10-09'))
  await one('bad', () => svc.ecbRateOn('US$', '2026-10-09'))
  await one('err', () => svc.ecbRateOn('ERR', '2026-10-09'))
  await one('inv', () => svc.rateForInvoice('c', 'USD', new Date('2026-09-15T00:00:00Z')))
  await one('man', () => svc.rateForInvoice('c', 'RUB', '2026-10-09', 95.5))
  await one('none', () => svc.rateForInvoice('c', 'RUB', '2026-10-09'))
  await one('down', () => svc.rateForInvoice('c', 'ERR', '2026-10-09'))
  await one('eur', () => svc.rateForInvoice('c', 'EUR', '2026-10-09'))
  console.log(out.join('\n'))
}
main()
TS
( cd "$SCRIPT_DIR/.." && env -u EXCHANGE_RATES_MOCK ECB_API_BASE="http://127.0.0.1:$PORT" npx ts-node -T .tier652-probe.ts > "$TMP/probe.txt" 2>&1 )
rm -f "$SCRIPT_DIR/../.tier652-probe.ts"
P() { grep "^$1=" "$TMP/probe.txt" | head -1 | cut -d= -f2-; }
assert_eq "USD on Tuesday 15.09.: that day's rate" "$(P tue)" "1.1539@2026-09-15"
assert_eq "USD on Sunday 13.09.: Friday's rate" "$(P sun)" "1.1592@2026-09-11"
assert_eq "a currency outside the seven of the nightly run" "$(P sek)" "11.1675@2026-10-09"
assert_eq "a series without a rate in these days (an empty answer)" "$(P rub)" "null"
assert_eq "a series that does not exist (404)" "$(P xxx)" "null"
assert_eq "what is not a currency code is not asked for" "$(P bad)" "null"
[[ "$(P err)" == "ERR 503"* ]] && pass "the ECB answering 500 is \"not reachable\", not \"no rate\"" || fail "ECB 500: $(P err)"
assert_eq "an invoice of 15.09." "$(P inv)" "1.1539@ecb:2026-09-15"
assert_eq "a rate by hand needs no ECB" "$(P man)" "95.5@manual"
[[ "$(P none)" == "ERR 400"* ]] && pass "no rate and none entered: refused (400)" || fail "no rate: $(P none)"
[[ "$(P down)" == "ERR 503"* ]] && pass "the ECB down and no rate of the day cached: 503, not 1 : 1" || fail "ECB down: $(P down)"
assert_eq "EUR is 1" "$(P eur)" "1@eur"

note "=== 7. the migration ==="
grep -q 'ADD COLUMN "exchangeRateSource" TEXT' "$SCRIPT_DIR"/../prisma/migrations/*_invoice_exchange_rate_source/migration.sql \
  && pass "a migration adds Invoice.exchangeRateSource" || fail "no migration for exchangeRateSource"

summary
