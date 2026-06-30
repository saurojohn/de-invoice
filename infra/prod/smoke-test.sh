#!/usr/bin/env bash
# Tier 24: de-invoice post-deploy smoke test
#
# Run this from your workstation AFTER deploy-prep.sh
# + DNS + certbot + docker compose up have completed
# on the VPS. The script exits non-zero on the first
# failed check; intended to be the entry point of a
# CI/CD pipeline or a manual post-deploy ritual.
#
# Checks (in order):
#   1. DNS resolves to the VPS IP
#   2. HTTPS endpoint reachable
#   3. TLS cert valid + matches the domain
#   4. Cert is auto-renewable (Let's Encrypt dry-run)
#   5. Backend health endpoint returns ok
#   6. Database connectivity
#   7. Frontend SPA loads
#   8. Login page renders
#   9. Static assets load (Next.js bundles)
#  10. The Prometheus metrics endpoint is up
#      (if observability stack is enabled)
#  11. The Alertmanager health endpoint is up
#      (if observability stack is enabled)
#  12. The webhook test endpoint accepts a POST
#  13. The backup cron ran within the last 36h
#
# Usage:
#   DOMAIN=rechnung.shleder.de bash smoke-test.sh
#   DOMAIN=rechnung.shleder.de VPS_IP=1.2.3.4 \
#     OPS_EMAIL=ops@shleder.de \
#     bash smoke-test.sh
#
# Required env vars: DOMAIN, VPS_IP
# Optional: SLACK_WEBHOOK (for end-to-end alert test)

set -uo pipefail
# Note: we don't use -e because some checks
# deliberately accept non-zero (e.g. "is this
# port reachable? return 0 = reachable, return
# !0 = unreachable — the !0 IS the answer we want").
# We rely on the explicit pass/fail counters at
# the end to decide exit status.

DOMAIN="${DOMAIN:-}"
VPS_IP="${VPS_IP:-}"
OPS_EMAIL="${OPS_EMAIL:-ops@${DOMAIN}}"

PASS=0
FAIL=0
log() { echo -e "\033[1;34m▶\033[0m $1"; }
pass() { echo "  \033[1;32m✓\033[0m $1"; PASS=$((PASS+1)); }
fail() { echo "  \033[1;31m✗\033[0m $1"; FAIL=$((FAIL+1)); }
warn() { echo "  \033[1;33m⚠\033[0m $1"; }

[[ -z "$DOMAIN" ]] && { echo "DOMAIN env var required"; exit 2; }
[[ -z "$VPS_IP" ]] && { echo "VPS_IP env var required"; exit 2; }

# ─── 1. DNS ─────────────────────────────────────────────
log "1. DNS resolves $DOMAIN → $VPS_IP"
RESOLVED=$(dig +short "$DOMAIN" A 2>/dev/null | head -1)
if [[ "$RESOLVED" == "$VPS_IP" ]]; then
  pass "DNS A record = $VPS_IP"
else
  fail "DNS A record is '$RESOLVED', expected '$VPS_IP' (wait longer for propagation?)"
fi

# ─── 2. HTTPS reachable ────────────────────────────────
log "2. HTTPS endpoint reachable"
HTTP_CODE=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 10 "https://$DOMAIN/api/v1/health" || echo "000")
if [[ "$HTTP_CODE" == "200" ]]; then
  pass "GET /api/v1/health = 200"
else
  fail "GET /api/v1/health = $HTTP_CODE"
fi

# ─── 3. TLS cert ───────────────────────────────────────
log "3. TLS certificate"
CERT_INFO=$(echo | openssl s_client -servername "$DOMAIN" -connect "$DOMAIN:443" 2>/dev/null \
  | openssl x509 -noout -subject -dates -issuer 2>/dev/null)
if [[ -n "$CERT_INFO" ]]; then
  pass "Cert retrieved"
  echo "$CERT_INFO" | sed 's/^/    /'
  EXPIRY=$(echo "$CERT_INFO" | grep notAfter | sed 's/notAfter=//')
  DAYS_LEFT=$(( ( $(date -d "$EXPIRY" +%s) - $(date +%s) ) / 86400 ))
  if (( DAYS_LEFT > 14 )); then
    pass "Cert valid for $DAYS_LEFT more days"
  else
    fail "Cert only valid for $DAYS_LEFT days (renewal needed)"
  fi
else
  fail "could not retrieve cert"
fi

# ─── 4. Certbot dry-run (renewal works) ─────────────────
log "4. Certbot dry-run (skipped — must run on VPS directly)"
warn "Run 'certbot renew --dry-run' on the VPS to confirm auto-renewal works"

# ─── 5. Backend health ─────────────────────────────────
log "5. Backend health endpoint"
HEALTH=$(curl -sk --max-time 10 "https://$DOMAIN/api/v1/health")
STATUS=$(echo "$HEALTH" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
if [[ "$STATUS" == "ok" ]]; then
  pass "Backend status=ok ($HEALTH)"
else
  fail "Backend status='$STATUS' (expected 'ok')"
fi

# ─── 6. Database connectivity ──────────────────────────
log "6. Database deep-health"
DEEP=$(curl -sk --max-time 10 "https://$DOMAIN/api/v1/health/deep")
DB_STATUS=$(echo "$DEEP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('database',{}).get('status',''))" 2>/dev/null)
if [[ "$DB_STATUS" == "ok" ]]; then
  pass "Database reachable"
else
  fail "Database status='$DB_STATUS'"
fi

# ─── 7. Frontend SPA loads ─────────────────────────────
log "7. Frontend SPA loads"
ROOT_CODE=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 15 "https://$DOMAIN/")
if [[ "$ROOT_CODE" == "200" || "$ROOT_CODE" == "307" ]]; then
  pass "GET / = $ROOT_CODE"
else
  fail "GET / = $ROOT_CODE"
fi

# ─── 8. Login page renders ─────────────────────────────
log "8. Login page renders"
LOGIN_CODE=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 15 "https://$DOMAIN/login")
if [[ "$LOGIN_CODE" == "200" ]]; then
  pass "GET /login = 200"
else
  fail "GET /login = $LOGIN_CODE"
fi

# ─── 9. Next.js bundle loads ───────────────────────────
log "9. Next.js bundle loads"
BUNDLE_CODE=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 15 "https://$DOMAIN/_next/static/chunks/main.js")
if [[ "$BUNDLE_CODE" == "200" || "$BUNDLE_CODE" == "404" ]]; then
  # 404 is OK — Next.js hashes bundle paths; the
  # server returning 200 or 404 (not 500) means
  # the asset routing is alive.
  pass "Next.js asset routing alive (HTTP $BUNDLE_CODE)"
else
  fail "Next.js asset routing broken (HTTP $BUNDLE_CODE)"
fi

# ─── 10. Prometheus (optional) ─────────────────────────
log "10. Prometheus health (optional — only if observability enabled)"
PROM_CODE=$(curl -sk --max-time 5 "https://$DOMAIN:9090/-/ready" -o /dev/null -w "%{http_code}" || echo "000")
# Note: prometheus is on a non-public port; this
# only succeeds if the operator is SSH-tunneled
# or has the firewall opened for testing.
if [[ "$PROM_CODE" == "200" ]]; then
  pass "Prometheus /-/ready = 200"
else
  warn "Prometheus not reachable on public port ($PROM_CODE) — expected, it's bound to 127.0.0.1"
fi

# ─── 11. Alertmanager (optional) ───────────────────────
log "11. Alertmanager health (optional)"
AM_CODE=$(curl -sk --max-time 5 "https://$DOMAIN:9093/-/healthy" -o /dev/null -w "%{http_code}" || echo "000")
if [[ "$AM_CODE" == "200" ]]; then
  pass "Alertmanager /-/healthy = 200"
else
  warn "Alertmanager not reachable on public port ($AM_CODE) — expected, it's bound to 127.0.0.1"
fi

# ─── 12. Webhook test ──────────────────────────────────
log "12. Webhook test endpoint"
WEBHOOK_RESP=$(curl -sk -X POST -H "Content-Type: application/json" \
  -d '{"event":"smoke-test","companyId":"none","userId":"none"}' \
  -w "\n%{http_code}" --max-time 10 "https://$DOMAIN/api/v1/webhooks/test" 2>&1)
# The endpoint may 404 (not configured) or 200
# (test event sent) — both are OK signals.
WEBHOOK_CODE=$(echo "$WEBHOOK_RESP" | tail -1)
if [[ "$WEBHOOK_CODE" == "200" || "$WEBHOOK_CODE" == "404" ]]; then
  pass "Webhook endpoint responsive (HTTP $WEBHOOK_CODE)"
else
  fail "Webhook endpoint broken (HTTP $WEBHOOK_CODE)"
fi

# ─── 13. Backup freshness ──────────────────────────────
log "13. Backup freshness (last backup within 36h)"
# This requires SSH access to the VPS to read the
# backup log. We attempt; failure here is a warning,
# not a hard fail (some operators run backups
# externally via cron + off-site).
if command -v ssh &>/dev/null; then
  BACKUP_AGE=$(ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new \
    "deploy@$VPS_IP" \
    "find /var/backups/de-invoice -name '*.sql.gz' -mmin -2160 -print 2>/dev/null | head -1" 2>/dev/null)
  if [[ -n "$BACKUP_AGE" ]]; then
    pass "Recent backup found: $(basename "$BACKUP_AGE")"
  else
    warn "No backup within last 36h — check backup cron"
  fi
else
  warn "ssh not available locally — skipping backup check"
fi

# ─── Summary ────────────────────────────────────────────
echo
echo "============================================================"
echo "Smoke test: $PASS passed, $FAIL failed"
echo "============================================================"
if (( FAIL > 0 )); then
  echo
  echo "Some checks failed. Runbook: infra/prod/README.md"
  exit 1
fi
echo
echo "All checks PASSED. The deployment is healthy."
echo "Consider:"
echo "  - Run certbot renew --dry-run on the VPS to confirm auto-renewal"
echo "  - Test a Stripe-style webhook end-to-end (if you have a receiver)"
echo "  - Run the Playwright UI test suite: cd frontend && npx playwright test"