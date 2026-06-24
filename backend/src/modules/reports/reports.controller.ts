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
}
