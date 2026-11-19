#!/bin/bash
# Tier 876 — the audit log keeps an IP address and a browser 90 days, the entry for good
#
# Every audit row kept the client's IP address and user agent for as long as
# the books (ten years) — sign-ins, failed sign-ins, every change. They are
# personal data and no part of the books. The owner chose (19.11.2026): 90
# days. The nightly session cleanup now clears both from older rows; the rest
# of the row stays, and so does the hash chain (the two are not hashed —
# computeAuditHash).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TAG="e2e-568-$(date +%s%N | cut -c1-13)"
sql() { docker exec "$PG_CONTAINER" psql -U de_invoice -d de_invoice -tA -c "$1" 2>/dev/null; }
reg() { curl -sS -X POST "$API/api/v1/auth/register" -H "Content-Type: application/json" -H "User-Agent: spec-568" -H "X-Forwarded-For: 198.51.100.68" \
  -d "{\"email\":\"$1@example.test\",\"password\":\"Tier876-e2e\",\"companyName\":\"$1 GmbH\"}" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['user']['id'], d['user'].get('companyId') or d['company']['id'])" 2>/dev/null; }
read -r U C < <(reg "$TAG")
read -r U2 C2 < <(reg "$TAG-other")
for i in 1 2; do curl -sS -o /dev/null -X POST "$API/api/v1/auth/login" -H "Content-Type: application/json" -H "User-Agent: spec-568" -H "X-Forwarded-For: 198.51.100.68" \
  -d "{\"email\":\"$TAG@example.test\",\"password\":\"Tier876-e2e\"}"; done
curl -sS -o /dev/null -X POST "$API/api/v1/customers?companyId=$C" -H "x-user-id: $U" -H "x-company-id: $C" -H "Content-Type: application/json" \
  -H "User-Agent: spec-568" -d '{"name":"Kunde 568","type":"business","address":{"street":"Weg 2","city":"Hamburg","postalCode":"20095","country":"DE"}}'
WITH=$(sql "select count(*) from \"AuditLog\" where \"companyId\"='$C' and (\"ipAddress\" is not null or \"userAgent\" is not null)")
[[ "$WITH" -ge 1 ]] && pass "fixture: the company's audit rows carry an address or browser ($WITH)" || fail "fixture: no row with an address"
CHAIN() { curl -sS "$API/api/v1/audit-logs/verify?companyId=$1" -H "x-user-id: $2" -H "x-company-id: $1" | python3 -c "import sys,json;print(json.load(sys.stdin).get('ok'))"; }
assert_eq "fixture: its chain is intact" "$(CHAIN "$C" "$U")" "True"

# the nightly job as it would run 91 days from now — on this company only (a shared database)
run_clear() { (cd "$SCRIPT_DIR/.." && ./node_modules/.bin/ts-node -T -e "
import { PrismaService } from './src/prisma/prisma.service'
import { SessionCleanupScheduler } from './src/auth/session-cleanup.scheduler'
const prisma = new PrismaService()
const job = new SessionCleanupScheduler(prisma as any, {} as any, {} as any)
job.clearOldAuditNetworkData({ now: new Date(Date.now() + $1 * 24 * 3600 * 1000), companyId: '$C' })
  .then((n) => { console.log(n); return prisma.\$disconnect() })
  .then(() => process.exit(0))" 2>&1 | tail -1); }
assert_eq "89 days on: nothing cleared yet" "$(run_clear 89)" "0"
assert_eq "91 days on: every row's address and browser cleared" "$(run_clear 91)" "$WITH"
assert_eq "…none left with either" "$(sql "select count(*) from \"AuditLog\" where \"companyId\"='$C' and (\"ipAddress\" is not null or \"userAgent\" is not null)")" "0"
assert_eq "…the entries themselves are all there" "$(sql "select count(*) >= $WITH from \"AuditLog\" where \"companyId\"='$C'")" "t"
assert_eq "…and the hash chain is still intact (the two are not hashed)" "$(CHAIN "$C" "$U")" "True"
assert_eq "another company's rows: untouched" "$(sql "select count(*) > 0 from \"AuditLog\" where \"companyId\"='$C2' and \"ipAddress\" is not null")" "t"
assert_eq "the nightly job runs it (session cleanup)" \
  "$(grep -c 'const auditNetworkCleared = await this.clearOldAuditNetworkData()' "$SCRIPT_DIR/../src/auth/session-cleanup.scheduler.ts")" "1"
assert_eq "the privacy statement says 90 days (de/en/zh)" \
  "$(grep -c 'IP-Adresse und Browser werden darin nach 90 Tagen entfernt' "$SCRIPT_DIR/../../frontend/messages/de.json")$(grep -c 'removed from it after 90 days' "$SCRIPT_DIR/../../frontend/messages/en.json")$(grep -c '90 天后删除' "$SCRIPT_DIR/../../frontend/messages/zh.json")" "111"
summary
