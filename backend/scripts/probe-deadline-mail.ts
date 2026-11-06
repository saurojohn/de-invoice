/**
 * Tier 806 — drives FilingDeadlineMailService.remindCompany against the real
 * database with a mail transport that refuses one address, for spec 507.
 *
 *   npx ts-node scripts/probe-deadline-mail.ts <companyId>
 *
 * The company's admins and its deadlines are stubbed (two admins, one
 * deadline five days away); the claims, the settings lock and the stored
 * keys are the real ones. Prints one JSON line.
 */
import { PrismaClient } from '@prisma/client'
import { FilingDeadlineMailService } from '../src/modules/reports/filing-deadline-mail.service'

async function main() {
  const companyId = process.argv[2]
  const real = new PrismaClient()
  const admins = [{ user: { email: 'first-admin@example.test' } }, { user: { email: 'second-admin@refuse.example.test' } }]
  const prisma = new Proxy(real, {
    get(t, k) {
      if (k === 'userCompany') return { findMany: async () => admins }
      const v = (t as any)[k]
      return typeof v === 'function' ? v.bind(t) : v
    },
  })
  let due = '2026-12-10'
  const row = () => ({
    kind: 'ustva', year: 2026, month: 10, quarter: null, periodName: 'Oktober 2026', periodEnd: '2026-10-31',
    dueDate: due, daysLeft: 5, status: 'open', noteCode: null, note: null,
  })
  const deadlines = { deadlines: async () => ({ deadlines: [row()] }) }
  let refuse = true
  let delay = 0
  const sends: string[] = []
  const mail = {
    send: async (_c: string, o: { to: string }) => {
      if (delay) await new Promise((r) => setTimeout(r, delay))
      if (refuse && o.to.includes('@refuse.')) throw new Error('550 mailbox unavailable')
      sends.push(o.to.split('@')[0])
      return { messageId: 'probe' }
    },
  }
  const audit = { writeActivity: async () => undefined }
  const svc = new FilingDeadlineMailService(prisma as any, deadlines as any, mail as any, audit as any)
  const run = async () => {
    sends.length = 0
    const r = await svc.remindCompany(companyId)
    return { sent: r.sent, recipients: r.recipients, failed: r.failed ?? 0, skipped: r.skipped ?? null, to: [...sends].sort() }
  }
  const keys = async () => {
    const c = await real.company.findUnique({ where: { id: companyId }, select: { settings: true } })
    return ((c?.settings as any)?.fristErinnerungGesendet ?? []).length
  }

  const out: Record<string, unknown> = {}
  out.firstRun = await run() // the second admin's address is refused
  out.keysAfterFirst = await keys()
  refuse = false
  out.secondRun = await run() // only the second admin, the first is not mailed again
  out.thirdRun = await run() // nothing left
  // two runs at once: each admin once
  await real.company.update({ where: { id: companyId }, data: { settings: {} } })
  delay = 150
  sends.length = 0
  const both = await Promise.all([svc.remindCompany(companyId), svc.remindCompany(companyId)])
  out.concurrent = { mails: sends.length, sentRuns: both.filter((r) => r.sent).length }
  delay = 0
  // the deadline moves a month (Dauerfristverlängerung): reminded again for the new day
  due = '2027-01-11'
  out.moved = await run()
  console.log(JSON.stringify(out))
  await real.$disconnect()
}

main().catch((e) => {
  console.log(JSON.stringify({ error: String(e?.message || e) }))
  process.exit(1)
})
