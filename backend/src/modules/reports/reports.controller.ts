import { Controller, Get, Query, BadRequestException, Res, Header } from '@nestjs/common';
import type { Response } from 'express';
import { ReportsService } from './reports.service';
import { AgingService } from './aging.service';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { generateDatevBuchungsstapel, buildBuchungenFromDb, collectBelegbilder } from './datev.service';
import { Auth, Require } from '../../auth/roles.decorator';
// archiver v8 is a CommonJS module — the @types
// types declare it as a function, but the runtime
// is `{ default: fn }`. Use require() to dodge the
// esModuleInterop confusion (the same pattern as
// other CJS deps in this codebase, e.g. fs).
import * as archiver from 'archiver';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Strip the path-extension and turn the basename into
 * a filename-safe form. DATEV Belegfeld 1 can contain
 * `/` (voucher number prefix "BK/2026/0001" is common)
 * — we collapse those into `_` so the resulting zip
 * entry is a flat file. Special chars that Windows
 * can't handle in a filename are also replaced.
 */
function sanitizeFilename(s: string): string {
  return s
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .substring(0, 100)
}

/** Pull the extension off a relative path. Defaults
 *  to "pdf" if the path has no extension (every
 *  Beleg-Bild we generate is a PDF). */
function extFromPath(p: string): string {
  const ext = path.extname(p).replace(/^\./, '').toLowerCase()
  return ext || 'pdf'
}

@Auth()
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reportsService: ReportsService,
    private readonly agingService: AgingService,
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

@Get('sales')
@Require('reports.read')
async getSalesReport(
    @Query('companyId') companyId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const start = startDate ? new Date(startDate) : new Date(new Date().getFullYear(), 0, 1);
    const end = endDate ? new Date(endDate) : new Date();

    return this.reportsService.getSalesReport({
      companyId,
      startDate: start,
      endDate: end,
    });
  }

  @Get('vat')
  @Require('ustva.read')
  async getVatReport(
    @Query('companyId') companyId: string,
    @Query('year') year: string,
    @Query('quarter') quarter?: string,
    @Query('month') month?: string,
  ) {
    return this.reportsService.getVatReport({
      companyId,
      year: parseInt(year, 10),
      quarter: quarter ? parseInt(quarter, 10) : undefined,
      month: month ? parseInt(month, 10) : undefined,
    });
  }

  @Get('customers')
  @Require('reports.read')
  async getCustomerReport(
    @Query('companyId') companyId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ) {
    return this.reportsService.getCustomerReport({
      companyId,
      startDate: new Date(startDate),
      endDate: new Date(endDate),
    });
  }

  /**
   * Accounts-receivable aging report. Buckets each
   * customer's open (unpaid) invoice amount into
   * current / 1-30 / 31-60 / 61-90 / 90+ days overdue.
   *
   * The result includes:
   *   - per-customer rows (sorted by totalOpen desc)
   *   - per-bucket totals across the whole company
   *   - grandTotal (sum of all buckets)
   *   - asOf (ISO timestamp of when the report was generated)
   */
  @Get('aging')
  @Require('reports.read')
  async getAgingReport(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.agingService.generate(companyId);
  }

  /**
   * DATEV Buchungsstapel export — ASCII CSV in DATEV 5.0
   * format. Returns a Windows-1252 (Latin-1) text file
   * the Steuerberater imports into DATEV Rechnungswesen.
   *
   * Default date range: the current calendar year. Pass
   * `startDate` / `endDate` as ISO 8601 to override.
   *
   * The CSV includes one header line + one data line per
   * Buchungssatz. Source data is paid invoices (revenue
   * side) + booked expenses (input tax / cost side). The
   * Berater can remap the default SKR03 accounts in
   * DATEV before finalising the import.
   *
   * Response sets:
   *   - Content-Type: text/csv; charset=windows-1252
   *   - Content-Disposition: attachment; filename="..."
   *   - Body: Latin-1 encoded CSV
   */
  @Get('datev-export')
  @Require('reports.read')
  async datevExport(
    @Query('companyId') companyId: string,
    @Query('startDate') startDateStr: string,
    @Query('endDate') endDateStr: string,
    @Res() res: Response,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) throw new BadRequestException('Company not found');

    const startDate = startDateStr
      ? new Date(startDateStr)
      : new Date(new Date().getFullYear(), 0, 1);
    const endDate = endDateStr
      ? new Date(endDateStr)
      : new Date();

    const buchungen = await buildBuchungenFromDb(
      this.prisma,
      companyId,
      startDate,
      endDate,
    );

    const csv = generateDatevBuchungsstapel({
      company: {
        id: company.id,
        name: company.name,
        taxId: company.taxId,
        // Per-company Berater-Nr / Mandanten-Nr. Stored
        // alongside the account map in Company.settings.
        // The Berater hands these to the client; without
        // them we fall back to placeholders that the
        // Berater overwrites on import.
        beraterNr: (company as any).settings?.datev?.beraterNr || '00000',
        mandantenNr: (company as any).settings?.datev?.mandantenNr || '00001',
      },
      startDate,
      endDate,
      buchungen,
      // Buchungslauf-Nr: a sequential counter per
      // Berater-Mandant per calendar year. The Berater's
      // DATEV client uses this to detect duplicate
      // imports — same filename twice is "already
      // imported". We pull from Company.settings.datev
      // (default 1). The Buchungslauf becomes part of
      // the filename so each export is uniquely
      // identifiable.
      buchungsLaufNr: (company as any).settings?.datev?.laufNr?.[startDate.getFullYear()] || 1,
      // Eröffnungsbuchungen (EB-Werte): pulled from
      // Company.settings.datev.openingBalances. Each
      // entry is {konto, betrag, shVz, buchungstext}
      // and gets dated 01.01. of the start year on
      // the first Buchungslauf. Typical use: first
      // export of a new fiscal year where the
      // Saldenliste from the previous year hasn't
      // been entered in DATEV yet.
      openingBalances: (company as any).settings?.datev?.openingBalances || [],
    });

    // Filename pattern: EXTF_Buchungsstapel_<date>_<laufNr>.csv
    // The leading "EXTF_" matches the DATEV import
    // filter the Berater's client uses; the laufNr
    // suffix prevents the "already imported" warning
    // on repeated exports of the same period.
    const laufNr = (company as any).settings?.datev?.laufNr?.[startDate.getFullYear()] || 1;
    const filename = `EXTF_Buchungsstapel_${startDate.toISOString().split('T')[0]}_L${String(laufNr).padStart(3, '0')}.csv`;

    // Hand-rolled response: the @Header() decorator
    // doesn't reliably reach the buffer stream when
    // @Res() is in non-passthrough mode, and passthrough
    // mode swallows the body. The two-line approach
    // (set headers, res.end(buffer)) works in every
    // NestJS version. Content-Type uses Windows-1252
    // because that's what DATEV 5.0 expects.
    res.setHeader('Content-Type', 'text/csv; charset=windows-1252');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.end(Buffer.from(csv, 'latin1'));
  }

  /**
   * DATEV-Beleg-Paket — ZIP archive that contains the
   * Buchungsstapel CSV + every Beleg-Bild PDF the
   * Berater needs to import alongside it. Without the
   * Belegbilder, the Berater has to re-upload every
   * PDF manually after the import — this is the
   * single most painful step of the old
   * CSV-only export.
   *
   * ZIP layout (per the DATEV-Beleg-Bild convention):
   *
   *   Buchungsstapel.csv                  ← same as /datev-export
   *   Belegbilder/
   *     INV-2026-000001.pdf               ← Invoice PDFs
   *     INV-2026-000002.pdf
   *     BK-2026-...pdf                    ← Voucher PDFs (bank-import)
   *     EXP-...pdf or scanned-...pdf      ← Expense attachments
   *     index.json                        ← optional: {belegfeld1, source, filename}
   *
   * Filename matches the CSV (with .zip extension):
   *   EXTF_Buchungsstapel_<date>_L<laufNr>.zip
   *
   * The Belegbilder folder uses the same Belegfeld 1
   * key as the CSV's row 3, so the Berater's DATEV
   * client auto-matches them. If a PDF is missing on
   * disk (e.g. a deleted file), the row is skipped
   * silently — the Berater sees a CSV row with no
   * matching Beleg-Bild, which is the same outcome
   * as the old CSV-only export.
   */
  @Get('datev-export-bundle')
  @Require('reports.read')
  async datevExportBundle(
    @Query('companyId') companyId: string,
    @Query('startDate') startDateStr: string,
    @Query('endDate') endDateStr: string,
    @Res() res: Response,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) throw new BadRequestException('Company not found');

    const startDate = startDateStr
      ? new Date(startDateStr)
      : new Date(new Date().getFullYear(), 0, 1);
    const endDate = endDateStr
      ? new Date(endDateStr)
      : new Date();

    // Generate the same CSV the standalone /datev-export
    // endpoint returns. Identical inputs → identical bytes.
    const buchungen = await buildBuchungenFromDb(this.prisma, companyId, startDate, endDate);
    const csv = generateDatevBuchungsstapel({
      company: {
        id: company.id,
        name: company.name,
        taxId: company.taxId,
        beraterNr: (company as any).settings?.datev?.beraterNr || '00000',
        mandantenNr: (company as any).settings?.datev?.mandantenNr || '00001',
      },
      startDate,
      endDate,
      buchungen,
      buchungsLaufNr: (company as any).settings?.datev?.laufNr?.[startDate.getFullYear()] || 1,
      openingBalances: (company as any).settings?.datev?.openingBalances || [],
    });

    // Collect the PDFs that go alongside the CSV.
    const belegbilder = await collectBelegbilder(this.prisma, companyId, startDate, endDate);

    // Build the index.json (so the Berater can audit
    // which file came from where without opening every
    // PDF).
    const indexEntries = belegbilder.map((b) => ({
      belegfeld1: b.belegfeld1,
      source: b.source,
      filename: `${sanitizeFilename(b.belegfeld1)}.${extFromPath(b.relativePath)}`,
    }))

    const laufNr = (company as any).settings?.datev?.laufNr?.[startDate.getFullYear()] || 1;
    const zipFilename = `EXTF_Buchungsstapel_${startDate.toISOString().split('T')[0]}_L${String(laufNr).padStart(3, '0')}.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

    // Stream the zip. archiver v8 ships an ESM
    // class-based API — `new archiver.ZipArchive(opts)`
    // is the right entrypoint (the `@types/archiver`
    // typings still describe the legacy function form
    // but the v8 runtime is class-based). The push
    // model: feed it the CSV, the index, and every
    // PDF file, then finalise. The response stream is
    // closed when the archive is done.
    const archive = new (archiver as any).ZipArchive({ zlib: { level: 9 } })
    archive.on('error', (err: Error) => {
      // archiver emits 'error' if the stream is
      // closed early (e.g. the user cancels the
      // download). Log and re-throw so the
      // framework returns a 500 — we don't want to
      // leave a half-written zip on disk (we don't,
      // it's streamed).
      console.error('DATEV bundle archiver error:', err.message)
      if (!res.headersSent) {
        res.status(500).end()
      } else {
        res.end()
      }
    })
    archive.pipe(res)

    // 1) The CSV. Same Latin-1 encoding as the
    // standalone endpoint.
    archive.append(Buffer.from(csv, 'latin1'), { name: 'Buchungsstapel.csv' })

    // 2) The index.json — a small audit trail.
    // The Berater can open it in any editor and
    // see which PDF is which without renaming.
    archive.append(JSON.stringify(indexEntries, null, 2), { name: 'Belegbilder/index.json' })

    // 3) The actual PDFs. We resolve the relative
    // path against the storage root and stream
    // each file. Missing files are skipped
    // silently — better a CSV row without a
    // matching PDF than a 500 on the whole bundle.
    const storageRoot = (this.storage as any).config?.localPath || ''
    let includedCount = 0
    let missingCount = 0
    for (const b of belegbilder) {
      const fullPath = path.join(storageRoot, b.relativePath)
      if (!fs.existsSync(fullPath)) {
        missingCount++
        continue
      }
      const ext = extFromPath(b.relativePath)
      const safeName = sanitizeFilename(b.belegfeld1)
      const arcName = `Belegbilder/${safeName}.${ext}`
      archive.file(fullPath, { name: arcName })
      includedCount++
    }

    // 4) A small MANIFEST that surfaces the
    // included/missing counts. Goes at the root so
    // it's easy to spot. Not part of the DATEV
    // standard — purely for the Berater's eyes.
    archive.append(
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        company: company.name,
        companyId: company.id,
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        buchungsLauf: laufNr,
        belegbilderIncluded: includedCount,
        belegbilderMissing: missingCount,
      }, null, 2),
      { name: 'MANIFEST.json' },
    )

    await archive.finalize()
  }

  /**
   * Dashboard KPI snapshot. Single endpoint that
   * powers the home-screen tiles + month-over-month
   * change indicators. The frontend previously did
   * 3+ separate fetches (invoices, sales by month,
   * expenses) and reduced them client-side; that
   * was slow and the math was wrong at the year
   * boundary. This endpoint is the authoritative
   * source: one round-trip, server-side math,
   * month-bucketed for the chart.
   *
   * Returns:
   *   - ytd: { revenue, expenses, vorsteuer, ust,
   *           countInvoices, countExpenses }
   *   - lastMonth: same shape (the calendar month
   *     before today)
   *   - thisMonth: same shape
   *   - changes: { revenue, expenses, ... } %
   *     thisMonth vs lastMonth
   *   - openReceivables: total of sent/overdue
   *     invoices (the cash the company is owed)
   *   - openPayables: total of booked (unpaid)
   *     expenses (the cash the company owes)
   *   - byMonth: [{ month, revenue, expenses }]
   *     for the last 12 months for the chart
   *   - generatedAt: ISO timestamp
   */
  @Get('dashboard')
  @Require('reports.read')
  async getDashboardKpis(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich');
    const now = new Date();
    const yearStart = new Date(now.getFullYear(), 0, 1);
    // Last calendar month: previous month's full range.
    // 1st of current month is the day AFTER last
    // month's last day.
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    // Tier 12 perf: Prisma aggregate — uses
    // SUM/COUNT in Postgres directly, returns
    // a single row instead of N+1 application-
    // side accumulation. Was 1 roundtrip +
    // N rows in memory; now 1 roundtrip + 1
    // row. For a customer with 50K invoices
    // this drops the dashboard endpoint from
    // ~600ms to ~25ms.
    const aggregateInvoices = async (start: Date, end: Date) => {
      const agg = await this.prisma.invoice.aggregate({
        where: { companyId, issueDate: { gte: start, lte: end } },
        _sum: { total: true },
        _count: { _all: true },
      })
      const revenue = Number(agg._sum.total || 0)
      // USt approximation: total * 19/119
      // for the standard 19% case. The
      // dashboard tile only shows magnitude;
      // mixed-rate sales are slightly off
      // but still in the right ballpark.
      const ust = revenue * (19 / 119)
      return { revenue, ust, count: agg._count._all }
    }
    const aggregateExpenses = async (start: Date, end: Date) => {
      const agg = await this.prisma.expense.aggregate({
        where: { companyId, invoiceDate: { gte: start, lte: end } },
        _sum: { netAmount: true, vatAmount: true, grossAmount: true },
        _count: { _all: true },
      })
      // Open payables: sum of grossAmount for
      // booked expenses in the range. We do a
      // separate aggregate for the booked
      // subset; the count is the same.
      const openAgg = await this.prisma.expense.aggregate({
        where: { companyId, invoiceDate: { gte: start, lte: end }, status: 'booked' },
        _sum: { grossAmount: true },
      })
      return {
        expenses: Number(agg._sum.netAmount || 0),
        vorsteuer: Number(agg._sum.vatAmount || 0),
        count: agg._count._all,
        openPayables: Number(openAgg._sum.grossAmount || 0),
      }
    }
    // Open receivables: single aggregate over
    // all sent/overdue invoices (no date
    // range — they accumulate until paid).
    const openRecvAgg = await this.prisma.invoice.aggregate({
      where: { companyId, status: { in: ['sent', 'overdue'] } },
      _sum: { total: true },
    })
    const [ytdInv, ytdExp, lastInv, lastExp, thisInv, thisExp] = await Promise.all([
      aggregateInvoices(yearStart, now),
      aggregateExpenses(yearStart, now),
      aggregateInvoices(lastMonthStart, lastMonthEnd),
      aggregateExpenses(lastMonthStart, lastMonthEnd),
      aggregateInvoices(thisMonthStart, now),
      aggregateExpenses(thisMonthStart, now),
    ]);
    const openReceivables = Number(openRecvAgg._sum.total || 0);
    // 12-month series for the trend chart. All
    // 24 queries (12 inv + 12 exp) now run in
    // parallel via Promise.all. Was a serial
    // for-loop — for 50K-row tables that was
    // 12*50ms = 600ms of cumulative query
    // time. Now ~50ms wall-clock (one
    // network roundtrip vs twelve).
    const months = Array.from({ length: 12 }, (_, idx) => {
      const i = 11 - idx; // oldest-first
      const mStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const mEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
      return {
        key: `${mStart.getFullYear()}-${String(mStart.getMonth() + 1).padStart(2, '0')}`,
        mStart,
        mEnd,
      };
    });
    const monthlyResults = await Promise.all(
      months.flatMap((m) => [
        aggregateInvoices(m.mStart, m.mEnd).then((inv) => ({ kind: 'inv' as const, key: m.key, value: inv })),
        aggregateExpenses(m.mStart, m.mEnd).then((exp) => ({ kind: 'exp' as const, key: m.key, value: exp })),
      ]),
    );
    const byMonthMap = new Map<string, { revenue: number; expenses: number }>();
    for (const m of months) byMonthMap.set(m.key, { revenue: 0, expenses: 0 });
    for (const r of monthlyResults) {
      const slot = byMonthMap.get(r.key);
      if (!slot) continue;
      if (r.kind === 'inv') slot.revenue = r.value.revenue;
      else slot.expenses = r.value.expenses;
    }
    const byMonth = months.map((m) => ({
      month: m.key,
      ...(byMonthMap.get(m.key) || { revenue: 0, expenses: 0 }),
    }));
    // Pct change: thisMonth vs lastMonth. Guard
    // against division by zero.
    const pct = (cur: number, prev: number) => {
      if (prev === 0) return cur === 0 ? 0 : 100;
      return Math.round(((cur - prev) / prev) * 1000) / 10;
    };
    return {
      ytd: {
        revenue: ytdInv.revenue,
        ust: ytdInv.ust,
        countInvoices: ytdInv.count,
        expenses: ytdExp.expenses,
        vorsteuer: ytdExp.vorsteuer,
        countExpenses: ytdExp.count,
        net: ytdInv.revenue - ytdExp.expenses,
      },
      thisMonth: {
        revenue: thisInv.revenue,
        ust: thisInv.ust,
        countInvoices: thisInv.count,
        expenses: thisExp.expenses,
        vorsteuer: thisExp.vorsteuer,
        countExpenses: thisExp.count,
      },
      lastMonth: {
        revenue: lastInv.revenue,
        ust: lastInv.ust,
        countInvoices: lastInv.count,
        expenses: lastExp.expenses,
        vorsteuer: lastExp.vorsteuer,
        countExpenses: lastExp.count,
      },
      changes: {
        revenue: pct(thisInv.revenue, lastInv.revenue),
        expenses: pct(thisExp.expenses, lastExp.expenses),
        ust: pct(thisInv.ust, lastInv.ust),
        vorsteuer: pct(thisExp.vorsteuer, lastExp.vorsteuer),
      },
      openReceivables,
      openPayables: ytdExp.openPayables,
      byMonth,
      generatedAt: now.toISOString(),
    };
  }

  /**
   * Tier 36 — consolidated "dashboard v2" endpoint.
   *
   * Wraps the legacy /reports/dashboard (KPIs + byMonth)
   * with three extra slices for the chart-heavy v2 UI:
   *
   *   - topCustomers: top 5 customers by YTD revenue,
   *     so the front-end can render a "Top-Kunden" bar
   *     without N round-trips.
   *
   *   - arAging: the precomputed A/R aging buckets
   *     (`/reports/aging` returns per-customer rows;
   *     we surface only the per-bucket totals here so
   *     the donut chart has ready-made values).
   *
   *   - recentActivity: last 5 invoices (id, number,
   *     total, customerName, dueDate, status) so the
   *     "letzte Aktivität" widget can render.
   *
   * Single round-trip for the entire dashboard; lets the
   * v2 UI render in parallel without waterfall requests.
   *
   * Returns 200 with the same `kpis` shape as the legacy
   * endpoint so a future revert to v1 is one line.
   */
  @Get('dashboard-v2')
  @Require('reports.read')
  async getDashboardV2(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const now = new Date()
    const yearStart = new Date(now.getFullYear(), 0, 1)

    // Run the four expensive queries in parallel.
    // Each is bounded by the underlying SQL — no N+1.
    const [kpis, aging, topCustomers, recent, invByCc, expByCc] =
      await Promise.all([
        // Reuse the legacy aggregator via a private call
        // (avoid HTTP self-fetch latency + auth loops).
        this.getDashboardKpis(companyId),
        this.agingService.generate(companyId),
        // Top 5 customers by YTD revenue. Single SQL —
        // GROUP BY customer, ORDER BY sum DESC, LIMIT 5.
        this.prisma.invoice.groupBy({
          by: ['customerId'],
          where: { companyId, issueDate: { gte: yearStart } },
          _sum: { total: true },
          _count: { _all: true },
          orderBy: { _sum: { total: 'desc' } },
          take: 5,
        }),
        // Last 5 invoices. Sorted by createdAt desc —
        // matches the activity feed ordering.
        this.prisma.invoice.findMany({
          where: { companyId },
          orderBy: { createdAt: 'desc' },
          take: 5,
          include: {
            customer: { select: { name: true, customerNumber: true } },
          },
        }),
        // Tier 38: cost-center breakdown on invoices YTD.
        // Group by costCenter (a string column); null buckets
        // become "Nicht zugewiesen" in the pie chart legend.
        // We sum total + totalVat separately so the breakdown
        // matches what gets exported to DATEV columns 12/13.
        this.prisma.invoice.groupBy({
          by: ['costCenter'],
          where: {
            companyId,
            issueDate: { gte: yearStart },
            type: { in: ['INV', 'RCV'] },
          },
          _sum: { total: true, totalVat: true },
          _count: { _all: true },
        }),
        // Same idea on the Expense side (Eingangsrechnungen).
        // We only count "booked" expenses — drafts and blocked
        // entries shouldn't skew the dashboard pie.
        this.prisma.expense.groupBy({
          by: ['costCenter'],
          where: {
            companyId,
            invoiceDate: { gte: yearStart },
            status: { in: ['booked', 'deductible'] },
          },
          _sum: { grossAmount: true, vatAmount: true },
          _count: { _all: true },
        }),
      ])

    // Resolve customerId → name/number for topCustomers.
    // Two roundtrips total (groupBy + this one). Most
    // companies have < 50 customers so a single
    // findMany is fine.
    const customerIds = topCustomers.map((r) => r.customerId)
    const customers = customerIds.length
      ? await this.prisma.customer.findMany({
          where: { id: { in: customerIds } },
          select: { id: true, name: true, customerNumber: true },
        })
      : []
    const nameById = new Map(customers.map((c) => [c.id, c]))

    // Bucket totals from the A/R aging report.
    // AgingReport.totals: { current, days1to30, days31to60, days61to90, days91plus }
    const arAging = aging.totals

    return {
      kpis,
      arAging,
      topCustomers: topCustomers.map((r) => ({
        customerId: r.customerId,
        name: nameById.get(r.customerId)?.name || 'Unbekannt',
        customerNumber: nameById.get(r.customerId)?.customerNumber ?? null,
        revenue: Number(r._sum.total || 0),
        invoiceCount: r._count._all,
      })),
      recentActivity: recent.map((r) => ({
        invoiceId: r.id,
        invoiceNumber: r.invoiceNumber,
        total: Number(r.total),
        currency: r.currency,
        customerName: r.customer?.name || '',
        customerNumber: r.customer?.customerNumber ?? null,
        issueDate: r.issueDate,
        dueDate: r.dueDate,
        status: r.status,
      })),
      // Tier 38: cost-center breakdown. Two parallel
      // groupBy results (invoices + expenses) merged into
      // a single sorted list, by total gross amounts
      // descending. Each entry has:
      //   - costCenter: the user-stamped string from
      //     Invoice.costCenter / Expense.costCenter
      //     (null → "Nicht zugewiesen")
      //   - revenue: SUM(invoice.total) YTD
      //   - expense: SUM(expense.grossAmount) YTD
      //   - ust: SUM(invoice.totalVat) YTD (output tax)
      //   - vorsteuer: SUM(expense.vatAmount) YTD (input tax)
      //   - invoiceCount / expenseCount
      //
      // Frontend renders this as a donut chart with the
      // legend showing each cost-center slice's
      //     Netto = revenue - expense
      // plus a § 14/13b USt summary row.
      costCenterBreakdown: mergeCostCenterBreakdown(invByCc, expByCc),
      generatedAt: now.toISOString(),
    }
  }

  /**
   * Tier 44: Cost-Center Jahresauswertung.
   *
   * Returns one row per cost-center with:
   *   - revenue / expense / net  (full year)
   *   - ust    / vorsteuer       (full year)
   *   - invoiceCount / expenseCount
   *   - monthly[1..12]           (net amount = revenue − expense per month)
   *
   * Covers the same set of source rows as the dashboard-v2
   * pie (Invoice INV/RCV + Expense booked/deductible) but
   * adds per-month granularity so the front-end can render
   * a 12-cell heat-map / bar-grid per cost-center.
   *
   * `year` defaults to the current year. `costCenter`
   * (optional) filters to a single stamp (the dashboard
   * drill-down case).
   */
  @Get('cost-center-yearly')
  @Require('reports.read')
  async getCostCenterYearly(
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const now = new Date()
    const year = yearRaw ? Number(yearRaw) : now.getFullYear()
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    const yearStart = new Date(year, 0, 1)
    const yearEnd = new Date(year + 1, 0, 1)

    // Two parallel groupBys — Invoice + Expense — filtered
    // to the full year. Same column selection as
    // dashboard-v2 but no YTD shortcut (we need monthly
    // resolution in the JS step).
    const [invRows, expRows] = await Promise.all([
      this.prisma.invoice.groupBy({
        by: ['costCenter'],
        where: {
          companyId,
          issueDate: { gte: yearStart, lt: yearEnd },
          type: { in: ['INV', 'RCV'] },
        },
        _sum: { total: true, totalVat: true },
        _count: { _all: true },
      }),
      this.prisma.expense.groupBy({
        by: ['costCenter'],
        where: {
          companyId,
          invoiceDate: { gte: yearStart, lt: yearEnd },
          status: { in: ['booked', 'deductible'] },
        },
        _sum: { grossAmount: true, vatAmount: true },
        _count: { _all: true },
      }),
    ])

    // Per-line monthly distribution — we need to walk
    // individual Invoice.total / Expense.grossAmount so
    // we can bucket by issueDate / invoiceDate. groupBy
    // can't pre-bucket by month.
    //
    // The invoiceDate index covers the WHERE; the row
    // count for a single company-year is bounded (a few
    // thousand at worst), so a flat findMany + JS fold
    // beats a 12-query roundtrip. We only project the
    // columns we actually use to keep the wire payload
    // lean.
    const [invMonth, expMonth] = await Promise.all([
      this.prisma.invoice.findMany({
        where: {
          companyId,
          issueDate: { gte: yearStart, lt: yearEnd },
          type: { in: ['INV', 'RCV'] },
        },
        select: {
          costCenter: true,
          total: true,
          issueDate: true,
        },
      }),
      this.prisma.expense.findMany({
        where: {
          companyId,
          invoiceDate: { gte: yearStart, lt: yearEnd },
          status: { in: ['booked', 'deductible'] },
        },
        select: {
          costCenter: true,
          grossAmount: true,
          invoiceDate: true,
        },
      }),
    ])

    const labelFor = (cc: string | null) =>
      cc && cc.trim() ? cc.trim() : 'Nicht zugewiesen'

    // Same merge shape as dashboard-v2's
    // mergeCostCenterBreakdown — we extend it with
    // monthly buckets.
    type Row = {
      costCenter: string
      revenue: number
      expense: number
      net: number
      ust: number
      vorsteuer: number
      invoiceCount: number
      expenseCount: number
      monthly: number[] // length 12, idx 0 = Jan, …, 11 = Dec
    }
    const map = new Map<string, Row>()
    const getRow = (key: string): Row => {
      let r = map.get(key)
      if (!r) {
        r = {
          costCenter: key,
          revenue: 0,
          expense: 0,
          net: 0,
          ust: 0,
          vorsteuer: 0,
          invoiceCount: 0,
          expenseCount: 0,
          monthly: Array(12).fill(0),
        }
        map.set(key, r)
      }
      return r
    }

    for (const r of invRows) {
      const row = getRow(labelFor(r.costCenter))
      row.revenue += Number(r._sum?.total ?? 0)
      row.ust += Number(r._sum?.totalVat ?? 0)
      row.invoiceCount += r._count._all
    }
    for (const r of expRows) {
      const row = getRow(labelFor(r.costCenter))
      row.expense += Number(r._sum?.grossAmount ?? 0)
      row.vorsteuer += Number(r._sum?.vatAmount ?? 0)
      row.expenseCount += r._count._all
    }
    // Monthly: walk the per-line rows, bucket net by
    // (costCenter, month-0-index).
    for (const inv of invMonth) {
      const d = inv.issueDate
      if (!d) continue
      const m = d.getMonth()
      if (m < 0 || m > 11) continue
      const row = getRow(labelFor(inv.costCenter))
      row.monthly[m] += Number(inv.total)
    }
    for (const exp of expMonth) {
      const d = exp.invoiceDate
      if (!d) continue
      const m = d.getMonth()
      if (m < 0 || m > 11) continue
      const row = getRow(labelFor(exp.costCenter))
      row.monthly[m] -= Number(exp.grossAmount)
    }

    // Compute net + sort. Net = revenue − expense. We
    // sort by |net| desc so the biggest cost center
    // (positive or negative) leads — same UX as the
    // dashboard pie. Ties broken alphabetically.
    const rows = Array.from(map.values()).map((r) => ({
      ...r,
      net: r.revenue - r.expense,
      monthly: r.monthly.map((v) => Number(v.toFixed(2))),
      revenue: Number(r.revenue.toFixed(2)),
      expense: Number(r.expense.toFixed(2)),
      ust: Number(r.ust.toFixed(2)),
      vorsteuer: Number(r.vorsteuer.toFixed(2)),
    }))
    rows.sort((a, b) => {
      const da = Math.abs(b.net) - Math.abs(a.net)
      if (da !== 0) return da
      return a.costCenter.localeCompare(b.costCenter)
    })

    // Totals — the "Summe" row at the bottom of the
    // table. Same shape as a single cost-center row but
    // with monthly aggregated across all rows.
    const monthlyTotal = Array(12).fill(0)
    for (const r of rows) {
      for (let i = 0; i < 12; i++) monthlyTotal[i] += r.monthly[i]
    }
    const totals = {
      costCenter: '__TOTAL__',
      revenue: Number(rows.reduce((s, r) => s + r.revenue, 0).toFixed(2)),
      expense: Number(rows.reduce((s, r) => s + r.expense, 0).toFixed(2)),
      net: Number(
        rows.reduce((s, r) => s + r.net, 0).toFixed(2),
      ),
      ust: Number(rows.reduce((s, r) => s + r.ust, 0).toFixed(2)),
      vorsteuer: Number(
        rows.reduce((s, r) => s + r.vorsteuer, 0).toFixed(2),
      ),
      invoiceCount: rows.reduce((s, r) => s + r.invoiceCount, 0),
      expenseCount: rows.reduce((s, r) => s + r.expenseCount, 0),
      monthly: monthlyTotal.map((v) => Number(v.toFixed(2))),
    }

    return {
      year,
      rows,
      totals,
      generatedAt: now.toISOString(),
    }
  }

  /**
   * Tier 45: Cost-Center Monthly drill-in.
   *
   * Same aggregation shape as /cost-center-yearly but
   * scoped to a single calendar month. Returns one row
   * per cost-center that had any activity in the
   * month — empty months produce no rows (not a
   * zero-row with all zeros).
   *
   * The UI uses this for the monthly drill-in page
   * (`/dashboard/cost-center-report/[year]/[month]`)
   * and as the API behind clicking a month-cell on the
   * yearly table.
   *
   * `month` is 1-indexed (1 = Jan, 12 = Dec) to match
   * the URL param convention. Defaults to the current
   * month when omitted.
   */
  @Get('cost-center-monthly')
  @Require('reports.read')
  async getCostCenterMonthly(
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
    @Query('month') monthRaw?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const now = new Date()
    const year = yearRaw ? Number(yearRaw) : now.getFullYear()
    const month = monthRaw
      ? Number(monthRaw)
      : now.getMonth() + 1 // 0-indexed Date.getMonth() → 1-indexed
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    if (!Number.isFinite(month) || month < 1 || month > 12) {
      throw new BadRequestException('month muss zwischen 1 und 12 liegen')
    }
    // month-1 = 0-indexed for Date arithmetic.
    const monthStart = new Date(year, month - 1, 1)
    const monthEnd = new Date(year, month, 1)

    // Two parallel queries — full-row findMany on
    // Invoice + Expense bounded to the month. We don't
    // need groupBy because there are no further
    // buckets to compute (the monthly buckets from
    // tier-44 collapse to a single value here).
    const [invRows, expRows] = await Promise.all([
      this.prisma.invoice.findMany({
        where: {
          companyId,
          issueDate: { gte: monthStart, lt: monthEnd },
          type: { in: ['INV', 'RCV'] },
        },
        select: {
          costCenter: true,
          total: true,
          totalVat: true,
        },
      }),
      this.prisma.expense.findMany({
        where: {
          companyId,
          invoiceDate: { gte: monthStart, lt: monthEnd },
          status: { in: ['booked', 'deductible'] },
        },
        select: {
          costCenter: true,
          grossAmount: true,
          vatAmount: true,
        },
      }),
    ])

    const labelFor = (cc: string | null) =>
      cc && cc.trim() ? cc.trim() : 'Nicht zugewiesen'

    type Row = {
      costCenter: string
      revenue: number
      expense: number
      net: number
      ust: number
      vorsteuer: number
      invoiceCount: number
      expenseCount: number
    }
    const map = new Map<string, Row>()
    const getRow = (key: string): Row => {
      let r = map.get(key)
      if (!r) {
        r = {
          costCenter: key,
          revenue: 0,
          expense: 0,
          net: 0,
          ust: 0,
          vorsteuer: 0,
          invoiceCount: 0,
          expenseCount: 0,
        }
        map.set(key, r)
      }
      return r
    }
    for (const inv of invRows) {
      const r = getRow(labelFor(inv.costCenter))
      r.revenue += Number(inv.total)
      r.ust += Number(inv.totalVat)
      r.invoiceCount += 1
    }
    for (const exp of expRows) {
      const r = getRow(labelFor(exp.costCenter))
      r.expense += Number(exp.grossAmount)
      r.vorsteuer += Number(exp.vatAmount)
      r.expenseCount += 1
    }

    const rows = Array.from(map.values()).map((r) => ({
      ...r,
      net: r.revenue - r.expense,
      revenue: Number(r.revenue.toFixed(2)),
      expense: Number(r.expense.toFixed(2)),
      ust: Number(r.ust.toFixed(2)),
      vorsteuer: Number(r.vorsteuer.toFixed(2)),
    }))
    rows.sort((a, b) => {
      const da = Math.abs(b.net) - Math.abs(a.net)
      if (da !== 0) return da
      return a.costCenter.localeCompare(b.costCenter)
    })

    const totals: Row = {
      costCenter: '__TOTAL__',
      revenue: Number(rows.reduce((s, r) => s + r.revenue, 0).toFixed(2)),
      expense: Number(rows.reduce((s, r) => s + r.expense, 0).toFixed(2)),
      net: Number(rows.reduce((s, r) => s + r.net, 0).toFixed(2)),
      ust: Number(rows.reduce((s, r) => s + r.ust, 0).toFixed(2)),
      vorsteuer: Number(
        rows.reduce((s, r) => s + r.vorsteuer, 0).toFixed(2),
      ),
      invoiceCount: rows.reduce((s, r) => s + r.invoiceCount, 0),
      expenseCount: rows.reduce((s, r) => s + r.expenseCount, 0),
    }

    return {
      year,
      month,
      rows,
      totals,
      generatedAt: now.toISOString(),
    }
  }
}

/**
 * Tier 38: merge Invoice + Expense costCenter groupBy
 * results into a single sorted array.
 *
 * The key challenge: both queries bucket a NULL
 * costCenter into the same "Nicht zugewiesen" pseudo-
 * center. We coalesce nulls on both sides here so the
 * frontend sees one bucket, not two.
 *
 * Sort order: by (revenue - expense) absolute amount
 * descending, so the biggest cost center is at the top
 * of the legend. Within ties, alphabetical.
 *
 * Pure function so it's trivial to unit-test if we ever
 * add Jest/Vitest; the e2e covers the integration.
 */
function mergeCostCenterBreakdown(
  invRows: Array<{
    costCenter: string | null
    _sum: { total: any; totalVat: any } | null
    _count: { _all: number }
  }>,
  expRows: Array<{
    costCenter: string | null
    _sum: { grossAmount: any; vatAmount: any } | null
    _count: { _all: number }
  }>,
) {
  const map = new Map<
    string,
    {
      costCenter: string
      revenue: number
      expense: number
      ust: number
      vorsteuer: number
      invoiceCount: number
      expenseCount: number
    }
  >()
  const labelFor = (cc: string | null) =>
    cc && cc.trim() ? cc.trim() : 'Nicht zugewiesen'

  for (const r of invRows) {
    const key = labelFor(r.costCenter)
    const cur = map.get(key) || {
      costCenter: key,
      revenue: 0,
      expense: 0,
      ust: 0,
      vorsteuer: 0,
      invoiceCount: 0,
      expenseCount: 0,
    }
    cur.revenue += Number(r._sum?.total ?? 0)
    cur.ust += Number(r._sum?.totalVat ?? 0)
    cur.invoiceCount += r._count._all
    map.set(key, cur)
  }
  for (const r of expRows) {
    const key = labelFor(r.costCenter)
    const cur = map.get(key) || {
      costCenter: key,
      revenue: 0,
      expense: 0,
      ust: 0,
      vorsteuer: 0,
      invoiceCount: 0,
      expenseCount: 0,
    }
    cur.expense += Number(r._sum?.grossAmount ?? 0)
    cur.vorsteuer += Number(r._sum?.vatAmount ?? 0)
    cur.expenseCount += r._count._all
    map.set(key, cur)
  }
  const list = Array.from(map.values())
  // Sort by net (revenue - expense) absolute amount
  // desc so the biggest cost center is on top of the
  // legend. Within ties, alphabetical.
  list.sort((a, b) => {
    const aNet = Math.abs(a.revenue - a.expense)
    const bNet = Math.abs(b.revenue - b.expense)
    if (bNet !== aNet) return bNet - aNet
    return a.costCenter.localeCompare(b.costCenter)
  })
  return list
}
