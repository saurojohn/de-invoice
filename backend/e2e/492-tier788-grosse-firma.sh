#!/bin/bash
# Tier 788 — a large company: the accounting page's computations once, every
# open invoice in the bank suggestions
#
# Measured on a company of 50 000 invoices (a throwaway database):
#   - the accounting page sends 24 requests; the Bilanz, the Anhang, the
#     E-Bilanz and the UStJA each computed the year's twelve monthly UStVA,
#     and the GuV was computed 19 times (GuV → KSt 1 → GuV before tax, in
#     every one of them): 6,7 s for the page. Identical computations asked
#     while one runs now share it (common/shared-while-running.ts) — never
#     one that began before a write — and the UStVA reads the columns it
#     uses: 3,9 s.
#   - the bank suggestions read the newest 2 000 open invoices: an older open
#     invoice got no suggestion, even with its number in the purpose.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-492-$(date +%s%N | cut -c1-13)"
PW="Tier788-e2e"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
field() { python3 -c "import json,sys
try:
  d=json.load(sys.stdin)
  for k in '$1'.split('.'): d=d.get(k) if isinstance(d,dict) else None
  print(d if d is not None else '')
except Exception: print('')" < "$D/out"; }
req() { # method path [body] → status; body in $D/out
  curl -sS -o "$D/out" -w '%{http_code}' -X "$1" "$API$2" -H "Content-Type: application/json" "${A[@]}" ${3:+-d "$3"}
}

note "=== sharing a computation: joined while it runs, never across a write ==="
OUT=$(cd "$SCRIPT_DIR/.." && npx ts-node -T -e "
import { shareWhileRunning, noteWrite } from './src/common/shared-while-running'
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
let runs = 0
const slow = (v: string) => async () => { runs++; await wait(150); return { v } }
;(async () => {
  const out: string[] = []
  const [a, b] = await Promise.all([shareWhileRunning('k', slow('a')), (async () => { await wait(20); return shareWhileRunning('k', slow('b')) })()])
  out.push('joined=' + (a === b && runs === 1))
  runs = 0
  const first = shareWhileRunning('k', slow('c'))
  await wait(20); noteWrite()
  const second = await shareWhileRunning('k', slow('d'))
  out.push('afterWrite=' + ((await first).v + second.v) + '/' + runs)
  runs = 0
  await shareWhileRunning('k', slow('e')); await shareWhileRunning('k', slow('f'))
  out.push('finishedNotKept=' + runs)
  const failed = await shareWhileRunning('x', async () => { throw new Error('boom') }).catch((e) => e.message)
  const again = await shareWhileRunning('x', async () => 'ok')
  out.push('failure=' + failed + '/' + again)
  console.log(out.join(' '))
})()
" 2>&1 | tail -1)
assert_eq "two callers while it runs: one computation, one result" "$(grep -o 'joined=[a-z]*' <<<"$OUT")" "joined=true"
assert_eq "a write while it runs: the next caller computes anew and sees it" "$(grep -o 'afterWrite=[a-z0-9/]*' <<<"$OUT")" "afterWrite=cd/2"
assert_eq "a finished computation is not kept" "$(grep -o 'finishedNotKept=[0-9]*' <<<"$OUT")" "finishedNotKept=2"
assert_eq "a failure reaches its callers and is not kept" "$(grep -o 'failure=[a-z/]*' <<<"$OUT")" "failure=boom/ok"

st=$(curl -sS -o "$D/out" -w '%{http_code}' -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"$PW\",\"companyName\":\"$TAG GmbH\"}")
U=$(field user.id); C=$(field user.companyId)
assert_eq "fixture: a company" "$st/${#C}" "201/36"
A=(-H "x-user-id: $U" -H "x-company-id: $C")
fixture_issuer "$C" DE811111111
YEAR=$(( $(date +%Y) - 1 ))

note "=== the UStJA and the Bilanz asked at once; then a new expense ==="
st=$(req POST "/api/v1/ustva/expenses?companyId=$C" "{\"invoiceDate\":\"$YEAR-03-10\",\"description\":\"Material\",\"netAmount\":1000,\"vatRate\":0.19,\"category\":\"material\"}")
assert_eq "fixture: an expense of March" "$st" "201"
for i in 1 2 3; do
  curl -sS -o "$D/ustja-$i" "$API/api/v1/ustva/ustja?companyId=$C&year=$YEAR" "${A[@]}" &
  curl -sS -o "$D/bilanz-$i" "$API/api/v1/accounting/bilanz?companyId=$C&year=$YEAR" "${A[@]}" &
done
wait
same=$(python3 - "$D" <<'PY'
import json, sys, os
d = sys.argv[1]
def load(n):
    x = json.load(open(os.path.join(d, n)))
    x.pop('generatedAt', None)
    return json.dumps(x, sort_keys=True)
u = {load(f'ustja-{i}') for i in (1, 2, 3)}; b = {load(f'bilanz-{i}') for i in (1, 2, 3)}
print(f"{len(u)}/{len(b)}")
PY
)
assert_eq "three UStJA and three Bilanzen at once: each the same answer" "$same" "1/1"
assert_eq "…the UStJA has the March input tax" "$(python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(next(m['vorsteuer'] for m in d['monthlyBreakdown'] if m['month']==3))" "$D/ustja-1")" "190"
st=$(req POST "/api/v1/ustva/expenses?companyId=$C" "{\"invoiceDate\":\"$YEAR-03-20\",\"description\":\"Werkzeug\",\"netAmount\":500,\"vatRate\":0.19,\"category\":\"material\"}")
req GET "/api/v1/ustva/ustja?companyId=$C&year=$YEAR" >/dev/null
assert_eq "an expense written after them is in the next UStJA" "$(python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(next(m['vorsteuer'] for m in d['monthlyBreakdown'] if m['month']==3))" "$D/out")" "285"

note "=== the bank suggestions see every open invoice ==="
st=$(req POST "/api/v1/customers?companyId=$C" "{\"name\":\"Kunde $TAG\",\"type\":\"business\",\"contact\":{\"email\":\"k-$TAG@example.test\"},\"address\":{\"street\":\"a\",\"city\":\"Köln\",\"postalCode\":\"50667\",\"country\":\"DE\"}}")
K=$(field id)
# 2 100 open invoices; the oldest, of 2020, is the one the transfer names
q "insert into \"Invoice\"(id,\"companyId\",\"customerId\",\"invoiceNumber\",\"sequenceNumber\",type,status,\"issueDate\",\"dueDate\",subtotal,\"totalVat\",total,currency,language,\"templateType\",\"createdAt\",\"updatedAt\")
   select gen_random_uuid()::text,'$C','$K','E492-'||lpad(n::text,5,'0'),n,'INV','sent',
     case when n=1 then timestamp '2020-01-15' else timestamp '2026-01-01' + (n||' minutes')::interval end,
     case when n=1 then timestamp '2020-02-15' else timestamp '2026-02-01' end,
     case when n=1 then 1037.45 else 100+n end, case when n=1 then 197.11 else 19 end, case when n=1 then 1234.56 else 119+n end,
     'EUR','de-DE','standard',now(),now() from generate_series(1,2100) n" >/dev/null
assert_eq "fixture: 2 100 open invoices" "$(q "select count(*) from \"Invoice\" where \"companyId\"='$C' and status='sent'")" "2100"
SID=$(q "insert into \"BankStatement\"(id,\"companyId\",format,\"fileName\",\"fileSize\",\"rawContent\",\"createdAt\") values (gen_random_uuid()::text,'$C','fints-mock','t492.json',100,'[]',now()) returning id" | head -1)
TID=$(q "insert into \"BankTransaction\"(id,\"statementId\",\"companyId\",\"valueDate\",\"entryDate\",amount,currency,purpose,\"counterpartyName\",\"createdAt\") values (gen_random_uuid()::text,'$SID','$C',now(),now(),1234.56,'EUR','Rechnung E492-00001 vom 15.01.2020','Kunde $TAG',now()) returning id" | head -1)
st=$(req GET "/api/v1/bank-statements/$SID/transactions/$TID/candidates?companyId=$C")
assert_eq "the old invoice is the first candidate (was none — it is not among the newest 2 000)" "$st/$(python3 -c "import json;d=json.load(open('$D/out'));c=d.get('candidates') or [];print(c[0]['invoiceNumber'] if c else '')")" "200/E492-00001"
st=$(req POST "/api/v1/bank-statements/$SID/suggest?companyId=$C" '{"autoConfirmThreshold":90}')
assert_eq "the statement's suggestion run confirms it" "$st/$(field generated)/$(field autoConfirmed)" "201/1/1"
assert_eq "…the invoice is paid" "$(q "select status from \"Invoice\" where \"companyId\"='$C' and \"invoiceNumber\"='E492-00001'")" "paid"

summary
