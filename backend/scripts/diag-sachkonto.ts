// One-shot diagnostic — what does the inference
// actually do against the SH Leder test company?
// Run: npx ts-node --transpile-only scripts/diag-sachkonto.ts
import { PrismaClient } from '@prisma/client'
import { applyExpenseInference } from '../src/modules/reports/datev-sachkonto-inference'

const prisma = new PrismaClient()

async function main() {
  // Cleanup any leftover fixtures
  const orphans = await prisma.voucher.findMany({ where: { voucherNumber: { startsWith: 'TEST-' } } })
  for (const o of orphans) await prisma.voucher.delete({ where: { id: o.id } })

  // Create a fresh voucher
  const voucher = await prisma.voucher.create({
    data: {
      companyId: 'ad257ec3-d319-479b-b870-3fe76e8f3111',
      date: new Date(),
      description: 'TEST-FIXTURE',
      status: 'draft',
      voucherNumber: `TEST-${Date.now()}`,
    },
  })
  const line = await prisma.voucherLine.create({
    data: {
      voucherId: voucher.id,
      description: 'TEST-LINE',
      debit: 100,
      credit: 0,
      sortOrder: 0,
    },
  })
  console.log('Created line:', line.id, 'accountId:', line.accountId)
  const result = await applyExpenseInference(prisma, line.id, 'Adobe Creative Cloud')
  console.log('Inference result:', result)
  const after = await prisma.voucherLine.findUnique({
    where: { id: line.id },
    include: { account: true },
  })
  console.log('After — accountId:', after?.accountId, 'accountNumber:', (after as any)?.account?.accountNumber)
  await prisma.voucher.delete({ where: { id: voucher.id } })
  await prisma.$disconnect()
}

main().catch((e) => { console.error('ERROR:', e); process.exit(1) })