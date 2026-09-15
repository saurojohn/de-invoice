#!/bin/bash
# Tier 377 — voucher correction / reversal / status, template apply and asset
# bodies are validated; voucher lines only book on the company's own accounts
#
# Measured on a fresh stack before the change:
#   POST /accounting/vouchers              line debit 1e12 → 500; unknown accountId → 500;
#                                          tenant B's accountId → 201 (line on B's account)
#   POST /accounting/vouchers/:id/correct  date "abc", debit 1e12, "zehn", vatRate 19,
#                                          unknown accountId → 500; negative debit → 201
#   PUT  /accounting/vouchers/:id/status   "bogus" or no status → 200, nothing changed
#   POST /voucher-templates/:id/apply      amount "zehn", date "abc", amount 1e12 → 201
#   POST /assets                           anschaffungsDatum "abc", AK 1e14, AK "hundert" → 500;
#                                          nutzungsdauerMonate 12.5 → 201 (Int column)
#   PATCH /assets/:id                      anschaffungsDatum "abc", restwert 1e14 → 500
#   POST /assets/:id/dispose               verkauftAm "abc", verkaufsPreis 1e14 → 500
# (The asset "DTOs" were interfaces in assets.service.ts — invisible to
# ValidationPipe despite their names.)
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
login
Q="companyId=$COMPANY_ID"
TODAY=$(date +%Y-%m-%d)
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
STAMP=$(date +%s%N | cut -c1-13)
TAG="e2e-178-$STAMP"
sql() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "$1" 2>/dev/null | tr -d ' '; }
acc() { sql "SELECT id FROM \"Account\" WHERE \"companyId\" = '$COMPANY_ID' AND \"accountNumber\" = '$1';"; }
A1200=$(acc 1200); A8400=$(acc 8400)
[[ -n "$A1200" && -n "$A8400" ]] && pass "accounts 1200/8400 present" || { fail "seed accounts missing"; summary; exit 1; }
voucher() { # description → sets VID
  api_post "/api/v1/accounting/vouchers?$Q" "{\"companyId\":\"$COMPANY_ID\",\"date\":\"$TODAY\",\"description\":\"$1\",\"status\":\"posted\",\"lines\":[{\"accountId\":\"$A1200\",\"debit\":10},{\"accountId\":\"$A8400\",\"credit\":10}]}"
  VID=$(json_field "$BODY" id)
}

note "=== 1. every real caller shape still succeeds ==="
# e2e 58: no companyId in the query, null description on a line, null accountId
api_post "/api/v1/accounting/vouchers" "{\"companyId\":\"$COMPANY_ID\",\"date\":\"$TODAY\",\"description\":\"$TAG spec58\",\"lines\":[{\"accountId\":null,\"description\":null,\"debit\":30,\"credit\":0},{\"accountId\":\"$A1200\",\"debit\":0,\"credit\":30,\"vatRate\":0.19}]}"
assert_status 201 "voucher: e2e 58 shape (null accountId / description)"
voucher "$TAG correct-page"; V_PAGE=$VID
# voucher detail page correct(): ISO timestamp, description null, cost centre
api_post "/api/v1/accounting/vouchers/$V_PAGE/correct?$Q" "{\"date\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"description\":\"$TAG Korrektur\",\"reason\":\"page\",\"lines\":[{\"accountId\":\"$A1200\",\"debit\":12,\"credit\":0,\"description\":null,\"costCenter\":\"VERTRIEB-100\"},{\"accountId\":\"$A8400\",\"debit\":0,\"credit\":12,\"description\":null}]}"
assert_status 201 "correct: page shape"
voucher "$TAG correct-70"; V70=$VID
api_post "/api/v1/accounting/vouchers/$V70/correct?$Q" "{\"date\":\"$NOW\",\"description\":\"$TAG 70\",\"reason\":\"e2e 70\",\"lines\":[{\"accountId\":\"$A1200\",\"description\":\"x\",\"debit\":1.5,\"credit\":0,\"costCenter\":\"VERTRIEB-100\",\"costObject\":\"PROJ-X\"},{\"accountId\":\"$A8400\",\"description\":\"y\",\"debit\":0,\"credit\":1.5}]}"
assert_status 201 "correct: e2e 70 shape"
api_post "/api/v1/accounting/vouchers/$V70/correct?$Q" "{\"date\":\"$NOW\",\"description\":\"empty\",\"lines\":[]}"
assert_status 400 "correct: empty lines still 400"
voucher "$TAG reversal"; V_REV=$VID
api_post "/api/v1/accounting/vouchers/$V_REV/reversal?$Q" '{"reason":""}'
assert_status 201 "reversal: page shape (empty reason)"
voucher "$TAG status"; V_STATUS=$VID
api_put "/api/v1/accounting/vouchers/$V_STATUS/status?$Q" '{"status":"voided"}'
assert_status 200 "status voided still reverses"

api_post "/api/v1/voucher-templates?$Q" "{\"name\":\"$TAG tpl\",\"linesJson\":\"[{\\\"accountNumber\\\":\\\"1200\\\",\\\"side\\\":\\\"debit\\\"},{\\\"accountNumber\\\":\\\"8400\\\",\\\"side\\\":\\\"credit\\\"}]\"}"
TPL=$(json_field "$BODY" id)
api_post "/api/v1/voucher-templates/$TPL/apply?$Q" '{"amount":12.5,"date":"2026-06-15"}'
assert_status 201 "apply: e2e 14 / page shape"
api_post "/api/v1/voucher-templates/$TPL/apply?$Q" "{\"amount\":2.5,\"date\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"counterparty\":\"Vermieter GmbH\"}"
assert_status 201 "apply: ISO date + counterparty (Playwright / e2e 14)"
api_post "/api/v1/voucher-templates/$TPL/apply?$Q" '{"amount":0,"date":"2026-06-15"}'
assert_status 400 "apply: amount 0 still 400 (service)"

# assets page create(): ISO timestamp, notiz null
api_post "/api/v1/assets?$Q" "{\"type\":\"Maschine\",\"bezeichnung\":\"$TAG page\",\"anschaffungsDatum\":\"2026-01-01T00:00:00.000Z\",\"anschaffungsKosten\":5000,\"nutzungsdauerMonate\":60,\"restwert\":0,\"notiz\":null}"
assert_status 201 "asset: page shape"
ASSET=$(json_field "$BODY" id)
# Playwright assets-afa: bilanzKonto, notiz null; e2e 160: afaMethode, restwert
api_post "/api/v1/assets?$Q" "{\"type\":\"Maschine\",\"bezeichnung\":\"$TAG afa\",\"anschaffungsDatum\":\"2026-01-01T00:00:00.000Z\",\"anschaffungsKosten\":5000,\"nutzungsdauerMonate\":60,\"restwert\":0,\"bilanzKonto\":\"0300\",\"notiz\":null,\"afaMethode\":\"linear\"}"
assert_status 201 "asset: Playwright/e2e 160 shape"
api_patch "/api/v1/assets/$ASSET?$Q" "{\"bezeichnung\":\"$TAG page updated\"}"
assert_status 200 "asset PATCH: e2e 160 shape"
api_post "/api/v1/assets?$Q" "{\"type\":\"Ungueltig\",\"bezeichnung\":\"x\",\"anschaffungsDatum\":\"$TODAY\",\"anschaffungsKosten\":1000,\"nutzungsdauerMonate\":12}"
assert_status 400 "asset: invalid type still 400 (service)"

note "=== 2. invalid bodies are 400 and write nothing ==="
V_COUNT() { sql "SELECT count(*) FROM \"Voucher\" WHERE \"companyId\" = '$COMPANY_ID';"; }
BEFORE=$(V_COUNT)
api_post "/api/v1/accounting/vouchers?$Q" "{\"companyId\":\"$COMPANY_ID\",\"date\":\"$TODAY\",\"lines\":[{\"accountId\":\"$A1200\",\"debit\":1000000000000},{\"accountId\":\"$A8400\",\"credit\":1000000000000}]}"
assert_status 400 "voucher: debit 1e12 (was 500)"
api_post "/api/v1/accounting/vouchers?$Q" "{\"companyId\":\"$COMPANY_ID\",\"date\":\"$TODAY\",\"lines\":[{\"accountId\":\"00000000-0000-0000-0000-000000000000\",\"debit\":1},{\"accountId\":\"$A8400\",\"credit\":1}]}"
assert_status 400 "voucher: unknown accountId (was 500)"
voucher "$TAG bad-correct"; V_BAD=$VID; BEFORE=$(V_COUNT)
C="/api/v1/accounting/vouchers/$V_BAD/correct?$Q"
L2="{\"accountId\":\"$A8400\",\"credit\":50}"
api_post "$C" "{\"date\":\"abc\",\"lines\":[{\"accountId\":\"$A1200\",\"debit\":50},$L2]}";                        assert_status 400 "correct: date abc (was 500)"
api_post "$C" "{\"lines\":[{\"accountId\":\"$A1200\",\"debit\":1000000000000},{\"accountId\":\"$A8400\",\"credit\":1000000000000}]}"; assert_status 400 "correct: debit 1e12 (was 500)"
api_post "$C" "{\"lines\":[{\"accountId\":\"$A1200\",\"debit\":\"zehn\"},{\"accountId\":\"$A8400\",\"credit\":\"zehn\"}]}";  assert_status 400 "correct: debit 'zehn' (was 500)"
api_post "$C" "{\"lines\":[{\"accountId\":\"$A1200\",\"debit\":50,\"vatRate\":19},$L2]}";                          assert_status 400 "correct: vatRate 19 (was 500)"
api_post "$C" "{\"lines\":[{\"accountId\":\"00000000-0000-0000-0000-000000000000\",\"debit\":50},$L2]}";           assert_status 400 "correct: unknown accountId (was 500)"
api_post "$C" "{\"lines\":[{\"accountId\":\"$A1200\",\"debit\":-50},{\"accountId\":\"$A8400\",\"credit\":-50}]}";      assert_status 400 "correct: negative amounts (was 201)"
assert_eq "no voucher written by the invalid corrections" "$(V_COUNT)" "$BEFORE"
api_put "/api/v1/accounting/vouchers/$V_BAD/status?$Q" '{"status":"bogus"}';  assert_status 400 "status bogus (was 200, no-op)"
api_put "/api/v1/accounting/vouchers/$V_BAD/status?$Q" '{}';                 assert_status 400 "status missing (was 200, no-op)"

api_post "/api/v1/voucher-templates/$TPL/apply?$Q" '{"amount":"zehn","date":"2026-06-15"}';      assert_status 400 "apply: amount zehn (was 201)"
api_post "/api/v1/voucher-templates/$TPL/apply?$Q" '{"amount":10,"date":"abc"}';                 assert_status 400 "apply: date abc (was 201)"
api_post "/api/v1/voucher-templates/$TPL/apply?$Q" '{"amount":1000000000000,"date":"2026-06-15"}'; assert_status 400 "apply: amount 1e12 (was 201)"

ASSETS_BEFORE=$(sql "SELECT count(*) FROM \"Asset\" WHERE bezeichnung LIKE '$TAG bad%';")
A="\"type\":\"Sonstiges\",\"bezeichnung\":\"$TAG bad\",\"nutzungsdauerMonate\":12"
api_post "/api/v1/assets?$Q" "{$A,\"anschaffungsDatum\":\"abc\",\"anschaffungsKosten\":100}";                assert_status 400 "asset: anschaffungsDatum abc (was 500)"
api_post "/api/v1/assets?$Q" "{$A,\"anschaffungsDatum\":\"$TODAY\",\"anschaffungsKosten\":100000000000000}";  assert_status 400 "asset: AK 1e14 (was 500)"
api_post "/api/v1/assets?$Q" "{$A,\"anschaffungsDatum\":\"$TODAY\",\"anschaffungsKosten\":\"hundert\"}";      assert_status 400 "asset: AK hundert (was 500)"
api_post "/api/v1/assets?$Q" "{\"type\":\"Sonstiges\",\"bezeichnung\":\"$TAG bad\",\"anschaffungsDatum\":\"$TODAY\",\"anschaffungsKosten\":100,\"nutzungsdauerMonate\":12.5}"; assert_status 400 "asset: nutzungsdauerMonate 12.5 (was 201)"
assert_eq "no asset written by the invalid creates" "$(sql "SELECT count(*) FROM \"Asset\" WHERE bezeichnung LIKE '$TAG bad%';")" "$ASSETS_BEFORE"
api_patch "/api/v1/assets/$ASSET?$Q" '{"anschaffungsDatum":"abc"}';          assert_status 400 "asset PATCH: anschaffungsDatum abc (was 500)"
api_patch "/api/v1/assets/$ASSET?$Q" '{"restwert":100000000000000}';         assert_status 400 "asset PATCH: restwert 1e14 (was 500)"
api_post "/api/v1/assets/$ASSET/dispose?$Q" '{"verkauftAm":"abc","verkaufsPreis":1}';                 assert_status 400 "dispose: verkauftAm abc (was 500)"
api_post "/api/v1/assets/$ASSET/dispose?$Q" '{"verkauftAm":"2026-06-01","verkaufsPreis":100000000000000}'; assert_status 400 "dispose: verkaufsPreis 1e14 (was 500)"
assert_eq "asset still not disposed" "$(sql "SELECT \"verkauftAm\" IS NULL FROM \"Asset\" WHERE id = '$ASSET';")" "t"
api_post "/api/v1/assets/$ASSET/dispose?$Q" "{\"verkauftAm\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"verkaufsPreis\":0}"
assert_status 201 "dispose: page shape still works"

note "=== 3. voucher lines only book on the company's own accounts ==="
BODY=$(curl -s -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier377-e2e\",\"companyName\":\"$TAG Tenant B\"}")
B_USER=$(json_field "$BODY" user.id); B_COMPANY=$(json_field "$BODY" company.id)
curl -s -o /dev/null "$API/api/v1/accounting/accounts/seed?companyId=$B_COMPANY" -H "x-user-id: $B_USER" -H "x-company-id: $B_COMPANY"
B1200=$(sql "SELECT id FROM \"Account\" WHERE \"companyId\" = '$B_COMPANY' AND \"accountNumber\" = '1200';")
[[ -n "$B1200" ]] && pass "tenant B has its own account 1200" || fail "tenant B accounts not seeded"
BEFORE=$(V_COUNT)
api_post "/api/v1/accounting/vouchers?$Q" "{\"companyId\":\"$COMPANY_ID\",\"date\":\"$TODAY\",\"description\":\"$TAG foreign\",\"lines\":[{\"accountId\":\"$B1200\",\"debit\":77},{\"accountId\":\"$A8400\",\"credit\":77}]}"
assert_status 400 "voucher with tenant B's account (was 201)"
api_post "/api/v1/accounting/vouchers/$V_BAD/correct?$Q" "{\"lines\":[{\"accountId\":\"$B1200\",\"debit\":5},{\"accountId\":\"$A8400\",\"credit\":5}]}"
assert_status 400 "correction with tenant B's account"
assert_eq "no voucher written with a foreign account" "$(V_COUNT)" "$BEFORE"
assert_eq "no line on B's account from company A" \
  "$(sql "SELECT count(*) FROM \"VoucherLine\" l JOIN \"Voucher\" v ON v.id = l.\"voucherId\" WHERE l.\"accountId\" = '$B1200' AND v.\"companyId\" = '$COMPANY_ID';")" "0"

summary
exit $?
