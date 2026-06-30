#!/usr/bin/env bash
# Tier 24: de-invoice emergency rollback
#
# When the deployed version is broken (health
# checks failing, users can't log in, etc.) this
# script rolls back to the previous git revision
# and restarts the stack. The database is left
# intact — schema changes in the new revision
# remain in place; only the code is reverted. If
# you also need to revert the database schema,
# restore from a backup with the backup.sh script
# BEFORE running this one.
#
# Usage (on the VPS as the deploy user):
#   sudo /usr/local/bin/de-invoice-rollback
#
# What it does:
#   1. Captures the current revision SHA into
#      /var/backups/de-invoice/revisions/ for
#      audit (so you can re-apply this roll-forward
#      later)
#   2. `git checkout HEAD~1` in the install dir
#      (reverts to the previous commit on the
#      current branch)
#   3. Runs `docker compose pull` + `up -d` to
#      pull the previous image tags (only works
#      if the previous image was pushed to a
#      registry; for git-source installs we
#      rebuild from the local checkout instead)
#   4. Waits 10s for the backend to come back up
#      and runs a health check
#   5. Reports status; exits 0 on success, 1 on
#      failure (in which case the operator should
#      re-run with --previous-count=2 to roll
#      back further)
#
# Side effects:
#   - The current commit is now HEAD~1
#   - The running container is rebuilt from the
#     previous code revision
#   - Any uploads to /var/backups/de-invoice/ are
#     left intact (so you can recover data if you
#     also need to roll back the schema)
#
# This is the "code" rollback only. If the new
# version made destructive schema changes (e.g.
# dropped columns), use backup.sh to roll back
# the database first, THEN this script.

set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/de-invoice}"
BACKUP_REV_DIR="/var/backups/de-invoice/revisions"
PREVIOUS_COUNT="${PREVIOUS_COUNT:-1}"

log() { echo -e "\033[1;34m▶\033[0m $1"; }
die() { echo -e "\033[1;31m✗\033[0m $1" >&2; exit 1; }

[[ -d "$INSTALL_DIR" ]] || die "Install dir not found: $INSTALL_DIR"
cd "$INSTALL_DIR"

# ─── 1. Audit-trail the current revision ───────────────
log "Capturing current revision for audit..."
mkdir -p "$BACKUP_REV_DIR"
git rev-parse HEAD > "$BACKUP_REV_DIR/$(date +%Y%m%d-%H%M%S)-pre-rollback"
log "  → $BACKUP_REV_DIR/$(ls -t "$BACKUP_REV_DIR" | head -1)"

# ─── 2. Confirm we have a previous revision ─────────────
log "Computing target revision (HEAD~$PREVIOUS_COUNT)..."
TARGET=$(git rev-parse "HEAD~$PREVIOUS_COUNT" 2>/dev/null) \
  || die "No revision HEAD~$PREVIOUS_COUNT — already at root commit?"
log "  current:  $(git rev-parse --short HEAD)"
log "  target:   $(git rev-parse --short "$TARGET")"

# ─── 3. Checkout the previous revision ─────────────────
log "Checking out $TARGET..."
git checkout --quiet "$TARGET"

# ─── 4. Rebuild + restart ───────────────────────────────
log "Rebuilding the backend image from local source..."
# Source installs: backend is built from the local
# checkout (no separate registry), so `docker
# compose build` re-creates the image with the
# previous code.
cd "$INSTALL_DIR/infra/prod"
docker compose build backend
docker compose up -d

# ─── 5. Health check ───────────────────────────────────
log "Waiting 10s for backend to come up..."
sleep 10

HEALTH=$(curl -sk --max-time 10 "http://localhost:3001/api/v1/health" || echo "FAILED")
STATUS=$(echo "$HEALTH" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "PARSE_FAILED")

if [[ "$STATUS" == "ok" ]]; then
  log "Backend reports status=ok. Rollback complete."
  echo
  echo "============================================================"
  echo -e "\033[1;32m✓\033[0m Rollback to $(git rev-parse --short HEAD) successful."
  echo "============================================================"
  echo
  echo "If this was a false alarm, you can re-apply the"
  echo "rolled-back commit with:"
  echo "  cd $INSTALL_DIR"
  echo "  git checkout \$(cat $BACKUP_REV_DIR/$(ls -t $BACKUP_REV_DIR | head -1))"
  echo
  echo "Don't forget to:"
  echo "  - Update any cloud DNS / CDN to point at the"
  echo "    rolled-back commit (if you tag releases)"
  echo "  - Notify users if the rollback changes behaviour"
  echo "  - File a post-mortem: what broke and how do we"
  echo "    catch it next time (alert rule? smoke test?)"
  exit 0
else
  die "Backend health check failed after rollback (status=$STATUS). Try --previous-count=2 to roll back further."
fi