/**
 * Expense (Eingangsrechnung) — vendor bills received.
 *
 * In the bank-import flow, the user can attribute a
 * debit transaction to a supplier by linking an
 * Expense row. The Expense carries the supplier,
 * invoice number, invoice date, net/VAT/gross
 * amounts, and VAT rate — exactly what the
 * DATEV UStVA / Vorsteuer reporting needs.
 *
 * For the bank-import flow, an Expense is created
 * "open" (status = 'booked' meaning the user has
 * entered it, awaiting payment), then bookExpense
 * marks it fully 'booked' once the bank txn lands
 * and the GoBD voucher is written.
 */

import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ExpenseService {
  constructor(private prisma: PrismaService) {}

  async findAll(companyId: string, opts: { supplierId?: string; status?: string; search?: string } = {}) {
    const where: any = { companyId };
    if (opts.supplierId) where.supplierId = opts.supplierId;
    if (opts.status) where.status = opts.status;
    if (opts.search) {
      where.OR = [
        { invoiceNumber: { contains: opts.search, mode: 'insensitive' } },
        { description: { contains: opts.search, mode: 'insensitive' } },
      ];
    }
    const items = await this.prisma.expense.findMany({
      where,
      include: { supplier: { select: { id: true, name: true, vatId: true } } },
      orderBy: { invoiceDate: 'desc' },
      take: 500,
    });
    if (items.length === 0) return items;
    // Augment each Expense with the most recent linked
    // Voucher (for the list page to show a "Buchungsbeleg"
    // link + a "Storniert" badge if the Voucher is a
    // reversal). The bank-import bookExpense flow links
    // Expense → Voucher by writing a Voucher with
    // referenceType='Expense' and the expenseId in
    // description — we resolve the link here by querying
    // for Vouchers whose description carries the expenseId.
    // The cheaper alternative would be a column on
    // Voucher, but we kept the Voucher self-contained.
    const expenseIds = items.map((e) => e.id);
    // Quick text-search for the most-recent Voucher per
    // expense. Patterns look like "... [expense:<id>] ..."
    // — see bank-import.service.ts bookExpense.
    const vouchers = await this.prisma.voucher.findMany({
      where: {
        companyId,
        referenceType: { in: ['Expense', 'VoucherReversal'] },
        description: { contains: 'expense:' },
        OR: expenseIds.map((id) => ({ description: { contains: id } })),
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        voucherNumber: true,
        referenceType: true,
        description: true,
        status: true,
      },
    });
    // Build a map of expenseId → most recent voucher
    const voucherByExpense: Record<string, typeof vouchers[number]> = {};
    for (const v of vouchers) {
      for (const eid of expenseIds) {
        if (v.description && v.description.includes(eid)) {
          if (!voucherByExpense[eid]) voucherByExpense[eid] = v;
          break;
        }
      }
    }
    return items.map((e) => {
      const v = voucherByExpense[e.id];
      return {
        ...e,
        // Cheap UI hint: "Storniert" if the linked
        // voucher is itself a VoucherReversal, "Bezahlt"
        // if there's any linked voucher, "Offen" otherwise.
        // This drives the colored badge in the list.
        paymentState: v
          ? v.referenceType === 'VoucherReversal'
            ? 'storniert'
            : 'bezahlt'
          : 'offen',
        linkedVoucher: v
          ? {
              id: v.id,
              voucherNumber: v.voucherNumber,
              referenceType: v.referenceType,
            }
          : null,
      };
    });
  }

  async findOne(id: string, companyId: string) {
    const exp = await this.prisma.expense.findFirst({
      where: { id, companyId },
      include: { supplier: true },
    });
    if (!exp) throw new NotFoundException('Eingangsrechnung nicht gefunden');
    return exp;
  }

  async create(companyId: string, data: any) {
    if (!data.description) throw new BadRequestException('Beschreibung ist erforderlich');
    if (!data.invoiceDate) throw new BadRequestException('Rechnungsdatum ist erforderlich');
    if (data.supplierId) {
      const sup = await this.prisma.supplier.findFirst({ where: { id: data.supplierId, companyId } });
      if (!sup) throw new BadRequestException('Lieferant nicht gefunden');
    }
    const net = Number(data.netAmount ?? 0);
    const vat = Number(data.vatAmount ?? 0);
    const gross = Number(data.grossAmount ?? net + vat);
    return this.prisma.expense.create({
      data: {
        companyId,
        supplierId: data.supplierId || null,
        invoiceNumber: data.invoiceNumber || null,
        description: data.description,
        invoiceDate: new Date(data.invoiceDate),
        netAmount: net.toFixed(4),
        vatRate: data.vatRate ?? 0,
        vatAmount: vat.toFixed(4),
        grossAmount: gross.toFixed(4),
        category: data.category || null,
        isIntraEU: !!data.isIntraEU,
        isReverseCharge: !!data.isReverseCharge,
        status: data.status || 'booked',
        notes: data.notes || null,
      },
    });
  }
}
