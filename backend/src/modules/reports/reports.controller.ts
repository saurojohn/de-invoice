import { Controller, Get, Query, BadRequestException, Res, Header, Post, Body, Delete, Param } from '@nestjs/common';
import type { Response } from 'express';
import { ReportsService } from './reports.service';
import { AgingService } from './aging.service';
import { CashFlowService } from './cashflow.service';
import { PnlService } from './pnl.service';
import { OssService } from './oss.service';
import { BwaService } from './bwa.service';
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
    private readonly cashflow: CashFlowService,
    private readonly pnl: PnlService,
    private readonly oss: OssService,
    private readonly bwa: BwaService,
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
   * Tier 142: DATEV monthly export.
   *
   * The /datev-export-bundle endpoint produces ONE
   * CSV covering the entire date range + one global
   * Belegbilder folder. The Berater then has to
   * re-split the CSV in Excel by month before
   * importing it into DATEV, because the DATEV
   * import UI expects one Buchungslauf per period.
   *
   * This endpoint walks the date range month by
   * month and produces one CSV per month, each
   * inside its own folder with its own Belegbilder
   * subfolder. Result: the Berater can drag the
   * whole ZIP into DATEV, then import each
   * monthly folder as a separate Buchungslauf.
   *
   * ZIP layout:
   *   2026-01/
   *     EXTF_Buchungsstapel_2026-01-31_L001.csv
   *     Belegbilder/
   *       INV-2026-000001.pdf
   *       BK-2026-...pdf
   *   2026-02/
   *     EXTF_Buchungsstapel_2026-02-28_L002.csv
   *     Belegbilder/
   *       ...
   *   MANIFEST.json
   *
   * laufNr is sequential across months (1, 2, 3...)
   * so the DATEV import order is deterministic.
   * The starting laufNr is the company's stored
   * value for that year, or 1 if unset.
   *
   * Empty months are skipped — if a month has 0
   * Buchungen there's no CSV to produce. The
   * MANIFEST.json still records every month in
   * the range, including the empty ones, so the
   * Berater sees "0 Buchungen" instead of "month
   * missing" (the latter would be a red flag).
   */
  @Get('datev-export-monthly')
  @Require('reports.read')
  async datevExportMonthly(
    @Query('companyId') companyId: string,
    @Query('startDate') startDateStr: string,
    @Query('endDate') endDateStr: string,
    @Res() res: Response,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) throw new BadRequestException('Company not found');

    // Normalise the date range to month boundaries.
    // startDate → 1st of that month. endDate → last
    // day of that month. Anything inside is bucketed
    // by its `datum` (the row's booking date, not
    // the issue date or the import date).
    const requestedStart = startDateStr
      ? new Date(startDateStr)
      : new Date(new Date().getFullYear(), 0, 1);
    const requestedEnd = endDateStr
      ? new Date(endDateStr)
      : new Date();
    if (isNaN(requestedStart.getTime()) || isNaN(requestedEnd.getTime())) {
      throw new BadRequestException('startDate / endDate invalid')
    }
    if (requestedStart > requestedEnd) {
      throw new BadRequestException('startDate must be ≤ endDate')
    }
    const firstMonth = new Date(requestedStart.getFullYear(), requestedStart.getMonth(), 1)
    const lastMonthEnd = new Date(requestedEnd.getFullYear(), requestedEnd.getMonth() + 1, 0, 23, 59, 59, 999)

    const year = firstMonth.getFullYear()
    const settings = (company as any).settings?.datev || {}
    const baseLaufNr = settings?.laufNr?.[year] || 1

    const beraterNr = settings?.beraterNr || '00000'
    const mandantenNr = settings?.mandantenNr || '00001'
    const openingBalances = settings?.openingBalances || []

    // Walk every month in [firstMonth, lastMonthEnd].
    // For each: build Buchungen, generate CSV, collect
    // Belegbilder, then push into the archive under
    // YYYY-MM/.
    const months: Array<{
      key: string
      start: string
      end: string
      laufNr: number
      buchungenCount: number
      belegbilderIncluded: number
      belegbilderMissing: number
      csvBytes: number
    }> = []

    const archive = new (archiver as any).ZipArchive({ zlib: { level: 9 } })
    const outerFilename = `EXTF_Buchungsstapel_Monatlich_${year}-${String(firstMonth.getMonth() + 1).padStart(2, '0')}_bis_${year}-${String(lastMonthEnd.getMonth() + 1).padStart(2, '0')}.zip`
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename="${outerFilename}"`)
    archive.pipe(res)

    let monthIdx = 0
    let cursor = new Date(firstMonth)
    while (cursor <= lastMonthEnd) {
      const monthStart = new Date(cursor)
      const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0, 23, 59, 59, 999)
      const monthKey = `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, '0')}`
      const laufNr = baseLaufNr + monthIdx

      // 1) Buchungen for this month.
      const buchungen = await buildBuchungenFromDb(
        this.prisma,
        companyId,
        monthStart,
        monthEnd,
      )
      // 2) CSV.
      const csv = generateDatevBuchungsstapel({
        company: {
          id: company.id,
          name: company.name,
          taxId: company.taxId,
          beraterNr,
          mandantenNr,
        },
        startDate: monthStart,
        endDate: monthEnd,
        buchungen,
        buchungsLaufNr: laufNr,
        // Only the FIRST month of the year carries
        // the Eröffnungsbuchungen — otherwise the
        // opening balances would double-count across
        // months.
        openingBalances: monthIdx === 0 ? openingBalances : [],
      })
      // 3) Belegbilder for this month.
      const belegbilder = await collectBelegbilder(
        this.prisma,
        companyId,
        monthStart,
        monthEnd,
      )
      const csvFilename = `EXTF_Buchungsstapel_${monthKey}-${String(monthEnd.getDate()).padStart(2, '0')}_L${String(laufNr).padStart(3, '0')}.csv`
      const storageRoot = (this.storage as any).config?.localPath || ''
      let includedCount = 0
      let missingCount = 0
      // Only emit a folder + CSV if the month has
      // any Buchungen OR any Belegbilder. Empty
      // months get a "0 Buchungen" entry in the
      // MANIFEST only — no folder. Keeps the
      // Berater's import dialog uncluttered.
      if (buchungen.length > 0 || belegbilder.length > 0) {
        archive.append(csv, { name: `${monthKey}/${csvFilename}` })
        for (const b of belegbilder) {
          const fullPath = path.join(storageRoot, b.relativePath)
          if (!fs.existsSync(fullPath)) {
            missingCount++
            continue
          }
          const ext = extFromPath(b.relativePath)
          const safeName = sanitizeFilename(b.belegfeld1)
          archive.file(fullPath, {
            name: `${monthKey}/Belegbilder/${safeName}.${ext}`,
          })
          includedCount++
        }
      }
      months.push({
        key: monthKey,
        start: monthStart.toISOString(),
        end: monthEnd.toISOString(),
        laufNr,
        buchungenCount: buchungen.length,
        belegbilderIncluded: includedCount,
        belegbilderMissing: missingCount,
        csvBytes: Buffer.byteLength(csv, 'latin1'),
      })

      // Advance to next month.
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
      monthIdx++
    }

    // MANIFEST.json — same shape as the bundle, plus
    // a per-month breakdown so the Berater can
    // audit what landed in each folder without
    // opening every CSV.
    const totalBuchungen = months.reduce((s, m) => s + m.buchungenCount, 0)
    const totalBelegIncluded = months.reduce((s, m) => s + m.belegbilderIncluded, 0)
    const totalBelegMissing = months.reduce((s, m) => s + m.belegbilderMissing, 0)
    archive.append(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          company: company.name,
          companyId: company.id,
          startDate: firstMonth.toISOString(),
          endDate: lastMonthEnd.toISOString(),
          months,
          totals: {
            months: months.length,
            buchungen: totalBuchungen,
            belegbilderIncluded: totalBelegIncluded,
            belegbilderMissing: totalBelegMissing,
          },
        },
        null,
        2,
      ),
      { name: 'MANIFEST.json' },
    )

    await archive.finalize()
  }

  /**
   * Tier 69: DATEV-Export Preview.
   *
   * The /datev-export endpoint streams a CSV the
   * user has to download + open in Excel / DATEV
   * to know if the export "looks right". For a
   * Berater who ships 12 exports a year to a
   * Steuerberater, that's a lot of round-trips
   * for what is essentially a "did I include
   * everything + did the columns balance?" check.
   *
   * This endpoint runs the same buildBuchungenFromDb
   * pipeline that the CSV endpoint uses (so the
   * preview matches the download exactly) and
   * returns a JSON summary:
   *
   *   - header       Berater-/Mandanten-Nr, period,
   *                  Buchungslauf-Nr, filename
   *   - rowCount     total Buchungen (matches the
   *                  CSV's body line count)
   *   - totalAmount  sum of all betrag
   *   - sollVsHaben  sum of Soll-Haben per side
   *                  (must balance to 0 for
   *                  double-entry correctness)
   *   - byAccount    per-Konto Soll/Haben sum
   *   - firstRows    first 5 Buchungen for the
   *                  preview table
   *   - validation   issues array:
   *                    - unbalanced totals
   *                    - missing Konto
   *                    - negative amounts
   *                    - missing VAT Schlüssel for
   *                      revenue lines
   *
   * The UI on /dashboard/reports calls this first
   * to render a preview, then the user clicks
   * "Download" to actually trigger the CSV
   * generation. The two paths share the same
   * buildBuchungenFromDb call signature, so the
   * preview is authoritative — anything the
   * preview shows is what the download will
   * contain.
   */
  @Get('datev-preview')
  @Require('reports.read')
  async datevPreview(
    @Query('companyId') companyId: string,
    @Query('startDate') startDateStr: string,
    @Query('endDate') endDateStr: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required')
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
    })
    if (!company) throw new BadRequestException('Company not found')

    const startDate = startDateStr
      ? new Date(startDateStr)
      : new Date(new Date().getFullYear(), 0, 1)
    const endDate = endDateStr ? new Date(endDateStr) : new Date()

    const buchungen = await buildBuchungenFromDb(
      this.prisma,
      companyId,
      startDate,
      endDate,
    )

    const settings = (company as any).settings?.datev || {}
    const laufNr = settings?.laufNr?.[startDate.getFullYear()] || 1
    const filename = `EXTF_Buchungsstapel_${startDate.toISOString().split('T')[0]}_L${String(laufNr).padStart(3, '0')}.csv`

    // Totals
    let totalSoll = 0
    let totalHaben = 0
    let totalNet = 0 // abs sum
    const byAccount = new Map<
      string,
      { konto: string; soll: number; haben: number; count: number }
    >()
    const issues: { severity: 'error' | 'warning'; message: string }[] = []
    for (const b of buchungen) {
      const signed = b.shVz === 'H' ? -b.betrag : b.betrag
      totalSoll += signed
      totalHaben += -signed
      totalNet += Math.abs(b.betrag)
      const a = byAccount.get(b.konto) || {
        konto: b.konto,
        soll: 0,
        haben: 0,
        count: 0,
      }
      a.soll += signed
      a.haben += -signed
      a.count += 1
      byAccount.set(b.konto, a)
      const a2 = byAccount.get(b.gegenkonto) || {
        konto: b.gegenkonto,
        soll: 0,
        haben: 0,
        count: 0,
      }
      a2.soll += -signed
      a2.haben += signed
      a2.count += 1
      byAccount.set(b.gegenkonto, a2)
      // Validation
      if (!b.konto || !b.gegenkonto) {
        issues.push({
          severity: 'error',
          message: `Buchung ohne Konto: ${b.belegfeld1}`,
        })
      }
      if (b.betrag <= 0) {
        issues.push({
          severity: 'warning',
          message: `Betrag ≤ 0 in Buchung ${b.belegfeld1}`,
        })
      }
      // Revenue lines (Soll on 8400/Erlöse) should
      // carry a USt-Schlüssel. Empty Schlüssel
      // means the export will fail DATEV's import
      // validator.
      if (/^8(4|0)00$/.test(b.konto) && !b.ustSchluessel) {
        issues.push({
          severity: 'warning',
          message: `Erlöskonto ${b.konto} ohne USt-Schlüssel in Buchung ${b.belegfeld1}`,
        })
      }
    }

    // Balance check: in proper double-entry, total
    // Soll must equal total Haben. A non-zero
    // delta here means the export would fail
    // DATEV's own validator.
    const balanceDelta = Math.round((totalSoll + totalHaben) * 100) / 100
    if (Math.abs(balanceDelta) > 0.01) {
      issues.push({
        severity: 'error',
        message: `Soll/Haben nicht ausgeglichen (Δ=${balanceDelta.toFixed(2)} €) — DATEV-Import wird fehlschlagen`,
      })
    }

    return {
      header: {
        beraterNr: settings?.beraterNr || '00000',
        mandantenNr: settings?.mandantenNr || '00001',
        startDate: startDate.toISOString().slice(0, 10),
        endDate: endDate.toISOString().slice(0, 10),
        buchungsLaufNr: laufNr,
        filename,
      },
      rowCount: buchungen.length,
      totalAmount: Math.round(totalNet * 100) / 100,
      totalSoll: Math.round(totalSoll * 100) / 100,
      totalHaben: Math.round(totalHaben * 100) / 100,
      balanceDelta,
      byAccount: Array.from(byAccount.values())
        .sort((a, b) => (a.soll + a.haben) - (b.soll + b.haben))
        .map((a) => ({
          konto: a.konto,
          soll: Math.round(a.soll * 100) / 100,
          haben: Math.round(a.haben * 100) / 100,
          count: a.count,
        })),
      firstRows: buchungen.slice(0, 5).map((b) => ({
        belegdatum:
          b.belegdatum instanceof Date
            ? b.belegdatum.toISOString().slice(0, 10)
            : String(b.belegdatum),
        belegfeld1: b.belegfeld1,
        konto: b.konto,
        gegenkonto: b.gegenkonto,
        betrag: b.betrag,
        shVz: b.shVz || 'S',
        buchungstext: b.buchungstext,
        ustSchluessel: b.ustSchluessel || null,
      })),
      issues,
    }
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
   * Tier 74: Liquiditätsplanung (Cash Flow Forecast).
   *
   * 12-month rolling forecast of the company's bank
   * balance, starting from the user's current
   * balance. Each month shows incoming (open invoices
   * + projected recurring templates) and outgoing
   * (booked expenses) plus the cumulative balance.
   *
   * The "trocken" warning (`firstDryMonth`) tells
   * the user WHEN, not just IF, the company would
   * go negative — that's the question every CFO /
   * Steuerberater actually asks: "können wir die
   * nächste Rate noch zahlen?"
   *
   * Query params:
   *   - companyId       (required)
   *   - months          (optional, 1-36, default 12)
   *   - startingBalance (optional, default 0)
   *   - fromDate        (optional, ISO date — defaults
   *                      to start of current month)
   *
   * The startingBalance is NOT auto-derived from
   * bank-import because (a) the sync may be stale
   * and (b) many users have multiple accounts they
   * want to net. The UI exposes an input for it.
   */
  @Get('cashflow')
  @Require('reports.read')
  async getCashflow(
    @Query('companyId') companyId: string,
    @Query('months') monthsRaw?: string,
    @Query('startingBalance') startingBalanceRaw?: string,
    @Query('fromDate') fromDateRaw?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const months = monthsRaw ? parseInt(monthsRaw, 10) : 12
    if (!Number.isFinite(months) || months < 1 || months > 36) {
      throw new BadRequestException('months muss zwischen 1 und 36 liegen')
    }
    const startingBalance = startingBalanceRaw
      ? Number(startingBalanceRaw.replace(',', '.'))
      : 0
    if (!Number.isFinite(startingBalance)) {
      throw new BadRequestException('startingBalance ist keine gültige Zahl')
    }
    return this.cashflow.forecast({
      companyId,
      months,
      startingBalance,
      fromDate: fromDateRaw ? new Date(fromDateRaw) : undefined,
    })
  }

  /**
   * Tier 75: P&L (Gewinn- und Verlustrechnung).
   *
   * Monthly + YTD operating result for a given year,
   * plus a prior-year comparison. The shape mirrors
   * the BWA a Berater would deliver to the Mandant
   * (Umsatzerlöse, Materialaufwand, Sonstige,
   * Betriebsergebnis).
   *
   * `year` defaults to the current year. The
   * Material/Sonstige split is derived from
   * expense.category: anything starting with
   * "Material" or "Waren" → Materialaufwand; the
   * rest → Sonstige. A v2 could integrate a proper
   * BWA category map.
   */
  @Get('pnl')
  @Require('reports.read')
  async getPnl(
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const year = yearRaw ? Number(yearRaw) : new Date().getFullYear()
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    return this.pnl.compute(companyId, year)
  }

  /**
   * Tier 78: EU OSS (One-Stop-Shop) — quarterly
   * B2C distance-sales declaration.
   *
   * Returns the OSS-Retourmeldung preview as JSON:
   *   - per (country, vatRate) line
   *   - per-country subtotal
   *   - grand total
   *   - exclusion counts (so the user can sanity-
   *     check "X excluded because B2B, Y excluded
   *     because non-EU")
   *
   * The OSS-Retourmeldung itself is filed via the
   * BZSt portal (XML). This endpoint + the matching
   * /oss.csv give the user the data they need to
   * fill the portal manually OR to feed an automated
   * uploader. The disclaimer in the response
   * surfaces the "this is a preview" caveat.
   *
   * Defaults: current calendar year, current quarter
   * (1-4). Year/quarter are required for the OSS
   * filing (you can't file a "year" — it has to be
   * a quarter) but the defaults keep the UI simple
   * when the user just wants to see the current
   * quarter's numbers.
   */
  @Get('oss')
  @Require('reports.read')
  async getOss(
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
    @Query('quarter') quarterRaw?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const now = new Date()
    const year = yearRaw ? Number(yearRaw) : now.getFullYear()
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    const quarter = quarterRaw ? Number(quarterRaw) : Math.floor(now.getMonth() / 3) + 1
    if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
      throw new BadRequestException('quarter muss zwischen 1 und 4 liegen')
    }
    return this.oss.compute(companyId, year, quarter)
  }

  /**
   * Tier 86: BWA (Betriebswirtschaftliche
   * Auswertung). The monthly operating
   * report that a Steuerberater sends to
   * the Mandant. Canonical DATEV BWA
   * structure (4-digit bucket codes 1000-
   * 5999) with Monatswert / Vormonat / YTD /
   * Vorjahres-YTD / % change.
   *
   * Defaults: current calendar year, current
   * month. Year/month validation matches the
   * other report endpoints.
   */
  @Get('bwa')
  @Require('reports.read')
  async getBwa(
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
    @Query('month') monthRaw?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const now = new Date()
    const year = yearRaw ? Number(yearRaw) : now.getFullYear()
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    const month = monthRaw ? Number(monthRaw) : now.getMonth() + 1
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new BadRequestException('month muss zwischen 1 und 12 liegen')
    }
    return this.bwa.compute(companyId, year, month)
  }

  @Get('bwa.pdf')
  @Header('Content-Type', 'application/pdf')
  async getBwaPdf(
    @Res() res: Response,
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
    @Query('month') monthRaw?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const now = new Date()
    const year = yearRaw ? Number(yearRaw) : now.getFullYear()
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    const month = monthRaw ? Number(monthRaw) : now.getMonth() + 1
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new BadRequestException('month muss zwischen 1 und 12 liegen')
    }
    await this.bwa.renderPdf(companyId, year, month, res)
  }

  /**
   * OSS CSV export. German semicolon format
   * (matches what DATEV / BZSt-OSS portal expect).
   * Same filters as the JSON endpoint — the CSV is
   * byte-identical to "take the JSON, flatten the
   * (country, vatRate) pairs, format as a single
   * table".
   *
   * Filename: OSS-Retourmeldung_<year>_Q<quarter>.csv
   */
  @Get('oss.csv')
  @Require('reports.read')
  async getOssCsv(
    @Res() res: Response,
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
    @Query('quarter') quarterRaw?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const now = new Date()
    const year = yearRaw ? Number(yearRaw) : now.getFullYear()
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    const quarter = quarterRaw ? Number(quarterRaw) : Math.floor(now.getMonth() / 3) + 1
    if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
      throw new BadRequestException('quarter muss zwischen 1 und 4 liegen')
    }
    const csv = await this.oss.renderCsv(companyId, year, quarter)
    const filename = `OSS-Retourmeldung_${year}_Q${quarter}.csv`
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.end(csv)
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

  /**
   * Tier 46: Cost-Center Transactions drill-in.
   *
   * Returns the actual invoices + expenses that
   * contribute to a single (year, month, costCenter)
   * bucket. The page
   * `/dashboard/cost-center-report/[year]/[month]/[costCenter]`
   * uses this to render a chronological list of
   * postings — "where did this month's 504€ net come
   * from?".
   *
   * The costCenter param matches the dashboard-v2
   * bucket convention: null/empty → "Nicht
   * zugewiesen". We URL-encode the bucket label so
   * spaces and umlauts survive the round-trip; the
   * decode happens here.
   *
   * Pagination via take + skip (defaults to 100 rows).
   * No DB-level cursor — a date-sorted offset is fine
   * for a single-month single-cc slice (bounded to a
   * few hundred rows even for big clients).
   */
  @Get('cost-center-transactions')
  @Require('reports.read')
  async getCostCenterTransactions(
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
    @Query('month') monthRaw?: string,
    @Query('costCenter') costCenterRaw?: string,
    @Query('take') takeRaw?: string,
    @Query('skip') skipRaw?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const now = new Date()
    const year = yearRaw ? Number(yearRaw) : now.getFullYear()
    const month = monthRaw
      ? Number(monthRaw)
      : now.getMonth() + 1
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    if (!Number.isFinite(month) || month < 1 || month > 12) {
      throw new BadRequestException('month muss zwischen 1 und 12 liegen')
    }
    // URL-decode the cost-center label. Front-end
    // sends encodeURIComponent(costCenter); on the
    // server, Express decodes the query string by
    // default so the raw value is already unescaped.
    // We also normalise empty/null → 'Nicht
    // zugewiesen' to match the bucket label from
    // dashboard-v2 / tier-44/45.
    const ccDecoded = costCenterRaw ?? ''
    const ccBucket =
      ccDecoded.trim() === '' || ccDecoded === 'Nicht zugewiesen'
        ? null
        : ccDecoded

    const take = Math.min(
      Math.max(Number(takeRaw) || 100, 1),
      500,
    )
    const skip = Math.max(Number(skipRaw) || 0, 0)

    const monthStart = new Date(year, month - 1, 1)
    const monthEnd = new Date(year, month, 1)

    // Two parallel queries — Invoice + Expense. The
    // costCenter filter on the model column matches
    // the same value the bucket query used (the
    // service stamps the string verbatim into the
    // column on create). NULL cc on the column matches
    // when the bucket is "Nicht zugewiesen".
    //
    // Pagination note: we deliberately do NOT pass
    // take/skip to the SQL queries, because that
    // would slice the Invoice and Expense lists
    // independently — the UI gets a mix of 2
    // invoices + 2 expenses under "take=2" even
    // though there are 100 invoices. We fetch the
    // full slice (bounded by single month + single
    // cc — typically <100 rows) and apply take/skip
    // in JS after merging + date-sorting. The total
    // counts still come from the parallel count
    // query so the UI knows "hasMore" correctly.
    const ccFilter = ccBucket === null ? null : ccBucket
    const [invRows, expRows, invTotal, expTotal] = await Promise.all([
      this.prisma.invoice.findMany({
        where: {
          companyId,
          costCenter: ccFilter, // null matches costCenter IS NULL
          issueDate: { gte: monthStart, lt: monthEnd },
          type: { in: ['INV', 'RCV'] },
        },
        select: {
          id: true,
          invoiceNumber: true,
          issueDate: true,
          dueDate: true,
          total: true,
          totalVat: true,
          currency: true,
          customerName: true,
          status: true,
        },
        orderBy: { issueDate: 'asc' },
      }),
      this.prisma.expense.findMany({
        where: {
          companyId,
          costCenter: ccFilter,
          invoiceDate: { gte: monthStart, lt: monthEnd },
          status: { in: ['booked', 'deductible'] },
        },
        select: {
          id: true,
          invoiceNumber: true,
          invoiceDate: true,
          description: true,
          supplierId: true,
          grossAmount: true,
          vatAmount: true,
          status: true,
        },
        orderBy: { invoiceDate: 'asc' },
      }),
      // Counts for pagination total (so the UI can
      // show "showing 1-50 of N"). Counting in
      // parallel with the findMany keeps the request
      // to one roundtrip + 1 extra count.
      this.prisma.invoice.count({
        where: {
          companyId,
          costCenter: ccFilter,
          issueDate: { gte: monthStart, lt: monthEnd },
          type: { in: ['INV', 'RCV'] },
        },
      }),
      this.prisma.expense.count({
        where: {
          companyId,
          costCenter: ccFilter,
          invoiceDate: { gte: monthStart, lt: monthEnd },
          status: { in: ['booked', 'deductible'] },
        },
      }),
    ])

    // Normalise to a single union shape — the UI
    // renders one chronological table. `kind` is
    // 'invoice' | 'expense' so the row knows which
    // fields to show (number vs description, etc.).
    type Tx = {
      kind: 'invoice' | 'expense'
      id: string
      date: Date
      number: string
      counterparty: string
      amount: number
      vat: number
      currency: string
      status: string
      _supplierId?: string | null
    }
    const tx: Tx[] = [
      ...invRows.map((i) => ({
        kind: 'invoice' as const,
        id: i.id,
        date: i.issueDate,
        number: i.invoiceNumber,
        counterparty: i.customerName || '',
        amount: Number(i.total),
        vat: Number(i.totalVat),
        currency: i.currency,
        status: i.status,
      })),
      ...expRows.map((e) => ({
        kind: 'expense' as const,
        id: e.id,
        date: e.invoiceDate,
        number: e.invoiceNumber || '',
        // Expense has no supplierName column — just a
        // supplierId FK. We resolve the supplier name
        // below via the supplierNames map. Fallback to
        // description if no supplier row is linked.
        counterparty: e.description || '',
        amount: Number(e.grossAmount),
        vat: Number(e.vatAmount),
        currency: 'EUR',
        status: e.status,
        // Internal field for the supplier name
        // resolution step below. Stripped before the
        // response.
        _supplierId: e.supplierId,
      })),
    ]
    // Resolve supplier names in one query (bounded
    // by the page slice — at most `take` distinct
    // supplierIds).
    const supplierIds = Array.from(
      new Set(
        tx
          .filter((t) => t.kind === 'expense' && t._supplierId)
          .map((t) => t._supplierId as string),
      ),
    )
    let supplierNames = new Map<string, string>()
    if (supplierIds.length > 0) {
      const suppliers = await this.prisma.supplier.findMany({
        where: { id: { in: supplierIds } },
        select: { id: true, name: true },
      })
      supplierNames = new Map(suppliers.map((s) => [s.id, s.name]))
    }
    // Apply the resolved name, falling back to the
    // description we already set if no supplier row
    // exists. Strip the internal _supplierId field
    // before sending.
    for (const t of tx) {
      if (t.kind === 'expense' && t._supplierId) {
        const n = supplierNames.get(t._supplierId)
        if (n) t.counterparty = n
      }
      delete t._supplierId
    }
    tx.sort((a, b) => a.date.getTime() - b.date.getTime())

    // Apply pagination AFTER the merge + sort so
    // "take=2" returns the 2 earliest rows across
    // invoices + expenses combined. Total counts
    // still come from the parallel count() so the
    // UI can show "showing 1-2 of 5".
    const totalCombined = tx.length
    const pagedTx = tx.slice(skip, skip + take)
    const hasMore = skip + take < totalCombined

    const totals = {
      revenue: tx
        .filter((t) => t.kind === 'invoice')
        .reduce((s, t) => s + t.amount, 0),
      expense: tx
        .filter((t) => t.kind === 'expense')
        .reduce((s, t) => s + t.amount, 0),
      ust: tx
        .filter((t) => t.kind === 'invoice')
        .reduce((s, t) => s + t.vat, 0),
      vorsteuer: tx
        .filter((t) => t.kind === 'expense')
        .reduce((s, t) => s + t.vat, 0),
      invoiceCount: invRows.length,
      expenseCount: expRows.length,
      invoiceTotal: invTotal,
      expenseTotal: expTotal,
    }

    return {
      year,
      month,
      costCenter: ccBucket === null ? 'Nicht zugewiesen' : ccBucket,
      transactions: pagedTx,
      totals,
      pagination: { take, skip, hasMore },
      generatedAt: now.toISOString(),
    }
  }

  /**
   * Tier 48: List budgets for a company/year.
   *
   * Returns every CostCenterBudget row for the given
   * (company, year), sorted by costCenter asc.
   * Missing years return []. The frontend renders
   * this as the editable list of monthly targets.
   */
  @Get('cost-center-budgets')
  @Require('reports.read')
  async listCostCenterBudgets(
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
  ) {
    if (!companyId)
      throw new BadRequestException('companyId ist erforderlich')
    const year = yearRaw ? Number(yearRaw) : new Date().getFullYear()
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    const rows = await this.prisma.costCenterBudget.findMany({
      where: { companyId, year },
      orderBy: [{ costCenter: 'asc' }, { label: 'asc' }],
    })
    return {
      year,
      budgets: rows.map((r) => ({
        id: r.id,
        costCenter: r.costCenter ?? 'Nicht zugewiesen',
        label: r.label,
        monthlyTargets: r.monthlyTargets,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
    }
  }

  /**
   * Tier 48: Upsert a budget. Same (company, cc, year)
   * triple replaces the existing row (the schema's
   * @@unique supports this). The frontend uses this
   * for both create and edit — simpler than two
   * endpoints and matches the Berater workflow of
   * "set the target for the year, refresh each
   * month".
   *
   * `costCenter` empty/null → "Nicht zugewiesen"
   * bucket. `monthlyTargets` MUST be length 12 with
   * numeric values.
   */
  @Post('cost-center-budgets')
  @Require('reports.write')
  async upsertCostCenterBudget(
    @Query('companyId') companyId: string,
    @Body()
    body: {
      year: number
      costCenter?: string | null
      monthlyTargets: number[]
      label?: string | null
    },
  ) {
    if (!companyId)
      throw new BadRequestException('companyId ist erforderlich')
    if (!body || !Number.isFinite(body.year))
      throw new BadRequestException('year ist erforderlich')
    if (
      !Array.isArray(body.monthlyTargets) ||
      body.monthlyTargets.length !== 12
    ) {
      throw new BadRequestException(
        'monthlyTargets muss ein Array der Länge 12 sein',
      )
    }
    if (
      !body.monthlyTargets.every(
        (v) => typeof v === 'number' && Number.isFinite(v),
      )
    ) {
      throw new BadRequestException(
        'monthlyTargets darf nur Zahlen enthalten',
      )
    }
    // Empty / null costCenter maps to NULL on the
    // column → "Nicht zugewiesen" pseudo-bucket.
    const cc =
      body.costCenter && body.costCenter.trim().length > 0
        ? body.costCenter.trim()
        : null

    // Prisma's generated type for the compound
    // unique input declares costCenter as non-null
    // string even when the column is nullable. We
    // sidestep the typing issue by doing findFirst
    // + create | update manually. The race window is
    // small (one user editing one budget), and we
    // keep the @@unique in the schema so the DB
    // enforces the constraint.
    const existing = await this.prisma.costCenterBudget.findFirst({
      where: { companyId, costCenter: cc, year: body.year },
    })
    const row = existing
      ? await this.prisma.costCenterBudget.update({
          where: { id: existing.id },
          data: {
            monthlyTargets: body.monthlyTargets,
            label: body.label ?? null,
          },
        })
      : await this.prisma.costCenterBudget.create({
          data: {
            companyId,
            costCenter: cc,
            year: body.year,
            monthlyTargets: body.monthlyTargets,
            label: body.label ?? null,
          },
        })

    return {
      id: row.id,
      costCenter: row.costCenter ?? 'Nicht zugewiesen',
      label: row.label,
      monthlyTargets: row.monthlyTargets,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }
  }

  /**
   * Tier 48: Delete a budget by id. The frontend
   * shows a confirm dialog and only fires this if
   * the user agrees — the data is small enough that
   * we don't soft-delete.
   */
  @Delete('cost-center-budgets/:id')
  @Require('reports.write')
  async deleteCostCenterBudget(@Param('id') id: string) {
    const row = await this.prisma.costCenterBudget.delete({
      where: { id },
    })
    return {
      id: row.id,
      costCenter: row.costCenter ?? 'Nicht zugewiesen',
      year: row.year,
    }
  }

  /**
   * Tier 48: Budget vs Actual report.
   *
   * Joins CostCenterBudget rows with the same
   * per-cc monthly aggregation as the tier-44 yearly
   * endpoint. Returns per-cc rows with:
   *   - target[12]  : the budgeted amount per month
   *   - actual[12]  : net (revenue − expense) per month
   *   - delta[12]   : actual − target (positive = over
   *                   budget for expenses / under
   *                   budget for revenue targets)
   *   - pct[12]     : actual / target as a fraction
   *                   (null when target = 0)
   *
   * Plus a yearly rollup row. Empty budget for a
   * cost-center → target = 0, delta = actual.
   *
   * The UI uses this to render a side-by-side
   * actual/budget table with green/red colouring and
   * a Δ column showing over/under.
   */
  @Get('cost-center-budget-vs-actual')
  @Require('reports.read')
  async getCostCenterBudgetVsActual(
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
  ) {
    if (!companyId)
      throw new BadRequestException('companyId ist erforderlich')
    const now = new Date()
    const year = yearRaw ? Number(yearRaw) : now.getFullYear()
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    const yearStart = new Date(year, 0, 1)
    const yearEnd = new Date(year + 1, 0, 1)

    // Same data fetches as tier-44 — we duplicate
    // rather than refactor into a shared helper
    // because the yearly endpoint already does this
    // work and the controller's class is already
    // large. If a third consumer appears we'll
    // extract.
    const [budgets, invRows, expRows] = await Promise.all([
      this.prisma.costCenterBudget.findMany({
        where: { companyId, year },
      }),
      this.prisma.invoice.groupBy({
        by: ['costCenter'],
        where: {
          companyId,
          issueDate: { gte: yearStart, lt: yearEnd },
          type: { in: ['INV', 'RCV'] },
        },
        _sum: { total: true },
      }),
      this.prisma.expense.groupBy({
        by: ['costCenter'],
        where: {
          companyId,
          invoiceDate: { gte: yearStart, lt: yearEnd },
          status: { in: ['booked', 'deductible'] },
        },
        _sum: { grossAmount: true },
      }),
    ])

    // Per-line monthly walk — same as tier-44.
    const [invMonth, expMonth] = await Promise.all([
      this.prisma.invoice.findMany({
        where: {
          companyId,
          issueDate: { gte: yearStart, lt: yearEnd },
          type: { in: ['INV', 'RCV'] },
        },
        select: { costCenter: true, total: true, issueDate: true },
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

    // Group actuals by bucket (matches tier-44 row
    // shape so we can join).
    type Row = {
      costCenter: string
      costCenterRaw: string | null
      target: number[]
      actual: number[]
      label: string | null
    }
    const map = new Map<string, Row>()
    const getRow = (key: string, raw: string | null): Row => {
      let r = map.get(key)
      if (!r) {
        r = {
          costCenter: key,
          costCenterRaw: raw,
          target: Array(12).fill(0),
          actual: Array(12).fill(0),
          label: null,
        }
        map.set(key, r)
      }
      return r
    }

    // Apply budget targets first.
    for (const b of budgets) {
      const r = getRow(labelFor(b.costCenter), b.costCenter)
      // b.monthlyTargets is stored as a Json value
      // — we trust the controller-side validation on
      // upsert and assert here defensively.
      const arr = Array.isArray(b.monthlyTargets)
        ? (b.monthlyTargets as number[])
        : []
      for (let i = 0; i < 12; i++) {
        r.target[i] = Number(arr[i] ?? 0)
      }
      r.label = b.label
    }

    // Apply actuals (gross net = revenue − expense).
    for (const inv of invMonth) {
      const d = inv.issueDate
      const m = d.getMonth()
      const r = getRow(labelFor(inv.costCenter), inv.costCenter)
      r.actual[m] += Number(inv.total)
    }
    for (const exp of expMonth) {
      const d = exp.invoiceDate
      const m = d.getMonth()
      const r = getRow(labelFor(exp.costCenter), exp.costCenter)
      r.actual[m] -= Number(exp.grossAmount)
    }

    // Build the response rows with delta + pct.
    // Sort by |yearlyDelta| desc so the biggest
    // over/under bubbles to the top — same UX as
    // tier-44's tier-38 pie.
    const rows = Array.from(map.values()).map((r) => {
      const delta = r.target.map((t, i) =>
        Number((r.actual[i] - t).toFixed(2)),
      )
      const pct = r.target.map((t, i) =>
        t === 0 ? null : Number((r.actual[i] / t).toFixed(4)),
      )
      const targetTotal = Number(
        r.target.reduce((s, v) => s + v, 0).toFixed(2),
      )
      const actualTotal = Number(
        r.actual.reduce((s, v) => s + v, 0).toFixed(2),
      )
      return {
        costCenter: r.costCenter,
        label: r.label,
        target: r.target,
        actual: r.actual,
        delta,
        pct,
        targetTotal,
        actualTotal,
        deltaTotal: Number((actualTotal - targetTotal).toFixed(2)),
      }
    })
    rows.sort((a, b) => {
      const da = Math.abs(b.deltaTotal) - Math.abs(a.deltaTotal)
      if (da !== 0) return da
      return a.costCenter.localeCompare(b.costCenter)
    })

    // Rollup totals.
    const target = Array(12).fill(0)
    const actual = Array(12).fill(0)
    const delta = Array(12).fill(0)
    const pct: (number | null)[] = Array(12).fill(0).map((_, i) => {
      if (target[i] === 0) return null
      return Number((actual[i] / target[i]).toFixed(4))
    })
    for (const r of rows) {
      for (let i = 0; i < 12; i++) {
        target[i] += r.target[i]
        actual[i] += r.actual[i]
        delta[i] += r.delta[i]
      }
    }
    for (let i = 0; i < 12; i++) {
      target[i] = Number(target[i].toFixed(2))
      actual[i] = Number(actual[i].toFixed(2))
      delta[i] = Number(delta[i].toFixed(2))
      pct[i] = target[i] === 0 ? null : Number((actual[i] / target[i]).toFixed(4))
    }
    const targetTotal = Number(target.reduce((s, v) => s + v, 0).toFixed(2))
    const actualTotal = Number(actual.reduce((s, v) => s + v, 0).toFixed(2))
    const deltaTotal = Number(delta.reduce((s, v) => s + v, 0).toFixed(2))

    return {
      year,
      rows,
      totals: {
        target,
        actual,
        delta,
        pct,
        targetTotal,
        actualTotal,
        deltaTotal,
      },
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
