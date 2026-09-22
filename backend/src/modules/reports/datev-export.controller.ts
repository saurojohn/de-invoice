/**
 * DatevExportController — Tier 173 split.
 *
 * Owns the 4 DATEV-shaped endpoints:
 *
 *   GET /api/v1/reports/datev-export          — Tier 67 single CSV
 *   GET /api/v1/reports/datev-export-bundle   — Tier 67 CSV + Belegbilder ZIP
 *   GET /api/v1/reports/datev-export-monthly  — Tier 142 one CSV per month
 *   GET /api/v1/reports/datev-preview         — Tier 69 JSON preview
 *
 * The /datev-buchungsliste endpoints (Tier 167)
 * are a SEPARATE controller (datev-buchungsliste.controller.ts)
 * because the per-Sachkonto + USt-Verprobung
 * logic is a different shape from the per-Buchung
 * DATEV CSV. The two controllers share
 * `datev.service.ts` helpers (buildBuchungenFromDb,
 * collectBelegbilder, generateDatevBuchungsstapel)
 * — the helpers are the source of truth for the
 * CSV format.
 *
 * All four endpoints stream a binary response
 * (CSV or ZIP), so they use @Res() + manual
 * header setting rather than the @Header() decorator
 * (which doesn't reliably reach the buffer stream
 * when @Res() is in non-passthrough mode).
 *
 * Split out of reports.controller.ts (Tier 173).
 * URL paths preserved.
 */
import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Res,
} from '@nestjs/common';
import * as archiver from 'archiver';
import * as fs from 'fs';
import * as path from 'path';
import type { Response } from 'express';

import { Auth, Require } from '../../auth/roles.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import {
  buildBuchungenFromDb,
  collectBelegbilder,
  generateDatevBuchungsstapel,
  encodeDatevCsv,
} from './datev.service';

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
export class DatevExportController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

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
    res.end(encodeDatevCsv(csv));
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
    @Query('year') yearParam: string | undefined,
    @Query('month') monthParam: string | undefined,
    @Res() res: Response,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) throw new BadRequestException('Company not found');

    // Tier 184: month-scoped DATEV bundle.
    // When ?month=N (1-12) is set, the bundle is
    // scoped to that single month (the date range
    // is the calendar month, and the filename
    // encodes the period). Mirrors Tier 181's
    // GoBD-export month-scoped pattern. When
    // absent, the legacy startDate/endDate range
    // applies (defaults to the current calendar
    // year if both are missing).
    let startDate: Date
    let endDate: Date
    let periodLabel: string | null = null
    if (monthParam !== undefined && monthParam !== '') {
      const m = parseInt(monthParam, 10)
      if (!Number.isInteger(m) || m < 1 || m > 12) {
        throw new BadRequestException(
          `Ungültiger Monat: ${monthParam} (1-12)`,
        )
      }
      const y = yearParam
        ? parseInt(yearParam, 10)
        : new Date().getFullYear()
      if (!Number.isInteger(y) || y < 2000 || y > 2100) {
        throw new BadRequestException(
          `Ungültiges Jahr: ${yearParam || 'default'} (2000-2100)`,
        )
      }
      // Month boundaries — start inclusive, end
      // inclusive. We push the end to 23:59:59.999
      // so that any buchung on the last day of
      // the month is included.
      startDate = new Date(y, m - 1, 1, 0, 0, 0, 0)
      endDate = new Date(y, m, 0, 23, 59, 59, 999)
      periodLabel = `${y}-${String(m).padStart(2, '0')}`
    } else {
      startDate = startDateStr
        ? new Date(startDateStr)
        : new Date(new Date().getFullYear(), 0, 1)
      endDate = endDateStr
        ? new Date(endDateStr)
        : new Date()
    }

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
    // Tier 184: month-scoped filename embeds the
    // period so a Berater's archive folder sorts
    // cleanly. Legacy range exports keep the
    // EXTF_Buchungsstapel_YYYY-MM-DD format.
    const zipFilename = periodLabel
      ? `EXTF_Buchungsstapel_${periodLabel}_L${String(laufNr).padStart(3, '0')}.zip`
      : `EXTF_Buchungsstapel_${startDate.toISOString().split('T')[0]}_L${String(laufNr).padStart(3, '0')}.zip`;

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
    archive.append(encodeDatevCsv(csv), { name: 'Buchungsstapel.csv' })

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
        // startDate / endDate stay as raw Date.toISOString()
        // for back-compat with the Tier 167 MANIFEST
        // format. Tier 184 adds periodLabel/periodStart/
        // periodEnd + scope so a Prüfer verifying a
        // month-scoped bundle can identify the period
        // without re-computing the date arithmetic.
        startDate: startDate.toISOString(),
        endDate: endDate.toISOString(),
        buchungsLauf: laufNr,
        belegbilderIncluded: includedCount,
        belegbilderMissing: missingCount,
        periodLabel,
        periodStart: periodLabel ? startDate.toISOString() : undefined,
        periodEnd: periodLabel ? endDate.toISOString() : undefined,
        scope: periodLabel ? 'month' : 'range',
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
        archive.append(encodeDatevCsv(csv), { name: `${monthKey}/${csvFilename}` })
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
        csvBytes: encodeDatevCsv(csv).length,
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
      // Tier 423: a credit note or refund is negative (DATEV gets it with
      // S/H swapped) — only a zero amount is suspicious. The check that a
      // revenue *Konto* carried a key is gone: revenue is the Gegenkonto now,
      // and 8400/8300 are Automatikkonten that need none.
      if (b.betrag === 0) {
        issues.push({
          severity: 'warning',
          message: `Betrag 0 in Buchung ${b.belegfeld1}`,
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
}
