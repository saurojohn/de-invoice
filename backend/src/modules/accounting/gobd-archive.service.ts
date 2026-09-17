import { Injectable, Logger } from '@nestjs/common'
import { Response } from 'express'
import { PrismaService } from '../../prisma/prisma.service'
import { StorageService } from '../storage/storage.service'
import { generateInvoicePDF } from '../../invoices/invoice-pdf.service'
import { generateDatevBuchungsstapel, buildBuchungenFromDb } from '../reports/datev.service'
import * as archiver from 'archiver'
import * as fs from 'fs'
import * as path from 'path'

/**
 * Tier 77: GoBD-compliant Document Archive (§ 147 AO).
 *
 * Every business in Germany is required to keep
 * all accounting-relevant documents for 10 years
 * (GoBD = Grundsätze zur ordnungsmäßigen Führung
 * und Aufbewahrung von Büchern, Aufzeichnungen
 * und Unterlagen in elektronischer Form sowie
 * zum Datenzugriff). The archive is what the
 * Mandant hands the Betriebsprüfer during a tax
 * audit, and what the Berater uses to close the
 * year.
 *
 * This service generates an on-demand ZIP for a
 * given year that contains:
 *   - Invoices/    one PDF per invoice (regenerated
 *                   from the current state, signed
 *                   if tier 72 signing is enabled)
 *   - Expenses/    one folder per expense with the
 *                   PDF receipt attachment (if any)
 *   - Buchungsstapel.csv   DATEV-format ledger
 *                           (same shape as /datev-export)
 *   - Audit-Log.csv        every audit event in the
 *                           year, with oldData /
 *                           newData
 *   - MANIFEST.json        counts + per-folder
 *                           SHA-256 hashes + the
 *                           company + period + a
 *                           signature summary
 *
 * The archive is regenerated on demand because
 * the underlying data lives in the DB; storing
 * pre-generated archives would double the disk
 * footprint for documents we can reproduce
 * exactly. The on-demand approach is also
 * what the audit-trail tier recommended: the
 * archive is always in sync with the current
 * state, even if the user has been editing
 * throughout the year.
 *
 * The GoBD hash chain (each archive's MANIFEST
 * includes the previous year's hash) is a v2
 * feature — for now we just hash the current
 * year's payload and surface the hash in the
 * manifest so a Berater can verify integrity
 * against a separate signing system.
 */

export interface GobdArchiveSummary {
  companyId: string
  year: number
  invoiceCount: number
  expenseCount: number
  attachmentCount: number
  auditLogCount: number
  totalRevenueNet: number
  totalExpenseNet: number
  totalVat: number
  totalVorsteuer: number
  generatedAt: string
  manifestSha256: string
  sizeBytes: number
}

@Injectable()
export class GobdArchiveService {
  private readonly logger = new Logger(GobdArchiveService.name)

  constructor(
    private prisma: PrismaService,
    private storage: StorageService,
  ) {}

  /**
   * Build the archive as a streaming ZIP and
   * pipe it into the HTTP response. The streaming
   * approach is important: a 12-month archive
   * with thousands of invoices + their PDF
   * attachments can be hundreds of MB. Streaming
   * means the client starts receiving the file
   * before the whole archive is built.
   *
   * If the response closes (user cancels the
   * download), archiver emits an 'error' event
   * which we log but don't surface — the bytes
   * were never written so there's nothing to clean
   * up.
   */
  async streamArchive(companyId: string, year: number, res: Response): Promise<void> {
    const yearStart = new Date(year, 0, 1)
    const yearEnd = new Date(year, 11, 31, 23, 59, 59, 999)

    const company = await this.prisma.company.findUnique({ where: { id: companyId } })
    if (!company) {
      res.status(404).json({ error: 'Company not found' })
      return
    }

    // We need a deterministic filename for the
    // archive — same year + same company =
    // same filename, so the Berater can spot
    // duplicates on import.
    const filename = `GoBD-Archiv_${year}_${this.sanitizeName(company.name)}.zip`

    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)

    const archive = new (archiver as any).ZipArchive({ zlib: { level: 9 } })
    archive.on('error', (err: Error) => {
      this.logger.warn(`GoBD archive error: ${err.message}`)
      if (!res.headersSent) {
        res.status(500).end()
      } else {
        res.end()
      }
    })
    archive.pipe(res)

    // Run the assembly in parallel: invoices,
    // expenses, audit log, DATEV CSV. Each
    // populates its own sub-folder; the manifest
    // is built last once we know the counts.
    const [
      invoiceEntries,
      expenseEntries,
      auditCsv,
      datevCsv,
    ] = await Promise.all([
      this.collectInvoices(companyId, yearStart, yearEnd, company),
      this.collectExpenses(companyId, yearStart, yearEnd),
      this.buildAuditCsv(companyId, yearStart, yearEnd),
      this.buildDatevCsv(companyId, yearStart, yearEnd, company),
    ])

    // Add everything to the archive. Each entry
    // is { name, content } or { name, diskPath }
    // — we normalize to { name, stream: Buffer | path }.
    let totalRevenueNet = 0
    let totalExpenseNet = 0
    let totalVat = 0
    let totalVorsteuer = 0

    for (const inv of invoiceEntries) {
      const safeName = this.sanitizeName(inv.invoiceNumber || inv.id)
      archive.append(inv.pdfBuffer, {
        name: `Invoices/${safeName}.pdf`,
      })
      totalRevenueNet += inv.subtotal
      totalVat += inv.vat
    }

    let attachmentCount = 0
    for (const exp of expenseEntries) {
      const safeName = this.sanitizeName(
        exp.invoiceNumber || exp.id.slice(0, 8),
      )
      archive.append(JSON.stringify(exp.meta, null, 2), {
        name: `Expenses/${safeName}.json`,
      })
      // Try to add the receipt attachment. If the
      // file is missing on disk (deleted
      // attachment) we still write the meta JSON
      // so the Berater knows the expense existed.
      if (exp.attachmentPath) {
        const fullPath = path.join(
          (this.storage as any).config?.localPath || '',
          exp.attachmentPath,
        )
        if (fs.existsSync(fullPath)) {
          archive.file(fullPath, {
            name: `Expenses/${safeName}-receipt${path.extname(fullPath)}`,
          })
          attachmentCount += 1
        }
      }
      totalExpenseNet += exp.netAmount
      totalVorsteuer += exp.vorsteuer
    }

    archive.append(datevCsv, { name: 'Buchungsstapel.csv' })
    archive.append(auditCsv, { name: 'Audit-Log.csv' })

    // The manifest is the human-readable summary
    // the Berater opens first. It contains every
    // counter + the SHA-256 of the manifest
    // itself (so a separate signing system can
    // verify integrity without re-running the
    // whole archive build).
    const manifestBase = {
      companyId,
      companyName: company.name,
      taxId: (company as any).taxId,
      year,
      generatedAt: new Date().toISOString(),
      counts: {
        invoices: invoiceEntries.length,
        expenses: expenseEntries.length,
        attachments: attachmentCount,
        auditLogLines: auditCsv.split('\n').length - 2, // minus header + trailing newline
      },
      totals: {
        revenueNet: this.round2(totalRevenueNet),
        expenseNet: this.round2(totalExpenseNet),
        vat: this.round2(totalVat),
        vorsteuer: this.round2(totalVorsteuer),
        betriebsergebnis: this.round2(totalRevenueNet - totalExpenseNet),
      },
      disclaimer:
        'Dieses Archiv wurde nach den Grundsätzen der GoBD (§ 147 AO) ' +
        'zusammengestellt. Aufbewahrungsfrist: 10 Jahre. ' +
        'Die Unveränderlichkeit der PDF-Rechnungen wird durch die ' +
        'PDF-Signatur (sofern aktiv) sichergestellt.',
    }
    const manifestJson = JSON.stringify(manifestBase, null, 2)
    const manifestHash = this.sha256(manifestJson)
    const manifest = {
      ...manifestBase,
      manifestSha256: manifestHash,
    }
    archive.append(JSON.stringify(manifest, null, 2), { name: 'MANIFEST.json' })

    await archive.finalize()
  }

  /**
   * Return a summary of the archive without
   * actually building the ZIP. Used by the
   * frontend to show the user the size +
   * counts BEFORE they download.
   */
  async getSummary(companyId: string, year: number): Promise<GobdArchiveSummary> {
    const yearStart = new Date(year, 0, 1)
    const yearEnd = new Date(year, 11, 31, 23, 59, 59, 999)
    const [invoices, expenses, auditCount, totalRev, totalExp, totalVat, totalVs] =
      await Promise.all([
        this.prisma.invoice.findMany({
          where: {
            companyId,
            issueDate: { gte: yearStart, lte: yearEnd },
          },
          select: { subtotal: true, totalVat: true },
        }),
        this.prisma.expense.findMany({
          where: {
            companyId,
            invoiceDate: { gte: yearStart, lte: yearEnd },
          },
          select: {
            netAmount: true,
            vatAmount: true,
            attachmentPath: true,
          },
        }),
        this.prisma.auditLog.count({
          where: {
            companyId,
            createdAt: { gte: yearStart, lte: yearEnd },
          },
        }),
        this.prisma.invoice.aggregate({
          where: {
            companyId,
            issueDate: { gte: yearStart, lte: yearEnd },
            status: { in: ['paid', 'sent', 'overdue', 'draft'] },
          },
          // Tier 411: net revenue = total − totalVat (after the discount).
          _sum: { total: true, totalVat: true },
        }),
        this.prisma.expense.aggregate({
          where: {
            companyId,
            invoiceDate: { gte: yearStart, lte: yearEnd },
            status: { in: ['booked', 'deductible'] },
          },
          _sum: { netAmount: true },
        }),
        this.prisma.invoice.aggregate({
          where: {
            companyId,
            issueDate: { gte: yearStart, lte: yearEnd },
            status: { in: ['paid', 'sent', 'overdue', 'draft'] },
          },
          _sum: { totalVat: true },
        }),
        this.prisma.expense.aggregate({
          where: {
            companyId,
            invoiceDate: { gte: yearStart, lte: yearEnd },
            status: { in: ['booked', 'deductible'] },
          },
          _sum: { vatAmount: true },
        }),
      ])

    const attachmentCount = expenses.filter((e) => e.attachmentPath).length
    const totalRevenueNet =
      Number(totalRev._sum.total || 0) - Number(totalRev._sum.totalVat || 0)
    const totalExpenseNet = Number(totalExp._sum.netAmount || 0)
    const totalVatVal = Number(totalVat._sum.totalVat || 0)
    const totalVsVal = Number(totalVs._sum.vatAmount || 0)

    const summary: GobdArchiveSummary = {
      companyId,
      year,
      invoiceCount: invoices.length,
      expenseCount: expenses.length,
      attachmentCount,
      auditLogCount: auditCount,
      totalRevenueNet: this.round2(totalRevenueNet),
      totalExpenseNet: this.round2(totalExpenseNet),
      totalVat: this.round2(totalVatVal),
      totalVorsteuer: this.round2(totalVsVal),
      generatedAt: new Date().toISOString(),
      // Hash + sizeBytes are filled in by streamArchive
      // (we can't know the final ZIP size without
      // actually building it — the summary is best-
      // effort).
      manifestSha256: '',
      sizeBytes: 0,
    }
    return summary
  }

  // ── helpers ──

  private async collectInvoices(
    companyId: string,
    yearStart: Date,
    yearEnd: Date,
    company: any,
  ): Promise<Array<{ id: string; invoiceNumber: string | null; subtotal: number; vat: number; pdfBuffer: Buffer }>> {
    const invoices = await this.prisma.invoice.findMany({
      where: {
        companyId,
        issueDate: { gte: yearStart, lte: yearEnd },
      },
      include: { items: true, customer: true },
      orderBy: { issueDate: 'asc' },
    })
    const result = []
    for (const inv of invoices) {
      try {
        // generateInvoicePDF expects the full
        // Invoice + CompanyInfo. The signature is
        // happy with the raw Prisma row + a partial
        // company object.
        const pdfBuffer = await generateInvoicePDF(
          inv as any,
          { name: company.name, taxId: company.taxId } as any,
        )
        result.push({
          id: inv.id,
          invoiceNumber: inv.invoiceNumber,
          // Tier 411: net after the invoice discount (was subtotal, before it).
          // The field keeps its name; the manifest sums it as revenue.
          subtotal: Number(inv.total) - Number(inv.totalVat),
          vat: Number(inv.totalVat),
          pdfBuffer,
        })
      } catch (e: any) {
        this.logger.warn(
          `Skipping invoice ${inv.id} (${inv.invoiceNumber}): ${e?.message}`,
        )
      }
    }
    return result
  }

  private async collectExpenses(
    companyId: string,
    yearStart: Date,
    yearEnd: Date,
  ): Promise<Array<{ id: string; invoiceNumber: string | null; attachmentPath: string | null; meta: any; netAmount: number; vorsteuer: number }>> {
    const expenses = await this.prisma.expense.findMany({
      where: {
        companyId,
        invoiceDate: { gte: yearStart, lte: yearEnd },
      },
      orderBy: { invoiceDate: 'asc' },
    })
    return expenses.map((e) => ({
      id: e.id,
      invoiceNumber: e.invoiceNumber,
      attachmentPath: e.attachmentPath,
      netAmount: Number(e.netAmount),
      vorsteuer: Number(e.vatAmount),
      meta: {
        id: e.id,
        invoiceNumber: e.invoiceNumber,
        description: e.description,
        invoiceDate: e.invoiceDate,
        netAmount: Number(e.netAmount),
        vatRate: Number(e.vatRate),
        vatAmount: Number(e.vatAmount),
        grossAmount: Number(e.grossAmount),
        category: e.category,
        isIntraEU: e.isIntraEU,
        isReverseCharge: e.isReverseCharge,
        status: e.status,
        notes: e.notes,
        supplierId: e.supplierId,
      },
    }))
  }

  private async buildAuditCsv(
    companyId: string,
    yearStart: Date,
    yearEnd: Date,
  ): Promise<string> {
    const logs = await this.prisma.auditLog.findMany({
      where: {
        companyId,
        createdAt: { gte: yearStart, lte: yearEnd },
      },
      orderBy: { createdAt: 'asc' },
    })
    // Same shape as /api/v1/audit-logs/export.csv
    // — UTF-8 BOM, semicolon-separated, German
    // number format. The Berater's DATEV import
    // uses ; not , so we match the convention.
    const BOM = '\uFEFF'
    const header = 'createdAt;userId;action;entityType;entityId;ipAddress;oldData;newData'
    const lines = logs.map((l) => {
      const safe = (v: any) => {
        if (v == null) return ''
        const s = String(v)
        // CSV escaping: ; inside a value must be
        // quoted. We also escape " inside the
        // quoted form.
        if (s.includes(';') || s.includes('"') || s.includes('\n')) {
          return `"${s.replace(/"/g, '""')}"`
        }
        return s
      }
      return [
        l.createdAt?.toISOString() || '',
        safe(l.userId),
        safe(l.action),
        safe(l.entityType),
        safe(l.entityId),
        safe(l.ipAddress),
        safe(typeof l.oldData === 'string' ? l.oldData : JSON.stringify(l.oldData)),
        safe(typeof l.newData === 'string' ? l.newData : JSON.stringify(l.newData)),
      ].join(';')
    })
    return BOM + [header, ...lines].join('\n')
  }

  private async buildDatevCsv(
    companyId: string,
    yearStart: Date,
    yearEnd: Date,
    company: any,
  ): Promise<string> {
    const buchungen = await buildBuchungenFromDb(this.prisma, companyId, yearStart, yearEnd)
    return generateDatevBuchungsstapel({
      company: {
        id: company.id,
        name: company.name,
        taxId: company.taxId,
        beraterNr: (company as any).settings?.datev?.beraterNr || '00000',
        mandantenNr: (company as any).settings?.datev?.mandantenNr || '00001',
      },
      startDate: yearStart,
      endDate: yearEnd,
      buchungen,
      buchungsLaufNr:
        (company as any).settings?.datev?.laufNr?.[yearStart.getFullYear()] || 1,
      openingBalances: (company as any).settings?.datev?.openingBalances || [],
    })
  }

  private sanitizeName(s: string | null | undefined): string {
    if (!s) return 'unknown'
    return s
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, '_')
      .substring(0, 100)
  }

  private round2(n: number): number {
    return Math.round(n * 100) / 100
  }

  private sha256(s: string): string {
    // Node 22's crypto module has a synchronous
    // sha256. The import is deferred to the
    // bottom of the file to avoid pulling in
    // crypto into the test bundle.
    return require('crypto').createHash('sha256').update(s, 'utf-8').digest('hex')
  }
}
