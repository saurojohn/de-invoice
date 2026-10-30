import * as crypto from 'crypto'
import { PrismaService } from '../../prisma/prisma.service'
import { StorageService } from '../storage/storage.service'

/**
 * Tier 741 — the received Belege in the GoBD exports.
 *
 * Both archives promised them and held none. `gobd-archive` looked at
 * Expense.attachmentPath, which nothing has written since Belege became
 * Attachment rows; `gobd-export` left them out on purpose ("not
 * geschäftsrelevant in the same sense"). Measured: an expense with its scanned
 * invoice gave Expenses/<number>.json and no invoice. The archive a tax auditor
 * gets has to hold the Belege (§ 147 Abs. 1 Nr. 4 AO), and a received e-invoice
 * in its original form.
 *
 * What a period holds: the attachments of the expenses, vouchers and invoices
 * dated in it — also those taken off a record (Tier 740), under `entfernt/`,
 * because they stay part of the trail. Each file is read back and its SHA-256
 * compared with the one stored at upload; a file missing or changed is listed
 * in the archive's manifest instead of silently passing.
 */
export interface PeriodBeleg {
  kind: 'expense' | 'voucher' | 'invoice'
  /** path inside the record's folder: <number>/[entfernt/]<id>_<name> */
  relativePath: string
  recordNumber: string
  originalName: string
  mimeType: string
  contentHash: string
  removed: boolean
  buffer: Buffer | null
  /** the bytes are there, but no longer those stored at upload */
  changed: boolean
}

const safe = (s: string) => s.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 120)

export async function belegeInPeriod(
  prisma: PrismaService,
  storage: StorageService,
  companyId: string,
  from: Date,
  to: Date,
): Promise<PeriodBeleg[]> {
  const inPeriod = { gte: from, lte: to }
  const [expenses, vouchers, invoices] = await Promise.all([
    prisma.expense.findMany({ where: { companyId, invoiceDate: inPeriod }, select: { id: true, invoiceNumber: true } }),
    prisma.voucher.findMany({ where: { companyId, date: inPeriod }, select: { id: true, voucherNumber: true } }),
    prisma.invoice.findMany({ where: { companyId, issueDate: inPeriod }, select: { id: true, invoiceNumber: true } }),
  ])
  const records = new Map<string, { kind: PeriodBeleg['kind']; number: string }>()
  for (const e of expenses) records.set(`expense:${e.id}`, { kind: 'expense', number: e.invoiceNumber || e.id.slice(0, 8) })
  for (const v of vouchers) records.set(`voucher:${v.id}`, { kind: 'voucher', number: v.voucherNumber || v.id.slice(0, 8) })
  for (const i of invoices) records.set(`invoice:${i.id}`, { kind: 'invoice', number: i.invoiceNumber || i.id.slice(0, 8) })
  if (records.size === 0) return []
  const ids = [...records.keys()].map((k) => k.split(':')[1])
  const rows = await prisma.attachment.findMany({
    where: { companyId, entityType: { in: ['expense', 'voucher', 'invoice'] }, entityId: { in: ids } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, entityType: true, entityId: true, originalName: true, mimeType: true, storagePath: true, contentHash: true, deletedAt: true },
  })
  const out: PeriodBeleg[] = []
  for (const a of rows) {
    const record = records.get(`${a.entityType}:${a.entityId}`)
    if (!record) continue
    const file = await storage.getFile(a.storagePath).catch(() => null)
    const buffer = file?.buffer ?? null
    const removed = !!a.deletedAt
    out.push({
      kind: record.kind,
      relativePath: `${safe(record.number)}/${removed ? 'entfernt/' : ''}${a.id.slice(0, 8)}_${safe(a.originalName)}`,
      recordNumber: record.number,
      originalName: a.originalName,
      mimeType: a.mimeType,
      contentHash: a.contentHash,
      removed,
      buffer,
      changed: !!buffer && crypto.createHash('sha256').update(buffer).digest('hex') !== a.contentHash,
    })
  }
  return out
}
