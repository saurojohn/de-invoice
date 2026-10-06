import { MONTH, YEAR, queryInt } from '../../common/query';
import { signedExpenseAmounts } from '../expense/credit-note'
import { Controller, Get, Post, Put, Delete, Body, Query, Param, BadRequestException, Header, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { UstvaService } from './ustva.service';
import { SaveUstvaFilingDto, RecordUstvaPaymentDto, CreateUstPaymentDto, ReleaseFilingDto } from './dto/ustva.dto';
import { CreateUstvaExpenseDto } from './dto/ustva-expense.dto';
import { UpdateExpenseDto } from '../expense/dto/expense.dto';
import { updateExpense } from '../expense/update-expense';
import { UstjaService } from './ustja.service';
import {
  generateUstvaElsterXml,
  generateUstvaAsciiPreview,
  generateUstjaElsterXml,
  generateUstjaAsciiPreview,
} from './elster.service';
import { PrismaService } from '../../prisma/prisma.service';
import { Auth, Require } from '../../auth/roles.decorator';

@Auth()
@Controller('ustva')
export class UstvaController {
  constructor(
    private ustva: UstvaService,
    private ustja: UstjaService,
    private prisma: PrismaService,
  ) {}

  // Computation (preview, no save) — looser rate limit (60/min)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('compute')
  @Require('ustva.read')
  async compute(
    @Query('companyId') companyId: string,
    @Query('year') yearStr: string,
    @Query('quarter') quarterStr?: string,
    @Query('month') monthStr?: string,
  ) {
    if (!companyId || !yearStr) throw new BadRequestException('companyId and year are required');
    const year = parseInt(yearStr, 10);
    const quarter = quarterStr ? parseInt(quarterStr, 10) : undefined;
    const month = monthStr ? parseInt(monthStr, 10) : undefined;
    return this.ustva.compute(companyId, year, quarter, month);
  }

  // Tier 177: UStVA-PDF. Phase 3 Berater-Walkthrough
  // found that USER-GUIDE Pfad 4.2 promised a
  // "UStVA-PDF" download but no such endpoint
  // existed. This is the Berater-readable summary
  // (A4 portrait, single page), not the ELSTER
  // submission XML — the Finanzamt still needs the
  // XML via /ustva/filings/:id/elster-xml.
  //
  // Required: month is mandatory for the PDF
  // because the Zahllast (Zahlung / Erstattung) is
  // per-month, not per-year. A user who wants
  // "UStVA für Q3" should fetch the 3 monthly PDFs.
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('ustva.pdf')
  @Header('Content-Type', 'application/pdf')
  @Require('ustva.read')
  async getUstvaPdf(
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
    // month is required — see comment above
    if (!monthRaw) {
      throw new BadRequestException('month ist erforderlich (UStVA-PDF ist pro Monat)')
    }
    const month = Number(monthRaw)
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new BadRequestException('month muss zwischen 1 und 12 liegen')
    }
    await this.ustva.renderPdf(companyId, year, month, res)
  }

  // Tier 491: Zusammenfassende Meldung (§ 18a UStG) — per month or quarter
  @Get('zm')
  @Require('ustva.read')
  async getZm(
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
    @Query('quarter') quarterRaw?: string,
    @Query('month') monthRaw?: string,
  ) {
    const { year, quarter, month } = this.zmPeriod(companyId, yearRaw, quarterRaw, monthRaw)
    return this.ustva.computeZm(companyId, year, quarter, month)
  }

  @Get('zm.csv')
  @Require('ustva.read')
  async getZmCsv(
    @Res() res: Response,
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
    @Query('quarter') quarterRaw?: string,
    @Query('month') monthRaw?: string,
  ) {
    const { year, quarter, month } = this.zmPeriod(companyId, yearRaw, quarterRaw, monthRaw)
    const zm = await this.ustva.computeZm(companyId, year, quarter, month)
    const name = `ZM_${year}_${quarter ? `Q${quarter}` : String(month).padStart(2, '0')}.csv`
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`)
    res.send(this.ustva.zmCsv(zm))
  }

  private zmPeriod(companyId: string, yearRaw?: string, quarterRaw?: string, monthRaw?: string) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const year = Number(yearRaw)
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new BadRequestException('year ist ungültig')
    const quarter = quarterRaw ? Number(quarterRaw) : undefined
    const month = monthRaw ? Number(monthRaw) : undefined
    if ((quarter == null) === (month == null)) {
      throw new BadRequestException('Genau einer von quarter (1–4) oder month (1–12) ist anzugeben')
    }
    if (quarter != null && !(Number.isInteger(quarter) && quarter >= 1 && quarter <= 4)) throw new BadRequestException('quarter muss 1–4 sein')
    if (month != null && !(Number.isInteger(month) && month >= 1 && month <= 12)) throw new BadRequestException('month muss 1–12 sein')
    return { year, quarter, month }
  }

  // Tier 161: Monatsvergleich USt-Voranmeldung.
  // Returns the last `months` months (default 6) of
  // UStVA aggregates for the dashboard widget. The
  // service serializes 6 compute() calls internally
  // (~1-2 s for a real dataset). The same 60/min
  // rate limit applies — the dashboard fetches this
  // on mount, so a heavy user might burst 6 calls
  // (1 widget load = 1 history call → 6 compute calls
  // server-side, but only 1 request from the client).
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('history')
  @Require('ustva.read')
  async history(
    @Query('companyId') companyId: string,
    @Query('months') monthsStr?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    const months = monthsStr ? parseInt(monthsStr, 10) : 6;
    return this.ustva.computeHistory(companyId, months);
  }

  // Save (draft or submit)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('filings')
  @Require('ustva.submit')
  async saveFiling(
    @Query('companyId') companyId: string,
    @Body() body: SaveUstvaFilingDto,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.ustva.saveFiling(companyId, body);
  }

  // List filings
  @Get('filings')
  @Require('ustva.read')
  async listFilings(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.ustva.listFilings(companyId);
  }

  // Tier 484: VAT paid to / refunded by the Finanzamt outside a UStVA
  @Get('payments')
  @Require('ustva.read')
  async listUstPayments(@Query('companyId') companyId: string, @Query('year') year?: string) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.ustva.listUstPayments(companyId, year ? parseInt(year, 10) : undefined);
  }

  @Post('payments')
  @Require('ustva.submit')
  async createUstPayment(@Query('companyId') companyId: string, @Body() body: CreateUstPaymentDto) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.ustva.createUstPayment(companyId, body);
  }

  @Delete('payments/:id')
  @Require('ustva.submit')
  async deleteUstPayment(@Query('companyId') companyId: string, @Param('id') id: string) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.ustva.deleteUstPayment(companyId, id);
  }

  // Tier 483: the payment to / refund from the Finanzamt for a return
  @Put('filings/:id/payment')
  @Require('ustva.submit')
  async recordFilingPayment(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
    @Body() body: RecordUstvaPaymentDto,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.ustva.recordFilingPayment(companyId, id, body);
  }

  // Tier 537: release a submitted period for corrections / lock it again
  @Put('filings/:id/release')
  @Require('ustva.submit')
  async releaseFiling(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
    @Body() body: ReleaseFilingDto,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.ustva.setFilingReleased(companyId, id, body.released);
  }

  // Get single filing
  @Get('filings/:id')
  @Require('ustva.read')
  async getFiling(@Query('companyId') companyId: string, @Param('id') id: string) {
    if (!companyId) throw new BadRequestException('companyId is required');
    const filing = await this.ustva.getFiling(companyId, id);
    if (!filing) throw new BadRequestException('Filing not found');
    return filing;
  }

  // Expenses
  @Get('expenses')
  @Require('accounting.read')
  async listExpenses(
    @Query('companyId') companyId: string,
    @Query('year') yearStr?: string,
    @Query('quarter') quarterStr?: string,
    @Query('month') monthStr?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    const year = queryInt(yearStr, 'year', YEAR);
    const quarter = queryInt(quarterStr, 'quarter', { min: 1, max: 4 });
    const month = queryInt(monthStr, 'month', MONTH);
    return this.ustva.listExpenses(companyId, year, quarter, month);
  }

  @Post('expenses')
  @Require('accounting.create')
  async createExpense(
    @Query('companyId') companyId: string,
    @Body() body: CreateUstvaExpenseDto,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    // Tier 213: ValidationPipe now enforces required fields
    // (description, invoiceDate, netAmount) — the inline
    // `if (!body.description)` check moved into the DTO.
    // Auto-compute VAT / gross if not provided.
    const net = Number(body.netAmount ?? 0)
    const vatRate = Number(body.vatRate ?? 0.19)
    const vatAmount = body.vatAmount !== undefined
      ? Number(body.vatAmount)
      : Number((net * vatRate).toFixed(2))
    const grossAmount = body.grossAmount !== undefined
      ? Number(body.grossAmount)
      : Number(net) + Number(vatAmount)
    // Tier 442: a supplier credit note is stored with negative amounts.
    const signed = signedExpenseAmounts(body.creditNote, { net, vat: vatAmount, gross: grossAmount })
    return this.ustva.createExpense(companyId, {
      supplierId: body.supplierId,
      invoiceNumber: body.invoiceNumber,
      description: body.description,
      invoiceDate: new Date(body.invoiceDate),
      netAmount: signed.net,
      vatRate,
      vatAmount: signed.vat,
      grossAmount: signed.gross,
      category: body.category,
      giftRecipient: body.giftRecipient, // Tier 503
      bewirtungAnlass: body.bewirtungAnlass, // Tier 539
      bewirtungTeilnehmer: body.bewirtungTeilnehmer,
      isIntraEU: body.isIntraEU ?? false,
      isReverseCharge: body.isReverseCharge ?? false,
      notes: body.notes,
      paidAt: body.paidAt ? new Date(body.paidAt) : null,
      confirmDuplicate: body.confirmDuplicate === true,
    });
  }

  // Tier 443: correct an open expense (expense/update-expense.ts).
  @Put('expenses/:id')
  @Require('accounting.update')
  async updateExpense(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
    @Body() body: UpdateExpenseDto,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return updateExpense(this.prisma, companyId, id, body);
  }

  @Delete('expenses/:id')
  @Require('accounting.delete')
  async deleteExpense(@Query('companyId') companyId: string, @Param('id') id: string) {
    if (!companyId) throw new BadRequestException('companyId is required');
    await this.ustva.deleteExpense(companyId, id);
    return { ok: true };
  }

  /**
   * Generate ELSTER XML for a saved UStVA filing.
   *
   * The returned file is a complete <Datenlieferung> packet
   * (ERiC schema, UStVA 2026). It can be uploaded as-is to
   * Mein ELSTER (ElsterOnline) via "Fragebogen hochladen".
   * For actual electronic submission with a certificate, the
   * file still needs to be passed through the official ERiC
   * C library — see the "Mein ELSTER" help pages for the
   * signature workflow.
   *
   * Two output formats:
   *   format=xml  (default) — full ERiC Datenlieferung
   *   format=ascii — short ASCII paste-format for sanity check
   *
   * The route is GET because the computation is deterministic
   * (saved filing + current company data). The browser-side
   * download is triggered by `?download=1`.
   */
  @Get('filings/:id/elster-xml')
  @Require('ustva.read')
  @Header('Content-Type', 'application/xml; charset=utf-8')
  async getElsterXml(
    @Query('companyId') companyId: string,
    @Param('id') id: string,
    @Query('format') format: 'xml' | 'ascii' = 'xml',
    @Query('download') download: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');
    const filing = await this.ustva.getFiling(companyId, id);
    if (!filing) throw new BadRequestException('Filing not found');

    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) throw new BadRequestException('Company not found');
    if (!company.taxId) {
      throw new BadRequestException(
        'Steuernummer im Firmenprofil fehlt. Bitte unter "Einstellungen" ergänzen.',
      );
    }

    // Recompute the live data (don't trust the persisted
    // snapshot — invoices/expenses can have changed since
    // the draft was saved). Use the saved period + the
    // current companyId to re-run compute().
    const live = await this.ustva.compute(companyId, filing.year, filing.quarter ?? undefined, filing.month ?? undefined);

    const filename = `UStVA_${filing.year}${filing.quarter ? `_Q${filing.quarter}` : filing.month ? `_${String(filing.month).padStart(2, '0')}` : ''}_${company.name.replace(/[^A-Za-z0-9]/g, '_')}.${format === 'ascii' ? 'txt' : 'xml'}`;

    if (download === '1' || download === 'true') {
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    }

    if (format === 'ascii') {
      // Override the Content-Type for ASCII preview
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return generateUstvaAsciiPreview({
        data: live,
        taxNumber: company.taxId,
        companyName: company.name,
        filingId: filing.id,
        berichtigt: filing.berichtigt,
      });
    }

    return generateUstvaElsterXml({
      data: live,
      taxNumber: company.taxId,
      companyName: company.name,
      filingId: filing.id,
      berichtigt: filing.berichtigt,
    });
  }

  // ─── Tier 105: UStJA — Umsatzsteuerjahreserklärung
  // The annual consolidation of the 12 monthly UStVAs.
  // The user files this with the Finanzamt by 31.07.
  // of the following year (§ 149 AO); the 12 UStVAs
  // are Vorauszahlungen on the same liability.
  //
  // v1: read-only preview (no save). v2: native
  // ELSTER-XML export similar to the UStVA path
  // above. The PDF is for the Mandant's records +
  // for the Berater packager.
  // ────────────────────────────────────────────────
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('ustja')
  @Require('ustva.read')
  async getUstja(
    @Query('companyId') companyId: string,
    @Query('year') yearStr: string,
  ) {
    if (!companyId || !yearStr) {
      throw new BadRequestException('companyId and year are required')
    }
    const year = parseInt(yearStr, 10)
    return this.ustja.compute(companyId, year)
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('ustja.pdf')
  @Require('ustva.read')
  @Header('Content-Type', 'application/pdf')
  async getUstjaPdf(
    @Res() res: Response,
    @Query('companyId') companyId: string,
    @Query('year') yearStr: string,
  ) {
    if (!companyId || !yearStr) {
      throw new BadRequestException('companyId and year are required')
    }
    const year = parseInt(yearStr, 10)
    await this.ustja.renderPdf(companyId, year, res)
  }

  // ─── Tier 107: UStJA ELSTER XML ────────────────
  // The annual USt return as a Datenlieferung
  // packet suitable for ELSTER upload. Same
  // envelope as the UStVA path; the AnlageName
  // is "AnlageUStJA" + the Zeitraum is the full
  // calendar year (no Quartal or Monat). The
  // BMF has required UStJA submission via ELSTER
  // since 2024.
  //
  // Query params:
  //   companyId — required
  //   year      — required
  //   format    — optional, "xml" (default) or "ascii"
  //   download  — optional, "1" to force attachment
  // ────────────────────────────────────────────────
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('ustja/elster-xml')
  @Require('ustva.read')
  @Header('Content-Type', 'application/xml; charset=utf-8')
  async getUstjaElsterXml(
    @Res({ passthrough: true }) res: Response,
    @Query('companyId') companyId: string,
    @Query('year') yearStr: string,
    @Query('format') format?: 'xml' | 'ascii',
    @Query('download') download?: string,
  ) {
    if (!companyId || !yearStr) {
      throw new BadRequestException('companyId and year are required')
    }
    const year = parseInt(yearStr, 10)
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
    })
    if (!company) {
      throw new BadRequestException('Firma nicht gefunden')
    }
    if (!company.taxId) {
      throw new BadRequestException(
        'Steuernummer im Firmenprofil fehlt. Bitte unter "Einstellungen" ergänzen.',
      )
    }
    // Recompute the live data (don't trust a
    // persisted snapshot — invoices/expenses
    // can have changed since the last compute).
    const data = await this.ustja.compute(companyId, year)
    const filename = `UStJA_${year}_${company.name.replace(/[^A-Za-z0-9]/g, '_')}.${format === 'ascii' ? 'txt' : 'xml'}`
    if (download === '1' || download === 'true') {
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    }
    if (format === 'ascii') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      return generateUstjaAsciiPreview({
        data,
        taxNumber: company.taxId,
        companyName: company.name,
      })
    }
    return generateUstjaElsterXml({
      data,
      taxNumber: company.taxId,
      companyName: company.name,
    })
  }
}
