#!/bin/bash
# Tier 242 — e2e coverage: health probes + Prometheus metrics
#
# Three controllers expose health / metrics endpoints:
#
# 1. /api/v1/health + /api/v1/health/deep
#    (health.controller.ts) — classic K8s liveness
#    + readiness probes. Both public, no auth,
#    @SkipThrottle.
#
# 2. /api/v1/system/health + /api/v1/system/health/deep
#    (system-health.controller.ts) — parallel
#    implementation. /system/health/deep verifies
#    migrations have run by counting invoices.
#
# 3. /api/v1/health/summary (from
#    notification.service.ts controller, Tier 193)
#    — dashboard-friendly JSON with uptime, dbOk,
#    storageOk, memory, business counts. No auth.
#
# 4. /metrics (metrics.controller.ts) — Prometheus
#    text format with de_invoice_uptime_seconds +
#    de_invoice_db_connected + business gauges.
#    Flat path (no /api/v1 prefix) because
#    Prometheus scrapers use a single config block.
#
# All 4 are public (no auth, no Throttler) so any
# monitoring system can hit them without credentials.
# Tier 242 closes the audit v2 0-coverage gap.
#
# Assertions:
#   1. /api/v1/health → 200 + JSON {status, version, uptimeSec, timestamp}
#   2. /api/v1/health/deep → 200 + JSON {status, uptimeSec, checks{db, storage}}
#   3. /api/v1/health/deep checks.db.status = "ok"
#   4. /api/v1/health/deep checks.storage.status = "ok"
#   5. /api/v1/system/health → 200 + JSON {status, ts, uptimeSec}
#   6. /api/v1/system/health/deep → 200 + JSON {status, dbOk, ...}
#   7. /api/v1/health/summary → 200 + JSON {status, dbOk, storageOk, ...}
#   8. /api/v1/health/summary has memory.{rssMB, heapMB}
#   9. /api/v1/health/summary has business.{companies, users, invoices, customers}
#  10. /metrics → 200 + text/plain + Prometheus format
#      (starts with "# HELP" comment)
#  11. /metrics contains de_invoice_uptime_seconds gauge
#  12. /metrics contains de_invoice_db_connected gauge
#  13. /metrics contains de_invoice_business_invoices
#      gauge (Tier 193 business metric)
#  14. No auth required (all 4 endpoints public)
#  15. /api/v1/health/deep uptimeSec increases after
#      2-second sleep (sanity: not cached / not stale)
source "$(dirname "$0")/_lib.sh"
login

# ---- 1. /api/v1/health → 200 + JSON ----
BODY=$(curl -sS -o /tmp/tier242-health.txt -w "%{http_code}" \
  "$API/api/v1/health")
[ "$BODY" = "200" ] && pass "GET /api/v1/health → 200" || fail "expected 200, got $BODY"
HAS_STATUS=$(json_field "$(cat /tmp/tier242-health.txt)" status)
HAS_VERSION=$(json_field "$(cat /tmp/tier242-health.txt)" version)
HAS_UPTIME=$(json_field "$(cat /tmp/tier242-health.txt)" uptimeSec)
[ "$HAS_STATUS" = "ok" ] && [ -n "$HAS_VERSION" ] && [ -n "$HAS_UPTIME" ] && \
  pass "health body has status/version/uptimeSec" || fail "health body missing fields"

# ---- 2. /api/v1/health/deep → 200 + JSON with checks ----
BODY=$(curl -sS -o /tmp/tier242-deep.txt -w "%{http_code}" \
  "$API/api/v1/health/deep")
[ "$BODY" = "200" ] && pass "GET /api/v1/health/deep → 200" || fail "expected 200, got $BODY"

# ---- 3. checks.db.status = "ok" ----
DB_STATUS=$(json_field "$(cat /tmp/tier242-deep.txt)" checks.db.status)
[ "$DB_STATUS" = "ok" ] && pass "deep checks.db.status = ok" || fail "db status = $DB_STATUS"

# ---- 4. checks.storage.status = "ok" ----
STORAGE_STATUS=$(json_field "$(cat /tmp/tier242-deep.txt)" checks.storage.status)
[ "$STORAGE_STATUS" = "ok" ] && pass "deep checks.storage.status = ok" || fail "storage status = $STORAGE_STATUS"

# ---- 5. /api/v1/system/health → 200 + JSON ----
BODY=$(curl -sS -o /tmp/tier242-syshealth.txt -w "%{http_code}" \
  "$API/api/v1/system/health")
[ "$BODY" = "200" ] && pass "GET /api/v1/system/health → 200" || fail "expected 200, got $BODY"
HAS_STATUS=$(json_field "$(cat /tmp/tier242-syshealth.txt)" status)
HAS_TS=$(json_field "$(cat /tmp/tier242-syshealth.txt)" ts)
[ "$HAS_STATUS" = "ok" ] && [ -n "$HAS_TS" ] && pass "system/health body has status/ts" || fail "missing fields"

# ---- 6. /api/v1/system/health/deep → 200 + JSON ----
# Shape: {status, ts, checks: {postgres: {ok, ms}}}
# (different from /api/v1/health/deep which uses checks.db)
BODY=$(curl -sS -o /tmp/tier242-sysdeep.txt -w "%{http_code}" \
  "$API/api/v1/system/health/deep")
[ "$BODY" = "200" ] && pass "GET /api/v1/system/health/deep → 200" || fail "expected 200, got $BODY"
PG_OK=$(json_field "$(cat /tmp/tier242-sysdeep.txt)" checks.postgres.ok)
[ "$PG_OK" = "True" ] || [ "$PG_OK" = "true" ] && pass "system/health/deep checks.postgres.ok = true" || fail "postgres.ok = $PG_OK"

# ---- 7. /api/v1/health/summary → 200 + JSON ----
BODY=$(curl -sS -o /tmp/tier242-summary.txt -w "%{http_code}" \
  "$API/api/v1/health/summary")
[ "$BODY" = "200" ] && pass "GET /api/v1/health/summary → 200" || fail "expected 200, got $BODY"
STATUS=$(json_field "$(cat /tmp/tier242-summary.txt)" status)
DB_OK=$(json_field "$(cat /tmp/tier242-summary.txt)" dbOk)
STORAGE_OK=$(json_field "$(cat /tmp/tier242-summary.txt)" storageOk)
[ "$STATUS" = "ok" ] && [ -n "$DB_OK" ] && [ -n "$STORAGE_OK" ] && \
  pass "summary has status/dbOk/storageOk" || fail "summary missing fields (status=$STATUS, dbOk=$DB_OK, storageOk=$STORAGE_OK)"

# ---- 8. memory.{rssMB, heapMB} ----
RSS=$(json_field "$(cat /tmp/tier242-summary.txt)" memory.rssMB)
HEAP=$(json_field "$(cat /tmp/tier242-summary.txt)" memory.heapMB)
[ -n "$RSS" ] && [ -n "$HEAP" ] && [ "$RSS" -gt 0 ] 2>/dev/null && [ "$HEAP" -gt 0 ] 2>/dev/null && \
  pass "summary has memory.rssMB=$RSS, memory.heapMB=$HEAP (both > 0)" || \
  fail "memory values missing or zero (rss=$RSS, heap=$HEAP)"

# ---- 9. business.{companies, users, invoices, customers} ----
COMPANIES=$(json_field "$(cat /tmp/tier242-summary.txt)" business.companies)
INVOICES=$(json_field "$(cat /tmp/tier242-summary.txt)" business.invoices)
[ -n "$COMPANIES" ] && [ -n "$INVOICES" ] && \
  pass "summary has business.companies=$COMPANIES, business.invoices=$INVOICES" || \
  fail "business counts missing"

# ---- 10. /metrics → 200 + Prometheus text format ----
BODY=$(curl -sS -o /tmp/tier242-metrics.txt -w "%{http_code}" \
  "$API/metrics")
[ "$BODY" = "200" ] && pass "GET /metrics → 200" || fail "expected 200, got $BODY"
FIRST_LINE=$(head -1 /tmp/tier242-metrics.txt 2>/dev/null)
[ "$FIRST_LINE" = "# HELP de_invoice_uptime_seconds Process uptime in seconds" ] && \
  pass "metrics starts with # HELP de_invoice_uptime_seconds" || \
  fail "first line: $FIRST_LINE"

# ---- 11. /metrics contains de_invoice_uptime_seconds gauge ----
grep -q "^de_invoice_uptime_seconds " /tmp/tier242-metrics.txt && \
  pass "metrics has de_invoice_uptime_seconds gauge" || fail "missing uptime gauge"

# ---- 12. /metrics contains de_invoice_db_connected gauge ----
grep -q "^de_invoice_db_connected " /tmp/tier242-metrics.txt && \
  pass "metrics has de_invoice_db_connected gauge" || fail "missing db_connected gauge"

# ---- 13. /metrics contains de_invoice_business_invoices gauge ----
grep -q "^de_invoice_business_invoices " /tmp/tier242-metrics.txt && \
  pass "metrics has de_invoice_business_invoices (Tier 193)" || \
  fail "missing business_invoices gauge"

# ---- 14. No auth required (all 4 endpoints public) ----
# Verify by sending an empty x-user-id / x-company-id
# and getting 200 (not 401).
HTTP=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/api/v1/health")
[ "$HTTP" = "200" ] && pass "no auth required for /api/v1/health" || fail "got $HTTP"
HTTP=$(curl -sS -o /dev/null -w "%{http_code}" \
  "$API/metrics")
[ "$HTTP" = "200" ] && pass "no auth required for /metrics" || fail "got $HTTP"

# ---- 15. /api/v1/health/deep uptimeSec increases (not cached) ----
U1=$(json_field "$(cat /tmp/tier242-deep.txt)" uptimeSec)
sleep 2
curl -sS -o /tmp/tier242-deep2.txt "$API/api/v1/health/deep" >/dev/null
U2=$(json_field "$(cat /tmp/tier242-deep2.txt)" uptimeSec)
[ -n "$U1" ] && [ -n "$U2" ] && [ "$U2" -gt "$U1" ] 2>/dev/null && \
  pass "uptimeSec increased: $U1 → $U2 (not cached)" || \
  fail "uptimeSec didn't grow: $U1 → $U2"

rm -f /tmp/tier242-*.txt
summary
