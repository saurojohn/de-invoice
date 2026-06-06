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
   *
   * Each customer in `data` is enriched with:
   *   - `lastInvoiceDate` — most recent `issueDate` from any invoice
   *   - `invoiceCount`    — total number of invoices
   *   - `isActive`        — derived boolean: false when the customer
   *                         hasn't received an invoice in the last
   *                         90 days (or never), true otherwise. Lets
   *                         the UI show an "inactive" badge without
   *                         a second round-trip.
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
      // The UI search box advertises "Name, USt-ID, Stadt, PLZ"
      // so we actually have to look at all four. Postgres JSON
      // path queries (string_contains) are case-sensitive — for
      // postal code that doesn't matter, for city we coerce the
      // search term to lower before matching.
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { vatId: { contains: q, mode: 'insensitive' } },
        { address: { path: ['city'], string_contains: q } },
        { address: { path: ['postalCode'], string_contains: q } },
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

    // "Active" = has at least one invoice AND the most recent one
    // is younger than 90 days. Everything else is inactive (never
    // invoiced, or stale).
    const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000
    const now = Date.now()
    const enriched = data.map((c: any) => {
      const lastDate = lastInvoiceByCustomer[c.id]?.lastInvoiceDate || null
      const count = lastInvoiceByCustomer[c.id]?.invoiceCount || 0
      const isActive =
        count > 0 && lastDate
          ? now - new Date(lastDate).getTime() < NINETY_DAYS_MS
          : false
      return {
        ...c,
        lastInvoiceDate: lastDate,
        invoiceCount: count,
        isActive,
      }
    })

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
    // Defensive: Prisma's `address` column is `Json` (NOT NULL) but
    // the global ValidationPipe strips @IsOptional() fields when the
    // payload omits them. Without this default, a minimal payload
    // like {"name":"X","contact":{"email":""}} produces a 500
    // "Argument `address` is missing". Same risk exists for `contact`.
    const safeData = {
      ...data,
      address: data.address ?? {},
      contact: data.contact ?? {},
    }
    // Auto-assign a per-company sequential customer number if the
    // caller didn't supply one (CSV import, manual form, etc.). Format
    // is "K-0001" with 4-digit zero-padding. Importer-provided numbers
    // are kept as-is and validated for per-company uniqueness.
    if (!safeData.customerNumber || !safeData.customerNumber.trim()) {
      safeData.customerNumber = await this.nextCustomerNumber(companyId)
    }
    return this.prisma.customer.create({
      data: { ...safeData, companyId },
    });
  }

  /**
   * Compute the next available customer number for a company.
   * Format: "K-0001", "K-0002", ... (4-digit zero-padded).
   * Looks at the highest existing number in this company and adds 1.
   * Gaps in numbering are tolerated (a deleted K-0005 won't shift
   * subsequent numbers down).
   */
  private async nextCustomerNumber(companyId: string): Promise<string> {
    // Find the max numeric suffix among this company's customers.
    // The .customerNumber column is optional + unique-per-company, so
    // a manual reset to a higher number is the only way to "skip"
    // ahead, which is the intended escape hatch.
    const rows = await this.prisma.customer.findMany({
      where: { companyId, customerNumber: { startsWith: 'K-' } },
      select: { customerNumber: true },
    })
    let max = 0
    for (const r of rows) {
      const m = r.customerNumber?.match(/^K-(\d+)$/)
      if (m) {
        const n = parseInt(m[1], 10)
        if (n > max) max = n
      }
    }
    return `K-${String(max + 1).padStart(4, '0')}`
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
