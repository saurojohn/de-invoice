#!/bin/bash
# Tier 984 — BLZ/Kontonummer and IBAN are the same account
#
# MT940 :25: often names the account as BLZ/Kontonummer (Sparkassen,
# Volksbanken); camt.053 names the IBAN. The duplicate check compared the two
# strings: the same receipt of 119 € (same day, EndToEndId, purpose, payer)
# from an MT940 and then a CAMT of the same account was imported twice — two
# rows to match or book (GoBD Rz. 44), for every overlap when a business moves
# from MT940 to CAMT.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-671-$(date +%s%N | cut -c1-13)"
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT

read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier984-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
{
  printf ':20:STARTUMS\n:25:37040044/0532013000\n:28C:1/1\n:60F:C260910EUR1000,00\n'
  printf ':61:2609100910C119,00NTRFNONREF\n:86:166?00GUTSCHRIFT?20EREF+E2E-0042?21SVWZ+Rechnung 42?31DE02120300000000202051?32Kunde A\n'
  printf ':62F:C260910EUR1119,00\n-\n'
} > "$W/st.mt940"
cat > "$W/st.xml" <<'X'
<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt>
<Acct><Id><IBAN>DE89370400440532013000</IBAN></Id><Ccy>EUR</Ccy></Acct>
<Bal><Tp><CdOrPrtry><Cd>PRCD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">1000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-09-09</Dt></Dt></Bal>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">1119.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-09-10</Dt></Dt></Bal>
<Ntry><Amt Ccy="EUR">119.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2026-09-10</Dt></BookgDt><ValDt><Dt>2026-09-10</Dt></ValDt>
<NtryDtls><TxDtls><Refs><EndToEndId>E2E-0042</EndToEndId></Refs>
<RltdPties><Dbtr><Nm>Kunde A</Nm></Dbtr><DbtrAcct><Id><IBAN>DE02120300000000202051</IBAN></Id></DbtrAcct></RltdPties>
<RmtInf><Ustrd>Rechnung 42</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
</Stmt></BkToCstmrStmt></Document>
X
imp() { curl -sS -X POST -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/bank-statements/import?companyId=$C" \
  -F "file=@$1;type=text/plain" --form-string "companyId=$C" --form-string "userId=$U"; }
R1=$(imp "$W/st.mt940")
assert_eq "the MT940 (:25: 37040044/0532013000): imported, its account as the IBAN" \
  "$(echo "$R1" | python3 -c "import sys,json;d=json.load(sys.stdin);print(len(d['transactions']), d.get('accountIban'))" 2>&1)" "1 DE89370400440532013000"
R2=$(imp "$W/st.xml")
assert_eq "the CAMT of the same account: its one receipt is already there — 409 (was imported again)" \
  "$(echo "$R2" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('statusCode'), 'bereits importiert' in str(d.get('message')))" 2>&1)" "409 True"
assert_eq "…one row of 119 € for the company" \
  "$(docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -qAtc "select count(*) from \"BankTransaction\" where \"companyId\"='$C' and amount=119")" "1"

summary
