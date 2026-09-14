#!/bin/bash
# Tier 242 — e2e coverage: vat-rate (USt-Satz CRUD)
#
# The VatRate controller exposes 3 endpoints (GET /,
# GET /current, POST). Pre-Tier 242 it had 0 focused
# e2e coverage — the table was only populated as a
# side effect of the EU-OSS + USt-Voranmeldung
# tests. Tier 240's audit v2 caught the gap.
#
# VatRate defines the per-country VAT rate schedule
# (DE 19% / 7%, AT 20% / 10% / 13%, etc.). The Berater
# uses these to pre-fill invoice line VAT rates when
# a new customer in a non-DE country is created.
#
# Key facts:
#   - rate is DECIMAL(5,4) in Prisma → max 9.9999
#     (covers 0% / 7% / 19% / 20% with room to spare)
#   - effectiveFrom is required; effectiveTo null = current
#   - companyId is OPTIONAL (null = global default rate
#     that applies to all companies in that country)
#   - countryCode must be 1-2 chars (DE, AT, FR, ...)
#   - DTO (Tier 211) enforces @Max(9.9999) on rate;
#     sending 0.20 (correct) works, 20 (would overflow)
#     returns 400 BEFORE the Prisma write
#
# Assertions:
#   1. POST creates a global rate (companyId null) +
#      effectiveFrom + countryCode + rate
#   2. POST rejects rate=20 (above DECIMAL(5,4) max)
#   3. POST rejects empty countryCode (MinLength 1)
#   4. POST rejects missing rateType
#   5. POST rejects unknown field (whitelistProperty)
#   6. GET / returns the seeded rate
#   7. GET /?countryCode=DE returns only DE rows
#   8. GET /?countryCode=ZZ returns empty
#   9. GET /current?countryCode=DE returns the most
#      recent effective rate (effectiveFrom <= now,
#      effectiveTo null OR in future)
#  10. GET /current?countryCode=ZZ returns null
#  11. POST + GET /current for an EXPIRED rate
#      (effectiveTo in past) returns the still-valid
#      previous rate (NOT the expired one)
#  12. Cleanup: delete seeded rates so reruns are
#      idempotent
set -uo pipefail

source "$(dirname "$0")/_lib.sh"
login

# ---- 1. POST creates a rate for the caller's company ----
# Tier 376: this used to create a GLOBAL row (companyId NULL) that every other
# tenant's GET /current then returned. A created rate now always belongs to the
# caller's company; reads see global rows plus the company's own.
api_post "/api/v1/vat-rates" \
  '{"countryCode":"DE","rate":0.19,"rateType":"standard","name":"Regelsteuersatz","effectiveFrom":"2020-01-01T00:00:00Z","description":"19% USt"}'
assert_status "201" "POST /vat-rates (DE 19%)"
assert_eq "created rate belongs to the caller's company" "$(json_field "$BODY" companyId)" "$COMPANY_ID"
RATE_ID=$(json_field "$BODY" id)
RATE_ID=$(echo "$RATE_ID" | tr -d ' \n')
[ -n "$RATE_ID" ] && pass "POST returns id ($RATE_ID)" || fail "POST no id"

# ---- 2. POST rejects rate=20 (above DECIMAL(5,4) max) ----
api_post "/api/v1/vat-rates" \
  '{"countryCode":"DE","rate":20,"rateType":"standard","name":"too high","effectiveFrom":"2020-01-01T00:00:00Z"}'
assert_status "400" "POST /vat-rates with rate=20 → 400 (DECIMAL(5,4) max 9.9999)"

# ---- 3. POST rejects empty countryCode ----
api_post "/api/v1/vat-rates" \
  '{"countryCode":"","rate":0.19,"rateType":"standard","effectiveFrom":"2020-01-01T00:00:00Z"}'
assert_status "400" "POST /vat-rates with empty countryCode → 400"

# ---- 4. POST rejects missing rateType ----
api_post "/api/v1/vat-rates" \
  '{"countryCode":"DE","rate":0.19,"effectiveFrom":"2020-01-01T00:00:00Z"}'
assert_status "400" "POST /vat-rates with missing rateType → 400"

# ---- 5. POST rejects unknown field (whitelistProperty) ----
# Tier 375: companyId is the tenant's own — a foreign one is now refused by
# HeaderAuthGuard (403) before validation runs, which would hide this check.
api_post "/api/v1/vat-rates" \
  "{\"countryCode\":\"DE\",\"rate\":0.19,\"rateType\":\"standard\",\"effectiveFrom\":\"2020-01-01T00:00:00Z\",\"companyId\":\"$COMPANY_ID\",\"secret\":\"leak\"}"
assert_status "400" "POST /vat-rates with unknown field → 400 (whitelistProperty)"

# ---- 6. GET / returns the seeded rate ----
api_get "/api/v1/vat-rates"
assert_status "200" "GET /vat-rates"
COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.loads(sys.stdin.read())))" 2>/dev/null)
[ "$COUNT" -ge 1 ] && pass "GET returns $COUNT row(s)" || fail "GET returned 0 rows"

# ---- 7. GET /?countryCode=DE returns only DE ----
api_get "/api/v1/vat-rates?countryCode=DE"
assert_status "200" "GET /vat-rates?countryCode=DE"
NON_DE=$(echo "$BODY" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
non_de = [r for r in d if r.get('countryCode') != 'DE']
print(len(non_de))
" 2>/dev/null)
[ "$NON_DE" = "0" ] && pass "countryCode filter returns only DE rows" || fail "found $NON_DE non-DE rows"

# ---- 8. GET /?countryCode=ZZ returns empty ----
api_get "/api/v1/vat-rates?countryCode=ZZ"
assert_status "200" "GET /vat-rates?countryCode=ZZ (no rows)"
ZZ_COUNT=$(echo "$BODY" | python3 -c "import json,sys; print(len(json.loads(sys.stdin.read())))" 2>/dev/null)
[ "$ZZ_COUNT" = "0" ] && pass "countryCode=ZZ returns 0 rows" || fail "ZZ returned $ZZ_COUNT rows"

# ---- 9. GET /current?countryCode=DE returns the rate ----
api_get "/api/v1/vat-rates/current?countryCode=DE"
assert_status "200" "GET /vat-rates/current?countryCode=DE"
CUR_RATE=$(json_field "$BODY" rate)
[ "$CUR_RATE" = "0.19" ] || [ "$CUR_RATE" = "0.1900" ] && pass "current DE rate = $CUR_RATE" || fail "current DE rate = $CUR_RATE (expected 0.19)"

# ---- 10. GET /current?countryCode=ZZ returns null ----
api_get "/api/v1/vat-rates/current?countryCode=ZZ"
assert_status "200" "GET /vat-rates/current?countryCode=ZZ"
# null serialises as empty body (Tier 228/240 lesson)
LEN=$(echo -n "$BODY" | wc -c | tr -d ' ')
[ "$LEN" -lt 5 ] && pass "current ZZ → null body (empty)" || fail "expected null, got: $BODY"

# ---- 11. Expired rate is not the current rate ----
# Insert a new rate with effectiveTo in the PAST.
# The previous one (effectiveFrom=2020-01-01, no
# effectiveTo) should still be returned as current.
api_post "/api/v1/vat-rates" \
  '{"countryCode":"DE","rate":0.16,"rateType":"reduced","name":"old 16%","effectiveFrom":"2018-01-01T00:00:00Z","effectiveTo":"2019-12-31T23:59:59Z"}'
assert_status "201" "POST /vat-rates (expired 16% rate)"
api_get "/api/v1/vat-rates/current?countryCode=DE"
assert_status "200" "GET /vat-rates/current after expired rate"
CUR_RATE2=$(json_field "$BODY" rate)
[ "$CUR_RATE2" = "0.19" ] || [ "$CUR_RATE2" = "0.1900" ] && pass "expired rate is NOT current ($CUR_RATE2 is still the active 19%)" || fail "current = $CUR_RATE2 (expected 0.19, NOT the expired 0.16)"

# ---- 12. Cleanup so reruns are idempotent ----
# Direct SQL because the VatRate controller has no
# DELETE endpoint (rates are managed by the
# Steuerberater via the Admin panel, not deleted).
for cc in DE; do
  docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -c \
    "DELETE FROM \"VatRate\" WHERE \"countryCode\" = '$cc' AND \"rateType\" IN ('standard','reduced') AND \"name\" IN ('Regelsteuersatz','old 16%');" >/dev/null 2>&1
done
pass "cleanup: deleted seeded VatRate rows"

summary
