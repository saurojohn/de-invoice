import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { WebhookService } from '../webhook/webhook.service';
import { CreateInvoiceDto, UpdateInvoiceDto } from './dto/invoice.dto';

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
  ) {}

  /**
   * Paginated invoice list with optional filters.
   * Search matches invoice number and customer name (case-insensitive).
   * Returns `{ data, total, page, pageSize, totalPages }`.
   */
  async findAll(
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
        notes: dto.notes,
        templateType: dto.templateType || 'standard',
        subtotal: finalSubtotal,
        totalVat: finalTotalVat,
        total: finalTotal,
        discountPercent: dto.discountPercent || null,
        discountAmount: discountAmount > 0 ? discountAmount : null,
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
        currency: dto.currency ?? undefined,
        language: dto.language ?? undefined,
        templateType: dto.templateType ?? undefined,
        // paymentTerms is on Customer, paymentMethod is on Payment
        // — neither lives on Invoice. The frontend form keeps them
        // for UX continuity with the create flow, but Invoice's
        // checked UpdateInput rejects them with "Unknown argument".
        // Drop them here so the update actually persists.
        discountPercent: dto.discountPercent ?? undefined,
        discountAmount: dto.discountAmount ?? undefined,
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
}
