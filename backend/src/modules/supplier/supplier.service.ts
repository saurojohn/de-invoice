/**
 * Supplier (Lieferant) management.
 *
 * Suppliers are the mirror image of Customers: a
 * business we receive invoices from. A Supplier
 * holds the master data (name, VAT ID, address,
 * bank info) and links to multiple Expense rows
 * (the actual vendor bills / Eingangsrechnungen).
 *
 * For the bank-import flow, suppliers let the user
 * attribute a debit transaction to a specific
 * vendor and pick the right expense entry. Without
 * a Supplier record, the user can still book a
 * generic "Aufwand" with `bookExpense` (4900 + 1200)
 * — the supplier is for the polished Eingangsrechnung
 * path with VAT recovery.
 */

import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class SupplierService {
  constructor(private prisma: PrismaService) {}

  async findAll(companyId: string, opts: { search?: string } = {}) {
    const where: any = { companyId };
    if (opts.search) {
      where.OR = [
        { name: { contains: opts.search, mode: 'insensitive' } },
        { vatId: { contains: opts.search, mode: 'insensitive' } },
      ];
    }
    return this.prisma.supplier.findMany({
      where,
      orderBy: { name: 'asc' },
      take: 500,
    });
  }

  async findOne(id: string, companyId: string) {
    const supplier = await this.prisma.supplier.findFirst({
      where: { id, companyId },
      include: {
        _count: { select: { expenses: true } },
        expenses: {
          orderBy: { invoiceDate: 'desc' },
          take: 20,
          select: {
            id: true,
            invoiceNumber: true,
            description: true,
            invoiceDate: true,
            netAmount: true,
            vatAmount: true,
            grossAmount: true,
            vatRate: true,
            status: true,
          },
        },
      },
    });
    if (!supplier) throw new NotFoundException('Lieferant nicht gefunden');
    return supplier;
  }

  async create(companyId: string, data: any) {
    if (!data.name) throw new BadRequestException('Name ist erforderlich');
    if (!data.address) data.address = {};
    return this.prisma.supplier.create({
      data: {
        companyId,
        name: data.name,
        vatId: data.vatId || null,
        address: data.address,
        contact: data.contact || null,
        bankInfo: data.bankInfo || null,
        paymentTerms: data.paymentTerms ?? 30,
        metadata: data.metadata || null,
      },
    });
  }

  async update(id: string, companyId: string, data: any) {
    const existing = await this.prisma.supplier.findFirst({ where: { id, companyId } });
    if (!existing) throw new NotFoundException('Lieferant nicht gefunden');
    return this.prisma.supplier.update({
      where: { id },
      data: {
        name: data.name ?? existing.name,
        vatId: data.vatId ?? existing.vatId,
        address: data.address ?? existing.address,
        contact: data.contact ?? existing.contact,
        bankInfo: data.bankInfo ?? existing.bankInfo,
        paymentTerms: data.paymentTerms ?? existing.paymentTerms,
        metadata: data.metadata ?? existing.metadata,
      },
    });
  }

  async remove(id: string, companyId: string) {
    const existing = await this.prisma.supplier.findFirst({ where: { id, companyId } });
    if (!existing) throw new NotFoundException('Lieferant nicht gefunden');
    // Refuse if there are still expenses — we don't
    // want to orphan Eingangsrechnungen. The user
    // has to delete or reassign those first.
    const expCount = await this.prisma.expense.count({ where: { supplierId: id } });
    if (expCount > 0) {
      throw new BadRequestException(
        `Lieferant hat ${expCount} Eingangsrechnung(en) — bitte zuerst löschen oder zuordnen.`
      );
    }
    await this.prisma.supplier.delete({ where: { id } });
    return { ok: true };
  }
}
