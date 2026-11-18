#!/bin/bash
# Tier 871 — the backup page offers manual backups only where they work
#
# The manual backups (Tier 120: „Backup erstellen“, verify, the restore
# drill of Tier 195) run scripts/backup.sh and `docker exec` against the
# database container. The production image has neither (Tier 558) — its
# database is dumped every hour by the compose file's backup container. The
# page offered the button there anyway: every click failed, and next to the
# green automatic backups stood a red „Letztes Backup: noch nie“.
#
# Now GET /admin/backups says `manualAvailable`; without it the page shows the
# automatic backups and a note, and run / verify / restore-drill answer 409 in
# words. Here and in CI (script and docker CLI present) nothing changes; the
# production image is checked in docker-build.yml.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
OUT=$(cd "$SCRIPT_DIR/.." && ./node_modules/.bin/ts-node -T -e "
import { BackupService } from './src/modules/backup/backup.service'
import { BackupController, MANUAL_UNAVAILABLE_MESSAGE } from './src/modules/backup/backup.controller'
const svc = new BackupService()
const keep = process.env.PATH
process.env.PATH = '/nonexistent'
const without = svc.manualAvailable()
process.env.PATH = keep
console.log('available with docker on PATH: ' + svc.manualAvailable() + ', without: ' + without)
const stub: any = { manualAvailable: () => false, list: async () => [], runBackup: async () => 'ran', verify: async () => 'ran', restoreDrill: async () => 'ran' }
const ctrl = new BackupController(stub, {} as any, {} as any, {} as any)
;(async () => {
  const listed: any = await ctrl.list()
  const answers: string[] = []
  for (const call of [() => ctrl.run(), () => ctrl.verify('x'), () => ctrl.restoreDrill()]) {
    try { answers.push(String(await call())) } catch (e: any) { answers.push(e.getStatus() + (e.message === MANUAL_UNAVAILABLE_MESSAGE ? ' with the note' : ' ' + e.message)) }
  }
  console.log('list says manualAvailable=' + listed.manualAvailable)
  console.log(answers.join(' | '))
})()
" 2>&1)
assert_eq "with the script and a docker CLI: available; without docker on PATH: not" "$(sed -n 1p <<<"$OUT")" "available with docker on PATH: true, without: false"
assert_eq "the list says so" "$(sed -n 2p <<<"$OUT")" "list says manualAvailable=false"
assert_eq "run, verify and the restore drill answer 409 in words (was: a failed run)" "$(sed -n 3p <<<"$OUT")" "409 with the note | 409 with the note | 409 with the note"
assert_eq "the image check asserts the production image has none" \
  "$(grep -c 'new BackupService().manualAvailable()' "$SCRIPT_DIR/../../.github/workflows/docker-build.yml")" "1"
note "=== here, the manual backups still work ==="
login
assert_eq "GET /admin/backups: manualAvailable true here" \
  "$(curl -sS "$API/api/v1/admin/backups" -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" | python3 -c "import sys,json;print(json.load(sys.stdin).get('manualAvailable'))")" "True"
summary
