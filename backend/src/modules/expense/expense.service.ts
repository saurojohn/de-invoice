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
    return this.prisma.expense.findMany({
      where,
      include: { supplier: { select: { id: true, name: true, vatId: true } } },
      orderBy: { invoiceDate: 'desc' },
      take: 500,
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
