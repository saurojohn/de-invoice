import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { VatValidationService } from '../vat-validation/vat-validation.service';

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
  constructor(
    private prisma: PrismaService,
    private vatValidation: VatValidationService,
  ) {}

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
      // Smart customer-number lookup: if the user types a string that
      // looks like a customer number (e.g. "K-0001" or just "K0001"),
      // match the exact number FIRST. The free-text fields and the
      // two generated text columns all have pg_trgm GIN indexes (see
      // prisma/init.sql), so substring search is also fast.
      //
      // Why a two-stage lookup instead of a single OR: Postgres'
      // OR-of-mixed-clauses uses BitmapOr and returns the UNION of
      // all matching rows, so "K-0001" substring matches K-00010..K-
      // 00019 and the exact K-00001 would just be one row among 11.
      // A two-stage query guarantees the exact match wins when it
      // exists, with substring fallback when it doesn't.
      const stripped = q.replace(/^K-?/i, '')
      const looksLikeNumber = /^\d{1,6}$/.test(stripped)
      const padded = looksLikeNumber ? stripped.padStart(5, '0') : null
      const exactNumber = padded ? `K-${padded}` : null

      if (exactNumber) {
        const exactCount = await this.prisma.customer.count({
          where: { companyId, customerNumber: exactNumber },
        })
        if (exactCount > 0) {
          // Exact match wins — restrict the search to just that row
          // (still OR'd, but a single clause, so the query is cheap).
          where.customerNumber = exactNumber
        } else {
          // Fall through to substring search so the user still gets
          // useful "did you mean" results instead of an empty list.
          where.OR = [
            { name: { contains: q, mode: 'insensitive' } },
            { vatId: { contains: q, mode: 'insensitive' } },
            { customerNumber: { contains: q, mode: 'insensitive' } },
            { cityText: { contains: q, mode: 'insensitive' } },
            { postalCodeText: { contains: q, mode: 'insensitive' } },
          ]
        }
      } else {
        where.OR = [
          { name: { contains: q, mode: 'insensitive' } },
          { vatId: { contains: q, mode: 'insensitive' } },
          { customerNumber: { contains: q, mode: 'insensitive' } },
          { cityText: { contains: q, mode: 'insensitive' } },
          { postalCodeText: { contains: q, mode: 'insensitive' } },
        ]
      }
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
    //
    // Race: two parallel create calls would both pick the same
    // next-number, and the second would crash on the
    // @@unique([companyId, customerNumber]) constraint. We retry
    // up to 3 times — each retry re-reads the current max, so
    // a concurrent winner causes us to step forward by 1.
    if (!safeData.customerNumber || !safeData.customerNumber.trim()) {
      // Race: parallel create calls all pick the same
      // next-number, only one survives the
      // @@unique([companyId, customerNumber]) constraint.
      // We retry with an exponential backoff AND a fresh
      // next-number read. The retry will see the row the
      // winner just committed and step forward by 1.
      //
      // Bump the cap to 8 — in the worst case 5 parallel
      // callers can collide. The +1 jitter prevents two
      // retries from re-aligning on the same number.
      let lastError: any = null
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          safeData.customerNumber = await this.nextCustomerNumber(companyId)
          // Don't `return` inside the try — let the
          // for-loop own the control flow so a thrown
          // P2002 lands in the catch below.
          const created = await this.prisma.customer.create({
            data: { ...safeData, companyId },
          })
          return created
        } catch (e: any) {
          lastError = e
          // P2002 = unique constraint violation. The
          // other concurrent creator beat us — wait a
          // short jittered backoff, then retry with a
          // fresh next-number read.
          if (e?.code !== 'P2002') throw e
          await new Promise((r) => setTimeout(r, 5 + Math.random() * 20))
        }
      }
      throw lastError
    }
    return this.prisma.customer.create({
      data: { ...safeData, companyId },
    });
  }

  /**
   * Compute the next available customer number for a company.
   * Format: "K-00001", "K-00002", ... (5-digit zero-padded).
   * Looks at the highest existing number in this company and adds 1.
   * Gaps in numbering are tolerated (a deleted K-00005 won't shift
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
    return `K-${String(max + 1).padStart(5, '0')}`
  }

  /**
   * Public version of nextCustomerNumber, exposed via
   * GET /api/v1/customers/next-number?companyId=... for the UI
   * to show "the next number will be K-00024" before the user
   * hits save. Does NOT reserve or consume the number.
   */
  async previewNextCustomerNumber(companyId: string): Promise<{ nextNumber: string; totalCustomers: number }> {
    const nextNumber = await this.nextCustomerNumber(companyId)
    const totalCustomers = await this.prisma.customer.count({ where: { companyId } })
    return { nextNumber, totalCustomers }
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
   * Verify this customer's VAT ID against VIES.
   * Delegates to the VatValidationService which
   * handles the SOAP call, the 30-day cache, and
   * the audit log write.
   *
   * This is the entry point the Customer detail
   * page's "USt-ID prüfen" button calls. We don't
   * auto-validate on create/update because:
   *   1. VIES is slow (1-3s) — blocking the create
   *      would be a UX regression
   *   2. VIES is offline ~5% of the time — we don't
   *      want create to fail just because the EU
   *      service is having a bad day
   * Instead we let the user trigger it explicitly.
   */
  async verifyVatId(id: string, companyId: string) {
    const customer = await this.findOne(id, companyId)
    const vatId = (customer as any).vatId
    if (!vatId) {
      throw new BadRequestException(
        'Keine USt-ID hinterlegt. Bitte zuerst eine USt-ID im Feld "USt-ID" speichern.',
      )
    }
    return this.vatValidation.validateAndLog(
      companyId,
      'customer',
      customer.id,
      vatId,
    )
  }

  /**
   * Return the most recent VIES check for this
   * customer, plus a 20-row history. The detail
   * page renders this as a "Verlauf" tab.
   */
  async vatHistory(id: string, companyId: string, limit = 20) {
    await this.findOne(id, companyId) // ownership check
    const [latest, history] = await Promise.all([
      this.vatValidation.latestForEntity(companyId, 'customer', id),
      this.prisma.vatValidationLog.findMany({
        where: { companyId, entityType: 'customer', entityId: id },
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
