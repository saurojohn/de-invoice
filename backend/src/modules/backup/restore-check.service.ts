/**
 * Tier 733 — invoices issued after the database dump a restore brought back.
 *
 * Found in the restore drill of 28.10.2026: the database is dumped every hour
 * on the hour, the files of the storage volume are mirrored at :20. An
 * invoice issued at 10:05 is in the 10:20 file mirror (its kept PDF and
 * XRechnung) but not in the 10:00 dump. After a restore of both its number
 * is free again: the next invoice got INV-2026-000004 a second time, while
 * the customer already held the first INV-2026-000004 — two documents with
 * one number (§ 14 Abs. 4 Nr. 4 UStG), and the first one missing from the
 * books.
 *
 * The kept copies are the evidence: `<year>/<month>/pdf/<companyId>/
 * <time>_<number>.pdf` (storage.service.ts, keepIssuedCopy). A number found
 * there that neither an invoice of that company nor its audit log knows (an
 * invoice deleted on its issue day, Tier 477, is in the audit log) is recorded as a
 * RetiredInvoiceNumber (`restore`) — the numbering never hands it out again — and reported:
 * in the log, as an error event (the notification channels), on the backup
 * page. The check runs before the app takes requests (a restore restarts the
 * backend), with every freshness check (hourly) and when the backup page is
 * opened.
 */
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common'
import { promises as fsp } from 'fs'
import * as path from 'path'
import { PrismaService } from '../../prisma/prisma.service'
import { ProductionBackupsService } from './production-backups.service'

/** the name keepIssuedCopy gives a kept copy: the time, then the invoice number */
const KEPT_COPY = /^(\d+)_([A-Z]{1,10}-\d{4}-\d+)\.pdf$/

export interface LostDocument {
  companyId: string
  companyName: string
  invoiceNumber: string
  pdfPath: string
  foundAt: string
}

export interface RestoreCheckResult {
  checkedAt: string
  /** kept copies looked at */
  copies: number
  /** numbers without their invoice, not yet in the books again */
  lost: LostDocument[]
}

@Injectable()
export class RestoreCheckService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RestoreCheckService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly production: ProductionBackupsService,
  ) {}

  /** before the first request: a number must not be handed out twice */
  async onApplicationBootstrap() {
    try {
      const r = await this.check()
      if (r.lost.length) this.logger.error(describeLost(r.lost))
    } catch (err) {
      this.logger.error(`Prüfung der Rechnungskopien fehlgeschlagen: ${(err as Error)?.message}`)
    }
  }

  async check(): Promise<RestoreCheckResult> {
    const { copies, byCompany } = await keptCopies(this.production.storageDir)
    if (byCompany.size) {
      const companies = await this.prisma.company.findMany({ where: { id: { in: [...byCompany.keys()] } }, select: { id: true } })
      for (const { id: companyId } of companies) {
        const numbers = byCompany.get(companyId)!
        const known = await this.prisma.invoice.findMany({
          where: { companyId, invoiceNumber: { in: [...numbers.keys()] } },
          select: { invoiceNumber: true },
        })
        const inBooks = new Set(known.map((i) => i.invoiceNumber))
        const missing = [...numbers.keys()].filter((n) => !inBooks.has(n))
        // A restore takes the invoice's audit rows along with it (one dump).
        // Rows the audit log still knows were removed afterwards — deleted on
        // the issue day (Tier 477, `invoice.deleted`) — and are not lost.
        const audited = missing.length
          ? await this.prisma.$queryRaw<Array<{ o: string | null; n: string | null }>>`
              SELECT "oldData"->>'invoiceNumber' AS o, "newData"->>'invoiceNumber' AS n FROM "AuditLog"
              WHERE "companyId" = ${companyId} AND "entityType" = 'Invoice'
                AND ("oldData"->>'invoiceNumber' = ANY(${missing}) OR "newData"->>'invoiceNumber' = ANY(${missing}))
            `
          : []
        const inAudit = new Set(audited.flatMap((a) => [a.o, a.n]))
        const lost = missing.filter((n) => !inAudit.has(n)).map((invoiceNumber) => ({ companyId, invoiceNumber, pdfPath: numbers.get(invoiceNumber)! }))
        if (lost.length) await this.prisma.retiredInvoiceNumber.createMany({ data: lost.map((l) => ({ ...l, reason: 'restore' })), skipDuplicates: true })
      }
    }
    // an invoice with the number is in the database again
    await this.prisma.$executeRaw`
      UPDATE "RetiredInvoiceNumber" l SET "resolvedAt" = now()
      WHERE l.reason = 'restore' AND l."resolvedAt" IS NULL
        AND EXISTS (SELECT 1 FROM "Invoice" i WHERE i."companyId" = l."companyId" AND i."invoiceNumber" = l."invoiceNumber")
    `
    const open = await this.prisma.retiredInvoiceNumber.findMany({
      where: { reason: 'restore', resolvedAt: null },
      include: { company: { select: { name: true } } },
      orderBy: [{ companyId: 'asc' }, { invoiceNumber: 'asc' }],
    })
    return {
      checkedAt: new Date().toISOString(),
      copies,
      lost: open.map((l) => ({
        companyId: l.companyId,
        companyName: l.company.name,
        invoiceNumber: l.invoiceNumber,
        pdfPath: l.pdfPath ?? '',
        foundAt: l.createdAt.toISOString(),
      })),
    }
  }
}

export function describeLost(lost: LostDocument[]): string {
  const names = lost.slice(0, 10).map((l) => `${l.invoiceNumber} (${l.companyName})`).join(', ')
  return `${lost.length} ausgestellte Rechnung(en) nur als Kopie vorhanden, nicht in der Datenbank — nach der letzten Sicherung ausgestellt? ` +
    `Ihre Nummern werden nicht erneut vergeben; erfassen Sie die Rechnungen wieder: ${names}${lost.length > 10 ? ' …' : ''}`
}

/**
 * Every kept copy under the storage root, per company: number → path
 * (relative). Of two copies of one number the older one — the one that went out.
 */
async function keptCopies(root: string): Promise<{ copies: number; byCompany: Map<string, Map<string, string>> }> {
  const byCompany = new Map<string, Map<string, string>>()
  const oldest = new Map<string, number>()
  let copies = 0
  const dirs = async (d: string, pattern?: RegExp): Promise<string[]> => {
    try {
      const entries = await fsp.readdir(d, { withFileTypes: true })
      return entries.filter((e) => e.isDirectory() && (!pattern || pattern.test(e.name))).map((e) => e.name)
    } catch {
      return []
    }
  }
  for (const year of await dirs(root, /^\d{4}$/)) {
    for (const month of await dirs(path.join(root, year), /^\d{2}$/)) {
      const pdfDir = path.join(root, year, month, 'pdf')
      for (const companyId of await dirs(pdfDir)) {
        let files: string[] = []
        try {
          files = await fsp.readdir(path.join(pdfDir, companyId))
        } catch {
          continue
        }
        for (const file of files) {
          const m = KEPT_COPY.exec(file)
          if (!m) continue
          copies++
          const [, time, number] = m
          const key = `${companyId}\n${number}`
          if (oldest.has(key) && oldest.get(key)! <= Number(time)) continue
          oldest.set(key, Number(time))
          if (!byCompany.has(companyId)) byCompany.set(companyId, new Map())
          byCompany.get(companyId)!.set(number, path.join(year, month, 'pdf', companyId, file))
        }
      }
    }
  }
  return { copies, byCompany }
}
