#!/bin/bash
# Tier 874 — the off-site copy's rclone.conf cannot be committed
#
# HETZNER-DEPLOY.md §9 has the operator write infra/prod/rclone.conf next to
# the compose file: the Storage Box password and the two crypt passphrases
# (Tier 856), only `rclone obscure`d — anyone can reverse that. infra/prod/
# .gitignore kept the .env files out of git, not this one: a `git add -A`
# on the server, and the access to the off-site copy and the keys to read it
# were in the repository.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
ROOT="$SCRIPT_DIR/../.."
for f in infra/prod/rclone.conf infra/prod/rclone.conf.bak infra/prod/.env infra/prod/.env.prod.generated; do
  assert_eq "$f is ignored by git" "$(cd "$ROOT" && git check-ignore -q "$f" && echo ignored || echo tracked-able)" "ignored"
done
assert_eq "no rclone.conf and no .env is in the repository" \
  "$(cd "$ROOT" && git ls-files | grep -c -E '(^|/)rclone\.conf$|(^|/)\.env$')" "0"
summary
