#!/bin/bash
# Tier 883 — a bank statement is read in its own encoding
#
# Found on the walk after Tier 882: both bank upload routes read the bytes as
# UTF-8. German banks deliver MT940 in ISO-8859-1 / Windows-1252 as often as
# not; the counterparty „BÄCKEREI MÜLLER GMBH“ was stored as „B?CKEREI
# M?LLER GMBH“ (U+FFFD), the purpose „Bäckerei“ as „B?ckerei“. A CAMT file
# declaring ISO-8859-1 was read as UTF-8 too.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-575-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier883-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
DIR=$(mktemp -d)
upload() { curl -sS -X POST -H "x-user-id: $U" -H "x-company-id: $C" "$API/api/v1/bank-statements/$1?companyId=$C" -F "file=@$2;type=$3" -F "companyId=$C" -F "userId=$U"; }
latest() { q "select t.\"counterpartyName\"||' | '||t.purpose from \"BankTransaction\" t join \"BankStatement\" s on s.id=t.\"statementId\" where s.\"companyId\"='$C' and s.id='$1'"; }
sid() { python3 -c "import json,sys;print(json.loads(sys.argv[1]).get('id'))" "$1"; }

note "=== 1. MT940 in ISO-8859-1 ==="
python3 - "$DIR/latin1.sta" <<'PY'
import sys
text = (":20:STL1\r\n:25:DE89370400440532013000\r\n:28C:1/1\r\n:60F:C261101EUR1000,00\r\n"
        ":61:2611021102C119,00NTRFNONREF//X\r\n"
        ":86:166?00GUTSCHRIFT?20SVWZ+Rechnung RE-77 Bäckerei?32BÄCKEREI MÜLLER GMBH\r\n"
        ":62F:C261102EUR1119,00\r\n-\r\n")
open(sys.argv[1], "wb").write(text.encode("latin-1"))
PY
R=$(upload preview "$DIR/latin1.sta" text/plain)
assert_eq "the preview shows the name as the bank wrote it" \
  "$(python3 -c "import json,sys;d=json.loads(sys.argv[1]);t=(d.get('sampleTransactions') or [{}])[0];print(t.get('counterpartyName'))" "$R")" "BÄCKEREI MÜLLER GMBH"
R=$(upload import "$DIR/latin1.sta" text/plain)
assert_eq "stored: name and purpose with their umlauts (was: B�CKEREI M�LLER GMBH)" "$(latest "$(sid "$R")")" "BÄCKEREI MÜLLER GMBH | Rechnung RE-77 Bäckerei"

note "=== 2. MT940 in UTF-8: as before ==="
python3 - "$DIR/utf8.sta" <<'PY'
import sys
text = (":20:STU1\r\n:25:DE89370400440532013000\r\n:28C:2/1\r\n:60F:C261102EUR1119,00\r\n"
        ":61:2611031103C50,00NTRFNONREF//X\r\n"
        ":86:166?00GUTSCHRIFT?20SVWZ+Rechnung RE-78 Größe?32JÜRGEN WEISS\r\n"
        ":62F:C261103EUR1169,00\r\n-\r\n")
open(sys.argv[1], "wb").write(text.encode("utf-8"))
PY
R=$(upload import "$DIR/utf8.sta" text/plain)
assert_eq "UTF-8 is read as UTF-8" "$(latest "$(sid "$R")")" "JÜRGEN WEISS | Rechnung RE-78 Größe"

note "=== 3. CAMT declaring ISO-8859-1 ==="
python3 - "$DIR/latin1.xml" <<'PY'
import sys
xml = """<?xml version="1.0" encoding="ISO-8859-1"?>
<Document><BkToCstmrStmt><Stmt>
<Acct><Id><IBAN>DE89370400440532013000</IBAN></Id></Acct>
<Bal type="OPBD"><Amt>100.00</Amt><Ccy>EUR</Ccy><Dt>2026-11-01</Dt></Bal>
<Bal type="CLBD"><Amt>300.00</Amt><Ccy>EUR</Ccy><Dt>2026-11-30</Dt></Bal>
<Ntry><Amt>200.00</Amt><Ccy>EUR</Ccy><CdtDbtInd>CRDT</CdtDbtInd>
<BookgDt><Dt>2026-11-15</Dt></BookgDt><ValDt><Dt>2026-11-15</Dt></ValDt>
<TxDtls><CdtTrxTxInf><PmtId><EndToEndId>E2E-575</EndToEndId></PmtId>
<RmtInf><Ustrd>Rechnung RE-79 Schlüsseldienst</Ustrd></RmtInf>
<Dbtr><Nm>Frau Müller</Nm></Dbtr></CdtTrxTxInf></TxDtls></Ntry>
</Stmt></BkToCstmrStmt></Document>
"""
open(sys.argv[1], "wb").write(xml.encode("latin-1"))
PY
R=$(upload import "$DIR/latin1.xml" application/xml)
assert_eq "read in the declared encoding" "$(latest "$(sid "$R")")" "Frau Müller | Rechnung RE-79 Schlüsseldienst"
rm -rf "$DIR"
summary
