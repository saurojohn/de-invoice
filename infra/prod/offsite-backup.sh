#!/bin/sh
# ──────────────────────────────────────────────────────────
# de-invoice: the off-site copy (compose service `offsite-backup`, profile
# `offsite`; runs in the rclone image's sh). Every INTERVAL_SECONDS the
# database dumps (/backups) and the file mirror (/data/backup-files) go to
# $REMOTE — a Hetzner Storage Box or any rclone remote (HETZNER-DEPLOY.md §9).
#
# Tier 733c. The dumps were `rclone sync`ed: the remote made equal to this
# server. On a new server after a loss — its own empty database dumped within
# the hour — the first pass deleted every dump off-site, the archive a restore
# needs. Measured with this image against a local remote: 8 dumps of the old
# server, then one pass of a new one, 4 left — its empty ones. Now nothing
# off-site is deleted or overwritten because of what is, or is not, here:
#
#   - the dumps are copied with --ignore-existing: a file that is there stays
#     as it is. Every hourly dump has a name of its own; the daily, weekly and
#     monthly files keep off-site the first dump of their day, week, month.
#   - off-site they are removed by age only — as the backup container keeps
#     them here, with a margin: hourly 3 days, daily 35 days, weekly 13
#     weeks, monthly 121 months (OFFSITE_KEEP_* to change).
#   - the files are only ever added (as before).
#
# Tier 856. The remote must be an rclone `crypt` remote: the dumps hold every
# invoice, customer, IBAN and user of the installation, the files every kept
# invoice and receipt. A plain remote (the Storage Box itself) kept them there
# as they are here — whoever reads the box (a leaked Storage Box password, the
# provider) read the books. The script refuses any other remote; crypt
# encrypts content and names before they leave the server. Its password is
# in rclone.conf: keep a copy apart from the server (password manager) — a
# restore from the box needs it (HETZNER-DEPLOY.md §9).
#
# ONCE=1: one pass, its result as the exit code (used by e2e specs 453, 549).
# ──────────────────────────────────────────────────────────
set -u

if [ -z "${REMOTE:-}" ]; then
  echo "offsite: BACKUP_OFFSITE_REMOTE is not set in .env — nothing is copied"
  exit 1
fi

NAME=${REMOTE%%:*}
TYPE=$(rclone listremotes --long 2>/dev/null | awk -v n="$NAME:" '$1 == n { print $2; exit }')
if [ "$TYPE" != "crypt" ]; then
  echo "offsite: BACKUP_OFFSITE_REMOTE=$REMOTE is no crypt remote (type: ${TYPE:-not in rclone.conf}) — nothing is copied."
  echo "offsite: the dumps and files would lie there unencrypted. Wrap the storage in a crypt remote (HETZNER-DEPLOY.md §9) and set BACKUP_OFFSITE_REMOTE to it."
  exit 1
fi

pass() {
  rclone copy /backups "$REMOTE/db" --ignore-existing --skip-links --create-empty-src-dirs \
    && rclone delete "$REMOTE/db/last" --min-age "${OFFSITE_KEEP_LAST:-3d}" \
    && rclone delete "$REMOTE/db/daily" --min-age "${OFFSITE_KEEP_DAILY:-35d}" \
    && rclone delete "$REMOTE/db/weekly" --min-age "${OFFSITE_KEEP_WEEKLY:-13w}" \
    && rclone delete "$REMOTE/db/monthly" --min-age "${OFFSITE_KEEP_MONTHLY:-121M}" \
    && rclone copy /data/backup-files "$REMOTE/files"
}

while true; do
  date -u +"%Y-%m-%dT%H:%M:%SZ offsite: start"
  if pass; then
    date -u +"%Y-%m-%dT%H:%M:%SZ offsite: ok"
    [ "${ONCE:-}" = "1" ] && exit 0
  else
    date -u +"%Y-%m-%dT%H:%M:%SZ offsite: FAILED"
    [ "${ONCE:-}" = "1" ] && exit 1
  fi
  sleep "${INTERVAL_SECONDS:-3600}"
done
