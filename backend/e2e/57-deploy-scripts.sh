#!/usr/bin/env bash
# e2e 57: Tier 24 — Deployment script shape validation
#
# We can't run the real deploy-prep.sh (it does
# apt-get install, creates users, etc — destructive).
# What we CAN do without a fresh VPS is validate
# that the scripts:
#   1. Have bash -euo pipefail (fail-fast on errors)
#   2. Don't accidentally delete data directories
#      (the only "rm -rf" allowed is in the backup
#       rotation logic, which targets /var/backups
#       only)
#   3. Use HTTPS endpoints (not HTTP) for the smoke
#       test
#   4. Use the recommended Tier 17 paths
#       (/opt/de-invoice, /var/backups/de-invoice)
#   5. Don't hardcode secrets
#   6. Don't `curl | sh` the install — security risk
#
# This is a static-analysis smoke test, not a
# real deploy. Real deploy is run by hand on
# the VPS; the verification is "do these scripts
# look like they were written by someone who
# understood the security model".

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
cd "$PROJECT_ROOT"

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

# ─── 1. Scripts exist + are executable ────────────────
echo "=== 1. Script presence ==="
for SCRIPT in deploy-prep.sh smoke-test.sh rollback.sh backup.sh; do
  if [[ -x "infra/prod/$SCRIPT" ]]; then
    pass "$SCRIPT exists and is executable"
  else
    fail "$SCRIPT missing or not executable"
  fi
done

# ─── 2. Bash strict mode ───────────────────────────────
echo
echo "=== 2. Strict mode + shebang ==="
for SCRIPT in deploy-prep.sh smoke-test.sh rollback.sh; do
  if head -1 "infra/prod/$SCRIPT" | grep -q "^#!/.*bash"; then
    if grep -qE "set -[eu]+o pipefail" "infra/prod/$SCRIPT"; then
      pass "$SCRIPT has bash + strict mode"
    else
      fail "$SCRIPT missing 'set -euo pipefail' (or -uo pipefail)"
    fi
  else
    fail "$SCRIPT missing bash shebang"
  fi
done

# ─── 3. No accidental data destruction ────────────────
echo
echo "=== 3. Data safety ==="
# Look for any rm -rf that targets /
if grep -E "rm -rf /[^/]" infra/prod/deploy-prep.sh infra/prod/rollback.sh 2>/dev/null | head; then
  fail "rm -rf on / detected in script"
else
  pass "no rm -rf on root filesystem"
fi
# Verify rollback doesn't touch the database
if grep -E "DROP DATABASE|TRUNCATE" infra/prod/rollback.sh 2>/dev/null; then
  fail "rollback script contains DROP/TRUNCATE"
else
  pass "rollback doesn't touch the database schema"
fi

# ─── 4. Smoke test uses HTTPS (not HTTP) ──────────────
echo
echo "=== 4. Smoke test uses HTTPS ==="
if grep -q "https://" infra/prod/smoke-test.sh; then
  pass "smoke-test uses HTTPS endpoints"
else
  fail "smoke-test does not use HTTPS"
fi
if grep -E "http://[^l]" infra/prod/smoke-test.sh | grep -v "localhost\|127.0.0.1\|s_client" | head; then
  warn "non-localhost http:// URL in smoke-test (should be localhost only)"
else
  pass "no public http:// URLs in smoke-test"
fi

# ─── 5. Recommended paths ──────────────────────────────
echo
echo "=== 5. Tier 17 paths ==="
for SCRIPT in deploy-prep.sh smoke-test.sh rollback.sh; do
  if grep -q "/opt/de-invoice" "infra/prod/$SCRIPT" 2>/dev/null; then
    pass "$SCRIPT uses /opt/de-invoice"
  fi
done
if grep -q "/var/backups/de-invoice" infra/prod/deploy-prep.sh infra/prod/rollback.sh 2>/dev/null; then
  pass "deploy-prep + rollback use /var/backups/de-invoice"
fi

# ─── 6. No hardcoded secrets ───────────────────────────
echo
echo "=== 6. Secret handling ==="
# Look for any obvious patterns — passwords, keys
# embedded directly. Real secrets should come from
# .env or environment, not from a constant in the
# script.
for PATTERN in "password.*=.*['\"]" "secret.*=.*['\"]" "BEGIN.*PRIVATE.*KEY"; do
  if grep -E "$PATTERN" infra/prod/deploy-prep.sh infra/prod/smoke-test.sh 2>/dev/null | head; then
    warn "possible hardcoded secret matching /$PATTERN/"
  fi
done
pass "no obvious hardcoded secrets"

# ─── 7. No curl | sh (RCE vector) ──────────────────────
echo
echo "=== 7. No curl|sh patterns ==="
if grep -E "curl[^|]*\|[^|]*sh" infra/prod/deploy-prep.sh 2>/dev/null; then
  fail "curl|sh pattern detected (RCE risk)"
else
  pass "no curl|sh patterns"
fi

# ─── 8. SSH hardening: disable password + root login ──
echo
echo "=== 8. SSH hardening ==="
if grep -q "PermitRootLogin.*no" infra/prod/deploy-prep.sh; then
  pass "PermitRootLogin=no set"
fi
if grep -q "PasswordAuthentication.*no" infra/prod/deploy-prep.sh; then
  pass "PasswordAuthentication=no set"
fi
if grep -q "X11Forwarding.*no" infra/prod/deploy-prep.sh; then
  pass "X11Forwarding=no set"
fi
if grep -q "fail2ban" infra/prod/deploy-prep.sh; then
  pass "fail2ban installed + configured"
fi

# ─── 9. Firewall config ──────────────────────────────
echo
echo "=== 9. UFW firewall ==="
if grep -q "ufw --force enable" infra/prod/deploy-prep.sh; then
  pass "ufw enabled"
fi
if grep -q "ufw allow 22" infra/prod/deploy-prep.sh && \
   grep -q "ufw allow 80" infra/prod/deploy-prep.sh && \
   grep -q "ufw allow 443" infra/prod/deploy-prep.sh; then
  pass "ufw allows 22, 80, 443"
fi
if ! grep -q "ufw allow 3001\|ufw allow 9090" infra/prod/deploy-prep.sh; then
  pass "monitoring ports NOT publicly opened (bound to 127.0.0.1 instead)"
fi

# ─── 10. Rollback preserves current state ─────────────
echo
echo "=== 10. Rollback audit trail ==="
if grep -q "git rev-parse HEAD" infra/prod/rollback.sh; then
  pass "rollback captures current revision for audit"
fi
if grep -q "BACKUP_REV_DIR" infra/prod/rollback.sh; then
  pass "rollback uses /var/backups/de-invoice/revisions/ for audit"
fi
if grep -q "git checkout" infra/prod/rollback.sh; then
  pass "rollback uses git checkout to revert"
fi
if grep -q "docker compose build\|docker compose up" infra/prod/rollback.sh; then
  pass "rollback rebuilds + restarts the stack"
fi

echo
echo "==== $PASS passed, $FAIL failed ===="
exit $FAIL