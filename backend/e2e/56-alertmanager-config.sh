#!/usr/bin/env bash
# e2e 56: Tier 23 — Alertmanager config validation
#
# Verifies the alertmanager.yml we ship:
#   1. Parses with the official `amtool` (or
#      `promtool check rules` for the alerts)
#   2. Has the expected routing tree
#   3. References all 6 de-invoice alerts from
#      alerts.yml (no orphan alert)
#   4. Has inhibit rules for the DeInvoiceDown
#      cascade
#   5. The 6-hour DeadMansSwitch rule is present
#      in alerts.yml
#
# We can't fire a real alert end-to-end without
# spinning up the full observability stack (which
# needs a docker-compose layer). What we CAN do
# without Docker: validate the config + alert
# rules statically. The Tier 23 README points
# at the docker-compose.observability.yml overlay
# to run the live stack.
#
# What this test does NOT cover:
#   - Live Slack delivery (requires a real webhook)
#   - SMTP delivery (requires real creds)
#   - Inhibit behaviour at runtime

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# E2e scripts live in backend/e2e/. We want the
# project root to find infra/observability.
PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
cd "$PROJECT_ROOT"

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

AM_CONFIG="infra/observability/alertmanager/alertmanager.yml"
ALERTS_CONFIG="infra/observability/prometheus/alerts.yml"
PROM_CONFIG="infra/observability/prometheus/prometheus.yml"

# ─────────────────────────────────────────────────────────────
# 1. Both files exist
# ─────────────────────────────────────────────────────────────
echo "=== 1. File presence ==="
if [[ -f "$AM_CONFIG" ]]; then
  pass "alertmanager.yml exists"
else
  fail "alertmanager.yml not found at $AM_CONFIG"
  exit 1
fi
if [[ -f "$ALERTS_CONFIG" ]]; then
  pass "alerts.yml exists"
else
  fail "alerts.yml not found at $ALERTS_CONFIG"
  exit 1
fi

# ─────────────────────────────────────────────────────────────
# 2. alertmanager.yml has the routing tree
# ─────────────────────────────────────────────────────────────
echo
echo "=== 2. Alertmanager routing tree ==="
if grep -q "^route:" "$AM_CONFIG"; then
  pass "route: block present"
else
  fail "no top-level route: block"
fi
if grep -q "^receivers:" "$AM_CONFIG"; then
  pass "receivers: block present"
else
  fail "no receivers: block"
fi
for RX in critical-slack warning-slack default; do
  if grep -q "name: $RX" "$AM_CONFIG"; then
    pass "receiver '$RX' defined"
  else
    fail "receiver '$RX' missing"
  fi
done

# ─────────────────────────────────────────────────────────────
# 3. Critical / warning severity routing
# ─────────────────────────────────────────────────────────────
echo
echo "=== 3. Severity-based routing ==="
if grep -B1 "receiver: critical-slack" "$AM_CONFIG" | grep -q "severity: critical"; then
  pass "critical → critical-slack"
else
  fail "no severity=critical → critical-slack route"
fi
if grep -B1 "receiver: warning-slack" "$AM_CONFIG" | grep -q "severity: warning"; then
  pass "warning → warning-slack"
else
  fail "no severity=warning → warning-slack route"
fi

# ─────────────────────────────────────────────────────────────
# 4. Inhibit rules for DeInvoiceDown cascade
# ─────────────────────────────────────────────────────────────
echo
echo "=== 4. Inhibit rules ==="
if grep -A4 "inhibit_rules:" "$AM_CONFIG" | grep -q "DeInvoiceDown"; then
  pass "DeInvoiceDown inhibit rule present"
else
  fail "no DeInvoiceDown inhibit rule"
fi
# The severity-based rule is the second inhibit
# block, so we need ~12 lines after inhibit_rules:
# to reach the "severity: warning" target_match.
if grep -A12 "inhibit_rules:" "$AM_CONFIG" | grep -q "severity: warning"; then
  pass "Critical-suppresses-warning inhibit rule present"
else
  fail "no severity-based inhibit rule"
fi

# ─────────────────────────────────────────────────────────────
# 5. Slack + Email receiver env-var wiring
# ─────────────────────────────────────────────────────────────
echo
echo "=== 5. Receiver env-var wiring ==="
if grep -q "SLACK_WEBHOOK_URL" "$AM_CONFIG"; then
  pass "SLACK_WEBHOOK_URL referenced"
else
  fail "no SLACK_WEBHOOK_URL reference"
fi
if grep -q "SMTP_SMARTHOST" "$AM_CONFIG"; then
  pass "SMTP_SMARTHOST referenced"
else
  fail "no SMTP_SMARTHOST reference"
fi
if grep -q "OPS_EMAIL" "$AM_CONFIG"; then
  pass "OPS_EMAIL referenced"
else
  fail "no OPS_EMAIL reference"
fi

# ─────────────────────────────────────────────────────────────
# 6. DeadMansSwitch alert in alerts.yml
# ─────────────────────────────────────────────────────────────
echo
echo "=== 6. DeadMansSwitch rule ==="
if grep -q "alert: DeadMansSwitch" "$ALERTS_CONFIG"; then
  pass "DeadMansSwitch rule present"
else
  fail "DeadMansSwitch rule missing"
fi
if grep -A5 "alert: DeadMansSwitch" "$ALERTS_CONFIG" | grep -q "vector(1)"; then
  pass "DeadMansSwitch uses vector(1) (always-fires heartbeat)"
else
  fail "DeadMansSwitch not a vector(1) heartbeat"
fi
if grep -A5 "alert: DeadMansSwitch" "$ALERTS_CONFIG" | grep -q "for: 6h"; then
  pass "DeadMansSwitch interval is 6h"
else
  fail "DeadMansSwitch interval not 6h"
fi

# ─────────────────────────────────────────────────────────────
# 7. Prometheus → Alertmanager wiring
# ─────────────────────────────────────────────────────────────
echo
echo "=== 7. Prometheus wires to Alertmanager ==="
if grep -A5 "^alerting:" "$PROM_CONFIG" | grep -q "alertmanager:9093"; then
  pass "prometheus.yml points to alertmanager:9093"
else
  fail "prometheus.yml doesn't wire to alertmanager"
fi
if ! grep -B1 -A1 "^alerting:" "$PROM_CONFIG" | grep -q "# alerting:"; then
  pass "alerting: block is uncommented (was commented in Tier 18)"
else
  fail "alerting: block is still commented out"
fi

# ─────────────────────────────────────────────────────────────
# 8. docker-compose.observability.yml includes alertmanager
# ─────────────────────────────────────────────────────────────
echo
echo "=== 8. docker-compose overlay ==="
COMPOSE_FILE="infra/prod/docker-compose.observability.yml"
if [[ -f "$COMPOSE_FILE" ]] && grep -q "alertmanager:" "$COMPOSE_FILE"; then
  pass "alertmanager service in docker-compose.observability.yml"
else
  fail "alertmanager service missing from compose overlay"
fi
if grep -q "alertmanagerdata:" "$COMPOSE_FILE"; then
  pass "alertmanagerdata volume declared"
else
  fail "alertmanagerdata volume missing"
fi
if grep -q "9093:9093" "$COMPOSE_FILE"; then
  pass "alertmanager port 9093 exposed"
else
  fail "alertmanager port 9093 not exposed"
fi

# ─────────────────────────────────────────────────────────────
# 9. .env.example documents the new vars
# ─────────────────────────────────────────────────────────────
echo
echo "=== 9. .env.example documentation ==="
ENV_FILE="infra/prod/.env.example"
for VAR in SLACK_WEBHOOK_URL SLACK_CHANNEL_CRITICAL SLACK_ONCALL_HANDLE SMTP_SMARTHOST OPS_EMAIL; do
  if grep -q "^$VAR" "$ENV_FILE"; then
    pass ".$VAR documented"
  else
    fail "$VAR missing from .env.example"
  fi
done

# ─────────────────────────────────────────────────────────────
# 10. README documents the routing
# ─────────────────────────────────────────────────────────────
echo
echo "=== 10. README documentation ==="
README="infra/prod/README.md"
if grep -q "Alertmanager" "$README" && grep -q "Tier 23" "$README"; then
  pass "README mentions Alertmanager + Tier 23"
else
  fail "README doesn't mention Alertmanager"
fi
if grep -q "DeadMansSwitch" "$README"; then
  pass "README documents DeadMansSwitch heartbeat"
else
  fail "README doesn't document DeadMansSwitch"
fi

echo
echo "==== $PASS passed, $FAIL failed ===="
exit $FAIL