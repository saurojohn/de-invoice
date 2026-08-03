import { BadRequestException, Controller, Get, Post, Put, Delete, Body, Param, Query, Header, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CustomerService, ImportCustomerRow } from './customer.service';
import { CustomerStatementService } from './customer-statement.service';
import { CustomerStatementBatchService } from './customer-statement-batch.service';
import { CreditBalanceService } from './credit-balance.service';
import { CreateCustomerDto } from './dto/customer.dto';
import { Auth, Require } from '../../auth/roles.decorator';

@Auth()
@Controller('customers')
export class CustomerController {
  constructor(
    private customerService: CustomerService,
    private statementService: CustomerStatementService,
    private batchStatementService: CustomerStatementBatchService,
    private creditBalanceService: CreditBalanceService,
  ) {}

  @Get()
  @Require('customer.read')
  async findAll(
    @Query('companyId') companyId: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
  ) {
    this.assertCompanyId(companyId)
    return this.customerService.findAll(companyId, {
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      search,
    });
  }

  @Get('next-number')
  @Require('customer.read')
  async previewNextNumber(@Query('companyId') companyId: string) {
    this.assertCompanyId(companyId)
    return this.customerService.previewNextCustomerNumber(companyId)
  }

  /**
   * Tier 20.2: batch Kontoauszug export — generates one PDF
   * per active customer for the date range, packaged as a
   * ZIP alongside an index.csv (customer list + balances)
   * and a summary.txt (generation metadata).
   *
   * Use case: month-end statements to all customers in one
   * click instead of N page loads.
   *
   * Order matters: this route must be registered BEFORE
   * `:id` routes so NestJS doesn't try to match
   * "statements-batch" as a customer id (it would fail the
   * UUID validation in the service and 404 anyway, but
   * explicit ordering avoids the spurious attempt + log
   * noise).
   */
  @Get('statements-batch')
  @Require('customer.read')
  async statementsBatch(
    @Query('companyId') companyId: string,
    @Query('from') fromStr: string,
    @Query('to') toStr: string,
    @Query('order') order: string,
    @Res() res: Response,
  ) {
    this.assertCompanyId(companyId)
    const { from, to } = this.parseStatementRange(fromStr, toStr)
    const dir = this.parseOrder(order)

    const result = await this.batchStatementService.generateBatch({
      companyId,
      from,
      to,
      order: dir,
    })

    const fromStr2 = fromStr.replace(/-/g, '')
    const toStr2 = toStr.replace(/-/g, '')
    const fname = `Kontoauszug_Batch_${fromStr2}_${toStr2}.zip`

    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${fname}"`,
      'Content-Length': String(result.zipBuffer.length),
    })
    res.send(result.zipBuffer)
  }

  // ── Tier 58: customer credit balance (Kundenguthaben) ─────

  /**
   * Tier 61: customer detail-page summary endpoint. Returns
   * the customer row + a flat stats object that the
   * detail page can render in one round-trip. The drill-down
   * tabs (Rechnungen / Ratenpläne / Mahnungen) call their
   * own endpoints for the full lists — this summary is just
   * the "KPI strip" at the top of the page:
   *
   *   - open balance (sum of unpaid invoices)
   *   - overdue count (sent invoices past dueDate, not
   *     already covered by a Skonto window — Tier 57)
   *   - last invoice date + number
   *   - last payment date + amount
   *   - active installment plan count
   *   - open Mahnung count (any status='open' rows)
   *   - credit balance (Kundenguthaben) — Tier 58
   *
   * The path is declared BEFORE the `:id` route so Nest
   * doesn't capture "summary" as a customer id (lesson
   * memory: Nest route-order is declaration order, not
   * parameter-vs-literal preference).
   */
  @Get(':id/summary')
  @Require('customer.read')
  async summary(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
  ) {
    this.assertCompanyId(companyId)
    return this.customerService.summary(id, companyId)
  }

  /**
   * Tier 144: email-Verlauf for one customer.
   *
   * Returns every email the system has sent to
   * this customer: invoice mails, Mahnung
   * letters, Kontoauszug emails, bulk-send
   * batches. Filter sources:
   *   - invoice.customerId = id  (most common)
   *   - recipientEmail = customer.email
   *     (catches standalone emails)
   *
   * Optional filters:
   *   - status (sent / opened / bounced / failed)
   *   - templateType (invoice / reminder / statement / ...)
   *   - from / to (date range on createdAt)
   *   - skip / take (pagination, max 200)
   */
  @Get(':id/emails')
  @Require('customer.read')
  async emails(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Query('status') status?: string,
    @Query('templateType') templateType?: string,
    @Query('from') fromStr?: string,
    @Query('to') toStr?: string,
    @Query('skip') skipStr?: string,
    @Query('take') takeStr?: string,
  ) {
    this.assertCompanyId(companyId)
    const opts: any = {}
    if (status) opts.status = status
    if (templateType) opts.templateType = templateType
    if (fromStr) {
      const d = new Date(fromStr)
      if (isNaN(d.getTime()))
        throw new BadRequestException('Invalid from (expected ISO 8601)')
      opts.from = d
    }
    if (toStr) {
      const d = new Date(toStr)
      if (isNaN(d.getTime()))
        throw new BadRequestException('Invalid to (expected ISO 8601)')
      opts.to = d
    }
    if (skipStr) {
      const n = parseInt(skipStr, 10)
      if (isNaN(n) || n < 0)
        throw new BadRequestException('Invalid skip')
      opts.skip = n
    }
    if (takeStr) {
      const n = parseInt(takeStr, 10)
      if (isNaN(n) || n < 1 || n > 200)
        throw new BadRequestException('Invalid take (1-200)')
      opts.take = n
    }
    return this.customerService.getEmails(id, companyId, opts)
  }

  /**
   * Current credit balance (Kundenguthaben) for a customer.
   * Returns the signed sum of all ledger rows: positive =
   * customer has credit owed (e.g. overpaid an invoice),
   * negative = customer owes the difference (Berater manual
   * adjustments can go either way). EUR.
   *
   * Mirrors the response shape used elsewhere on this
   * controller (flat object, snake_case keys) so the
   * frontend can use a single parser.
   */
  @Get(':id/credit-balance')
  @Require('customer.read')
  async creditBalance(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
  ) {
    this.assertCompanyId(companyId)
    return this.creditBalanceService.getCreditBalance(companyId, id)
  }

  /**
   * Full ledger (Kundenguthaben-Bewegungen) for a customer,
   * oldest first. Each row carries `balanceAfter` so the UI
   * can render a running balance with a single linear pass.
   *
   * Use case: the customer detail page's "Guthaben-Verlauf"
   * tab — shows overpayments, Gutschrift overages, payouts,
   * apply-to-invoice and manual adjustments in chronological
   * order.
   */
  @Get(':id/credit-ledger')
  @Require('customer.read')
  async creditLedger(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
  ) {
    this.assertCompanyId(companyId)
    return this.creditBalanceService.getLedger(companyId, id)
  }

  /**
   * Issue an Auszahlung (refund) to the customer. Posts a
   * double-entry Voucher (1800 Bank Soll / 1210 Forderungen
   * Haben) AND a ledger row that reduces the credit
   * balance. The Voucher becomes part of the Buchungsjournal
   * and the DATEV export.
   *
   * Body:
   *   amount          number    required, > 0
   *   paymentDate     ISO date  required
   *   bankAccountId   string    required (Sachkonto 1800-style)
   *   description     string    optional, defaults to
   *                              "Auszahlung Guthaben an <name>"
   *   createdById     string    optional, used for audit
   *
   * Returns the Voucher + ledger row IDs and the new balance.
   *
   * Permission: `customer.update` (the same Berater who can
   * adjust customer master data can also issue a refund — the
   * action is reversible by deleting the Voucher, but the
   * ledger row stays for the audit trail).
   */
  @Post(':id/credit-payout')
  @Require('customer.update')
  async creditPayout(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Body() body: {
      amount: number;
      paymentDate: string;
      bankAccountId: string;
      description?: string;
      createdById?: string;
    },
  ) {
    this.assertCompanyId(companyId)
    if (!body || typeof body.amount !== 'number' || !body.paymentDate || !body.bankAccountId) {
      throw new BadRequestException(
        'amount, paymentDate, bankAccountId sind erforderlich',
      )
    }
    return this.creditBalanceService.payout(companyId, id, {
      amount: body.amount,
      paymentDate: new Date(body.paymentDate),
      bankAccountId: body.bankAccountId,
      description: body.description,
      createdById: body.createdById,
    })
  }

  /**
   * Apply credit balance to a specific invoice. Reduces the
   * invoice's open balance by `amount` (capped at the
   * current open balance), records a synthetic Payment row
   * with `paymentMethod='Guthaben'` for the customer
   * statement + aging report, and writes a negative ledger
   * entry. If the credit closes the invoice entirely, the
   * status flips to 'paid'.
   *
   * Body: { invoiceId, amount, createdById? }
   */
  @Post(':id/apply-credit')
  @Require('customer.update')
  async applyCredit(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Body() body: {
      invoiceId: string;
      amount: number;
      createdById?: string;
    },
  ) {
    this.assertCompanyId(companyId)
    if (!body || !body.invoiceId || typeof body.amount !== 'number') {
      throw new BadRequestException('invoiceId und amount sind erforderlich')
    }
    return this.creditBalanceService.applyToInvoice(
      companyId, id, body.invoiceId, body.amount, body.createdById,
    )
  }

  /**
   * Berater manual adjustment of the credit balance. Both
   * signs supported: positive `amount` adds credit, negative
   * uses it. Always records as type='manual' so the audit
   * trail can distinguish Berater overrides from system-
   * generated events.
   *
   * Body: { amount (signed), description, createdById? }
   * `description` is required and stored verbatim — the
   * Berater must leave a note explaining WHY.
   */
  @Post(':id/credit-adjust')
  @Require('customer.update')
  async creditAdjust(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Body() body: {
      amount: number;
      description: string;
      createdById?: string;
    },
  ) {
    this.assertCompanyId(companyId)
    if (!body || typeof body.amount !== 'number' || !body.description) {
      throw new BadRequestException('amount und description sind erforderlich')
    }
    return this.creditBalanceService.manualAdjustment(
      companyId, id, {
        amount: body.amount,
        description: body.description,
        createdById: body.createdById,
      },
    )
  }

  @Get(':id')
  @Require('customer.read')
  async findOne(@Param('id') id: string, @Query('companyId') companyId: string) {
    this.assertCompanyId(companyId)
    return this.customerService.findOne(id, companyId);
  }

  @Post()
  @Require('customer.create')
  async create(@Query('companyId') companyId: string, @Body() data: CreateCustomerDto) {
    this.assertCompanyId(companyId)
    return this.customerService.create(companyId, data);
  }

  @Put(':id')
  @Require('customer.update')
  async update(@Param('id') id: string, @Query('companyId') companyId: string, @Body() data: any) {
    this.assertCompanyId(companyId)
    return this.customerService.update(id, companyId, data);
  }

  /**
   * Verify this customer's VAT ID against VIES.
   * The detail page's "USt-ID prüfen" button hits
   * this. Returns the VIES result + log id (the
   * frontend can read `status` to show the badge
   * and `cached` to show "frisch geprüft" vs
   * "aus Cache"). We use POST (not GET) because
   * it's a side-effectful operation that writes
   * to VatValidationLog — even though there's no
   * "form" body, POST is the right verb here.
   */
  @Post(':id/verify-vat')
  @Require('customer.update')
  async verifyVat(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
  ) {
    this.assertCompanyId(companyId)
    return this.customerService.verifyVatId(id, companyId)
  }

  /**
   * VIES check history for a single customer.
   * Returns { latest, history } — the latest is
   * what the detail page's badge shows, the
   * history is the "Verlauf" tab content. Same
   * shape as VatValidationService's own endpoint
   * but co-located on the customer so the detail
   * page can hit one URL.
   */
  @Get(':id/vat-history')
  @Require('customer.read')
  async vatHistory(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Query('limit') limitStr?: string,
  ) {
    this.assertCompanyId(companyId)
    return this.customerService.vatHistory(
      id, companyId,
      limitStr ? Math.min(50, Math.max(1, Number(limitStr))) : 20,
    )
  }

  // ── Tier 20: Kontoauszug (Customer statement) ──────────

  /**
   * Generate the JSON Kontoauszug for a customer over a date
   * range. Returns the unified timeline (invoices + credits +
   * payments), opening/closing balances, and totals — used
   * by the on-screen statement page.
   *
   * Date format: ISO 8601 (YYYY-MM-DD). The dates are
   * interpreted in the company's local timezone — for now
   * we just use UTC midnight (good enough for B2B monthly
   * statements where day boundaries rarely cross midnight).
   *
   * Tenant isolation: customerId is scoped by companyId
   * (NotFoundException if mismatched).
   */
  @Get(':id/statement')
  @Require('customer.read')
  async statement(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Query('from') fromStr: string,
    @Query('to') toStr: string,
    @Query('order') order?: string,
  ) {
    this.assertCompanyId(companyId)
    const { from, to } = this.parseStatementRange(fromStr, toStr)
    return this.statementService.generate(
      companyId, id, from, to,
      this.parseOrder(order),
    )
  }

  /**
   * Generate the Kontoauszug as a downloadable PDF.
   * Same query params as :id/statement.
   * Filename: `Kontoauszug_<CustomerNumber>_<from>_<to>.pdf`.
   */
  @Get(':id/statement.pdf')
  @Require('customer.read')
  async statementPdf(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Query('from') fromStr: string,
    @Query('to') toStr: string,
    @Query('order') order: string,
    @Res() res: Response,
  ) {
    this.assertCompanyId(companyId)
    const { from, to } = this.parseStatementRange(fromStr, toStr)
    const data = await this.statementService.generate(
      companyId, id, from, to,
      this.parseOrder(order),
    )
    const { generateStatementPdf } = await import(
      './customer-statement-pdf.service'
    )
    const pdf = await generateStatementPdf(data)
    const customerNum = data.customer.customerNumber || data.customer.id.slice(0, 8)
    const fname = `Kontoauszug_${customerNum}_${fromStr}_${toStr}.pdf`
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${fname}"`,
      'Content-Length': String(pdf.length),
    })
    res.send(pdf)
  }

  /**
   * Parse + validate the from/to query params.
   * - Both required (we don't default — silent defaults lead
   *   to surprising statements that don't match the user's
   *   mental model).
   * - from must be ≤ to (else 400).
   * - Range capped at 24 months (a 5-year statement would
   *   produce a 200+ row PDF and a 5MB response).
   */
  private parseStatementRange(fromStr: string, toStr: string) {
    if (!fromStr || !toStr) {
      throw new BadRequestException('from and to are required (ISO 8601 YYYY-MM-DD)')
    }
    const from = new Date(fromStr + 'T00:00:00.000Z')
    const to = new Date(toStr + 'T23:59:59.999Z')
    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      throw new BadRequestException('Invalid from/to (expected YYYY-MM-DD)')
    }
    if (from > to) {
      throw new BadRequestException('from must be ≤ to')
    }
    const months = (to.getFullYear() - from.getFullYear()) * 12 +
      (to.getMonth() - from.getMonth())
    if (months > 24) {
      throw new BadRequestException('Statement range cannot exceed 24 months')
    }
    return { from, to }
  }

  /**
   * Parse the `?order=` query param.
   *   - absent / empty → DESC (default, newest first)
   *   - 'desc' / 'DESC' → DESC
   *   - 'asc' / 'ASC'  → ASC (chronological paper-trail order)
   * Anything else → 400.
   *
   * Why default DESC: customers open a statement wanting to
   * see the latest activity and current balance first. ASC
   * is the accountant's view (chronological posting order);
   * we keep it as an opt-in for paper-ledger exports.
   */
  private parseOrder(order?: string): 'asc' | 'desc' {
    if (!order) return 'desc'
    const lower = order.toLowerCase()
    if (lower === 'asc' || lower === 'desc') return lower
    throw new BadRequestException(
      `Invalid order='${order}' (expected 'asc' or 'desc')`,
    )
  }

  @Delete(':id')
  @Require('customer.delete')
  async remove(@Param('id') id: string, @Query('companyId') companyId: string) {
    this.assertCompanyId(companyId)
    return this.customerService.remove(id, companyId);
  }

  /**
   * Bulk-import customers from a CSV-like array of rows.
   * The frontend parses the CSV (Papa Parse, etc.) and posts the
   * resulting array of objects here. We do the server-side validation
   * and dedup against existing customers.
   *
   * Returns a per-row summary: `{ total, imported, skipped, errors }`.
   */
  @Post('import')
  @Require('customer.create')
  async import(
    @Query('companyId') companyId: string,
    @Body() body: {
      rows: ImportCustomerRow[]
      verifyVat?: boolean
      maxVatVerifications?: number
    },
  ) {
    this.assertCompanyId(companyId)
    if (!body || !Array.isArray(body.rows)) {
      throw new BadRequestException('rows array is required')
    }
    if (body.rows.length > 5000) {
      throw new BadRequestException('Maximal 5000 Zeilen pro Import')
    }
    return this.customerService.importBulk(companyId, body.rows, {
      // Default ON. The service caps at 10 by default
      // so the import response stays under 90s even
      // with VIES at its slowest. The frontend can
      // opt out by passing verifyVat: false (useful
      // for bulk migrations where the user will
      // re-verify interactively later).
      verifyVat: body.verifyVat ?? true,
      maxVatVerifications: body.maxVatVerifications,
    })
  }

  /**
   * CSV template for customer import — column names in
   * German + 3 example rows (one business with full
   * address, one private without VAT ID, one with
   * paymentTerms override). UTF-8 + BOM for Excel.
   */
  @Get('import/template.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="kunden-import.csv"')
  getTemplate(): string {
    return [
      'name;vatId;type;street;postalCode;city;country;email;phone;paymentTerms;taxExempt;tags',
      'Beispiel GmbH;DE123456789;business;Beispielweg 1;12345;Berlin;DE;rechnung@beispiel.de;+49 30 12345;30;false;B2C;Standard',
      'Maria Mustermann;;private;Musterstraße 7;80331;München;DE;maria@example.org;;0;false;Privat',
      'Firma XYZ AG;DE987654321;business;Industriestraße 5;60311;Frankfurt;DE;info@xyz.de;+49 69 99999;14;true;Großkunde',
    ].join('\n')
  }

  /**
   * Normalise the "companyId required" guard to a 400 instead of
   * an unhandled 500. Every public route on this controller calls
   * this, so a missing header (e.g. the user picked the wrong API
   * base or the request came from a script that forgot the param)
   * becomes a clean error message in the UI.
   */
  private assertCompanyId(companyId?: string | null) {
    if (!companyId || !companyId.trim()) {
      throw new BadRequestException('companyId is required')
    }
  }
}
