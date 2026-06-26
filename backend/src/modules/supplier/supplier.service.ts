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
import { VatValidationService } from '../vat-validation/vat-validation.service';
import { WebhookService } from '../webhook/webhook.service';

@Injectable()
export class SupplierService {
  constructor(
    private prisma: PrismaService,
    private vatValidation: VatValidationService,
    private webhooks: WebhookService,
  ) {}

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
    const created = await this.prisma.supplier.create({
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

    // Fire supplier.created. We don't
    // have a dedicated event type for
    // this in the UI yet (it'll be
    // added when the UI exposes a
    // supplier create event), but the
    // type 'company.updated' is a
    // fine catch-all for "something
    // master-data-level changed".
    // Receivers that care about
    // suppliers specifically can
    // filter on data.kind === 'supplier'.
    this.webhooks
      .emit({
        id: `sup_${created.id}`,
        type: 'company.updated',
        occurredAt: new Date().toISOString(),
        companyId,
        data: {
          kind: 'supplier',
          action: 'created',
          id: created.id,
          name: created.name,
          vatId: created.vatId ?? null,
        },
      })
      .catch((err) => console.error('webhook emit(supplier.created) failed:', err))

    return created;
  }

  async update(id: string, companyId: string, data: any) {
    const existing = await this.prisma.supplier.findFirst({ where: { id, companyId } });
    if (!existing) throw new NotFoundException('Lieferant nicht gefunden');
    const updated = await this.prisma.supplier.update({
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

    this.webhooks
      .emit({
        id: `sup_${id}_updated_${updated.updatedAt?.getTime() ?? Date.now()}`,
        type: 'company.updated',
        occurredAt: new Date().toISOString(),
        companyId,
        data: {
          kind: 'supplier',
          action: 'updated',
          id: updated.id,
          name: updated.name,
          vatId: updated.vatId ?? null,
        },
      })
      .catch((err) => console.error('webhook emit(supplier.updated) failed:', err))

    return updated;
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

  /**
   * Verify this supplier's VAT ID against VIES.
   * Same logic as CustomerService.verifyVatId —
   * see the longer comment there. Suppliers
   * (Eingangsrechnung vendor bills) are the
   * higher-stakes case for VIES verification
   * (the user's Vorsteuerabzug depends on having
   * the right USt-ID on the bill), so the detail
   * page should call this proactively.
   */
  async verifyVatId(id: string, companyId: string) {
    const supplier = await this.findOne(id, companyId)
    const vatId = (supplier as any).vatId
    if (!vatId) {
      throw new BadRequestException(
        'Keine USt-ID hinterlegt. Bitte zuerst eine USt-ID im Lieferanten-Datensatz speichern.',
      )
    }
    return this.vatValidation.validateAndLog(
      companyId,
      'supplier',
      supplier.id,
      vatId,
    )
  }

  /**
   * VIES history for a supplier. Same shape as
   * the customer variant — see the comment there.
   */
  async vatHistory(id: string, companyId: string, limit = 20) {
    await this.findOne(id, companyId) // ownership check
    const [latest, history] = await Promise.all([
      this.vatValidation.latestForEntity(companyId, 'supplier', id),
      this.prisma.vatValidationLog.findMany({
        where: { companyId, entityType: 'supplier', entityId: id },
        orderBy: { checkedAt: 'desc' },
        take: limit,
        select: {
          id: true,
          vatId: true,
          status: true,
          countryCode: true,
          viesName: true,
          errorCode: true,
          errorMessage: true,
          checkedAt: true,
          durationMs: true,
          createdAt: true,
        },
      }),
    ])
    return { latest, history }
  }
}
