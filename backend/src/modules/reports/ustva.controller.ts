import { Controller, Get, Post, Put, Delete, Body, Query, Param, BadRequestException, Header, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { UstvaService } from './ustva.service';
import { UstjaService } from './ustja.service';
import {
  generateUstvaElsterXml,
  generateUstvaAsciiPreview,
  generateUstjaElsterXml,
  generateUstjaAsciiPreview,
  normaliseSteuernummer,
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

  // Save (draft or submit)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('filings')
  @Require('ustva.submit')
  async saveFiling(
    @Query('companyId') companyId: string,
    @Body() body: any,
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
    const year = yearStr ? parseInt(yearStr, 10) : undefined;
    const quarter = quarterStr ? parseInt(quarterStr, 10) : undefined;
    const month = monthStr ? parseInt(monthStr, 10) : undefined;
    return this.ustva.listExpenses(companyId, year, quarter, month);
  }

  @Post('expenses')
  @Require('accounting.create')
  async createExpense(@Query('companyId') companyId: string, @Body() body: any) {
    if (!companyId) throw new BadRequestException('companyId is required');
    if (!body.description || !body.invoiceDate || body.netAmount === undefined) {
      throw new BadRequestException('description, invoiceDate, netAmount are required');
    }
    if (body.vatAmount === undefined) {
      // Auto-compute VAT if not given
      body.vatAmount = Number((body.netAmount * (body.vatRate || 0.19)).toFixed(2));
    }
    if (body.grossAmount === undefined) {
      body.grossAmount = Number(body.netAmount) + Number(body.vatAmount);
    }
    return this.ustva.createExpense(companyId, {
      supplierId: body.supplierId,
      invoiceNumber: body.invoiceNumber,
      description: body.description,
      invoiceDate: new Date(body.invoiceDate),
      netAmount: Number(body.netAmount),
      vatRate: Number(body.vatRate ?? 0.19),
      vatAmount: Number(body.vatAmount),
      grossAmount: Number(body.grossAmount),
      category: body.category,
      isIntraEU: body.isIntraEU ?? false,
      isReverseCharge: body.isReverseCharge ?? false,
      notes: body.notes,
    });
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
      });
    }

    return generateUstvaElsterXml({
      data: live,
      taxNumber: company.taxId,
      companyName: company.name,
      filingId: filing.id,
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
