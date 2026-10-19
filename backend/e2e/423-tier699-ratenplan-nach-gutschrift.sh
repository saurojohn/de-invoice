#!/bin/bash
# Tier 699 — a Ratenplan follows the credit notes of its invoice
#
# The Raten of a plan follow the invoice's payments (Tier 429), the
# „Gutschrift“ payment a credit note books among them — but that payment is
# written by the credit-note code, not by PaymentService, and the plan was
# never synchronised. Measured: a 1 190 € invoice on three Raten (396,66 €
# each from November), cancelled by its Storno credit note (Tier 694) — the
# plan stayed "active" with three open Raten, and the dunning pause the plan
# had set stayed on. Now a credit note settles Raten as a payment does: a
# partial one the first Rate(n), a Storno all of them; the plan completes and
# its pause ends.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-423-$(date +%s%N | cut -c1-13)"
q() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -Atc "$1"; }
FIRST=$(python3 -c "import datetime,zoneinfo;d=datetime.datetime.now(zoneinfo.ZoneInfo('Europe/Berlin')).date()+datetime.timedelta(days=20);print(d.isoformat())")
read -r U C < <(curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier699-e2e\",\"companyName\":\"$TAG GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null)
fixture_issuer "$C" DE123456789
[[ -n "${C:-}" ]] && pass "fixture: a fresh company" || { fail "register"; summary; exit 1; }
AS() { # method path [body]
  local resp
  resp=$(curl -sS -w "\n%{http_code}" -X "$1" "$API$2" -H "x-user-id: $U" -H "x-company-id: $C" \
    -H "Content-Type: application/json" ${3:+-d "$3"})
  STATUS=$(echo "$resp" | tail -n1); BODY=$(echo "$resp" | sed '$d')
}
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Kunde AG\",\"type\":\"business\",\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
planned() { # → INV with a plan of three Raten
  AS POST "/api/v1/invoices?companyId=$C" "{\"customerId\":\"$K\",\"issueDate\":\"2026-09-01\",\"items\":[{\"description\":\"Anlage\",\"quantity\":1,\"unit\":\"Stk\",\"unitPrice\":1000,\"vatRate\":0.19}]}"
  INV=$(json_field "$BODY" id)
  AS PUT "/api/v1/invoices/$INV/status?companyId=$C" '{"status":"sent"}'
  AS POST "/api/v1/installment-plans/from-invoice?companyId=$C" "{\"invoiceId\":\"$INV\",\"installmentCount\":3,\"firstDueDate\":\"$FIRST\",\"createdById\":\"$U\"}"
}
raten() { q "select p.status||':'||string_agg(i.status||'/'||trim(trailing '.' from trim(trailing '0' from i.\"paidAmount\"::text)), ',' order by i.\"sequenceNumber\") from \"InstallmentPlan\" p join \"Installment\" i on i.\"planId\"=p.id where p.\"invoiceId\"='$1' group by p.status"; }
pause_on() { q "select count(*) from \"Mahnungspause\" where \"invoiceId\"='$1' and \"cancelledAt\" is null and (\"pausedUntil\" is null or \"pausedUntil\" > now())"; }

note "=== 1. a partial credit note ==="
planned; A=$INV
assert_eq "fixture: a plan of three open Raten" "$STATUS/$(raten "$A")" "201/active:open/0,open/0,open/0"
AS POST "/api/v1/invoices/$A/credit-note?companyId=$C" '{"amount":500,"reason":"Preisnachlass"}'
assert_eq "500 € credited: the first Rate settled, the second in part (was: all open)" "$STATUS/$(raten "$A")" "201/active:paid/396.66,partial/103.34,open/0"

note "=== 2. the Storno credit note ==="
# (one active plan per customer: another customer)
AS POST "/api/v1/customers?companyId=$C" "{\"name\":\"$TAG Zweiter Kunde\",\"type\":\"business\",\"address\":{\"street\":\"Ring 3\",\"postalCode\":\"80331\",\"city\":\"München\",\"country\":\"DE\"}}"
K=$(json_field "$BODY" id)
planned; B=$INV
assert_eq "fixture: a second plan" "$STATUS" "201"
assert_eq "fixture: the plan's dunning pause is on" "$(pause_on "$B")" "1"
AS POST "/api/v1/invoices/$B/credit-note?companyId=$C" '{"reason":"Storno"}'
assert_eq "the plan is completed, no Rate open (was: active, three open)" "$STATUS/$(raten "$B")" "201/completed:paid/396.66,paid/396.66,paid/396.68"
assert_eq "…and its dunning pause ends (was: on)" "$(pause_on "$B")" "0"

summary
