#!/bin/bash
# Tier 556 — a mailed link carries the installation's address, not the request's
#
# The customer portal mails a login link. The public route that asks for one
# (POST /customer-portal/request-session) and the admin's (…/admin/create-session)
# built it from X-Forwarded-Host / Host. Measured: with
# `X-Forwarded-Host: evil.example` the customer was mailed
# `https://evil.example/portal?token=<the real token>`; the admin route
# returned that URL. The token opens the customer's invoices.
# Now: a request's host counts only when it is a configured address
# (FRONTEND_URL), otherwise APP_ORIGIN / the first FRONTEND_URL entry.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
TAG="e2e-338-$(date +%s%N | cut -c1-13)"
H=(-H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" -H "Content-Type: application/json")
R=$(curl -sS -X POST "$API/api/v1/customers?companyId=$COMPANY_ID" "${H[@]}" -d "{\"name\":\"$TAG\",\"type\":\"business\",\"contact\":{\"email\":\"$TAG@example.test\"},\"address\":{\"street\":\"Ring 2\",\"postalCode\":\"80331\",\"city\":\"Muenchen\",\"country\":\"DE\"}}")
K=$(json_field "$R" id)
[[ -n "$K" ]] && pass "fixture: a customer with an e-mail address" || { fail "fixture: ${R:0:200}"; summary; exit 1; }
session() { curl -sS -m 30 -X POST "$API/api/v1/customer-portal/admin/create-session" "${H[@]}" "$@" -d "{\"customerId\":\"$K\",\"companyId\":\"$COMPANY_ID\"}"; }

R=$(session -H "X-Forwarded-Host: evil.example" -H "X-Forwarded-Proto: https")
URL=$(json_field "$R" url)
[[ "$URL" == *"/portal?token="* ]] && pass "the admin gets a portal link" || fail "no link: ${R:0:200}"
assert_eq "X-Forwarded-Host: evil.example is not in it (was https://evil.example/portal?token=…)" "$(grep -c "evil" <<<"$URL")" "0"
R=$(session -H "Host: evil.example")
assert_eq "nor a forged Host" "$(grep -c "evil" <<<"$(json_field "$R" url)")" "0"
assert_eq "the link is on a configured address" "$(python3 -c "import sys;u=sys.argv[1];print(any(u.startswith(o.strip().rstrip('/')+'/portal?token=') for o in sys.argv[2].split(',')))" "$URL" "${FRONTEND_URL:-http://localhost:3000,http://localhost:3100}")" "True"
R=$(session -H "X-Forwarded-Host: localhost:3100" -H "X-Forwarded-Proto: http")
assert_eq "a configured address in the request is kept (the frontend's proxy)" "$(json_field "$R" url | cut -d/ -f1-3)" "http://localhost:3100"
assert_eq "the public route still answers" "$(curl -sS -m 30 -X POST "$API/api/v1/customer-portal/request-session" -H "Content-Type: application/json" -H "X-Forwarded-Host: evil.example" -d "{\"email\":\"$TAG@example.test\"}")" '{"sent":true}'
curl -sS -o /dev/null -X DELETE "$API/api/v1/customers/$K?companyId=$COMPANY_ID" "${H[@]}"
summary
