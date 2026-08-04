import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { WebhookService } from '../webhook/webhook.service';
import { CreateInvoiceDto, UpdateInvoiceDto } from './dto/invoice.dto';
// Tier 58: when a Gutschrift (CN) amount exceeds the original
// invoice's remaining open balance, the overage becomes credit
// balance (Kundenguthaben) instead of "overpaying" the original
// past zero. The CN row itself carries the full refund amount
// (so the USt-Voranmeldung sees the right number) and a
// separate ledger entry books the overage.
import { CreditBalanceService } from '../customer/credit-balance.service';
// Tier 118: multi-currency. For non-EUR invoices, the create
// flow looks up the cached ECB rate and stores the EUR
// equivalent on the row (eurSubtotal / eurTotalVat / eurTotal).
// The original currency + original totals stay on the row for
// the PDF / XRechnung / customer-facing display. The EUR
// amounts are what EÜR / UStVA / BWA / GuV aggregate over.
import { ExchangeRateService } from '../exchange-rate/exchange-rate.service';

export type InvoiceType = 'INV' | 'CN' | 'PI' | 'RCV';

export interface StockWarning {
  productId: string;
  productName: string;
  available: number;
  required: number;
}

@Injectable()
export class InvoiceService {
  constructor(
    private prisma: PrismaService,
    private webhooks: WebhookService,
    // Tier 58: see class-level comment above.
    private creditBalance: CreditBalanceService,
    // Tier 118: see class-level comment above.
    private exchangeRates: ExchangeRateService,
  ) {}

  /**
   * Paginated invoice list with optional filters.
   * Search matches invoice number and customer name (case-insensitive).
   * Returns `{ data, total, page, pageSize, totalPages }`.
   */  async findAll(
    companyId: string,
    filters: {
      status?: string;
      customerId?: string;
      type?: string;
      page?: number;
      pageSize?: number;
      search?: string;
      dateFrom?: string;
      dateTo?: string;
    } = {},
  ) {
    const { status, customerId, type, page, pageSize, search, dateFrom, dateTo } = filters
    const pg = Math.max(1, page ?? 1)
    const ps = Math.min(200, Math.max(1, pageSize ?? 50))
    const skip = (pg - 1) * ps

    const where: any = { companyId }
    if (status) where.status = status
    if (customerId) where.customerId = customerId
    if (type) where.type = type
    // Date range filter on issueDate. Use gte/lte on ISO date strings
    // (YYYY-MM-DD) so the same input shape works from the frontend
    // date picker without timezone drift.
    if (dateFrom || dateTo) {
      where.issueDate = {}
      if (dateFrom) where.issueDate.gte = new Date(`${dateFrom}T00:00:00.000Z`)
      if (dateTo) where.issueDate.lte = new Date(`${dateTo}T23:59:59.999Z`)
    }
    if (search && search.trim()) {
      const q = search.trim()
      where.OR = [
        { invoiceNumber: { contains: q, mode: 'insensitive' } },
        { customer: { name: { contains: q, mode: 'insensitive' } } },
      ]
    }
    const [data, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        include: { customer: true, items: true, payments: true, referenceInvoice: true },
        orderBy: { createdAt: 'desc' },
        skip,
        take: ps,
      }),
      this.prisma.invoice.count({ where }),
    ])
    return {
      data,
      total,
      page: pg,
      pageSize: ps,
      totalPages: Math.ceil(total / ps) || 1,
    }
  }

  /**
   * Tier 150: find possible duplicate invoices.
   *
   * The admin is creating a new invoice with
   * amount X for customer C on date D. We
   * look for any existing invoice that
   * matches (customer=C, amount≈X, date≈D)
   * and return them. The frontend shows them
   * in a "Possible duplicate" warning banner.
   *
   * Tolerance:
   *   - amount: within 0.01 EUR (handles float
   *     rounding — two invoices totalling
   *     119.0000 vs 119.0001 should match)
   *   - date: within ±7 days (catches the
   *     common case of "I think I issued this
   *     Tuesday but I already did Wednesday")
   *
   * We do NOT count cancelled invoices
   * (status='cancelled') as duplicates — they
   * were voided for a reason, and surfacing
   * them would create false positives.
   *
   * Type filter: only INV + PI. Credit notes
   * (CN) and receipts (RCV) are different
   * documents, not duplicates.
   */
  async findDuplicates(
    companyId: string,
    customerId: string,
    amount: number,
    from: Date,
    to: Date,
  ) {
    // Look 1 cent above and below the input
    // amount. Prisma's Decimal column doesn't
    // support `Math.abs(...)` on the server
    // side directly via the typed query API,
    // so we use a small "epsilon" range.
    const epsilon = 0.01
    const rows = await this.prisma.invoice.findMany({
      where: {
        companyId,
        customerId,
        type: { in: ['INV', 'PI'] },
        status: { not: 'cancelled' },
        total: { gte: amount - epsilon, lte: amount + epsilon },
        issueDate: { gte: from, lte: to },
      },
      orderBy: { issueDate: 'desc' },
      take: 10,
      select: {
        id: true,
        invoiceNumber: true,
        type: true,
        status: true,
        total: true,
        currency: true,
        issueDate: true,
        customer: { select: { id: true, name: true } },
      },
    })
    return {
      matches: rows.map((r) => ({
        id: r.id,
        invoiceNumber: r.invoiceNumber,
        type: r.type,
        status: r.status,
        total: Number(r.total),
        currency: r.currency,
        issueDate: r.issueDate,
        customer: r.customer,
      })),
      count: rows.length,
    }
  }

  /**
   * Same filters as findAll() but without pagination. Used for exports
   * (CSV / ZIP) where the user expects the full result set, not just
   * the current page.
   */
  async findForExport(
    companyId: string,
    filters: {
      status?: string;
      type?: string;
      dateFrom?: string;
      dateTo?: string;
    } = {},
  ) {
    const { status, type, dateFrom, dateTo } = filters
    const where: any = { companyId }
    if (status) where.status = status
    if (type) where.type = type
    if (dateFrom || dateTo) {
      where.issueDate = {}
      if (dateFrom) where.issueDate.gte = new Date(`${dateFrom}T00:00:00.000Z`)
      if (dateTo) where.issueDate.lte = new Date(`${dateTo}T23:59:59.999Z`)
    }
    return this.prisma.invoice.findMany({
      where,
      include: { customer: true, items: true, payments: true, referenceInvoice: true },
      orderBy: { issueDate: 'asc' },
    })
  }

  async findOne(id: string, companyId: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, companyId },
      include: {
        // Company is included so the detail page can render the
        // sender letterhead (logo, name, address) — both on screen
        // and for browser print. Excluding it would force a second
        // round-trip to /companies/:id from the frontend.
        company: true,
        customer: true,
        items: { include: { product: { select: { sku: true, name: true } } } },
        payments: true,
        referenceInvoice: true,
      },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');
    return invoice;
  }

  async checkStockForItems(items: { productId?: string; quantity: number }[]): Promise<StockWarning[]> {
    const warnings: StockWarning[] = [];

    for (const item of items) {
      if (!item.productId) continue;

      const product = await this.prisma.product.findUnique({
        where: { id: item.productId },
        select: { name: true, trackInventory: true, stockQuantity: true },
      });

      if (product?.trackInventory) {
        const available = parseFloat(product.stockQuantity.toString());
        if (available < item.quantity) {
          warnings.push({
            productId: item.productId,
            productName: product.name,
            available,
            required: item.quantity,
          });
        }
      }
    }

    return warnings;
  }

  async recordInventorySale(invoiceId: string, items: { productId: string; quantity: number }[]) {
    for (const item of items) {
      if (!item.productId) continue;

      const product = await this.prisma.product.findUnique({
        where: { id: item.productId },
        select: { trackInventory: true, stockQuantity: true },
      });

      if (product?.trackInventory) {
        const currentStock = parseFloat(product.stockQuantity.toString());
        const newStock = Math.max(0, currentStock - item.quantity);

        await this.prisma.$transaction([
          this.prisma.product.update({
            where: { id: item.productId },
            data: { stockQuantity: newStock },
          }),
          this.prisma.productStockHistory.create({
            data: {
              productId: item.productId,
              changeType: 'sale',
              quantity: item.quantity,
              previousQty: currentStock,
              newQty: newStock,
              reference: invoiceId,
              referenceType: 'invoice',
              notes: `Bestandsreduzierung durch Rechnung ${invoiceId}`,
            },
          }),
        ]);
      }
    }
  }

  async create(companyId: string, dto: CreateInvoiceDto) {
    try {
    const type = (dto.type as InvoiceType) || 'INV';

    // Check stock for tracked products and issue warnings
    const stockWarnings = await this.checkStockForItems(dto.items || []);
    const hasStockWarnings = stockWarnings.length > 0;

    // Generate invoice number. The user wants the delete-last-
    // invoice rule to mean the freed-up number is REUSED on
    // the next create (no permanent gap). Combined with the
    // "only the last invoice can be deleted" rule, the
    // simplest correct algorithm is: pick the lowest
    // available sequence number within the current year.
    // That is, find the smallest positive integer s such
    // that (TYPE-YYYY-zeroPad(s)) is not currently in the
    // DB; if all 1..max are taken, use max+1.
    //
    // In SQL terms: a single round-trip with a CTE that
    // generates 1..max and finds the first missing one. We
    // do it in two round-trips (fetch used set + pick gap
    // in JS) because Prisma's raw query for generate_series
    // is awkward and the existing invoice count for a
    // single company+type is small (< 100k in practice).
    const currentYear = new Date().getFullYear()
    const prefix = type === 'CN'
      ? 'CN-'
      : type === 'PI'
      ? 'PI-'
      : type === 'RCV'
      ? 'RCV-'
      : 'INV-'
    const sameYear = await this.prisma.invoice.findMany({
      where: { companyId, type, invoiceNumber: { startsWith: `${prefix}${currentYear}-` } },
      select: { invoiceNumber: true },
    })
    const usedSeqs = new Set<number>()
    for (const inv of sameYear) {
      const m = new RegExp(`^${prefix}${currentYear}-(\\d+)$`).exec(inv.invoiceNumber)
      if (m) usedSeqs.add(parseInt(m[1], 10))
    }
    let nextSeq = 1
    while (usedSeqs.has(nextSeq)) nextSeq++
    const padded = String(nextSeq).padStart(6, '0')
    const invoiceNumber = `${prefix}${currentYear}-${padded}`

    // For Credit Notes, copy customer info from reference invoice if not provided
    let customerId = dto.customerId;
    if (type === 'CN' && dto.referenceInvoiceId && !customerId) {
      const refInvoice = await this.prisma.invoice.findFirst({
        where: { id: dto.referenceInvoiceId, companyId },
      });
      if (refInvoice) {
        customerId = refInvoice.customerId;
      }
    }

    // Tier 28: load the customer once so we can
    // (a) snapshot the customerName onto the
    // Invoice row for full-text search (the
    // tsvector STORED column can't span
    // relations), and (b) keep the customer
    // reference resolution in one place. The
    // snapshot is at issue-time: a later rename
    // of the customer does NOT update historical
    // invoices (the Berater filtering the
    // journal by name sees the original).
    const customer = customerId
      ? await this.prisma.customer.findFirst({
          where: { id: customerId, companyId },
          select: { id: true, name: true },
        })
      : null
    if (customerId && !customer) {
      throw new NotFoundException('Kunde nicht gefunden')
    }

    // Tier 27 validation: §13b and §1a are
    // mutually exclusive. A sale can't be BOTH
    // reverse-charge (recipient in DE, we as
    // supplier pass the Steuerschuld to them)
    // AND innergemeinschaftlich (we sell to an
    // EU business, no DE-side VAT, recipient
    // self-assesses via their IgE Versteuerung).
    // Reject the contradictory request with a
    // 400 — the UI prevents this but a direct
    // API caller could try.
    if (dto.reverseCharge === true && dto.euTransaction === true) {
      throw new BadRequestException(
        'Reverse-Charge (§13b UStG) und Innergemeinschaftliche Lieferung (§1a UStG) schließen sich gegenseitig aus — bitte nur eine USt-Behandlung wählen.',
      )
    }

    // Calculate amounts.
    //
    // VAT is computed on the DISCOUNTED net (per § 12 UStG — the tax
    // base / Bemessungsgrundlage is the net consideration actually
    // received, i.e. subtotal minus any discount granted on the
    // invoice). The previous code applied the discount only to the
    // grand total, which understated VAT and over-reported revenue
    // (e.g. 10% discount with 19% VAT on a €100 line was charged as
    // 19% VAT instead of 19% on €90). The discount is allocated
    // proportionally to each line so per-item tax stays correct.
    const subtotal = dto.items?.reduce((sum, item) => sum + (item.quantity * item.unitPrice), 0) || 0;
    const discountPercent = dto.discountPercent || 0;
    const discountAmount = dto.discountAmount || (discountPercent > 0 ? subtotal * (discountPercent / 100) : 0);
    const discountRatio =
      discountPercent > 0
        ? discountPercent / 100
        : subtotal > 0
        ? discountAmount / subtotal
        : 0;
    const totalVat = dto.items?.reduce((sum, item) => {
      const itemNet = item.quantity * item.unitPrice;
      const discountedNet = itemNet * (1 - discountRatio);
      return sum + (discountedNet * (item.vatRate || 0.19));
    }, 0) || 0;
    const total = subtotal - discountAmount + totalVat;

    // For Credit Notes, total / subtotal / totalVat are all negative
    // — the line items already get negated below. Apply the same sign
    // to the invoice-level totals so the PDF, CSV and dashboard
    // displays stay consistent (previously the items were negative
    // but the header totals were positive, producing visually broken
    // Gutschriften that didn't add up).
    const isCN = type === 'CN';
    const finalSubtotal = isCN ? -subtotal : subtotal;
    const finalTotalVat = isCN ? -totalVat : totalVat;
    const finalTotal = isCN ? -total : total;

    // Parse dates safely
    const issueDate = dto.issueDate ? new Date(dto.issueDate) : new Date();
    const dueDate = dto.dueDate ? new Date(dto.dueDate) : null;
    const deliveryDate = dto.deliveryDate ? new Date(dto.deliveryDate) : null;

    // ──────────────────────────────────────────────────────
    // Tier 118: multi-currency. Look up the ECB rate
    // for the invoice's currency and pre-compute the
    // EUR equivalents at issue time. For EUR invoices
    // the rate is 1.0000 and the EUR amounts mirror
    // the originals.
    //
    // The lookup is best-effort: if no rate is cached
    // yet (the cron hasn't run since the company was
    // created), we fall back to rate=1 and the EUR
    // values mirror the originals. The user can hit
    // the manual "Jetzt aktualisieren" button on the
    // DATEV settings page to populate rates and
    // re-issue affected invoices.
    //
    // For reverse-charge + igE invoices, the EUR
    // conversion still happens — the VAT on these
    // invoices is reported by the buyer, not us, but
    // the invoice total still contributes to EÜR
    // revenue.
    // ──────────────────────────────────────────────────────
    const invoiceCurrency = (dto.currency || 'EUR').toUpperCase()
    let exchangeRateStr = '1.0000'
    if (invoiceCurrency !== 'EUR') {
      try {
        exchangeRateStr = await this.exchangeRates.getRate(companyId, invoiceCurrency)
      } catch (e: any) {
        // Fall through with rate=1.0000 — the
        // invoice is still created, just without
        // an EUR equivalent.
        console.warn(
          `[Tier 118] Failed to look up rate for ${invoiceCurrency}, falling back to 1.0000: ${e?.message}`,
        )
      }
    }
    const exchangeRate = parseFloat(exchangeRateStr)
    // EUR = currency / rate (since rate = 1 EUR = X currency)
    const eurSubtotal =
      invoiceCurrency === 'EUR'
        ? finalSubtotal
        : Math.round((finalSubtotal / exchangeRate) * 10000) / 10000
    const eurTotalVat =
      invoiceCurrency === 'EUR'
        ? finalTotalVat
        : Math.round((finalTotalVat / exchangeRate) * 10000) / 10000
    const eurTotal =
      invoiceCurrency === 'EUR'
        ? finalTotal
        : Math.round((finalTotal / exchangeRate) * 10000) / 10000

    const invoice = await this.prisma.invoice.create({
      data: {
        companyId,
        customerId,
        invoiceNumber,
        issueDate,
        dueDate,
        deliveryDate,
        type: dto.type || 'INV',
        status: 'draft',
        currency: dto.currency || 'EUR',
        language: dto.language || 'de-DE',
        // Tier 118: multi-currency. Pre-computed EUR
        // equivalents for cross-currency aggregation.
        // For EUR invoices all three mirror the
        // originals (rate=1).
        exchangeRate: invoiceCurrency === 'EUR' ? 1.0 : exchangeRate,
        eurSubtotal,
        eurTotalVat,
        eurTotal,
        notes: dto.notes,
        templateType: dto.templateType || 'standard',
        subtotal: finalSubtotal,
        totalVat: finalTotalVat,
        total: finalTotal,
        discountPercent: dto.discountPercent || null,
        discountAmount: discountAmount > 0 ? discountAmount : null,
        // Tier 52: Skonto (cash discount for early
        // payment). Both fields are nullable; the
        // PDF + bank-import auto-match consult them
        // when computing the Erlösminderung. We
        // require BOTH to be set or BOTH null —
        // half-set makes no sense (you can't offer
        // a 2% discount "for some days" without
        // saying how many).
        skontoPercent:
          dto.skontoPercent != null && dto.skontoDays != null
            ? dto.skontoPercent
            : null,
        skontoDays:
          dto.skontoPercent != null && dto.skontoDays != null
            ? dto.skontoDays
            : null,
        // For credit notes, store the link back to the original invoice.
        // The FK is nullable so this is a no-op for INV/PI/RCV.
        referenceInvoiceId: (dto.type === 'CN' && dto.referenceInvoiceId) ? dto.referenceInvoiceId : null,
        // Tier 27: USt-Behandlung. The UI presents a
        // single radio group ("Standard" / "Reverse-
        // Charge" / "IgE"), but on the wire these are
        // two independent booleans — the service
        // rejects the impossible "both true" state
        // below. The two booleans drive the DATEV
        // export (see datev.service.ts buildBuchungen-
        // FromDb for the §1a / §13b branches), the
        // UStVA Kennzahl 41/46, and the PDF footnote
        // text. See the DTO comment for the full
        // semantics.
        reverseCharge: dto.reverseCharge ?? false,
        euTransaction: dto.euTransaction ?? false,
        // Tier 39: DATEV Kostenstelle 1 + Kostenträger
        // stamps. Optional — the column is already on
        // Invoice. Trims whitespace so a stray space at
        // the end doesn't end up baked into the PDF.
        costCenter: dto.costCenter?.trim() || null,
        costObject: dto.costObject?.trim() || null,
        // Tier 28: denormalise the customer name so
        // the Postgres tsvector STORED column
        // (search_tsv) can include it without a
        // relation join. Generated columns can't
        // span relations in PG 16. We snap the name
        // AT ISSUE TIME — historical invoices keep
        // the customer's name even after a rename
        // (the Berater filtering the journal by name
        // sees the name that was on the invoice,
        // not the current name).
        customerName: customer?.name ?? '',
        items: {
          create: dto.items?.map((item, index) => ({
            description: item.description,
            // productId is optional on the DTO (manual line items may
            // not have a product reference) but when the frontend
            // picks a product from the dropdown we MUST persist it.
            // Otherwise the product's usage history is lost and we
            // can't refuse to delete a product that's still on past
            // invoices.
            productId: item.productId || null,
            // Produktnummer / SKU snapshot. Empty string is
            // normalized to null so the column reads cleanly in
            // the DB; the PDF only renders it when set.
            productNumber: item.productNumber?.trim() || null,
            quantity: item.quantity,
            unit: item.unit || 'Stück',
            unitPrice: item.unitPrice,
            vatRate: item.vatRate || 0.19,
            netAmount: type === 'CN' ? -(item.quantity * item.unitPrice) : (item.quantity * item.unitPrice),
            vatAmount: type === 'CN' ? -(item.quantity * item.unitPrice * (item.vatRate || 0.19)) : (item.quantity * item.unitPrice * (item.vatRate || 0.19)),
            grossAmount: type === 'CN'
              ? -(item.quantity * item.unitPrice * (1 + (item.vatRate || 0.19)))
              : (item.quantity * item.unitPrice * (1 + (item.vatRate || 0.19))),
            sortOrder: index,
          })),
        },
      },
      include: { items: true, customer: true, referenceInvoice: true },
    });

    // Record inventory sale for tracked products
    if (type !== 'CN' && type !== 'PI') {
      await this.recordInventorySale(
        invoice.id,
        dto.items?.map(item => ({ productId: item.productId || '', quantity: item.quantity })) || []
      );
    }

    // Return invoice with stock warnings if any
    const result = {
      ...invoice,
      stockWarnings: hasStockWarnings ? stockWarnings : undefined,
    };

    // Fire webhook AFTER the transaction has committed
    // (we're outside the prisma.$transaction block — the
    // create was a single .create() call, so we're good).
    // We don't await — the delivery is fire-and-forget so
    // the API response isn't blocked by the receiver's
    // latency. If the receiver is down, the delivery is
    // retried by the cron worker (see webhook.scheduler.ts).
    //
    // The eventId includes the invoice id so receivers
    // can dedupe if they receive the same event twice
    // (e.g. retry after backend crash).
    this.webhooks
      .emit({
        id: `inv_${result.id}`,
        type: 'invoice.created',
        occurredAt: new Date().toISOString(),
        companyId,
        data: {
          id: result.id,
          invoiceNumber: result.invoiceNumber,
          type: result.type,
          status: result.status,
          customerId: result.customerId,
          total: result.total,
          currency: result.currency,
          issueDate: result.issueDate,
          dueDate: result.dueDate,
        },
      })
      .catch((err) => {
        // emit() is supposed to never throw, but
        // be defensive — an unhandled rejection
        // here would crash the process.
        console.error('webhook emit(invoice.created) failed:', err)
      })

    return result;
    } catch (error) {
      console.error('Invoice creation error:', error);
      throw error;
    }
  }

  async update(id: string, companyId: string, dto: UpdateInvoiceDto) {
    // Same-day edit rule. Once the calendar flips, the invoice is
    // considered "frozen" — the user might have already sent the
    // PDF / email to the customer, and a back-dated edit would
    // silently mismatch the version in the customer's inbox. Only
    // the issueDate-equals-today path is allowed.
    const existing = await this.prisma.invoice.findFirst({
      where: { id, companyId },
    });
    if (!existing) {
      throw new NotFoundException('Rechnung nicht gefunden');
    }
    if (!this.isToday(existing.issueDate)) {
      throw new ForbiddenException(
        'Rechnung kann nur am Ausstellungstag bearbeitet werden. Ältere Rechnungen sind eingefroren — stattdessen eine Gutschrift (CN) erstellen.',
      );
    }

    // Tier 27: same §13b/§1a contradiction
    // guard as on create. The user can switch
    // BETWEEN standard and one of the special
    // treatments in the same-day window, but
    // can't set both to true.
    //
    // The effective state is the new value if
    // the user passed it, otherwise the existing
    // value (so editing only `reverseCharge: true`
    // on an existing IgE invoice is rejected
    // even though only one flag was sent).
    const effectiveRC = dto.reverseCharge ?? existing.reverseCharge
    const effectiveIgE = dto.euTransaction ?? existing.euTransaction
    if (effectiveRC && effectiveIgE) {
      throw new BadRequestException(
        'Reverse-Charge (§13b UStG) und Innergemeinschaftliche Lieferung (§1a UStG) schließen sich gegenseitig aus — bitte nur eine USt-Behandlung wählen.',
      )
    }

    // Recompute totals from items if items were provided. The old
    // items are wiped and replaced (no partial edit — keeps the
    // math simple and matches the create flow).
    let itemsData: any = undefined;
    let totalsData: any = {};
    if (dto.items && dto.items.length > 0) {
      const type = existing.type as InvoiceType;
      const isCN = type === 'CN';
      const discountPercent = dto.discountPercent ?? Number(existing.discountPercent ?? 0);
      const discountAmount = dto.discountAmount ?? Number(existing.discountAmount ?? 0);
      const discountRatio =
        discountPercent > 0
          ? discountPercent / 100
          : dto.items.reduce((s, i) => s + i.quantity * i.unitPrice, 0) > 0
            ? discountAmount / dto.items.reduce((s, i) => s + i.quantity * i.unitPrice, 0)
            : 0;
      const subtotal = dto.items.reduce((s, i) => s + i.quantity * i.unitPrice, 0);
      const totalVat = dto.items.reduce((s, i) => {
        const net = i.quantity * i.unitPrice * (1 - discountRatio);
        return s + net * (i.vatRate || 0.19);
      }, 0);
      const total = subtotal - discountAmount + totalVat;

      itemsData = {
        deleteMany: {},
        create: dto.items.map((item, index) => ({
          description: item.description,
          productId: item.productId || null,
          productNumber: item.productNumber?.trim() || null,
          quantity: item.quantity,
          unit: item.unit || 'Stück',
          unitPrice: item.unitPrice,
          vatRate: item.vatRate || 0.19,
          netAmount: isCN ? -(item.quantity * item.unitPrice) : (item.quantity * item.unitPrice) * (1 - discountRatio),
          vatAmount: isCN ? -(item.quantity * item.unitPrice * (item.vatRate || 0.19)) : (item.quantity * item.unitPrice * (1 - discountRatio)) * (item.vatRate || 0.19),
          grossAmount: isCN
            ? -(item.quantity * item.unitPrice * (1 + (item.vatRate || 0.19)))
            : (item.quantity * item.unitPrice * (1 + (item.vatRate || 0.19))),
          sortOrder: index,
        })),
      };
      totalsData = {
        subtotal: isCN ? -subtotal : subtotal,
        totalVat: isCN ? -totalVat : totalVat,
        total: isCN ? -total : total,
        discountPercent: discountPercent || null,
        discountAmount: discountAmount > 0 ? discountAmount : null,
      };
      // Tier 118: re-compute EUR equivalents on edit
      // when totals change. Currency may have changed
      // too (user can flip EUR ↔ USD on a same-day
      // edit). We re-derive everything from the
      // EFFECTIVE currency (new value if passed, else
      // existing).
      const effectiveCurrency = (dto.currency ?? existing.currency ?? 'EUR').toUpperCase()
      if (effectiveCurrency !== 'EUR') {
        let rateStr = '1.0000'
        try {
          rateStr = await this.exchangeRates.getRate(companyId, effectiveCurrency)
        } catch {
          rateStr = '1.0000'
        }
        const rate = parseFloat(rateStr)
        const t = totalsData
        totalsData = {
          ...t,
          exchangeRate: rate,
          eurSubtotal: Math.round((t.subtotal / rate) * 10000) / 10000,
          eurTotalVat: Math.round((t.totalVat / rate) * 10000) / 10000,
          eurTotal: Math.round((t.total / rate) * 10000) / 10000,
        }
      } else {
        // EUR: rate=1, EUR amounts = originals
        totalsData = {
          ...totalsData,
          exchangeRate: 1.0,
          eurSubtotal: totalsData.subtotal,
          eurTotalVat: totalsData.totalVat,
          eurTotal: totalsData.total,
        }
      }
    }

    return this.prisma.invoice.update({
      where: { id },
      data: {
        // Issue date is the same-day anchor — never editable.
        // Use the relation field (`customer: { connect: {...} }`)
        // instead of the raw `customerId` scalar — Prisma's default
        // checked `InvoiceUpdateInput` doesn't expose customerId
        // directly (it only offers the relation), and the unchecked
        // variant isn't what `.update()` uses by default. Setting
        // `customerId` directly throws "Unknown argument customerId.
        // Did you mean `customer`?".
        ...(dto.customerId ? { customer: { connect: { id: dto.customerId } } } : {}),
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
        deliveryDate: dto.deliveryDate ? new Date(dto.deliveryDate) : undefined,
        notes: dto.notes ?? undefined,
        internalNotes: dto.internalNotes ?? undefined,
        currency: dto.currency ?? undefined,
        language: dto.language ?? undefined,
        templateType: dto.templateType ?? undefined,
        // Tier 39: costCenter + costObject. Trim + coerce
        // empty strings to null so the column reads "null"
        // rather than "" (matches the create flow).
        costCenter:
          dto.costCenter === undefined ? undefined : (dto.costCenter.trim() || null),
        costObject:
          dto.costObject === undefined ? undefined : (dto.costObject.trim() || null),
        // paymentTerms is on Customer, paymentMethod is on Payment
        // — neither lives on Invoice. The frontend form keeps them
        // for UX continuity with the create flow, but Invoice's
        // checked UpdateInput rejects them with "Unknown argument".
        // Drop them here so the update actually persists.
        discountPercent: dto.discountPercent ?? undefined,
        discountAmount: dto.discountAmount ?? undefined,
        // Tier 52: Skonto (cash discount for early
        // payment). Same atomic-pair rule as on
        // create — both fields together or neither.
        // If the user clears only one of them on
        // edit, the OTHER auto-clears to keep the
        // invariant intact.
        skontoPercent:
          dto.skontoPercent != null && dto.skontoDays != null
            ? dto.skontoPercent
            : dto.skontoPercent === null
            ? null
            : undefined,
        skontoDays:
          dto.skontoPercent != null && dto.skontoDays != null
            ? dto.skontoDays
            : dto.skontoDays === null
            ? null
            : undefined,
        // Tier 27: USt-Behandlung editable in
        // same-day edit window. The audit trail
        // (InvoiceEditLog) captures the before/after
        // values, so a Berater can see when an
        // invoice was re-classified (e.g. user
        // accidentally checked RC, then unchecked
        // it the next day if the same-day window is
        // still open).
        reverseCharge: dto.reverseCharge ?? undefined,
        euTransaction: dto.euTransaction ?? undefined,
        ...totalsData,
        ...(itemsData ? { items: itemsData } : {}),
      },
      include: { items: true, customer: true },
    });
  }

  /**
   * Returns true if the given date is today (local server time).
   * Used by the same-day edit gate in update() and by the frontend
   * "is the edit button visible" check — both compare against the
   * invoice's own issueDate, not creation timestamp.
   */
  private isToday(d: Date | string | null): boolean {
    if (!d) return false
    const date = new Date(d)
    if (isNaN(date.getTime())) return false
    const now = new Date()
    return (
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate()
    )
  }

  /**
   * Hard-delete an invoice + everything that hangs off it.
   * - InvoiceItem: relation has onDelete:Cascade, auto-deleted.
   * - Payment: no cascade in the schema (would need a migration),
   *   so we delete them explicitly inside the same transaction so
   *   the FK constraint on Payment.invoiceId doesn't block us.
   * - EmailSend: no FK to invoice (just a free-form invoiceId string
   *   for joining), so it survives — that's fine, it's an audit log.
   * - Inventory: stock movements recorded against this invoice are
   *   also not FK-cascaded, but they're audit records too and stay.
   *   We could add a "revert inventory" step later if needed.
   */
  async delete(id: string, companyId: string) {
    const existing = await this.prisma.invoice.findFirst({
      where: { id, companyId },
    });
    if (!existing) {
      throw new NotFoundException('Rechnung nicht gefunden');
    }
    // Same-day rule applies to delete too. After the calendar
    // flips, the customer may have already received the PDF/email;
    // a hard delete would silently wipe a record that exists in
    // the customer's inbox. Use status='cancelled' for past-date
    // removal of intent (the "soft delete" we had before).
    if (!this.isToday(existing.issueDate)) {
      throw new ForbiddenException(
        'Rechnung kann nur am Ausstellungstag gelöscht werden. Für ältere Rechnungen den Status auf "Storniert" setzen.',
      );
    }
    // Last-invoice rule: only the invoice with the highest
    // invoiceNumber within its (companyId, type) bucket can be
    // deleted. This prevents the user from deleting invoice N
    // and leaving invoice N+1 in the DB — which would create a
    // gap in the sequential numbering and break the
    // "lückenlose fortlaufende Nummerierung" requirement
    // (§146 AO / GoBD).
    //
    // We compare by (year DESC, sequence DESC) so a 2026
    // invoice outranks a 2025 invoice even if the 2025
    // sequence number happens to be numerically larger
    // (e.g. INV-2025-000999 vs INV-2026-000001).
    const sameType = await this.prisma.invoice.findMany({
      where: { companyId, type: existing.type },
      select: { id: true, invoiceNumber: true },
    })
    const parseNumber = (s: string): { year: number; seq: number } => {
      // Format: "INV-2026-000042" → { year: 2026, seq: 42 }
      const m = /^([A-Z]+)-(\d{4})-(\d+)$/.exec(s)
      if (!m) return { year: 0, seq: 0 }
      return { year: parseInt(m[2], 10), seq: parseInt(m[3], 10) }
    }
    const maxEntry = sameType.reduce<{ id: string; year: number; seq: number } | null>(
      (acc, inv) => {
        const p = parseNumber(inv.invoiceNumber)
        if (!acc) return { id: inv.id, ...p }
        if (p.year > acc.year) return { id: inv.id, ...p }
        if (p.year === acc.year && p.seq > acc.seq) return { id: inv.id, ...p }
        return acc
      },
      null
    )
    if (!maxEntry || maxEntry.id !== id) {
      throw new ForbiddenException(
        'Es kann nur die zuletzt erstellte Rechnung gelöscht werden. Für ältere Rechnungen den Status auf "Storniert" setzen.',
      )
    }
    const deleted = await this.prisma.$transaction(async (tx) => {
      await tx.payment.deleteMany({ where: { invoiceId: id } });
      // deleteMany items explicitly even though cascade exists —
      // it's a no-op then, but future-proofs if cascade is removed.
      await tx.invoiceItem.deleteMany({ where: { invoiceId: id } });
      return tx.invoice.delete({ where: { id } });
    });

    // Fire invoice.deleted event with a stable eventId
    // based on the deleted invoice's id. Receivers can
    // see this as a "tombstone" event — the invoice used
    // to exist with this id, and now it doesn't.
    this.webhooks
      .emit({
        id: `inv_${id}`,
        type: 'invoice.deleted',
        occurredAt: new Date().toISOString(),
        companyId,
        data: {
          id: deleted.id,
          invoiceNumber: deleted.invoiceNumber,
          type: deleted.type,
          customerId: deleted.customerId,
        },
      })
      .catch((err) => console.error('webhook emit(invoice.deleted) failed:', err))

    return deleted;
  }

  async updateStatus(id: string, companyId: string, status: string) {
    const before = await this.prisma.invoice.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Rechnung nicht gefunden');

    const updated = await this.prisma.invoice.update({
      where: { id },
      data: { status },
    });

    // Fire invoice.paid ONLY on the draft → paid transition.
    // We don't fire it on every status change because that
    // would spam receivers (sent → paid shouldn't double-fire).
    // If we later add more transitions (e.g. invoice.overdue),
    // they get their own event types.
    //
    // Note: the Invoice model doesn't have a paidDate field —
    // payments are recorded as separate Payment rows. The
    // `updatedAt` timestamp on the invoice is the closest proxy
    // for "when did the user mark this paid?". Receivers that
    // need the actual payment record can fetch
    // `GET /api/v1/invoices/:id/payments`.
    if (before.status !== 'paid' && status === 'paid') {
      this.webhooks
        .emit({
          id: `inv_${id}_paid_${updated.updatedAt?.getTime() ?? Date.now()}`,
          type: 'invoice.paid',
          occurredAt: new Date().toISOString(),
          companyId,
          data: {
            id: updated.id,
            invoiceNumber: updated.invoiceNumber,
            customerId: updated.customerId,
            total: updated.total,
            paidAt: (updated.updatedAt ?? new Date()).toISOString(),
          },
        })
        .catch((err) => console.error('webhook emit(invoice.paid) failed:', err))
    }

    // Fire invoice.sent on the draft → sent transition
    // (e.g. when /api/v1/invoices/:id/send is called).
    if (before.status !== 'sent' && status === 'sent') {
      this.webhooks
        .emit({
          id: `inv_${id}_sent_${updated.updatedAt?.getTime() ?? Date.now()}`,
          type: 'invoice.sent',
          occurredAt: new Date().toISOString(),
          companyId,
          data: {
            id: updated.id,
            invoiceNumber: updated.invoiceNumber,
            customerId: updated.customerId,
            total: updated.total,
          },
        })
        .catch((err) => console.error('webhook emit(invoice.sent) failed:', err))
    }

    // Fire invoice.updated for all OTHER status changes
    // (cancellation, draft revert, etc). Receivers
    // care about the diff, so we include the previous
    // status too.
    if (
      before.status !== status &&
      status !== 'paid' &&
      status !== 'sent'
    ) {
      this.webhooks
        .emit({
          id: `inv_${id}_status_${updated.updatedAt?.getTime() ?? Date.now()}`,
          type: 'invoice.updated',
          occurredAt: new Date().toISOString(),
          companyId,
          data: {
            id: updated.id,
            invoiceNumber: updated.invoiceNumber,
            customerId: updated.customerId,
            previousStatus: before.status,
            newStatus: status,
          },
        })
        .catch((err) => console.error('webhook emit(invoice.updated) failed:', err))
    }

    return updated;
  }

  /**
   * Tier 53: Gutschrift (credit note) generator.
   *
   * Creates a new Invoice with `type='CN'` +
   * `referenceInvoiceId=<original.id>`. Three modes:
   *
   *   1. Full refund: caller passes no `lines` /
   *      `amount`. We mirror every line of the
   *      original with a negative sign — the CN
   *      total equals -original.total.
   *
   *   2. Partial refund with custom lines: caller
   *      passes `lines: [{ description, quantity,
   *      unitPrice, vatRate }]`. We negate unitPrice
   *      so a refund of 100 € is unitPrice=100 (not
   *      -100). The CN total = -sum of (qty * price).
   *
   *   3. Flat amount: caller passes `amount: 100`.
   *      We generate a single "Erstattung" line on
   *      the CN (no VAT) for that exact value.
   *      Useful for "we owe them 50 € back, no
   *      particular line" style refunds.
   *
   * The original invoice's open balance is reduced
   * by the (absolute value of the) CN total. We do
   * NOT mutate the original — the CN is a separate
   * invoice with its own number sequence and audit
   * trail.
   *
   * The original invoice's status flips to 'paid'
   * automatically if the cumulative (payments +
   * |CN|) >= total. The Mahnung service excludes
   * such over-cleared invoices from its next run.
   */
  async createCreditNote(
    originalId: string,
    companyId: string,
    opts: {
      amount?: number
      lines?: Array<{
        description: string
        quantity?: number
        unitPrice: number
        vatRate?: number
      }>
      reason?: string
    },
  ) {
    const original = await this.prisma.invoice.findFirst({
      where: { id: originalId, companyId },
      include: {
        items: { orderBy: { sortOrder: 'asc' } },
        // Tier 58: we need the original's current payment
        // total to compute the open balance — anything
        // beyond the open balance flows to credit balance
        // (Kundenguthaben) instead of "overpaying" the
        // original past zero. The overage would otherwise
        // be silently lost (the synthetic payment row
        // would carry the full CN amount, but the original
        // status flip would clamp at 'paid' and the extra
        // would not be tracked anywhere).
        payments: { select: { amount: true } },
      },
    })
    if (!original) {
      throw new NotFoundException('Originalrechnung nicht gefunden')
    }
    if (original.type === 'CN') {
      // A CN can reference another CN, but the user
      // expectation is "credit to original invoice".
      // Refuse to chain — surface a clear error.
      throw new BadRequestException(
        'Gutschriften können nicht aus weiteren Gutschriften erzeugt werden — bitte die Originalrechnung (Typ INV) auswählen.',
      )
    }
    if (original.status === 'cancelled') {
      throw new BadRequestException(
        'Gutschrift kann nicht zu einer stornierten Rechnung erstellt werden',
      )
    }

    // Build the line items for the CN. Three modes
    // as documented above.
    let cnLines: Array<{
      description: string
      quantity: number
      unitPrice: number
      vatRate: number
    }>
    if (opts.lines && opts.lines.length > 0) {
      // Partial refund: caller-supplied lines. Negate
      // unitPrice so the CN carries negative amounts.
      cnLines = opts.lines.map((l) => ({
        description: l.description,
        quantity: l.quantity ?? 1,
        unitPrice: -Math.abs(Number(l.unitPrice)),
        vatRate: l.vatRate ?? 0.19,
      }))
    } else if (opts.amount != null && opts.amount > 0) {
      // Flat amount: single "Erstattung" line. We
      // don't add VAT — the user can override via
      // lines: [...] if they need a VAT-bearing CN.
      cnLines = [
        {
          description: opts.reason || 'Erstattung',
          quantity: 1,
          unitPrice: -Math.abs(Number(opts.amount)),
          vatRate: 0,
        },
      ]
    } else {
      // Full refund: mirror every line of the original.
      cnLines = original.items.map((it) => ({
        description: it.description,
        quantity: Number(it.quantity),
        unitPrice: -Number(it.unitPrice),
        vatRate: Number(it.vatRate ?? 0.19),
      }))
    }

    // Compute the CN's totals using the same logic as
    // the regular create flow. We use a small inline
    // calculator (we don't have a "negative invoice"
    // create DTO — the create DTO always expects
    // positive unit prices).
    let subtotal = 0
    let totalVat = 0
    for (const l of cnLines) {
      const net = l.quantity * l.unitPrice
      const vat = net * l.vatRate
      subtotal += net
      totalVat += vat
    }
    const total = subtotal + totalVat

    // Allocate a new invoice number on the CN's
    // number sequence. CNs use the same year/month
    // numbering as the original — the prefix
    // differentiates (CN-2026-001).
    const now = new Date()
    const year = now.getFullYear()
    const month = now.getMonth() + 1
    // Count existing CNs this year to set sequence.
    const cnCount = await this.prisma.invoice.count({
      where: {
        companyId,
        type: 'CN',
        sequenceYear: year,
      },
    })
    const sequenceNumber = cnCount + 1
    const invoiceNumber = `CN-${year}-${String(sequenceNumber).padStart(3, '0')}`

    // Create the CN + its items in a single
    // transaction. If the items insert fails, the
    // CN rollbacks and we don't end up with a
    // half-built Gutschrift.
    const cn = await this.prisma.$transaction(async (tx) => {
      const created = await tx.invoice.create({
        data: {
          companyId,
          customerId: original.customerId,
          invoiceNumber,
          sequencePrefix: 'CN',
          sequenceYear: year,
          sequenceMonth: month,
          sequenceNumber,
          type: 'CN',
          status: 'sent',
          issueDate: now,
          dueDate: now,
          subtotal,
          totalVat,
          total,
          // The original is the source — copy over
          // the same cost-center stamps.
          costCenter: original.costCenter,
          costObject: original.costObject,
          referenceInvoiceId: original.id,
          // The CN's own notes line carries the
          // reason (or a default "Gutschrift zu
          // <original.invoiceNumber>").
          notes: opts.reason
            ? `Gutschrift zu ${original.invoiceNumber} — ${opts.reason}`
            : `Gutschrift zu ${original.invoiceNumber}`,
          // CNs don't carry their own Skonto — the
          // original's Skonto already applied (or
          // expired) at the time of the original
          // payment. A subsequent refund is a
          // separate transaction.
          vatBreakdown: this.computeVatBreakdown(cnLines),
          items: {
            create: cnLines.map((l, i) => ({
              description: l.description,
              quantity: l.quantity,
              unit: 'Stück',
              unitPrice: l.unitPrice,
              vatRate: l.vatRate,
              netAmount: l.quantity * l.unitPrice,
              vatAmount: l.quantity * l.unitPrice * l.vatRate,
              grossAmount: l.quantity * l.unitPrice * (1 + l.vatRate),
              sortOrder: i,
              // No costCenter/costObject on CN
              // lines — the original carried the
              // stamps, and refunding doesn't
              // reassign the original cost.
            })),
          },
        },
        include: { items: { orderBy: { sortOrder: 'asc' } } },
      })

      // Reduce the original invoice's open balance
      // by the absolute value of the CN total, capped
      // at the original's current open balance. We
      // do this by adding a synthetic Payment row
      // of type 'credit_note' — that way the
      // payment listing on the original shows
      // exactly what cleared the balance, and the
      // customer statement groups CNs together
      // for the Berater.
      //
      // The Payment.amount is stored as a positive
      // number (the absolute refund value). The
      // PaymentService treats positive amounts as
      // inflows toward the invoice total.
      //
      // Tier 58: the synthetic payment is CAPPED at
      // the original's remaining open balance. The
      // overage (CN total > original remaining) is
      // captured separately as a credit-balance
      // entry by CreditBalanceService.recordGutschriftOverage
      // after this transaction commits. The CN row
      // itself still carries the FULL refund amount
      // (so the USt-Voranmeldung + DATEV export see
      // the right number) — only the synthetic
      // payment is capped.
      const originalPaid = original.payments.reduce(
        (s, p) => s + Number(p.amount),
        0,
      )
      const originalRemaining = Math.max(
        0,
        Number(original.total) - originalPaid,
      )
      const cnAmount = Math.abs(total)
      const syntheticPayment = Math.min(cnAmount, originalRemaining)
      await tx.payment.create({
        data: {
          invoiceId: original.id,
          amount: syntheticPayment,
          paymentDate: now,
          paymentMethod: 'Gutschrift',
          reference: `CN ${invoiceNumber}`,
          notes: `Auto-verrechnet aus Gutschrift ${invoiceNumber}`,
        },
      })
      // Expose the overage to the caller via the
      // created CN row's notes. We don't have a
      // dedicated column for it, but the post-
      // transaction handler below records the
      // credit-balance ledger entry. The notes
      // annotation is purely informational.
      return { ...created, _gutschriftOverage: cnAmount - syntheticPayment }
    })

    // After the transaction: re-check the original's
    // status. If the new cumulative (payments + |CN|)
    // >= total, the original flips to 'paid' and
    // we fire the invoice.paid webhook.
    const updatedOriginal = await this.prisma.invoice.findFirst({
      where: { id: original.id, companyId },
      include: {
        payments: { select: { amount: true } },
      },
    })
    if (updatedOriginal) {
      const paid = updatedOriginal.payments.reduce(
        (s, p) => s + Number(p.amount),
        0,
      )
      if (
        paid >= Number(updatedOriginal.total) &&
        updatedOriginal.status !== 'paid'
      ) {
        await this.updateStatus(original.id, companyId, 'paid')
      }
    }

    // Tier 58: record the Gutschrift overage as a
    // credit-balance ledger entry. The synthetic payment
    // row inside the transaction was capped at the
    // original's open balance — any leftover flows to
    // Kundenguthaben instead of "overpaying" the original
    // past zero (which would create a phantom credit
    // that the customer statement can't explain).
    const overage = (cn as any)._gutschriftOverage as number
    if (overage > 0.005) {
      try {
        await this.creditBalance.recordGutschriftOverage(
          companyId,
          original.customerId,
          cn.id,
          overage,
          original.invoiceNumber,
        )
      } catch (err: any) {
        // Soft-fail: the Gutschrift itself succeeded;
        // the credit-balance ledger is a derived view.
        // Log to ErrorEvent so the Berater can re-trigger
        // manually if the audit demands it.
        try {
          await this.prisma.errorEvent.create({
            data: {
              source: 'backend',
              kind: 'manual',
              message: `Credit-balance Gutschrift overage record failed for CN ${cn.invoiceNumber}, original ${original.invoiceNumber}: ${err?.message ?? err}`,
              stack: err?.stack,
              fingerprint: `credit-gutschrift-${cn.id}`,
              companyId,
            },
          })
        } catch {
          // Ignore secondary failures.
        }
      }
    }

    // Strip the internal _gutschriftOverage field
    // before returning — callers should not see it.
    const { _gutschriftOverage, ...cnForCaller } = cn as any
    return cnForCaller
  }

  /**
   * Helper: build the JSON VAT breakdown from a
   * list of negative-priced line items. Same shape
   * as the create flow's breakdown but for refunds.
   */
  private computeVatBreakdown(
    lines: Array<{
      quantity: number
      unitPrice: number
      vatRate: number
    }>,
  ) {
    const byRate: Record<string, { rate: number; net: number; vat: number }> =
      {}
    for (const l of lines) {
      const key = l.vatRate.toFixed(2)
      if (!byRate[key]) {
        byRate[key] = { rate: l.vatRate, net: 0, vat: 0 }
      }
      const net = l.quantity * l.unitPrice
      byRate[key].net += net
      byRate[key].vat += net * l.vatRate
    }
    return Object.values(byRate)
  }

  // ---- Tier 138: internal team notes ----
  //
  // Append-only at the API surface: GET (list),
  // POST (create), DELETE (own / admin). No PUT —
  // edits are modeled as a new note + DELETE on
  // the old one so the audit trail is clean.
  // `Invoice.notes` (Bemerkungen) is the customer-
  // facing field; these are purely internal,
  // excluded from the PDF and the customer portal.

  async listInternalNotes(companyId: string, invoiceId: string) {
    // Make sure the invoice belongs to this company
    // before returning notes — otherwise a guessed
    // invoiceId from another tenant would leak its
    // internal notes.
    const inv = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, companyId },
      select: { id: true },
    })
    if (!inv) throw new NotFoundException('Invoice not found')
    return this.prisma.invoiceInternalNote.findMany({
      where: { companyId, invoiceId },
      orderBy: { createdAt: 'desc' },
    })
  }

  async createInternalNote(
    companyId: string,
    invoiceId: string,
    body: string,
    user: { id?: string; email?: string | null },
  ) {
    const trimmed = (body || '').trim()
    if (!trimmed) {
      throw new BadRequestException('body is required')
    }
    if (trimmed.length > 2000) {
      throw new BadRequestException('body too long (max 2000 chars)')
    }
    const inv = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, companyId },
      select: { id: true },
    })
    if (!inv) throw new NotFoundException('Invoice not found')
    return this.prisma.invoiceInternalNote.create({
      data: {
        companyId,
        invoiceId,
        userId: user.id || null,
        userEmail: user.email || null,
        body: trimmed,
      },
    })
  }

  async deleteInternalNote(
    companyId: string,
    invoiceId: string,
    noteId: string,
    user: { id?: string; email?: string | null; isAdmin?: boolean },
  ) {
    const note = await this.prisma.invoiceInternalNote.findFirst({
      where: { id: noteId, companyId, invoiceId },
    })
    if (!note) throw new NotFoundException('Note not found')
    // Only the author OR an admin can delete. This
    // prevents a teammate from wiping someone else's
    // observation.
    const isAuthor =
      user.id && note.userId && note.userId === user.id
    if (!isAuthor && !user.isAdmin) {
      throw new ForbiddenException(
        'You can only delete your own notes (or be an admin)',
      )
    }
    await this.prisma.invoiceInternalNote.delete({ where: { id: noteId } })
    return { ok: true }
  }
}
