import { Controller, Get, Post, Put, Param, Query, Body, Res, Header, Req, BadRequestException, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AccountService } from './account.service';
import { VoucherService } from './voucher.service';
import { generateVoucherPDF } from '../../accounting/voucher-pdf.service';
import { EuerService } from './euer.service';
import { AnlageSService } from './anlage-s.service';
// Tier 92: Anlage V (Vermietung und Verpachtung).
import { AnlageVService } from './anlage-v.service';
// Tier 98: Anlage KAP (Kapitalerträge,
// § 20 EStG). Sibling of Anlage S / V.
import { AnlageKAPService } from './anlage-kap.service'
// Tier 100: Anlage G (Gewerbebetrieb,
// § 15 EStG). The 4th Anlage form — for
// gewerbliche Einzelunternehmen +
// Personengesellschaften. Pairs with EÜR.
import { AnlageGService } from './anlage-g.service'
// Tier 101: Anlage N (Arbeitnehmereinkünfte,
// § 3 EStG). The 5th Anlage form — for
// Arbeitnehmer + Beamte + Teilzeit-Beschäftigte.
import { AnlageNService } from './anlage-n.service';
import { BilanzService } from './bilanz.service';
import { GuVService } from './guv.service';
import { AnhangService } from './anhang.service';
import { BeraterPackagerService } from './berater-packager.service';
import { EBilanzService } from './ebilanz.service';
import { GobdArchiveService } from './gobd-archive.service';
import { HeaderAuthGuard } from '../../auth/header-auth.guard';
import { PrismaService } from '../../prisma/prisma.service';

@Controller('accounting')
export class AccountingController {
  constructor(
    private accountService: AccountService,
    private voucherService: VoucherService,
    private euer: EuerService,
    private anlageS: AnlageSService,
    private anlageV: AnlageVService,
    // Tier 98: Anlage KAP (Kapitalerträge,
    // § 20 EStG) — sibling of Anlage S / V.
    private anlageKAP: AnlageKAPService,
    // Tier 100: Anlage G (Gewerbebetrieb,
    // § 15 EStG) — 4th Anlage form.
    private anlageG: AnlageGService,
    // Tier 101: Anlage N (Arbeitnehmereinkünfte,
    // § 3 EStG) — 5th Anlage form.
    private anlageN: AnlageNService,
    private bilanz: BilanzService,
    private guv: GuVService,
    private anhang: AnhangService,
    private beraterPackager: BeraterPackagerService,
    private ebilanz: EBilanzService,
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
   * Tier 80: Anlage S — Einkünfte aus selbständiger
   * Arbeit (§ 18 EStG). The freelancer / self-
   * employed counterpart to the EÜR (which is for
   * § 15 EStG Gewerbebetrieb). Same Kennziffer
   * vocabulary on the revenue side; expense side
   * is shifted to the typical freelance
   * deductible categories (Kfz, Fortbildung,
   * Steuerberatung, etc.).
   *
   * Defaults: previous calendar year. Year
   * validation matches /euer.
   */
  @Get('anlage-s')
  @UseGuards(HeaderAuthGuard)
  async getAnlageS(
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
    return this.anlageS.compute(companyId, year)
  }

  @Get('anlage-s.pdf')
  @UseGuards(HeaderAuthGuard)
  @Header('Content-Type', 'application/pdf')
  async getAnlageSPdf(
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
    await this.anlageS.renderPdf(companyId, year, res)
  }

  /**
   * Tier 92: Anlage V — Einkünfte aus
   * Vermietung und Verpachtung (§ 21 EStG).
   * The German tax filing for landlords /
   * Vermieter. v1 heuristic: ALL paid/sent/
   * overdue invoices in the year are treated
   * as Mieteinnahmen (assumes the user has
   * one company per Vermietung use case).
   *
   * The 8600 Gebäude-AfA line is preferred
   * from the booked AfA-Buchung rows (tier 87),
   * falling back to the in-memory computed
   * AfA from the Anlagenverzeichnis if no
   * booking exists. Same preference order as
   * Anlage S 4600.
   *
   * Defaults: previous calendar year. Year
   * validation matches /euer.
   */
  @Get('anlage-v')
  @UseGuards(HeaderAuthGuard)
  async getAnlageV(
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
    return this.anlageV.compute(companyId, year)
  }

  @Get('anlage-v.pdf')
  @UseGuards(HeaderAuthGuard)
  @Header('Content-Type', 'application/pdf')
  async getAnlageVPdf(
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
    await this.anlageV.renderPdf(companyId, year, res)
  }

  // =============================================================
  // Tier 98 — Anlage KAP (Kapitalerträge, § 20 EStG)
  // =============================================================
  //
  // The German tax filing for investment
  // income: a year-end attachment to the
  // Einkommensteuererklärung. Pairs with Anlage
  // S (freelancer) and Anlage V (Vermietung).
  // The 25% Abgeltungssteuer is normally
  // deducted at source by the bank / depot —
  // the Anlage KAP declares the gross + the
  // Sparer-Pauschbetrag (1000 EUR) so the
  // Finanzamt can apply the allowance.
  //
  // v1 heuristic: bank transactions with
  // "Zins" / "Dividende" / "Ausschüttung" in
  // the purpose field are tentatively classified
  // as Kapitalerträge. The user adjusts in
  // their ELSTER submission.
  @Get('anlage-kap')
  @UseGuards(HeaderAuthGuard)
  async getAnlageKAP(
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
  ) {
    if (!companyId)
      throw new BadRequestException('companyId ist erforderlich')
    const year = yearRaw
      ? Number(yearRaw)
      : new Date().getFullYear() - 1
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    return this.anlageKAP.compute(companyId, year)
  }

  @Get('anlage-kap.pdf')
  @UseGuards(HeaderAuthGuard)
  @Header('Content-Type', 'application/pdf')
  async getAnlageKAPPdf(
    @Res() res: Response,
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
  ) {
    if (!companyId)
      throw new BadRequestException('companyId ist erforderlich')
    const year = yearRaw
      ? Number(yearRaw)
      : new Date().getFullYear() - 1
    if (!Number.isFinite(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    await this.anlageKAP.renderPdf(companyId, year, res)
  }

  // =============================================================
  // Tier 100 — Anlage G (Gewerbebetrieb, § 15 EStG)
  // =============================================================
  //
  // The German tax filing for gewerbliche
  // Einzelunternehmen + Personengesellschaften.
  // Pairs with the EÜR: the EÜR computes
  // Einnahmen - Betriebsausgaben, Anlage G adds
  // the § 8/9 GewStG Hinzurechnungs-/Kürzungs-
  // mechanism to derive the Gewerbeertrag.
  //
  // The 4th Anlage form (after S / V / KAP).
  // Capital companies (GmbH/AG) file a separate
  // KSt 1 instead — Anlage G is for
  // einkommensteuer-pflichtige entities.
  //
  // v1 heuristic: All paid/sent/overdue invoices
  // in the year are gewerbliche Umsatzerlöse.
  // § 8/9 GewStG Korrekturen: only 4100 (25%
  // Hinzurechnung Miete/Pacht) and 5100 (50%
  // Kürzung Kfz-Nutzungsanteil) are computed;
  // the rest is placeholder.
  @Get('anlage-g')
  @UseGuards(HeaderAuthGuard)
  async getAnlageG(
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const year = yearRaw
      ? Number(yearRaw)
      : new Date().getFullYear() - 1
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    return this.anlageG.compute(companyId, year)
  }

  @Get('anlage-g.pdf')
  @UseGuards(HeaderAuthGuard)
  @Header('Content-Type', 'application/pdf')
  async getAnlageGPdf(
    @Res() res: Response,
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const year = yearRaw
      ? Number(yearRaw)
      : new Date().getFullYear() - 1
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    await this.anlageG.renderPdf(companyId, year, res)
  }

  // =============================================================
  // Tier 101 — Anlage N (Arbeitnehmereinkünfte, § 3 EStG)
  // =============================================================
  //
  // The German tax filing for Arbeitnehmer
  // (employees) + Beamte (civil servants) +
  // Teilzeit-Beschäftigte (part-time workers).
  // Pairs with the Lohnsteuerbescheinigung
  // (annual wage tax certificate issued by
  // the employer). The 5th Anlage form
  // (after S / V / KAP / G).
  //
  // v1: data comes from
  // Company.settings.lohnsteuerbescheinigungen
  // (per-year map of BMF Kz values). The
  // Werbungskosten / Sonderausgaben / aB
  // come from the same settings (per-year
  // map keyed by Kz). v1: user enters these
  // manually via the section's input form.
  //
  // For a Mandant without any employment
  // income (e.g. pure Freelancer with no
  // side job), the section is empty + the
  // Berater packager skips it.
  @Get('anlage-n')
  @UseGuards(HeaderAuthGuard)
  async getAnlageN(
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const year = yearRaw
      ? Number(yearRaw)
      : new Date().getFullYear() - 1
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    return this.anlageN.compute(companyId, year)
  }

  @Get('anlage-n.pdf')
  @UseGuards(HeaderAuthGuard)
  @Header('Content-Type', 'application/pdf')
  async getAnlageNPdf(
    @Res() res: Response,
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const year = yearRaw
      ? Number(yearRaw)
      : new Date().getFullYear() - 1
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }
    await this.anlageN.renderPdf(companyId, year, res)
  }

  // Tier 101: PUT /anlage-n/settings — Update the
  // per-year Lohnsteuerbescheinigung + Werbungs-
  // kosten + Sonderausgaben + aB. Body:
  //   { year: 2026, bruttoArbeitslohn, lohnsteuer,
  //     soli, kirchensteuer, rv, av, kv, pv,
  //     werbungskosten: { 140: 1500, 170: 200, ... },
  //     sonderausgaben: { 200: 2000, ... },
  //     aussergewoehnlicheBelastungen: { 230: 500, ... } }
  // The endpoint stores these on
  // Company.settings.{lohnsteuerbescheinigungen,
  // werbungskosten, sonderausgaben,
  // aussergewoehnlicheBelastungen}[year].
  // Auth: HeaderAuthGuard (same as the GET).
  @Put('anlage-n/settings')
  @UseGuards(HeaderAuthGuard)
  async updateAnlageNSettings(
    @Query('companyId') companyId: string,
    @Body() body: {
      year: number
      bruttoArbeitslohn?: number
      lohnsteuer?: number
      soli?: number
      kirchensteuer?: number
      rentenversicherung?: number
      arbeitslosenversicherung?: number
      krankenversicherung?: number
      pflegeversicherung?: number
      werbungskosten?: Record<string, number>
      sonderausgaben?: Record<string, number>
      aussergewoehnlicheBelastungen?: Record<string, number>
    },
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    if (!body || !Number.isInteger(body.year) || body.year < 2000 || body.year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
    })
    if (!company) throw new BadRequestException('Firma nicht gefunden')

    const settings = ((company as any).settings ?? {}) as Record<string, any>
    const lsbAll = (settings.lohnsteuerbescheinigungen as any) || {}
    const wkAll = (settings.werbungskosten as any) || {}
    const saAll = (settings.sonderausgaben as any) || {}
    const abAll = (settings.aussergewoehnlicheBelastungen as any) || {}

    const lsbUpdate: any = {
      bruttoArbeitslohn: Number(body.bruttoArbeitslohn) || 0,
      lohnsteuer: Number(body.lohnsteuer) || 0,
      soli: Number(body.soli) || 0,
      kirchensteuer: Number(body.kirchensteuer) || 0,
      rentenversicherung: Number(body.rentenversicherung) || 0,
      arbeitslosenversicherung: Number(body.arbeitslosenversicherung) || 0,
      krankenversicherung: Number(body.krankenversicherung) || 0,
      pflegeversicherung: Number(body.pflegeversicherung) || 0,
    }
    lsbAll[body.year] = lsbUpdate
    if (body.werbungskosten) wkAll[body.year] = body.werbungskosten
    if (body.sonderausgaben) saAll[body.year] = body.sonderausgaben
    if (body.aussergewoehnlicheBelastungen) {
      abAll[body.year] = body.aussergewoehnlicheBelastungen
    }

    const next = {
      ...settings,
      lohnsteuerbescheinigungen: lsbAll,
      werbungskosten: wkAll,
      sonderausgaben: saAll,
      aussergewoehnlicheBelastungen: abAll,
    }
    await this.prisma.company.update({
      where: { id: companyId },
      data: { settings: next } as any,
    })

    return {
      ok: true,
      year: body.year,
      lohnsteuerbescheinigung: lsbUpdate,
      werbungskosten: wkAll[body.year] || {},
      sonderausgaben: saAll[body.year] || {},
      aussergewoehnlicheBelastungen: abAll[body.year] || {},
    }
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

  /**
   * Tier 81: Bilanz (Balance Sheet) VORSCHAU.
   *
   * Year-end snapshot of Aktiva + Passiva for
   * Bilanz-pflichtige entities (GmbH, AG, etc.
   * per § 264 HGB). v1 only computes positions
   * we can derive from existing data; the rest
   * is "nicht ausgewiesen" with explanatory
   * notes. The Berater completes the missing
   * positions before filing.
   *
   * The Saldoposten in the Eigenkapital section
   * balances the Bilanzgleichung. The user /
   * Berater replaces it with the real equity
   * from the SKR03 / Handelsregister.
   */
  @Get('bilanz')
  @UseGuards(HeaderAuthGuard)
  async getBilanz(
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
    return this.bilanz.compute(companyId, year)
  }

  @Get('bilanz.pdf')
  @UseGuards(HeaderAuthGuard)
  @Header('Content-Type', 'application/pdf')
  async getBilanzPdf(
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
    await this.bilanz.renderPdf(companyId, year, res)
  }

  /**
   * Tier 82: Anlage G+V (Gewinn- und Verlustrechnung).
   *
   * § 275 HGB Gesamtkostenverfahren (GKV) — the
   * canonical income statement that pairs with
   * the Bilanz for Bilanz-pflichtige entities.
   * The Berater (Steuerberater) attaches the G+V
   * to the Jahresabschluss (§ 242 HGB) and
   * files it with the Bundesanzeiger for
   * Kapitalgesellschaften.
   *
   * v1 computes the positions that map directly
   * to Invoice + Expense + CustomerCredit data
   * (Umsatzerlöse, Material-/Personal-/sonstige
   * Aufwendungen, Sonstige betr. Erträge,
   * Zinsaufwendungen); the rest is "nicht
   * ausgewiesen" with explanatory notes. The
   * Jahresüberschuss is the bottom line — it
   * should match the year-over-year change in
   * Bilanz Eigenkapital minus capital movements.
   *
   * Year defaults to previous calendar year,
   * matching the EÜR / Anlage S / Bilanz.
   */
  @Get('guv')
  @UseGuards(HeaderAuthGuard)
  async getGuV(
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
    return this.guv.compute(companyId, year)
  }

  @Get('guv.pdf')
  @UseGuards(HeaderAuthGuard)
  @Header('Content-Type', 'application/pdf')
  async getGuVPdf(
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
    await this.guv.renderPdf(companyId, year, res)
  }

  /**
   * Tier 84: Anhang zum Jahresabschluss (§ 284 HGB).
   *
   * The third part of the Bilanz-pflichtige
   * entity's Jahresabschluss. Pulls from the
   * BilanzService + GuVService to cross-
   * reference the position values + the
   * "nicht ausgewiesen" notes. The
   * Pflichtangaben section is marked
   * "vom Berater zu ergänzen" — the Berater
   * fills in the § 285 HGB disclosures
   * (Haftungsverhältnisse, related-party,
   * events after BS date, etc.).
   *
   * Year defaults to previous calendar year,
   * matching the Bilanz + G+V endpoints.
   */
  @Get('anhang')
  @UseGuards(HeaderAuthGuard)
  async getAnhang(
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
    return this.anhang.compute(companyId, year)
  }

  @Get('anhang.pdf')
  @UseGuards(HeaderAuthGuard)
  @Header('Content-Type', 'application/pdf')
  async getAnhangPdf(
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
    await this.anhang.renderPdf(companyId, year, res)
  }

  /**
   * Tier 85: Anlage Steuererklärung packager.
   *
   * Bundles every VORSCHAU report a Berater
   * needs at year-end into a single ZIP:
   * EÜR + Anlage S + Bilanz + G+V + Anhang +
   * Anlagenverzeichnis (CSV) + MANIFEST.md.
   * The Mandant hands this ZIP to the Berater
   * at the year-end meeting.
   *
   * Streaming archiver (same pattern as
   * GoBD-Archiv): the client starts receiving
   * bytes before the whole archive is built.
   * The packager renders all 5 PDFs in
   * parallel via PassThrough fake-Response
   * (a stand-in for `res` that captures bytes
   * instead of writing to HTTP).
   */
  @Get('berater-packager')
  @UseGuards(HeaderAuthGuard)
  async getBeraterPackager(
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
    await this.beraterPackager.streamPackage(companyId, year, res)
  }

  // ----------------------------------------------------------------
  // Tier 88: E-Bilanz (XBRL) — BMF
  // eBilanz-in-xtml VORSCHAU.
  //
  // 3 routes — declared in this order so the
  // literal paths (ebilanz / ebilanz.xml /
  // ebilanz.pdf) don't collide with any
  // future :id pattern.
  // ----------------------------------------------------------------

  /**
   * JSON preview of the eBilanz mapping
   * table for the year. Returns per-position
   * { elementId, label, value, source,
   *   computed, note } + the company
   *   stammdaten + counts (X of Y
   *   Pflichtpositionen berechnet).
   *
   * The frontend /dashboard/accounting tab
   * hits this to render the mapping table +
   * the count summary.
   */
  @Get('ebilanz')
  @UseGuards(HeaderAuthGuard)
  async getEBilanz(
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
    return this.ebilanz.compute(companyId, year)
  }

  /**
   * eBilanz-in-xtml XBRL instance document.
   * The Berater downloads this and (after
   * adding the BMF taxonomy schemaRef +
   * filling the placeholder positions)
   * uploads it to ELSTER Mein-ELSTER.
   *
   * Content-Type: application/xml (NOT
   * application/xbrl — that's for the
   * taxonomy XSD, not the instance
   * document). The file extension is .xbrl
   * per BMF convention.
   */
  @Get('ebilanz.xml')
  @UseGuards(HeaderAuthGuard)
  @Header('Content-Type', 'application/xml; charset=utf-8')
  async getEBilanzXml(
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
    const xml = await this.ebilanz.renderXml(companyId, year)
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="EBilanz-${year}.xbrl"`,
    )
    res.send(xml)
  }

  /**
   * Human-readable PDF preview of the
   * eBilanz mapping table. The Berater
   * reviews this before uploading the .xbrl
   * file to ELSTER.
   */
  @Get('ebilanz.pdf')
  @UseGuards(HeaderAuthGuard)
  @Header('Content-Type', 'application/pdf')
  async getEBilanzPdf(
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
    await this.ebilanz.renderPdf(companyId, year, res)
  }
}