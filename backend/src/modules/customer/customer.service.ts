import { Injectable, NotFoundException, BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { VatValidationService } from '../vat-validation/vat-validation.service';
import { WebhookService } from '../webhook/webhook.service';

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
  private readonly logger = new Logger(CustomerService.name)
  constructor(
    private prisma: PrismaService,
    private vatValidation: VatValidationService,
    private webhooks: WebhookService,
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
   * Tier 61: detail-page summary. Returns the customer row
   * plus a flat stats object that the React detail page can
   * render in one round-trip. The drill-down tabs (Rechnungen
   * / Ratenpläne / Mahnungen) call their own endpoints for
   * the full lists — this summary is just the "KPI strip"
   * at the top of the page.
   *
   * Why a dedicated endpoint instead of multiple round-trips:
   *   - the detail page hydrates 5+ stats (open balance,
   *     overdue count, last invoice, last payment, plans,
   *     Mahnungen, credit balance). 7 round-trips on
   *     every page load is too chatty.
   *   - the queries are index-backed (customerId + status,
   *     customerId + createdAt, customerId + customerId)
   *     so the wall-clock cost is dominated by Prisma
   *     round-trip overhead, not query time.
   *   - the Skonto-aware overdue count reuses the same
   *     findOverdueInvoices() logic as the Mahnung
   *     scheduler (single source of truth — Tier 57).
   *
   * Skonto window: a Mahnung during the Skonto window is
   * hostile ("forgot to pay?" when the customer can still
   * take the discount), so the overdue count EXCLUDES
   * invoices whose Skonto window is still open.
   */
  async summary(id: string, companyId: string) {
    const customer = await this.findOne(id, companyId)
    const now = new Date()

    // Run all KPI queries in parallel — Prisma reuses
    // the connection pool so the wall-clock cost is
    // roughly one round-trip, not seven.
    const [
      openInvoices,
      lastInvoice,
      lastPayment,
      activePlans,
      openMahnungen,
      creditSum,
    ] = await Promise.all([
      // Open invoices (sent/overdue, not draft, not
      // cancelled) for the open-balance + overdue-count.
      this.prisma.invoice.findMany({
        where: {
          companyId,
          customerId: id,
          status: { in: ['sent', 'overdue'] },
          type: { in: ['INV', 'PI'] },
        },
        select: {
          id: true,
          invoiceNumber: true,
          total: true,
          dueDate: true,
          issueDate: true,
          skontoPercent: true,
          skontoDays: true,
          payments: { select: { amount: true } },
        },
      }),
      // Most recent invoice (any status) for "last activity"
      this.prisma.invoice.findFirst({
        where: { companyId, customerId: id },
        orderBy: { issueDate: 'desc' },
        select: { id: true, invoiceNumber: true, issueDate: true, total: true, status: true, type: true },
      }),
      // Most recent payment on any of this customer's
      // invoices — surfaces "customer paid in full last
      // week" on the detail page so the Berater sees the
      // relationship is healthy.
      this.prisma.payment.findFirst({
        where: { invoice: { customerId: id, companyId } },
        orderBy: { paymentDate: 'desc' },
        select: {
          id: true,
          amount: true,
          paymentDate: true,
          paymentMethod: true,
          invoice: { select: { id: true, invoiceNumber: true } },
        },
      }),
      // Active installment plans. Ratenpläne is the only
      // billing construct that "carries forward" beyond
      // the invoice lifecycle — listing them here is the
      // Berater's only way to see "this customer is on
      // a 6-Rate plan, 2 Rates paid, 4 to go".
      this.prisma.installmentPlan.count({
        where: { customerId: id, status: 'active' },
      }),
      // Open Mahnungen. The Mahnung table is linked via
      // invoice (no direct customerId) so we use a
      // relation filter. Tier 55 added the cancel() path
      // so paid invoices auto-void their Mahnungen — the
      // "open" filter matches the reminder service's
      // own definition (`cancelledAt: null`).
      this.prisma.mahnung.count({
        where: {
          cancelledAt: null,
          invoice: { customerId: id, companyId },
        },
      }),
      // Credit balance (Tier 58 ledger sum). SUM(amount)
      // is the source of truth — the same value as
      // GET /customers/:id/credit-balance.
      this.prisma.customerCreditTransaction.aggregate({
        where: { companyId, customerId: id },
        _sum: { amount: true },
      }),
    ])

    // Compute openBalance + overdueCount from the invoice
    // rows. We can't use a Prisma aggregate here because
    // we need the per-invoice remaining amount
    // (total - sum(payments)), which Prisma can't express
    // in a single `where` filter.
    let openBalance = 0
    let overdueCount = 0
    for (const inv of openInvoices) {
      const total = Number(inv.total)
      const paid = inv.payments.reduce((s, p) => s + Number(p.amount), 0)
      const open = Math.max(0, total - paid)
      openBalance += open
      // Skonto-aware: skip invoices in their Skonto
      // window (Tier 57). The window is `issueDate +
      // skontoDays` (NOT dueDate + skontoDays — the
      // Skonto deadline is the EARLIER of the two).
      if (open < 0.005) continue
      if (!inv.dueDate) continue
      const due = new Date(inv.dueDate)
      if (due > now) continue // not yet overdue
      // Skonto window check (mirror of ReminderService)
      if (inv.skontoPercent && inv.skontoDays) {
        const issue = new Date(inv.issueDate)
        const skontoUntil = new Date(issue)
        skontoUntil.setUTCDate(skontoUntil.getUTCDate() + inv.skontoDays)
        if (skontoUntil >= due) {
          // Skonto window is the earlier-or-equal deadline;
          // if it's still in the future relative to now,
          // skip the Mahnung.
          if (now <= skontoUntil) continue
        }
      }
      overdueCount += 1
    }
    openBalance = Math.round(openBalance * 100) / 100

    return {
      customer: {
        id: customer.id,
        name: customer.name,
        customerNumber: customer.customerNumber,
        type: customer.type,
        vatId: customer.vatId,
        taxExempt: customer.taxExempt,
        address: customer.address,
        contact: customer.contact,
        paymentTerms: customer.paymentTerms,
        creditLimit: customer.creditLimit ? Number(customer.creditLimit) : null,
        tags: customer.tags,
        metadata: customer.metadata,
        createdAt: customer.createdAt.toISOString(),
      },
      stats: {
        openBalance,
        overdueCount,
        openInvoiceCount: openInvoices.length,
        activeInstallmentPlanCount: activePlans,
        openMahnungCount: openMahnungen,
        creditBalance: Number(creditSum._sum.amount ?? 0),
        // Last activity (most recent invoice).
        lastInvoice: lastInvoice
          ? {
              id: lastInvoice.id,
              invoiceNumber: lastInvoice.invoiceNumber,
              issueDate: lastInvoice.issueDate.toISOString(),
              total: Number(lastInvoice.total),
              status: lastInvoice.status,
              type: lastInvoice.type,
            }
          : null,
        // Last payment received.
        lastPayment: lastPayment
          ? {
              id: lastPayment.id,
              amount: Number(lastPayment.amount),
              paymentDate: lastPayment.paymentDate.toISOString(),
              paymentMethod: lastPayment.paymentMethod,
              invoiceNumber: lastPayment.invoice.invoiceNumber,
            }
          : null,
      },
      generatedAt: now.toISOString(),
    }
  }

  /**
   * Tier 144: email log for a single customer.
   *
   * Returns the chronological history of every
   * email the system has sent to this customer:
   *   - Invoice mails (original, reminders)
   *   - Dunning letters (Mahnung)
   *   - Statements (Kontoauszug)
   *   - Any bulk-send batch
   *
   * The Berater's primary use case: "did we
   * send the second reminder to BWA Test Kunde
   * on Friday?" — without this endpoint they
   * have to dig through the audit log + the
   * reminder scheduler output.
   *
   * Filter sources:
   *   1. invoice.customerId = id  (most common —
   *      every invoice mail has this link)
   *   2. recipientEmail = customer.email
   *      (catches standalone emails that don't
   *      have an invoice relation)
   *
   * Both are OR'd so a single query returns
   * the full picture.
   */
  async getEmails(
    id: string,
    companyId: string,
    opts: {
      skip?: number
      take?: number
      status?: string
      templateType?: string
      from?: Date
      to?: Date
    } = {},
  ) {
    const customer = await this.findOne(id, companyId)
    // Customer's email lives inside the `contact`
    // JSON (not a top-level field). We read it via
    // path so we can match EmailSend.recipientEmail
    // case-insensitively.
    const contact = (customer.contact as any) ?? {}
    const customerEmail =
      typeof contact.email === 'string' ? contact.email.toLowerCase() : null
    const where: any = {
      companyId,
      OR: [
        { invoice: { customerId: id } },
        ...(customerEmail
          ? [{ recipientEmail: { equals: customerEmail, mode: 'insensitive' as const } }]
          : []),
      ],
    }
    if (opts.status) where.status = opts.status
    if (opts.templateType) where.templateType = opts.templateType
    if (opts.from || opts.to) {
      where.createdAt = {}
      if (opts.from) where.createdAt.gte = opts.from
      if (opts.to) where.createdAt.lte = opts.to
    }
    const take = Math.min(opts.take ?? 50, 200)
    const skip = Math.max(opts.skip ?? 0, 0)
    const [rows, total] = await Promise.all([
      this.prisma.emailSend.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        select: {
          id: true,
          subject: true,
          recipientEmail: true,
          recipientName: true,
          templateType: true,
          status: true,
          sentAt: true,
          bodyPreview: true,
          createdAt: true,
          invoice: { select: { id: true, invoiceNumber: true } },
          createdBy: { select: { id: true, email: true } },
        },
      }),
      this.prisma.emailSend.count({ where }),
    ])
    return {
      rows: rows.map((r) => ({
        id: r.id,
        subject: r.subject,
        recipientEmail: r.recipientEmail,
        recipientName: r.recipientName,
        templateType: r.templateType,
        status: r.status,
        sentAt: r.sentAt,
        bodyPreview: r.bodyPreview,
        createdAt: r.createdAt,
        invoice: r.invoice,
        createdBy: r.createdBy,
      })),
      total,
      take,
      skip,
    }
  }

  /**
   * Tier 146: payment allocation (Zahlung zuordnen).
   *
   * The admin records a payment from a customer and
   * asks the system to apply it to open invoices.
   * Strategy is "oldest first" by default — the
   * one with the earliest dueDate gets paid first.
   *
   * Two-step flow:
   *   1. previewAllocatePayment: dry-run. Walks the
   *      open invoices, applies as much of the
   *      payment as possible, returns the proposed
   *      allocation list. NO writes.
   *   2. allocatePayment: same logic, but writes
   *      the Payment rows AND updates each invoice
   *      to status='paid' when fully settled.
   *
   * Both use the same helper to walk the open
   * invoices — only the side effect differs. This
   * way the preview is exactly what the write does
   * (no surprises).
   *
   * The remaining amount (when the payment is
   * smaller than the total outstanding) is returned
   * as `unallocatedAmount` — the admin can then
   * decide to apply it as Kundenguthaben (Tier 58)
   * or leave it as a partial payment on the last
   * invoice.
   */
  private async buildAllocation(
    companyId: string,
    customerId: string,
    amount: number,
  ): Promise<{
    invoices: Array<{
      invoiceId: string
      invoiceNumber: string
      dueDate: Date | null
      total: number
      alreadyPaid: number
      remaining: number
      applied: number
    }>
    unallocatedAmount: number
    totalOutstanding: number
  }> {
    // Find every open invoice (sent/overdue, not
    // draft, not cancelled, not yet fully paid).
    // We compute "remaining" client-side because
    // a per-row SUM(payments) aggregate would be
    // a second roundtrip; for a typical customer
    // (< 50 open invoices) this is fast.
    const openInvoices = await this.prisma.invoice.findMany({
      where: {
        companyId,
        customerId,
        status: { in: ['sent', 'overdue'] },
        type: { in: ['INV', 'PI'] },
      },
      include: {
        payments: { select: { amount: true } },
      },
      orderBy: { dueDate: 'asc' },
    })

    let remaining = amount
    const invoices: Array<{
      invoiceId: string
      invoiceNumber: string
      dueDate: Date | null
      total: number
      alreadyPaid: number
      remaining: number
      applied: number
    }> = []
    let totalOutstanding = 0

    for (const inv of openInvoices) {
      const total = Number(inv.total)
      const alreadyPaid = inv.payments.reduce(
        (s, p) => s + Number(p.amount),
        0,
      )
      const outstanding = Math.max(total - alreadyPaid, 0)
      totalOutstanding += outstanding
      if (outstanding <= 0) continue
      const applied = Math.min(outstanding, remaining)
      remaining = Math.max(remaining - applied, 0)
      invoices.push({
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        dueDate: inv.dueDate,
        total,
        alreadyPaid,
        remaining: outstanding,
        applied,
      })
    }
    return {
      invoices,
      unallocatedAmount: remaining,
      totalOutstanding,
    }
  }

  /**
   * Dry-run: walk the open invoices and return
   * the proposed allocation. No writes. The admin
   * shows this in the modal so they can review
   * "would INV-001 get €2000 and INV-002 get €1500?"
   * before confirming.
   */
  async previewAllocatePayment(
    companyId: string,
    customerId: string,
    amount: number,
  ) {
    if (!amount || amount <= 0) {
      throw new BadRequestException('amount must be > 0')
    }
    // Tenant isolation: confirm the customer
    // belongs to this company first. Otherwise a
    // guessed customerId from another tenant would
    // allocate payments against the wrong tenant's
    // invoices.
    await this.findOne(customerId, companyId)
    return this.buildAllocation(companyId, customerId, amount)
  }

  /**
   * Actually write the allocation. Same walk as
   * preview, but each "applied > 0" row gets a
   * Payment row + the invoice gets bumped to
   * 'paid' when its total is fully covered.
   *
   * Returns the same shape as preview + appliedCount
   * + appliedTotal. The frontend uses appliedCount
   * to show "3 Rechnungen bezahlt, 1.500 € Rest".
   */
  async allocatePayment(
    companyId: string,
    customerId: string,
    args: {
      amount: number
      paymentDate: Date
      paymentMethod: string
      reference?: string
      notes?: string
    },
  ) {
    if (!args.amount || args.amount <= 0) {
      throw new BadRequestException('amount must be > 0')
    }
    if (!args.paymentMethod || !args.paymentMethod.trim()) {
      throw new BadRequestException('paymentMethod is required')
    }
    await this.findOne(customerId, companyId)
    const preview = await this.buildAllocation(
      companyId,
      customerId,
      args.amount,
    )

    // Walk the same allocation, writing Payment
    // rows. We use a Prisma transaction so that
    // either every Payment row + invoice status
    // change lands, or none does — no half-paid
    // state on a crash.
    const appliedInvoices: typeof preview.invoices = []
    await this.prisma.$transaction(async (tx) => {
      for (const alloc of preview.invoices) {
        if (alloc.applied <= 0) continue
        await tx.payment.create({
          data: {
            invoiceId: alloc.invoiceId,
            amount: alloc.applied,
            paymentDate: args.paymentDate,
            paymentMethod: args.paymentMethod,
            reference: args.reference || null,
            notes: args.notes || null,
          },
        })
        // Bump the invoice to 'paid' when fully
        // settled (total - alreadyPaid - applied <= 0).
        // The Tier 32 / Prisma audit-log extension
        // will pick this up automatically — no
        // manual write to AuditLog here.
        if (alloc.applied >= alloc.remaining) {
          await tx.invoice.update({
            where: { id: alloc.invoiceId },
            data: { status: 'paid' },
          })
        }
        appliedInvoices.push(alloc)
      }
    })

    const appliedTotal = appliedInvoices.reduce(
      (s, a) => s + a.applied,
      0,
    )
    return {
      appliedCount: appliedInvoices.length,
      appliedTotal,
      unallocatedAmount: preview.unallocatedAmount,
      totalOutstanding: preview.totalOutstanding,
      applied: appliedInvoices,
    }
  }

  /**
   * Tier 145: internal Berater-Notizen on a customer.
   *
   * Parallel to the invoice-internal-notes API
   * (Tier 138). The same GoBD § 146 Abs. 4 AO
   * compliance angle applies: internal
   * communication between the Berater and the
   * admin that the customer must NEVER see.
   * Goes into a separate table (NOT a field on
   * Customer) so the visibility boundary is
   * enforced at the data layer — there is no
   * way the customer-portal / PDF / email
   * templates can accidentally render these.
   *
   * - listInternalNotes: 200 newest first
   * - createInternalNote: 1..2000 char body, denormalised user email
   * - deleteInternalNote: only the author or an admin
   */
  async listInternalNotes(companyId: string, customerId: string) {
    // Verify the customer belongs to this company
    // first — otherwise a guessed customerId from
    // another tenant would leak its internal notes.
    const cust = await this.findOne(customerId, companyId)
    if (!cust) throw new NotFoundException('Customer not found')
    return this.prisma.customerInternalNote.findMany({
      where: { companyId, customerId },
      orderBy: { createdAt: 'desc' },
    })
  }

  async createInternalNote(
    companyId: string,
    customerId: string,
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
    const cust = await this.findOne(customerId, companyId)
    if (!cust) throw new NotFoundException('Customer not found')
    return this.prisma.customerInternalNote.create({
      data: {
        companyId,
        customerId,
        userId: user.id,
        userEmail: user.email ?? null,
        body: trimmed,
      },
    })
  }

  async deleteInternalNote(
    companyId: string,
    customerId: string,
    noteId: string,
    actor: { id?: string; role?: string | null },
  ) {
    // Tenant isolation: confirm the customer
    // belongs to this company first.
    const cust = await this.findOne(customerId, companyId)
    if (!cust) throw new NotFoundException('Customer not found')
    const note = await this.prisma.customerInternalNote.findFirst({
      where: { id: noteId, companyId, customerId },
    })
    if (!note) throw new NotFoundException('Note not found')
    // Authorization: only the original author or
    // an admin can delete. Otherwise any admin
    // could wipe another admin's notes — bad
    // audit trail.
    const isAuthor = note.userId && actor.id && note.userId === actor.id
    const isAdmin = (actor.role || '').toLowerCase() === 'admin'
    if (!isAuthor && !isAdmin) {
      throw new BadRequestException(
        'Nur der Autor oder ein Admin kann diese Notiz löschen',
      )
    }
    await this.prisma.customerInternalNote.delete({ where: { id: noteId } })
    return { ok: true }
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
          // Fire customer.created webhook for the
          // auto-numbered path too. Same event, same
          // payload as the manually-numbered path
          // below — receivers shouldn't have to
          // distinguish the two cases.
          this.webhooks
            .emit({
              id: `cust_${created.id}`,
              type: 'customer.created',
              occurredAt: new Date().toISOString(),
              companyId,
              data: {
                id: created.id,
                customerNumber: created.customerNumber,
                name: created.name,
                vatId: created.vatId ?? null,
              },
            })
            .catch((err) =>
              console.error(
                'webhook emit(customer.created) failed:',
                err,
              ),
            )
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
    const created = await this.prisma.customer.create({
      data: { ...safeData, companyId },
    });

    // Fire customer.created webhook.
    // eventId is stable for the customer's
    // lifetime — receivers can dedupe on it
    // if they receive the event multiple
    // times (retry after backend crash).
    this.webhooks
      .emit({
        id: `cust_${created.id}`,
        type: 'customer.created',
        occurredAt: new Date().toISOString(),
        companyId,
        data: {
          id: created.id,
          customerNumber: created.customerNumber,
          name: created.name,
          vatId: created.vatId ?? null,
        },
      })
      .catch((err) => console.error('webhook emit(customer.created) failed:', err))

    return created;
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
    const updated = await this.prisma.customer.update({
      where: { id: existing.id },
      data,
    });

    // Fire customer.updated webhook. We use a
    // timestamped eventId so re-deliveries
    // (after backend crash) carry a different
    // eventId, but receivers that dedupe on
    // customer id can still group them.
    this.webhooks
      .emit({
        id: `cust_${id}_updated_${updated.updatedAt?.getTime() ?? Date.now()}`,
        type: 'customer.updated',
        occurredAt: new Date().toISOString(),
        companyId,
        data: {
          id: updated.id,
          customerNumber: updated.customerNumber,
          name: updated.name,
          vatId: updated.vatId ?? null,
        },
      })
      .catch((err) => console.error('webhook emit(customer.updated) failed:', err))

    return updated;
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
    opts: { verifyVat?: boolean; maxVatVerifications?: number } = {},
  ): Promise<ImportResult> {
    // Auto-verify VIES on bulk import. Production
    // behaviour: cap the number of synchronous
    // VIES calls to avoid the import request
    // blocking for 8s × N. The user gets a quick
    // "X imported, Y verified, Z pending" report;
    // the rest can be re-verified later via the
    // per-row Jetzt-prüfen button.
    //
    // Capping strategy: verify the FIRST N rows
    // that have a non-empty VAT. The user can
    // re-import the rest of the file later if
    // they want everything verified at import
    // time. 10 is conservative — it leaves the
    // rest of the token bucket available for
    // interactive "Jetzt prüfen" clicks.
    const MAX_VERIFICATIONS = opts.maxVatVerifications ?? 10
    const verifyVat = opts.verifyVat ?? true
    let verificationsDone = 0
    let verificationsSkipped = 0

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

        // VIES auto-verify. Only if the row has a
        // VAT AND we still have verification budget
        // AND the service is available.
        if (verifyVat && vatId && verificationsDone < MAX_VERIFICATIONS) {
          try {
            const parsed = this.vatValidation.parseVatId(vatId)
            if (parsed) {
              await this.vatValidation.validateAndLog(
                companyId,
                'customer',
                customer.id,
                vatId,
              )
              verificationsDone++
            }
          } catch (e: any) {
            // VIES failure must NOT fail the import.
            // The customer is created; the user can
            // re-verify later. The error is silently
            // dropped here (the row-level VatValidationLog
            // entry already records the failure for
            // audit).
            this.logger.warn(
              `Bulk-import VAT verify failed for row ${rowNum} (${vatId}): ${e?.message || e}`,
            )
          }
        } else if (verifyVat && vatId) {
          verificationsSkipped++
        }
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

    // Attach verification summary to the result so
    // the frontend can show "X verified, Y
    // skipped (re-verify manually)". ImportResult
    // is the existing public type; we add the
    // optional fields defensively.
    if (verifyVat && (verificationsDone > 0 || verificationsSkipped > 0)) {
      ;(result as any).vatVerifications = {
        done: verificationsDone,
        skipped: verificationsSkipped,
        maxPerImport: MAX_VERIFICATIONS,
      }
    }
    return result
  }
}
