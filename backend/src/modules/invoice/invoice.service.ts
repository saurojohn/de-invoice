import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
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
  constructor(private prisma: PrismaService) {}

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

    // Generate invoice number based on type
    const count = await this.prisma.invoice.count({ where: { companyId, type } });
    let invoiceNumber: string;

    if (type === 'CN') {
      // Credit Note number format: CN-YYYY-XXXXXX
      invoiceNumber = `CN-${new Date().getFullYear()}-${String(count + 1).padStart(6, '0')}`;
    } else if (type === 'PI') {
      // Proforma Invoice number format: PI-YYYY-XXXXXX
      invoiceNumber = `PI-${new Date().getFullYear()}-${String(count + 1).padStart(6, '0')}`;
    } else if (type === 'RCV') {
      // Receipt number format: RCV-YYYY-XXXXXX
      invoiceNumber = `RCV-${new Date().getFullYear()}-${String(count + 1).padStart(6, '0')}`;
    } else {
      // Standard Invoice number format: INV-YYYY-XXXXXX
      invoiceNumber = `INV-${new Date().getFullYear()}-${String(count + 1).padStart(6, '0')}`;
    }

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

    const invoice = await this.prisma.invoice.create({
      data: {
        companyId,
        customerId,
        invoiceNumber,
        issueDate,
        dueDate,
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
    return {
      ...invoice,
      stockWarnings: hasStockWarnings ? stockWarnings : undefined,
    };
    } catch (error) {
      console.error('Invoice creation error:', error);
      throw error;
    }
  }

  async update(id: string, companyId: string, dto: UpdateInvoiceDto) {
    return this.prisma.invoice.update({
      where: { id },
      data: dto,
      include: { items: true },
    });
  }

  async updateStatus(id: string, companyId: string, status: string) {
    return this.prisma.invoice.update({
      where: { id },
      data: { status },
    });
  }
}
