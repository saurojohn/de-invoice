#!/bin/bash
# Tier 488 — a bank transaction is imported once
#
# Measured before: the same CAMT file imported twice gave two statements and
# the 1 190 € receipt twice (200 both times); the copy stayed open, to be
# matched or booked as an expense a second time. Now transactions already
# imported (same account, value date, amount, reference, purpose,
# counterparty IBAN) are skipped — counted per key, so two genuinely
# identical bookings in one file both stay — and a file with nothing new is
# refused (409).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-274-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier488-e2e\",\"companyName\":\"$TAG Handel\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
camt() { # file closing entries...
  local f=$1 close=$2; shift 2
  { echo '<?xml version="1.0" encoding="UTF-8"?><Document><BkToCstmrStmt><Stmt>'
    echo '<Acct><Id><IBAN>DE02120300000000202051</IBAN></Id></Acct>'
    echo '<Bal type="OPBD"><Amt>0.00</Amt><Ccy>EUR</Ccy><Dt>2026-06-01</Dt></Bal>'
    echo "<Bal type=\"CLBD\"><Amt>$close</Amt><Ccy>EUR</Ccy><Dt>2026-06-30</Dt></Bal>"
    for e in "$@"; do
      IFS='|' read -r amt ind dt ref txt <<< "$e"
      echo "<Ntry><Amt>$amt</Amt><Ccy>EUR</Ccy><CdtDbtInd>$ind</CdtDbtInd><BookgDt><Dt>$dt</Dt></BookgDt><ValDt><Dt>$dt</Dt></ValDt>"
      echo "<TxDtls><CdtTrxTxInf>${ref:+<PmtId><EndToEndId>$ref</EndToEndId></PmtId>}<RmtInf><Ustrd>$txt</Ustrd></RmtInf></CdtTrxTxInf></TxDtls></Ntry>"
    done
    echo '</Stmt></BkToCstmrStmt></Document>'; } > "$f"
}
up() { # file → "status skipped transactions"
  local resp; resp=$(curl -sS -w "\n%{http_code}" -X POST -H "x-user-id: $U" -H "x-company-id: $C" \
    "$API/api/v1/bank-statements/import?companyId=$C" -F "file=@$1;type=application/xml" -F "companyId=$C" -F "userId=$U")
  local st; st=$(echo "$resp" | tail -n1)
  echo "$st $(echo "$resp" | sed '$d' | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('skippedDuplicates','-'), len(d.get('transactions',[])))" 2>/dev/null)"
}

camt /tmp/t488-a.xml 1190.00 "1190.00|CRDT|2026-06-15|E2E-488|Rechnung 1"
assert_eq "first import" "$(up /tmp/t488-a.xml)" "201 0 1"
assert_eq "the same file again: refused (was 201, the receipt twice)" "$(up /tmp/t488-a.xml | cut -d' ' -f1)" "409"

camt /tmp/t488-b.xml 1090.00 "1190.00|CRDT|2026-06-15|E2E-488|Rechnung 1" "100.00|DBIT|2026-06-20||Miete Juni"
assert_eq "an overlapping statement: only the new debit, 1 skipped" "$(up /tmp/t488-b.xml)" "201 1 1"

camt /tmp/t488-c.xml -19.98 "9.99|DBIT|2026-06-25||Abo" "9.99|DBIT|2026-06-25||Abo"
assert_eq "two identical bookings in one file: both kept" "$(up /tmp/t488-c.xml)" "201 0 2"
assert_eq "…and that file again: refused" "$(up /tmp/t488-c.xml | cut -d' ' -f1)" "409"

summary
