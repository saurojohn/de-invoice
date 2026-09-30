#!/bin/bash
# Tier 486 — an innergemeinschaftliche Lieferung needs the customer's
# USt-IdNr. of another EU state
#
# § 4 Nr. 1b, § 6a Abs. 1 Nr. 4 UStG. Measured before: invoices marked igL
# (euTransaction — 0 % VAT, the § 1a note on the PDF) were issued to a French
# customer without an USt-IdNr. and to a German customer with a DE-IdNr.
# (201 each) — both supplies owe 19 %, and the UStVA quietly moved them to
# "sonstige steuerfreie Umsätze". And an invoice without a customer answered
# 500 "Related resource not found".
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-272-$(date +%s%N | cut -c1-13)"
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier486-e2e\",\"companyName\":\"$TAG Handel\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
customer() { AS POST "/api/v1/customers?companyId=$C" "$1"; json_field "$BODY" id; }
igl() { # customerId
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$1\",\"issueDate\":\"2026-05-01\",\"euTransaction\":true,\"items\":[{\"description\":\"Maschine\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0}]}"
}
FR_NONE=$(customer '{"name":"FR ohne IdNr","type":"business","address":{"country":"FR"}}')
DE_ID=$(customer '{"name":"DE mit IdNr","type":"business","vatId":"DE123456789","address":{"country":"DE"}}')
CH_ID=$(customer '{"name":"CH","type":"business","vatId":"CHE123456789","address":{"country":"CH"}}')
FR_ID=$(customer '{"name":"FR mit IdNr","type":"business","vatId":"FR12345678901","address":{"country":"FR"}}')
GR_ID=$(customer '{"name":"GR mit IdNr","type":"business","vatId":"EL123456789","address":{"country":"GR"}}')

igl "$FR_NONE"; assert_eq "igL to a customer without USt-IdNr. refused (was 201)" "$STATUS" "400"
igl "$DE_ID";   assert_eq "igL to a German USt-IdNr. refused (was 201)" "$STATUS" "400"
igl "$CH_ID";   assert_eq "igL to a non-EU number refused" "$STATUS" "400"
igl "$FR_ID";   assert_eq "igL to a French USt-IdNr. accepted" "$STATUS" "201"
I=$(json_field "$BODY" id)
igl "$GR_ID";   assert_eq "…and a Greek one (EL prefix)" "$STATUS" "201"

# (dated today — only a same-day invoice can be edited at all)
TODAY=$(python3 -c "import datetime, zoneinfo;print(datetime.datetime.now(zoneinfo.ZoneInfo('Europe/Berlin')).date())")
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$FR_ID\",\"issueDate\":\"$TODAY\",\"euTransaction\":true,\"items\":[{\"description\":\"Maschine\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0}]}"
I=$(json_field "$BODY" id)
AS PUT "/api/v1/invoices/$I?companyId=$C" "{\"customerId\":\"$FR_NONE\",\"items\":[{\"description\":\"Maschine\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0}]}"
assert_eq "switching an igL invoice to a customer without USt-IdNr. refused" "$STATUS" "400"

# the company default (Tier 176) makes an invoice igL too
AS PUT "/api/v1/companies/$C" '{"defaultVatMode":"igL"}'
AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$DE_ID\",\"issueDate\":\"2026-05-01\",\"items\":[{\"description\":\"Maschine\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0}]}"
assert_eq "…also when the igL comes from the company default" "$STATUS" "400"
AS PUT "/api/v1/companies/$C" '{"defaultVatMode":"standard"}'

AS POST "/api/v1/invoices?companyId=$C" '{"customerId":"","issueDate":"2026-05-01","items":[{"description":"x","quantity":1,"unit":"Stk","unitPrice":10,"vatRate":0.19}]}'
assert_eq "no customer: 400 (was 500)" "$STATUS" "400"

summary
