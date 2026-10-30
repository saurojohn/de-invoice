#!/bin/bash
# Tier 749b — the day is Germany's, also in the hour after midnight
#
# CI run 41140816615 ran at 00:18 on 31.10. in Germany and 23:18 on 30.10. in
# UTC. An auditor's access "to 30.10." was accepted as not yet past, and the
# note of an e-invoice checked on the 31st said the 30th. The other places
# that cut a date out of an instant had the same fault:
#   - the last day of an auditor's access ended at 23:59:59.999Z, in summer
#     at 01:59 of the next day in Germany;
#   - the retention of a company closed in the first hour of a year began a
#     year too early;
#   - the Verfahrensdokumentation and the index.xml carried the UTC day.
# The bounds of a period in the index.xml are UTC by construction: its
# 31.12. 23:59:59.999Z stays the 31st.
#
# The instants are given to the code, so this does not depend on when it runs.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"; rm -f "$SCRIPT_DIR/../.tier749b-probe.ts"' EXIT

cat > "$SCRIPT_DIR/../.tier749b-probe.ts" <<'TS'
import { auditorAccessUntil } from './src/modules/users/users.service'
import { retentionUntilFor } from './src/modules/auth/account.service'
import { noteFor } from './src/modules/expense/e-invoice/e-invoice-import.service'
import { VerfahrensdokuService } from './src/modules/accounting/verfahrensdoku.service'
import { z3IndexXml, z3Csv } from './src/modules/gobd-export/z3-dataset'
const MIDNIGHT = new Date('2026-10-30T23:18:00.000Z') // 00:18 on the 31st in Germany
const access = (day: string, now: Date) => {
  try { return auditorAccessUntil(day, now).toISOString() } catch (e: any) { return `refused: ${e.message}` }
}
const inv: any = { syntax: 'ubl', profile: 'EN 16931', totals: {}, payment: {}, skonto: [] }
const note = (check: any) => noteFor(inv, { source: 'xml' } as any, undefined, check)
const prisma: any = {
  company: { findUnique: async () => ({ id: 'c', name: 'Probe GmbH', address: {} }) },
  userCompany: { groupBy: async () => [] },
  mailConfig: { findUnique: async () => null },
  cashBookEntry: { count: async () => 0 },
  voucher: { count: async () => 0 },
  asset: { count: async () => 0 },
}
const table: any = { file: 't.csv', name: 'T', description: 'T', keys: [], columns: [{ name: 'Tag', description: 'Tag', type: 'date' }], rows: [[new Date('2025-12-31T00:00:00.000Z')]] }
;(async () => {
  const doc = await new VerfahrensdokuService(prisma).markdown('c', MIDNIGHT)
  const xml = z3IndexXml({
    supplierName: 'Probe GmbH', supplierLocation: 'Berlin', period: '2025', tables: [table],
    from: new Date('2025-01-01T00:00:00.000Z'), to: new Date('2025-12-31T23:59:59.999Z'), generatedAt: MIDNIGHT,
  } as any)
  const out: Array<[string, string]> = [
    ['past', access('2026-10-30', MIDNIGHT)],
    ['today', access('2026-10-31', MIDNIGHT)],
    ['summer', access('2026-06-30', new Date('2026-06-01T10:00:00.000Z'))],
    ['bad', access('2026-02-30', MIDNIGHT)],
    ['far', access('2028-01-01', MIDNIGHT)],
    ['note', note({ at: MIDNIGHT.toISOString(), checked: true, valid: true, errors: [] })],
    ['retention', retentionUntilFor(new Date('2026-12-31T23:30:00.000Z')).toISOString().slice(0, 10)],
    ['docStand', /\| Angabe \| Stand ([\d.]+) \|/.exec(doc)?.[1] ?? 'none'],
    ['xmlMade', /erstellt am ([\d.]+)/.exec(xml)?.[1] ?? 'none'],
    ['xmlRange', /<From>([\d.]+)<\/From><To>([\d.]+)<\/To>/.exec(xml)?.slice(1).join('-') ?? 'none'],
    ['csvDay', z3Csv(table).toString().trim()],
  ]
  for (const [k, v] of out) console.log(`${k}=${v}`)
})()
TS
( cd "$SCRIPT_DIR/.." && npx ts-node -T .tier749b-probe.ts > "$TMP/probe.txt" 2>&1 )
P() { grep "^$1=" "$TMP/probe.txt" | head -1 | cut -d= -f2-; }
assert_eq "at 00:18 on 31.10.: an access to 30.10. is past" "$(P past)" "refused: Das Enddatum des Prüferzugangs liegt in der Vergangenheit."
assert_eq "…one to 31.10. runs to the end of the German day" "$(P today)" "2026-10-31T22:59:59.999Z"
assert_eq "in summer too, not to 01:59 of the next day" "$(P summer)" "2026-06-30T21:59:59.999Z"
assert_eq "a day that does not exist" "$(P bad)" "refused: Für einen Prüferzugang ist ein Enddatum erforderlich (accessUntil, JJJJ-MM-TT)."
assert_eq "more than a year ahead: refused" "$(P far | cut -c1-8)" "refused:"
assert_eq "the note of an e-invoice checked then says the 31st" "$(P note | grep -o 'geprüft am [0-9.]*')" "geprüft am 31.10.2026"
assert_eq "closed at 00:30 on 01.01.2027: ten years from the end of 2027" "$(P retention)" "2037-12-31"
assert_eq "the Verfahrensdokumentation is dated the 31st" "$(P docStand)" "31.10.2026"
assert_eq "the index.xml was made on the 31st" "$(P xmlMade)" "31.10.2026"
assert_eq "…its period stays 01.01.–31.12., not 01.01. of the next year" "$(P xmlRange)" "01.01.2025-31.12.2025"
assert_eq "a date of the books stays its day" "$(P csvDay)" "31.12.2025"
summary
