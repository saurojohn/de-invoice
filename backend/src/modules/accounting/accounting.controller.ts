import { Controller, Get, Post, Put, Param, Query, Body, Res, Header, Req, BadRequestException, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AccountService } from './account.service';
import { VoucherService } from './voucher.service';
import { generateVoucherPDF } from '../../accounting/voucher-pdf.service';
import { EuerService } from './euer.service';
import { GobdArchiveService } from './gobd-archive.service';
import { HeaderAuthGuard } from '../../auth/header-auth.guard';
import { PrismaService } from '../../prisma/prisma.service';

@Controller('accounting')
export class AccountingController {
  constructor(
    private accountService: AccountService,
    private voucherService: VoucherService,
    private euer: EuerService,
    private gobd: GobdArchiveService,
    private prisma: PrismaService,
  ) {}

  // ========== Accounts ==========
  @Get('accounts')
  async listAccounts(@Query('companyId') companyId: string) {
    if (!companyId) {
      return { error: 'companyId ist erforderlich' };
    }
    return this.accountService.findAll(companyId);
  }

  @Post('accounts')
  async createAccount(@Body() body: any) {
    return this.accountService.create(body);
  }

  @Get('accounts/seed')
  async seedAccounts(@Query('companyId') companyId: string) {
    if (!companyId) {
      return { error: 'companyId ist erforderlich' };
    }
    return this.accountService.seedDefaultAccounts(companyId);
  }

  // ========== Vouchers ==========

  /**
   * Tier 41: GET /accounting/vouchers/cost-center-suggestion
   *
   * Returns the top-1 most-used cost-center pair the
   * company has stamped on VoucherLines for the given
   * Sachkonto. The Voucher create form hits this on
   * every account-pick so the user sees "your last 28
   * bookings on 4970 used Kostenstelle VERTRIEB-100"
   * instead of having to retype it.
   *
   * Pure read — does NOT persist any state. The user's
   * final choice lands via the regular /vouchers POST.
   *
   * Path is mounted BEFORE `@Get('vouchers/:id')` and
   * `@Get('vouchers')` so neither swallows the literal
   * "cost-center-suggestion" segment.
   */
  @Get('vouchers/cost-center-suggestion')
  async suggestVoucherCostCenter(
    @Query('companyId') companyId: string,
    @Query('accountId') accountId: string,
    @Query('prefix') prefix?: string,
    @Query('costObjectPrefix') costObjectPrefix?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    if (!accountId) throw new BadRequestException('accountId ist erforderlich')
    // Tier 49: optional `prefix` and `costObjectPrefix`
    // narrow the candidate pool. Empty string means
    // "no filter" (matches all rows). When both are
    // present, the suggestion is constrained to lines
    // where costCenter starts with `prefix` AND
    // costObject starts with `costObjectPrefix`.
    return this.voucherService.suggestCostCenter(
      companyId,
      accountId,
      prefix,
      costObjectPrefix,
    )
  }

  /**
   * Tier 41: GET /accounting/vouchers/cost-center-suggestion/list
   * (Full distinct list with counts — for the dropdown.)
   *
   * Tier 49: optional `prefix` and `costObjectPrefix`
   * narrow the candidate pool. The Berater form uses
   * this for the autocomplete dropdown under the
   * cost-center input — typing "VER" narrows the
   * suggestions to "VERTRIEB" / "VERTRIEB-100" etc.
   */
  @Get('vouchers/cost-center-suggestion/list')
  async listVoucherCostCenters(
    @Query('companyId') companyId: string,
    @Query('accountId') accountId: string,
    @Query('prefix') prefix?: string,
    @Query('costObjectPrefix') costObjectPrefix?: string,
    @Query('take') takeRaw?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    if (!accountId) throw new BadRequestException('accountId ist erforderlich')
    const take = Math.min(Math.max(Number(takeRaw) || 20, 1), 100)
    const rows = await this.voucherService.listCostCenters(
      companyId,
      accountId,
      prefix,
      costObjectPrefix,
      take,
    )
    return { items: rows, count: rows.length }
  }

  @Get('vouchers')
  async listVouchers(
    @Query('companyId') companyId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('status') status?: string,
    @Query('referenceType') referenceType?: string,
    @Query('search') search?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    if (!companyId) {
      return { error: 'companyId ist erforderlich' };
    }
    return this.voucherService.findAll(companyId, {
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      status,
      referenceType,
      search,
      take: take ? Number(take) : undefined,
      skip: skip ? Number(skip) : undefined,
    });
  }

  @Get('vouchers/:id')
  async getVoucher(@Param('id') id: string, @Query('companyId') companyId: string) {
    if (!companyId) {
      return { error: 'companyId ist erforderlich' };
    }
    return this.voucherService.findOne(id, companyId);
  }

  @Post('vouchers')
  async createVoucher(
    @Body() body: any,
    @Req() req: any,
  ) {
    // Pick up the user id from the auth context.
    // HeaderAuthGuard is opt-in (not global), so
    // req.user may be unset — fall back to the
    // x-user-id header directly. If neither is
    // present, leave createdById undefined; the
    // Voucher is still created and the Berater
    // column just shows blank.
    const createdById =
      req?.user?.id || req?.headers?.['x-user-id'] || body.createdById;
    return this.voucherService.create({
      ...body,
      createdById,
      date: new Date(body.date),
    });
  }

  @Post('vouchers/generate/:invoiceId')
  async generateVoucherFromInvoice(
    @Param('invoiceId') invoiceId: string,
    @Query('companyId') companyId: string,
  ) {
    if (!companyId) {
      return { error: 'companyId ist erforderlich' };
    }
    return this.voucherService.generateFromInvoice(invoiceId, companyId);
  }

  @Put('vouchers/:id/status')
  async updateVoucherStatus(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Body() body: { status: string },
  ) {
    if (!companyId) {
      return { error: 'companyId ist erforderlich' };
    }
    if (body.status === 'voided') {
      return this.voucherService.void(id, companyId);
    }
    return this.voucherService.findOne(id, companyId);
  }

  /**
   * Create a GoBD Korrekturbeleg (Storno-Buchung) for
   * a Voucher. The original Voucher is NOT mutated —
   * a new Voucher is created with all lines negated
   * and referenceType='VoucherReversal', linked back
   * to the original via the Voucher.reversedById
    * self-relation. Body carries an optional reason
    * that gets prepended to the Storno description.
    */
  @Post('vouchers/:id/reversal')
  async createReversal(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Body() body: { reason?: string },
  ) {
    if (!companyId) {
      return { error: 'companyId ist erforderlich' };
    }
    return this.voucherService.createReversal(
      id,
      companyId,
      body?.reason,
    );
  }

  /**
   * Tier 42: POST /vouchers/:id/correct — Atomically
   * reverse + replace a posted Voucher with a Korrektur
   * (K-booking). Replaces the manual 3-step flow with one
   * request, while keeping full GoBD §146 AO immutability:
   * the original is never modified, the reversal is appended,
   * and the new K-voucher carries the corrected lines.
   *
   * See VoucherService.correct() for the transactional
   * details. Body:
   *
   *   {
   *     date: 'YYYY-MM-DDTHH:mm:ssZ',         // today, but
   *                                            // takeable
   *     description?: 'Korrektur …',
   *     reason?: 'Grund für Korrektur',       // goes into
   *                                            // both vouchers'
   *                                            // descriptions
   *     lines: [
   *       {
   *         accountId, debit, credit, description,
   *         vatRate?, vatAmount?,
   *         costCenter?, costObject?           // Tier 41
   *       },
   *       ...
   *     ]
   *   }
   *
   * Response: { reversal, correction } — both Vouchers
   * with their line breakdowns, full edges intact.
   */
  @Post('vouchers/:id/correct')
  async correctVoucher(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Body() body: {
      date?: string;
      description?: string;
      reason?: string;
      lines: Array<{
        accountId: string;
        debit?: number;
        credit?: number;
        description?: string;
        vatRate?: number;
        vatAmount?: number;
        costCenter?: string;
        costObject?: string;
      }>;
    },
  ) {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich');
    }
    if (!body || !Array.isArray(body.lines) || body.lines.length === 0) {
      throw new BadRequestException(
        'lines[] ist erforderlich (mindestens 2 Positionen)',
      );
    }
    return this.voucherService.correct(id, companyId, {
      date: body.date ? new Date(body.date) : new Date(),
      description: body.description,
      reason: body.reason,
      lines: body.lines,
    });
  }

  /**
   * Download the Voucher as a Buchungsbeleg PDF
   * (single page, German layout). The audit-trail
   * footer references the source invoice, the bank
   * transaction, and the original statement file
   * so the Beleg a Berater hands the tax auditor
   * is self-contained.
   */
  @Get('vouchers/:id/pdf')
  @Header('Content-Type', 'application/pdf')
  async downloadVoucherPdf(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Res() res: Response,
  ) {
    try {
      if (!companyId) {
        res.status(400).json({ error: 'companyId is required' });
        return;
      }
      const voucher = await this.voucherService.findOne(id, companyId);
      const company = await this.prisma.company.findUnique({
        where: { id: companyId },
      });
      if (!company) {
        res.status(404).json({ error: 'Company not found' });
        return;
      }

      // Build the audit-trail summary for the PDF
      // footer. The order of preference mirrors the
      // Berater's primary use case: a bank-import
      // Voucher is a customer payment → the
      // invoice + bank-txn + raw statement are all
      // relevant. A Storno Voucher points at the
      // original recon.
      const recon = voucher.bankReconciliations[0] || voucher.reversalOf[0];
      const bankTxn = recon?.bankTransaction || voucher.bankTransactions[0];

      const pdfBuffer = await generateVoucherPDF({
        voucherNumber: voucher.voucherNumber,
        date: voucher.date,
        description: voucher.description,
        referenceType: voucher.referenceType,
        status: voucher.status,
        lines: voucher.lines.map((l) => ({
          // Tier 26.3: l.account is now optional
          // (nullable accountId). Pass undefined
          // so the PDF renders the placeholder
          // instead of crashing.
          accountNumber: l.account?.accountNumber,
          accountName: l.account?.name,
          description: l.description,
          debit: Number(l.debit),
          credit: Number(l.credit),
        })),
        auditTrail: {
          invoiceNumber: recon?.invoice?.invoiceNumber || voucher.invoiceRef?.invoiceNumber || null,
          bankTxnValueDate: bankTxn?.valueDate ? bankTxn.valueDate.toISOString() : null,
          bankTxnAmount: bankTxn?.amount != null ? Number(bankTxn.amount) : null,
          bankTxnCounterparty: bankTxn?.counterpartyName || null,
          sourceFileName: bankTxn?.statement?.fileName || null,
          sourceFileFormat: bankTxn?.statement?.format || null,
        },
        company: {
          name: company.name,
          legalName: company.legalName,
        },
      });

      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${voucher.voucherNumber}.pdf"`,
        'Content-Length': pdfBuffer.length,
      });
      res.end(pdfBuffer);
    } catch (e: any) {
      console.error('Voucher PDF generation error:', e);
      // Headers may already be set — just end the
      // response with an error if we can.
      if (!res.headersSent) {
        res.status(500).json({ error: 'PDF generation failed' });
      } else {
        res.end();
      }
    }
  }

  /**
   * Tier 76: Anlage EÜR (Einnahmen-Überschuss-Rechnung).
   *
   * Returns the EÜR for a given year as JSON:
   *   - einnahmen[]    per-Kennziffer revenue lines
   *   - ausgaben[]     per-Kennziffer expense lines
   *   - totals         einnahmenTotal / ausgabenTotal / gewinn
   *   - counts         invoices + expenses
   *   - disclaimer     the "vom Steuerberater prüfen
   *                    lassen" notice (UI displays it
   *                    next to the table)
   *
   * `year` defaults to the previous calendar year
   * (the EÜR is typically filed for the just-ended
   * year in early Q1 of the next).
   *
   * Note: we explicitly add HeaderAuthGuard here
   * (and on /euer.pdf) instead of relying on a
   * class-level @Auth() — the rest of the
   * accounting controller is intentionally opt-in
   * for backward compat. The EÜR exposes revenue
   * + expense totals, so a missing guard would
   * leak the company's full P&L to anyone with
   * the URL.
   */
  @Get('euer')
  @UseGuards(HeaderAuthGuard)
  async getEuer(
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const year = yearRaw
      ? Number(yearRaw)
      : new Date().getFullYear() - 1
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    return this.euer.compute(companyId, year)
  }

  /**
   * Tier 76: Anlage EÜR PDF.
   *
   * Single-page A4 PDF with the same Kennziffer
   * breakdown as the JSON endpoint, formatted in
   * a print-friendly layout. The PDF is a
   * VORSCHAU (preview) — the disclaimer in the
   * footer is the same one the Berater wants to
   * see before signing.
   */
  @Get('euer.pdf')
  @UseGuards(HeaderAuthGuard)
  @Header('Content-Type', 'application/pdf')
  async getEuerPdf(
    @Res() res: Response,
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const year = yearRaw
      ? Number(yearRaw)
      : new Date().getFullYear() - 1
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    await this.euer.renderPdf(companyId, year, res)
  }

  /**
   * Tier 77: GoBD Document Archive (§ 147 AO).
   *
   * Streams a ZIP archive containing every
   * invoice PDF, every expense meta + receipt
   * attachment, the DATEV Buchungsstapel CSV,
   * the audit log, and a MANIFEST.json with
   * SHA-256 hashes. The Mandant hands this to
   * the Berater at year-end or to the
   * Betriebsprüfer during a tax audit.
   *
   * Returns application/zip. The archive is
   * generated on demand (no pre-stored archives
   * — the source data is the DB, so storing
   * pre-built copies would just duplicate the
   * storage cost).
   *
   * The GoBD § 147 AO 10-year retention is
   * satisfied as long as the source data is in
   * the DB. The archive itself is a snapshot
   * export — losing the ZIP doesn't lose the
   * underlying records, but the Berater
   * appreciates having the immutable copy
   * for offline review.
   */
  @Get('gobd-archive')
  @UseGuards(HeaderAuthGuard)
  async getGobdArchive(
    @Res() res: Response,
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const year = yearRaw
      ? Number(yearRaw)
      : new Date().getFullYear() - 1
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    await this.gobd.streamArchive(companyId, year, res)
  }

  /**
   * Tier 77: GoBD archive summary.
   *
   * Returns counts + totals without building
   * the ZIP. Used by the UI to show the user
   * what's in the archive BEFORE they download
   * (a multi-MB download is much more pleasant
   * after a confirmation dialog).
   */
  @Get('gobd-archive/summary')
  @UseGuards(HeaderAuthGuard)
  async getGobdArchiveSummary(
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const year = yearRaw
      ? Number(yearRaw)
      : new Date().getFullYear() - 1
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    return this.gobd.getSummary(companyId, year)
  }
}