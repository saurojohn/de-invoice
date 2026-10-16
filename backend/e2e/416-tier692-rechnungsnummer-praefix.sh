#!/bin/bash
# Tier 692 — the invoice-number prefix of the settings page is used
#
# Measured before: Einstellungen → „Rechnungspräfix“ stored "RE" (200, read
# back "RE") and the next invoice was INV-2026-000001 — invoice-number.ts
# hard-coded INV- and never read Company.invoicePrefix.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-416-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier692-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a company" || { fail "register"; summary; exit 1; }
AS() { local resp; resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" ${3:+-d "$3"}); STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d'); }
P() { echo "$BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
AS PUT "/api/v1/companies/$C?companyId=$C" '{"vatId":"DE123456789","address":{"street":"Hauptstr. 1","city":"Berlin","postalCode":"10115","country":"DE"}}'
AS POST "/api/v1/customers?companyId=$C" '{"name":"Kunde","type":"business","address":{"street":"Weg 2","city":"Hamburg","postalCode":"20095","country":"DE"}}'
K=$(P "d['id']")
Y=$(TZ=Europe/Berlin date +%Y)
mk() { AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"$(TZ=Europe/Berlin date +%F)\",\"items\":[{\"description\":\"x\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"; ID=$(P "d['id']"); NR=$(P "d['invoiceNumber']"); }
prefix() { AS PUT "/api/v1/companies/$C?companyId=$C" "{\"invoicePrefix\":\"$1\"}"; echo "$STATUS"; }

note "=== 1. the prefix is used ==="
assert_eq "set „RE“: 200" "$(prefix RE)" "200"
mk; A=$ID
assert_eq "the next invoice is RE-… (was: INV-$Y-000001)" "$NR" "RE-$Y-000001"
mk; B=$ID
assert_eq "…and counts on" "$NR" "RE-$Y-000002"

note "=== 2. deleting the newest draft gives its number back, with the prefix too ==="
AS DELETE "/api/v1/invoices/$B?companyId=$C"
assert_eq "the newest draft deleted" "$STATUS" "200"
mk
assert_eq "the next one takes its number again (no gap)" "$NR" "RE-$Y-000002"

note "=== 3. a changed prefix continues the count of the year ==="
assert_eq "lower case is taken, as upper case" "$(prefix rg)" "200"
mk
assert_eq "RG-…-000003" "$NR" "RG-$Y-000003"
assert_eq "empty: the default INV again" "$(prefix "")" "200"
mk
assert_eq "INV-…-000004" "$NR" "INV-$Y-000004"

note "=== 4. what is no prefix ==="
AS PUT "/api/v1/companies/$C?companyId=$C" '{"invoicePrefix":"R1"}'
assert_eq "digits: 400" "$STATUS" "400"
assert_eq "…the answer says what is allowed" "$(P "'1 bis 10 Buchstaben' in str(d['message'])")" "True"
assert_eq "another document's prefix (CN): 400" "$(prefix CN)" "400"
assert_eq "…nor AN (Angebot)" "$(prefix AN-)" "400"
assert_eq "more than 10 letters: 400" "$(prefix RECHNUNGENX)" "400"

note "=== 5. the other documents keep theirs ==="
assert_eq "fixture: RE again" "$(prefix RE)" "200"
AS PUT "/api/v1/invoices/$A/status?companyId=$C" '{"status":"sent"}'
AS POST "/api/v1/invoices/$A/credit-note?companyId=$C" '{"reason":"Storno"}'
assert_eq "a credit note is CN-…" "$STATUS $(P "d['invoiceNumber']" | cut -d- -f1)" "201 CN"
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"type\":\"QU\",\"issueDate\":\"$(TZ=Europe/Berlin date +%F)\",\"items\":[{\"description\":\"x\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":100,\"vatRate\":0.19}]}"
assert_eq "a quote AN-…" "$(P "d['invoiceNumber']" | cut -d- -f1)" "AN"

summary
