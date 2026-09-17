#!/usr/bin/env ts-node
/**
 * Tier 406 — prove that writes inside an interactive transaction are audited
 * exactly when they commit.
 *
 * Runs the same wiring PrismaService uses (the audit extension plus
 * runWithBufferedAudit) against DATABASE_URL, and prints one JSON line:
 *
 *   committedRows   audit rows for a customer created in a committed tx   (want 1)
 *   rolledBackRow   whether the rolled-back customer exists              (want 0)
 *   rolledBackRows  audit rows for that rolled-back customer             (want 0)
 *   nestedRows      audit rows for a write in a nested tx that committed (want 1)
 *
 * Without buffering, the rolled-back write still left an audit row (measured:
 * row gone, audit row present) because the extension writes on its own
 * connection. That is what this guards.
 *
 * Usage: DATABASE_URL=… npx ts-node scripts/probe-audit-transactions.ts
 */
import { PrismaClient } from '@prisma/client'
import { runWithBufferedAudit, withAuditLog } from '../src/prisma/audit-log.extension'

async function main() {
  const base = new PrismaClient()
  const ext = withAuditLog(base) as any
  const tx = (fn: (t: any) => Promise<unknown>) =>
    runWithBufferedAudit(() => ext.$transaction(fn))

  const company = await base.company.findFirst({ select: { id: true } })
  if (!company) throw new Error('no company in the database')
  const tag = `probe-406-${Date.now()}`
  const data = (suffix: string) => ({
    companyId: company.id,
    name: `${tag} ${suffix}`,
    type: 'business',
    address: {},
  })

  const committed: any = await tx((t) => t.customer.create({ data: data('commit') }))

  let rolledBackId = ''
  await tx(async (t) => {
    const c = await t.customer.create({ data: data('rollback') })
    rolledBackId = c.id
    throw new Error('deliberate rollback')
  }).catch(() => undefined)

  let nestedId = ''
  await tx(async (t) => {
    await tx(async () => {
      const c = await t.customer.create({ data: data('nested') })
      nestedId = c.id
    })
  })

  const count = (entityId: string) => base.auditLog.count({ where: { entityId } })
  const result = {
    committedRows: await count(committed.id),
    rolledBackRow: await base.customer.count({ where: { id: rolledBackId } }),
    rolledBackRows: await count(rolledBackId),
    nestedRows: await count(nestedId),
  }
  console.log(JSON.stringify(result))
  // The probe's customers are left in place, tagged, like every spec's
  // fixtures — it may be pointed at any DATABASE_URL, so it deletes nothing.
  await base.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
