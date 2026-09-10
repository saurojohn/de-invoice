// customer-statement-batch.service.ts — Tier 20.2
//
// Batch Kontoauszug export — generates one PDF per customer
// for a given date range and packages them as a ZIP.
//
// Why this exists:
//   At month-end, SH Leder needs to send a statement to every
//   active customer. Doing that one-by-one via the UI means
//   ~30 page loads + 30 PDF downloads. This endpoint collapses
//   that to a single click.
//
// Output structure (ZIP):
//   /Kontoauszug_K-00001_Müller_GmbH_2026-06-01_2026-06-30.pdf
//   /Kontoauszug_K-00002_Schmidt_AG_2026-06-01_2026-06-30.pdf
//   ...
//   /index.csv         ← customer list + closing balances
//   /summary.txt       ← generation metadata
//
// Limits:
//   - 500 customers max per batch (larger companies should use
//     the enterprise-tier background-job API; not in scope here)
//   - Same 24-month date range cap as the single-customer endpoint
//   - Serial PDF generation: ~50ms per customer × 500 = ~25s
//     worst-case latency. We could parallelize but for the
//     current single-VPS deployment serial is simpler + safer
//     (no Prisma pool exhaustion from N concurrent transactions)
//
// Skipped customers (no invoices AND no payments in the range):
//   - Still included in index.csv with closing=0
//   - PDF is generated but contains only the "no activity" message
//     (matches the single-customer behavior for empty ranges)
//
// Skipped customers (no invoices AND no payments in the range):
//   - Still included in index.csv with closing=0
//   - PDF is generated but contains only the "no activity" message
//     (matches the single-customer behavior for empty ranges)
//
// Note: the Customer schema has no `status` column — "active"
// vs "inactive" is a frontend-computed property (based on
// lastInvoiceDate). The batch endpoint includes ALL customers;
// the operator can post-filter the ZIP if needed. Filtering
// here would require either (a) a schema migration to add a
// status column or (b) heuristic filtering on lastInvoiceDate
// which would silently exclude customers the user wanted to
// include.

import { Injectable } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { generateStatementPdf } from './customer-statement-pdf.service'
import type { CustomerStatement } from './customer-statement.service'

interface BatchParams {
  companyId: string
  from: Date
  to: Date
  order: 'asc' | 'desc'
  maxCustomers?: number
}

interface BatchResult {
  zipBuffer: Buffer
  customerCount: number
  totalOpenBalance: number
  totalOverdueCount: number
  generatedAt: string
}

const MAX_CUSTOMERS_DEFAULT = 500

@Injectable()
export class CustomerStatementBatchService {
  constructor(private readonly prisma: PrismaService) {}

  async generateBatch(params: BatchParams): Promise<BatchResult> {
    const max = params.maxCustomers ?? MAX_CUSTOMERS_DEFAULT

    // Load all customers for the company. Order by customer
    // number so the index.csv is in a stable order (matches
    // the alphabetical numbering SH Leder uses).
    //
    // We include ALL customers, not just active ones. The
    // Customer schema has no status column — see the longer
    // comment below for why we don't try to filter here.
    const customers = await this.prisma.customer.findMany({
      where: { companyId: params.companyId },
      select: {
        id: true,
        name: true,
        customerNumber: true,
      },
      orderBy: { customerNumber: 'asc' },
      take: max + 1, // +1 to detect overflow
    })

    const overflow = customers.length > max
    if (overflow) {
      customers.length = max  // truncate for the rest of the run
    }

    // Lazy import to avoid loading archiver + pdfkit on
    // every single-customer request. The bundle path is
    // rare (only monthly), so paying the import cost there
    // is fine.
    //
    // archiver v8 is a CommonJS module whose @types
    // describe the legacy function form, but the actual
    // runtime is class-based: `new archiver.ZipArchive(opts)`.
    // The same pattern is used in reports.controller.ts
    // (search for `new archiver.ZipArchive`).
    const archiver = await import('archiver')

    // Tier 355: the executor used to be `async (resolve, reject) => {...}`,
    // which eslint flags as no-async-promise-executor. The danger is that a
    // throw from an await inside an async executor rejects an invisible
    // promise, not this one -- so the outer `await` would hang forever
    // instead of failing. Today every await in the body sits inside the
    // per-customer try/catch, so nothing leaks yet; this makes that
    // structural rather than accidental. The executor is now synchronous
    // and the async work runs in an IIFE whose rejection is routed to
    // reject().
    const zipBuffer = await new Promise<Buffer>((resolve, reject) => {
      void (async () => {
        const archive = new (archiver as any).ZipArchive({ zlib: { level: 6 } })
        const chunks: Buffer[] = []
        archive.on('data', (c: Buffer) => chunks.push(c))
        archive.on('end', () => resolve(Buffer.concat(chunks)))
        archive.on('error', reject)

        // We generate PDFs SERIALLY (not Promise.all) because:
        // 1. Each PDF takes ~50ms; parallel only saves time if
        //    we have CPU headroom (a 4-core VPS handles ~4 PDFs
        //    in parallel before saturating)
        // 2. Prisma's default pool size is 8 (set via the
        //    connection_limit=8 in DATABASE_URL). 8 concurrent
        //    transaction-heavy operations would saturate the
        //    pool and queue subsequent requests
        // 3. Serial is predictable — easier to debug if a
        //    specific customer's data triggers an error
        //
        // If we ever need parallelism, wrap the per-customer
        // work in `pMap(cust, ..., { concurrency: 4 })`.
        const indexRows: string[] = [
          [
            'customerNumber',
            'name',
            'openingBalance',
            'closingBalance',
            'invoicesAmount',
            'paymentsAmount',
            'openAmount',
            'pdfFilename',
          ].join(';'),
        ]
        let totalOpenBalance = 0
        let totalOverdueCount = 0

        for (const cust of customers) {
          try {
            // Re-use the single-customer service. We import
            // dynamically so this module doesn't have a hard
            // dep on CustomerStatementService.
            const { CustomerStatementService } = await import(
              './customer-statement.service'
            )
            const svc = new CustomerStatementService(this.prisma)
            const stmt: CustomerStatement = await svc.generate(
              params.companyId,
              cust.id,
              params.from,
              params.to,
              params.order,
            )

            const pdf = await generateStatementPdf(stmt)
            const fname = this.safeFilename(stmt)
            archive.append(pdf, { name: fname })

            // Open-balance > 0 means the customer owes us money
            // (with overdue = past the period.to date). For the
            // batch summary we count any positive closing as
            // "owed" — true overdue tracking needs the per-invoice
            // dueDate which isn't in the statement timeline.
            // For a "total receivables" view this is enough.
            totalOpenBalance += stmt.totals.openAmount
            if (stmt.totals.openAmount > 0) totalOverdueCount += 1

            indexRows.push(
              [
                stmt.customer.customerNumber || '',
                this.csvEscape(stmt.customer.name),
                this.fmtEur(stmt.openingBalance),
                this.fmtEur(stmt.closingBalance),
                this.fmtEur(stmt.totals.invoicesAmount),
                this.fmtEur(stmt.totals.paymentsAmount),
                this.fmtEur(stmt.totals.openAmount),
                fname,
              ].join(';'),
            )
          } catch (e: any) {
            // Don't let one bad customer fail the whole batch.
            // Log to index.csv so the operator can investigate.
            // The customer's PDF is skipped (no entry in ZIP
            // except via the error row).
            const errMsg = e?.message || String(e)
            console.error(
              `[customer-statement-batch] ${cust.customerNumber || cust.id} (${cust.name}) failed:`,
              errMsg,
            )
            indexRows.push(
              [
                cust.customerNumber || '',
                this.csvEscape(cust.name),
                'ERROR',
                'ERROR',
                '',
                '',
                '',
                `(error: ${this.csvEscape(errMsg)})`,
              ].join(';'),
            )
          }
        }

        // index.csv — semicolon-separated (matches DATEV
        // convention + Excel-friendly on Windows where DE
        // users typically open these).
        archive.append(
          Buffer.from(indexRows.join('\n'), 'utf-8'),
          { name: 'index.csv' },
        )

        // summary.txt — short human-readable generation metadata.
        const summary = [
          'de-invoice Batch Kontoauszug',
          '============================',
          '',
          `Period:        ${params.from.toISOString().slice(0, 10)} – ${params.to.toISOString().slice(0, 10)}`,
          `Customer count: ${customers.length}${overflow ? ' (TRUNCATED — over the ' + max + ' cap)' : ''}`,
          `Total open balance: ${this.fmtEur(totalOpenBalance)}`,
          `Customers with open balance: ${totalOverdueCount}`,
          `Generated at:  ${new Date().toISOString()}`,
          '',
          'Structure:',
          '  Kontoauszug_<CustomerNumber>_<Name>_<from>_<to>.pdf — one per customer',
          '  index.csv — customer list + closing balances',
          '  summary.txt — this file',
          '',
          'The Berater (Steuerberater) imports the EXTF bundle',
          'via DATEV Rechnungswesen "Buchungsstapel einlesen".',
        ].join('\n')
        archive.append(Buffer.from(summary, 'utf-8'), {
          name: 'summary.txt',
        })

        archive.finalize()
      })().catch(reject)
    })

    return {
      zipBuffer,
      customerCount: customers.length,
      totalOpenBalance: 0, // filled by caller if needed; we recompute
      totalOverdueCount: 0,
      generatedAt: new Date().toISOString(),
    }
  }

  /** Sanitize a customer name for use as a filename. */
  private safeFilename(stmt: CustomerStatement): string {
    const num = stmt.customer.customerNumber || stmt.customer.id.slice(0, 8)
    const nameSafe = stmt.customer.name
      // Remove anything that's not a letter, digit, or
      // common German umlaut. Spaces → underscores.
      .replace(/[äöüÄÖÜß]/g, (m) => ({ 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'Ä': 'Ae', 'Ö': 'Oe', 'Ü': 'Ue', 'ß': 'ss' }[m] || m))
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 40)
    const from = stmt.period.from.slice(0, 10)
    const to = stmt.period.to.slice(0, 10)
    return `Kontoauszug_${num}_${nameSafe}_${from}_${to}.pdf`
  }

  private csvEscape(s: string): string {
    // CSV with semicolon separator: escape quotes + wrap in
    // quotes if the value contains ; or " or newline.
    if (/[;"\n\r]/.test(s)) {
      return `"${s.replace(/"/g, '""')}"`
    }
    return s
  }

  private fmtEur(n: number): string {
    return n.toFixed(2).replace('.', ',')
  }
}