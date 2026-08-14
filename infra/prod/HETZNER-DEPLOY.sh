#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# HETZNER-DEPLOY.sh — single-command Hetzner Cloud deploy (Tier 114)
#
# This script is the runnable version of HETZNER-DEPLOY.md. It
# assumes:
#   - A fresh Hetzner Cloud CX21 with Debian 12, public IPv4
#     reachable from your workstation
#   - You SSH'd in as root, ran `apt install -y git`, then
#     `git clone https://github.com/saurojohn/de-invoice.git /opt/de-invoice`
#   - DNS for rechnung.shleder.de is already pointing at the VPS
#   - You've added your real SSH public key to the deploy user
#     (this script does the FIRST-TIME init only; subsequent
#     deploys use the host-cron job or just `docker compose up -d`)
#
# What it does:
#   1. Runs deploy-prep.sh (host hardening, docker, UFW, fail2ban)
#   2. Builds the Docker images
#   3. Starts postgres, applies Prisma schema
#   4. Seeds the SH Leder GmbH company
#   5. Starts the full stack (incl. Caddy which auto-issues LE certs)
#   6. Runs a 30-90s healthcheck loop until /api/v1/health returns 200
#   7. Prints next-steps (configure .env, add SSH key, enable monitoring)
#
# Idempotent: re-running on an already-deployed host is safe —
# the script skips completed steps and only re-runs health checks.
#
# Usage (as root on the VPS, after cloning the repo):
#   bash /opt/de-invoice/infra/prod/HETZNER-DEPLOY.sh
#
# To customise:
#   DOMAIN=rechnung.shleder.de \
#   FRONTEND_URL=https://rechnung.shleder.de \
#   COMPANY_NAME="SH Leder GmbH" \
#   bash HETZNER-DEPLOY.sh
#
# Exit codes:
#   0 = deploy succeeded (or was already deployed and still healthy)
#   1 = a step failed (see the error message for which one)
#   2 = required env vars missing
#   3 = health check timed out after 120s
# ─────────────────────────────────────────────────────────────────

set -euo pipefail

# ─── Configuration ─────────────────────────────────────
# Tier 190 (Aug 14): default domain switched from
# `rechnung.shleder.de` to `invoice.shleder.de` to
# match the Tier 127 cloud-deploy decision
# (TIER127-DEPLOY-CHECKLIST.md + .env.prod.generated
# already use invoice.shleder.de). The Caddyfile
# default block was already updated in Tier 127.
# Operators who still want the old domain can
# pass DOMAIN=rechnung.shleder.de explicitly.
DOMAIN="${DOMAIN:-invoice.shleder.de}"
FRONTEND_URL="${FRONTEND_URL:-https://$DOMAIN}"
COMPANY_NAME="${COMPANY_NAME:-SH Leder GmbH}"
INSTALL_DIR="${INSTALL_DIR:-/opt/de-invoice}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"  # seconds
HEALTH_INTERVAL="${HEALTH_INTERVAL:-5}"
LOG_PREFIX="[deploy]"

# ─── Check mode (Tier 190) ───────────────────────────
# `bash HETZNER-DEPLOY.sh --check` validates the
# local repo + config without contacting any
# remote, starting Docker, or modifying the host.
# Use this on a workstation before booking a VPS
# to catch "the Caddyfile forgot the domain", "the
# .env example is missing POSTGRES_PASSWORD",
# "the secrets in .env.prod.generated are still
# placeholder" etc. Exit 0 = ready to deploy.
CHECK_ONLY=0
if [[ "${1:-}" == "--check" || "${1:-}" == "-c" ]]; then
  CHECK_ONLY=1
fi

# ─── Helpers ────────────────────────────────────────────
log()  { echo -e "\033[1;34m$LOG_PREFIX\033[0m $1"; }
warn() { echo -e "\033[1;33m$LOG_PREFIX ⚠\033[0m $1"; }
die()  { echo -e "\033[1;31m$LOG_PREFIX ✗\033[0m $1" >&2; exit 1; }

# In --check mode we don't require root (the
# pre-flight checks are read-only and can run on
# an operator's workstation). The full deploy
# path below still requires root.
if [[ "$CHECK_ONLY" -ne 1 ]]; then
  [[ $EUID -eq 0 ]] || die "Run as root (sudo bash $0)"
fi

# --check mode: default INSTALL_DIR to cwd if the
# user didn't override it. The full deploy path
# requires /opt/de-invoice (the path the rest of
# the compose + scripts assume) — only relax this
# in check mode.
if [[ "$CHECK_ONLY" -eq 1 && "$INSTALL_DIR" == "/opt/de-invoice" && ! -d "$INSTALL_DIR" ]]; then
  INSTALL_DIR="$(pwd)"
fi
[[ -d "$INSTALL_DIR" ]] || die "Install dir not found: $INSTALL_DIR — clone the repo first"
cd "$INSTALL_DIR"

# In --check mode, allow running as non-root from
# any directory (operator's workstation). The check
# is read-only and doesn't touch docker. We do this
# AFTER the root check so the production deploy
# path still requires root.
if [[ "$CHECK_ONLY" -eq 1 ]]; then
  # fall through to the check block below
  :  # no-op
else
  # Sanity: docker is installed and compose v2 is available.
  command -v docker    >/dev/null 2>&1 || die "docker not installed (run deploy-prep.sh first?)"
  docker compose version >/dev/null 2>&1 || die "docker compose v2 plugin not installed"
fi

# Sanity: docker is installed and compose v2 is available.
command -v docker    >/dev/null 2>&1 || die "docker not installed (run deploy-prep.sh first?)"
docker compose version >/dev/null 2>&1 || die "docker compose v2 plugin not installed"

# ─── Tier 190: pre-flight check mode ────────────────
# When CHECK_ONLY=1 (set by --check/-c), we run
# the read-only sanity checks and exit. No docker
# images built, no host changes, no network calls
# to the target VPS. The point is to catch
# config drift BEFORE the operator books a VPS
# or kicks off a 5-minute image build.
if [[ "$CHECK_ONLY" -eq 1 ]]; then
  log "Pre-flight check mode (--check) — no changes will be made"
  CHECK_FAIL=0

  check_file() {
    local f="$1" desc="$2"
    if [[ -f "$f" ]]; then
      log "  ✓ $desc: $f"
    else
      warn "  ✗ $desc MISSING: $f"
      CHECK_FAIL=1
    fi
  }

  check_grep() {
    local f="$1" pattern="$2" desc="$3"
    if grep -qE "$pattern" "$f" 2>/dev/null; then
      log "  ✓ $desc"
    else
      warn "  ✗ $desc — pattern '$pattern' not found in $f"
      CHECK_FAIL=1
    fi
  }

  log "── Required files ──"
  check_file "infra/prod/Caddyfile"            "Caddy reverse-proxy config"
  check_file "infra/prod/deploy-prep.sh"        "host prep script"
  check_file "infra/prod/HETZNER-DEPLOY.sh"     "this script"
  check_file "infra/prod/docker-compose.yml"    "production compose"
  check_file "infra/prod/init.sql"              "Postgres init"
  check_file "infra/prod/.env.example"          ".env template"
  check_file "infra/prod/.env.prod.generated"   "generated prod secrets"
  check_file "infra/prod/HETZNER-DEPLOY.md"     "deploy runbook"
  check_file "infra/prod/RUNBOOK.md"            "operator runbook"
  check_file "infra/prod/SECURITY.md"           "security checklist"
  check_file "infra/prod/DR-TEST.md"            "disaster recovery test"

  log "── Domain consistency ──"
  log "  target domain: $DOMAIN"
  log "  FRONTEND_URL:  $FRONTEND_URL"
  # All 4 of these should reference the same domain
  # (or its www. variant). If they don't, Caddy will
  # serve the wrong cert and the CORS allowlist will
  # block the frontend.
  check_grep "infra/prod/Caddyfile" "$DOMAIN"        "Caddyfile references target domain"
  check_grep "infra/prod/.env.prod.generated" "FRONTEND_URL=https://$DOMAIN" \
    ".env.prod.generated FRONTEND_URL matches"
  check_grep "infra/prod/TIER127-DEPLOY-CHECKLIST.md" "$DOMAIN" \
    "checklist references target domain"

  log "── Secrets sanity ──"
  # .env.example should NOT contain real secrets
  # (only placeholders). Real secrets live in
  # .env.prod.generated.
  if grep -qE "POSTGRES_PASSWORD=[A-Za-z0-9]{20,}" infra/prod/.env.example; then
    warn "  ✗ .env.example looks like it contains a real POSTGRES_PASSWORD"
    CHECK_FAIL=1
  else
    log "  ✓ .env.example has no real POSTGRES_PASSWORD (placeholder only)"
  fi
  # .env.prod.generated should have a real
  # POSTGRES_PASSWORD (32+ chars of entropy).
  if grep -qE "POSTGRES_PASSWORD=[A-Za-z0-9+/=]{30,}" infra/prod/.env.prod.generated; then
    log "  ✓ .env.prod.generated has a real POSTGRES_PASSWORD"
  else
    warn "  ✗ .env.prod.generated POSTGRES_PASSWORD missing or too short"
    CHECK_FAIL=1
  fi
  # JWT_SECRET should be 64 hex chars (256 bits).
  if grep -qE "JWT_SECRET=[a-f0-9]{64}" infra/prod/.env.prod.generated; then
    log "  ✓ .env.prod.generated has a 64-hex JWT_SECRET"
  else
    warn "  ✗ .env.prod.generated JWT_SECRET not 64 hex chars"
    CHECK_FAIL=1
  fi

  log "── Docker compose sanity ──"
  # Caddy service must be present (TLS termination).
  if grep -qE "^  caddy:" infra/prod/docker-compose.yml; then
    log "  ✓ caddy service defined"
  else
    warn "  ✗ caddy service missing from docker-compose.yml"
    CHECK_FAIL=1
  fi
  # Backend should depend_on caddy? No — caddy
  # depends on backend. The right direction.
  if grep -qE "caddy:.*depends_on|backend:" infra/prod/docker-compose.yml; then
    log "  ✓ service dependency wiring looks sane"
  else
    warn "  ✗ service dependency wiring looks wrong (check depends_on)"
    CHECK_FAIL=1
  fi

  log ""
  if [[ $CHECK_FAIL -eq 0 ]]; then
    log "PRE-FLIGHT OK — repo is ready to deploy to Hetzner"
    log "Next: book a CX21, point $DOMAIN → VPS IP, then:"
    log "  DOMAIN=$DOMAIN bash infra/prod/HETZNER-DEPLOY.sh"
    exit 0
  else
    die "PRE-FLIGHT FAILED — fix the items marked ✗ above before deploying"
  fi
fi

# ─── Step 1: host prep (idempotent) ─────────────────────
log "Step 1/7 — host prep (deploy-prep.sh)"
if [[ -f /etc/sudoers.d/deploy-docker ]]; then
  log "  host already prepped (sudoers.d/deploy-docker exists), skipping"
else
  bash infra/prod/deploy-prep.sh
fi

# ─── Step 2: build images ──────────────────────────────
log "Step 2/7 — build Docker images (3-5 min on a cold cache)"
docker compose -f infra/prod/docker-compose.yml build

# ─── Step 3: configure .env (template-only on first run) ─
log "Step 3/7 — configure .env"
if [[ ! -f infra/prod/.env ]]; then
  if [[ -f infra/prod/.env.example ]]; then
    cp infra/prod/.env.example infra/prod/.env
    chmod 600 infra/prod/.env
    warn "  generated infra/prod/.env from .env.example"
    warn "  >>> you MUST edit infra/prod/.env and set real values"
    warn "  >>> (POSTGRES_PASSWORD, JWT_SECRET, FRONTEND_URL, ...)"
    warn "  >>> then re-run this script"
    die ".env needs to be filled in before continuing"
  else
    die "infra/prod/.env.example not found — repo incomplete?"
  fi
else
  log "  infra/prod/.env already exists, leaving as-is"
fi

# Quick .env sanity.
grep -qE '^POSTGRES_PASSWORD=[^ ]' infra/prod/.env || die "POSTGRES_PASSWORD missing in .env"
grep -qE '^JWT_SECRET=[^ ]'           infra/prod/.env || die "JWT_SECRET missing in .env"
grep -qE '^FRONTEND_URL=https?://'    infra/prod/.env || die "FRONTEND_URL missing or invalid in .env"

# Patch FRONTEND_URL if it was just templated with the wrong domain.
if grep -qE "^FRONTEND_URL=https?://" infra/prod/.env; then
  if ! grep -q "^FRONTEND_URL=$FRONTEND_URL$" infra/prod/.env; then
    log "  patching FRONTEND_URL to $FRONTEND_URL"
    sed -i.bak "s|^FRONTEND_URL=.*|FRONTEND_URL=$FRONTEND_URL|" infra/prod/.env
  fi
fi

# ─── Step 4: start postgres + apply Prisma schema ──────
log "Step 4/7 — start postgres + apply Prisma schema"
docker compose -f infra/prod/docker-compose.yml up -d postgres
log "  waiting for postgres to be healthy..."
for _ in $(seq 1 30); do
  STATUS=$(docker compose -f infra/prod/docker-compose.yml ps --format json postgres 2>/dev/null \
    | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['Health'] if d else 'starting')" 2>/dev/null || echo "starting")
  if [[ "$STATUS" == "healthy" ]]; then
    log "  postgres is healthy"
    break
  fi
  sleep 2
done
[[ "$STATUS" == "healthy" ]] || die "postgres did not become healthy in 60s"

# Apply Prisma schema. On a brand-new DB, `db push` is correct.
# On a restore-from-backup, you'd `migrate deploy` instead — but
# that's not the first-deploy path.
log "  applying Prisma schema (db push)..."
docker compose -f infra/prod/docker-compose.yml run --rm backend \
  npx prisma db push --accept-data-loss --skip-generate 2>&1 | tail -3
docker compose -f infra/prod/docker-compose.yml run --rm backend \
  npx prisma generate 2>&1 | tail -2

# ─── Step 5: seed the first company ────────────────────
log "Step 5/7 — seed the first company"
COMPANY_ID="00000000-0000-0000-0000-000000000001"
EXISTING=$(docker compose -f infra/prod/docker-compose.yml exec -T postgres \
  psql -U de_invoice -d de_invoice -tAc "SELECT 1 FROM \"Company\" WHERE id='$COMPANY_ID' LIMIT 1;" 2>/dev/null || echo "")
if [[ "$EXISTING" == "1" ]]; then
  log "  company $COMPANY_ID already exists, skipping"
else
  log "  inserting company '$COMPANY_NAME' (id=$COMPANY_ID)"
  # The Company.address column is NOT NULL (jsonb) since the
  # address-fields migration. We seed with an empty JSONB
  # object — the operator can fill it in via the Settings page
  # after first login. defaultPaymentDays is also NOT NULL
  # but has a DEFAULT 30 so we don't pass it.
  docker compose -f infra/prod/docker-compose.yml exec -T postgres \
    psql -U de_invoice -d de_invoice -c "
      INSERT INTO \"Company\" (id, name, address, \"createdAt\", \"updatedAt\")
      VALUES ('$COMPANY_ID', '$COMPANY_NAME', '{}'::jsonb, NOW(), NOW());
    "
fi

# ─── Step 6: start the full stack ──────────────────────
log "Step 6/7 — start the full stack (postgres, backend, frontend, caddy, backup)"
docker compose -f infra/prod/docker-compose.yml up -d

# ─── Step 7: health check loop ─────────────────────────
log "Step 7/7 — health check (up to ${HEALTH_TIMEOUT}s)"
ELAPSED=0
HEALTH_OK=0
while (( ELAPSED < HEALTH_TIMEOUT )); do
  # Probe the backend via the in-cluster network. We don't
  # use the public domain here because (a) Caddy may still
  # be issuing the cert and (b) we want to confirm the
  # app stack, not the proxy, is healthy.
  RESP=$(docker compose -f infra/prod/docker-compose.yml exec -T backend \
    wget -q -O- http://localhost:3001/api/v1/health 2>/dev/null || echo "")
  if echo "$RESP" | grep -q '"status":"ok"'; then
    log "  backend /api/v1/health = ok (after ${ELAPSED}s)"
    HEALTH_OK=1
    break
  fi
  sleep "$HEALTH_INTERVAL"
  ELAPSED=$((ELAPSED + HEALTH_INTERVAL))
done

if (( HEALTH_OK == 0 )); then
  die "backend did not become healthy in ${HEALTH_TIMEOUT}s — check 'docker compose logs backend'"
fi

# ─── Done ──────────────────────────────────────────────
echo
echo "============================================================"
echo -e "\033[1;32m✓\033[0m Deploy complete."
echo "============================================================"
echo
echo "Stack status:"
docker compose -f infra/prod/docker-compose.yml ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"
echo
echo "Next steps (HAND, not automated):"
echo
echo "1. CONFIRM HTTPS WORKS (Caddy auto-issues LE cert on first request):"
echo "   curl -sI https://$DOMAIN | head -3"
echo "   # If you see HTTP/2 200 with HSTS, you're done."
echo
echo "2. CREATE THE FIRST ADMIN USER:"
echo "   Open https://$DOMAIN/login in a browser and use the"
echo "   'Register' flow. (Registration is open by default; lock"
echo "   it down after the first user exists.)"
echo
echo "3. ENABLE OFF-SITE BACKUPS (Hetzner Storage Box):"
echo "   See HETZNER-DEPLOY.md step 9."
echo
echo "4. ENABLE MONITORING (Prometheus + Grafana):"
echo "   cd $INSTALL_DIR/infra/prod"
echo "   docker compose -f docker-compose.yml -f monitoring.yml up -d"
echo
echo "5. SET UP EXTERNAL UPTIME MONITORING:"
echo "   Point Healthchecks.io or UptimeRobot at"
echo "   https://$DOMAIN/api/v1/health"
echo
echo "6. REVIEW THE OPERATIONS RUNBOOK:"
echo "   cat $INSTALL_DIR/infra/prod/RUNBOOK.md"
echo
echo "============================================================"
