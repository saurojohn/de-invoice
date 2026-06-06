import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface ImportCustomerRow {
  name?: string
  vatId?: string
  type?: string
  street?: string
  postalCode?: string
  city?: string
  country?: string
  email?: string
  phone?: string
  paymentTerms?: number
  taxExempt?: boolean
  tags?: string[]
}

export interface ImportResult {
  total: number
  imported: number
  skipped: number
  errors: Array<{ row: number; error: string; name?: string }>
}

@Injectable()
export class CustomerService {
  constructor(private prisma: PrismaService) {}

  /**
   * Paginated list. Returns `{ data, total, page, pageSize, totalPages }`.
   */
  async findAll(
    companyId: string,
    opts: { page?: number; pageSize?: number; search?: string } = {},
  ) {
    const page = Math.max(1, opts.page ?? 1)
    const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 50))
    const skip = (page - 1) * pageSize
    const where: any = { companyId }
    if (opts.search && opts.search.trim()) {
      const q = opts.search.trim()
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { vatId: { contains: q, mode: 'insensitive' } },
        { address: { path: ['city'], string_contains: q } },
      ]
    }
    const [data, total] = await Promise.all([
      this.prisma.customer.findMany({
        where,
        orderBy: { name: 'asc' },
        skip,
        take: pageSize,
      }),
      this.prisma.customer.count({ where }),
    ])

    // Augment each customer with their last invoice date and total
    // invoice count. A single groupBy query is much cheaper than N+1
    // findFirst calls per row.
    const customerIds = data.map((c: any) => c.id)
    let lastInvoiceByCustomer: Record<string, { lastInvoiceDate: string | null; invoiceCount: number }> = {}
    if (customerIds.length > 0) {
      // Note: Prisma's groupBy doesn't support aggregations on
      // JSON fields, but `issueDate` is a real column so we can
      // group + max it.
      const grouped = await this.prisma.invoice.groupBy({
        by: ['customerId'],
        where: { companyId, customerId: { in: customerIds } },
        _count: { _all: true },
        _max: { issueDate: true },
      })
      lastInvoiceByCustomer = Object.fromEntries(
        grouped.map((g: any) => [
          g.customerId,
          {
            lastInvoiceDate: g._max.issueDate ? g._max.issueDate.toISOString() : null,
            invoiceCount: g._count._all,
          },
        ]),
      )
    }
    const enriched = data.map((c: any) => ({
      ...c,
      lastInvoiceDate: lastInvoiceByCustomer[c.id]?.lastInvoiceDate || null,
      invoiceCount: lastInvoiceByCustomer[c.id]?.invoiceCount || 0,
    }))

    return {
      data: enriched,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize) || 1,
    }
  }

  async findOne(id: string, companyId: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, companyId },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }

  /**
   * Lookup by email (used for dedup detection during import).
   * Returns null when the email is missing or no match exists.
   */
  async findByEmail(email: string, companyId: string) {
    if (!email) return null
    const normalized = email.trim().toLowerCase()
    if (!normalized) return null
    return this.prisma.customer.findFirst({
      where: { companyId, contact: { path: ['email'], equals: normalized } },
    })
  }

  async create(companyId: string, data: any) {
    // Defensive: re-fetch by email to surface a 409 cleanly when the
    // frontend's pre-check missed (e.g. concurrent import).
    if (data.contact?.email) {
      const existing = await this.findByEmail(data.contact.email, companyId)
      if (existing) {
        throw new ConflictException(
          `Kunde mit E-Mail "${data.contact.email}" existiert bereits`
        )
      }
    }
    return this.prisma.customer.create({
      data: { ...data, companyId },
    });
  }

  async update(id: string, companyId: string, data: any) {
    // Verify the customer belongs to this company before updating
    const existing = await this.findOne(id, companyId)
    return this.prisma.customer.update({
      where: { id: existing.id },
      data,
    });
  }

  /**
   * Delete a customer. Refuses if the customer has any invoices —
   * we don't want to leave dangling FK references in the audit log
   * and we should let the user archive the customer instead.
   */
  async remove(id: string, companyId: string) {
    const customer = await this.findOne(id, companyId)
    const invoiceCount = await this.prisma.invoice.count({
      where: { customerId: customer.id },
    })
    if (invoiceCount > 0) {
      throw new BadRequestException(
        `Kunde hat ${invoiceCount} Rechnung(en) und kann nicht gelöscht werden. Archivieren Sie den Kunden stattdessen.`
      )
    }
    await this.prisma.customer.delete({ where: { id: customer.id } })
    return { ok: true }
  }

  /**
   * Bulk-import customers from CSV-style rows.
   *
   * Behaviour:
   *   - Rows with no `name` are skipped with an error entry.
   *   - Rows whose email matches an existing customer in this company
   *     are SKIPPED (not overwritten) — the import is additive.
   *   - `vatId` is trimmed; empty becomes null.
   *   - `type` defaults to "business" when missing.
   *   - `paymentTerms` defaults to 30 when missing/invalid.
   *
   * The function returns a summary so the frontend can show a
   * "X imported, Y skipped, Z errors" report.
   */
  async importBulk(
    companyId: string,
    rows: ImportCustomerRow[],
  ): Promise<ImportResult> {
    const result: ImportResult = { total: rows.length, imported: 0, skipped: 0, errors: [] }
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] || {}
      const rowNum = i + 2 // +2 because row 1 is the header in CSV
      try {
        const name = (row.name || '').trim()
        if (!name) {
          result.errors.push({ row: rowNum, error: 'Name fehlt', name })
          continue
        }
        const email = (row.email || '').trim()
        if (email) {
          const existing = await this.findByEmail(email, companyId)
          if (existing) {
            result.skipped++
            continue
          }
        }
        const vatId = (row.vatId || '').trim() || null
        const type = (row.type || 'business').trim() === 'individual' ? 'individual' : 'business'
        const country = (row.country || 'DE').trim() || 'DE'
        const paymentTermsRaw = Number(row.paymentTerms)
        const paymentTerms = Number.isFinite(paymentTermsRaw) ? paymentTermsRaw : 30

        const customer = await this.prisma.customer.create({
          data: {
            companyId,
            name,
            type,
            vatId,
            taxExempt: !!row.taxExempt,
            address: {
              street: (row.street || '').trim(),
              postalCode: (row.postalCode || '').trim(),
              city: (row.city || '').trim(),
              country,
            },
            contact: {
              email: email || undefined,
              phone: (row.phone || '').trim() || undefined,
            },
            paymentTerms,
            tags: Array.isArray(row.tags) ? row.tags : [],
          },
        })
        result.imported++
        // touch customer to keep TS happy (no-op in production)
        void customer
      } catch (err: any) {
        result.errors.push({
          row: rowNum,
          error: err?.message || 'Unbekannter Fehler',
          name: (row.name || '').trim(),
        })
      }
    }
    return result
  }
}
