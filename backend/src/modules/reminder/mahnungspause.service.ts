import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'

/**
 * Tier 64: Mahnungspause (reminder pause) service.
 *
 * Use cases the API needs to support:
 *   1. Berater pauses a single invoice (overdue, customer
 *      disputed) — invoiceId set, customerId null.
 *   2. Berater pauses a whole customer (Ratenplan active)
 *      — customerId set, invoiceId null.
 *   3. Berater extends / shortens a pause (PATCH).
 *   4. Berater ends a pause early (DELETE = soft-cancel
 *      via cancelledAt = now()).
 *   5. ReminderService.findOverdueInvoices calls
 *      `getActivePausesForCustomers()` to filter
 *      out paused invoices.
 *
 * Validation rules:
 *   - Exactly one of {customerId, invoiceId} is set.
 *   - pausedFrom < pausedUntil (when pausedUntil is set).
 *   - cancelledAt pauses are excluded from the
 *     "active" list (the soft-cancel stamp is permanent).
 *
 * GoBD: the row is never hard-deleted. DELETE
 * soft-cancels. The audit trail (who created /
 * when / why) stays forever.
 */
@Injectable()
export class MahnungspauseService {
  constructor(private prisma: PrismaService) {}

  /**
   * List all Mahnungspausen for the company, ordered
   * most-recent first. Includes both active and
   * cancelled rows so the UI can show a history.
   *
   * `?customerId=X` filters to one customer.
   * `?activeOnly=true` filters to non-cancelled
   * AND currently-in-window rows.
   */
  async list(
    companyId: string,
    opts: { customerId?: string; activeOnly?: boolean; now?: Date } = {},
  ) {
    const now = opts.now ?? new Date()
    const where: any = { companyId }
    if (opts.customerId) where.customerId = opts.customerId
    if (opts.activeOnly) {
      where.cancelledAt = null
      where.pausedFrom = { lte: now }
      where.OR = [{ pausedUntil: null }, { pausedUntil: { gte: now } }]
    }
    return this.prisma.mahnungspause.findMany({
      where,
      orderBy: [{ cancelledAt: 'asc' }, { pausedFrom: 'desc' }],
      include: {
        customer: { select: { id: true, name: true, customerNumber: true } },
        invoice: {
          select: { id: true, invoiceNumber: true, total: true, dueDate: true },
        },
        // User has no `name` column (display name is in
        // profile: Json). Select only id + email so the
        // UI can show "paused by X".
        createdBy: { select: { id: true, email: true } },
      },
    })
  }

  /**
   * Look up the active Mahnungspausen that affect a
   * given set of customer IDs. Used by
   * ReminderService.findOverdueInvoices to filter
   * out paused customers.
   *
   * Returns a Set<customerId> + a Set<invoiceId> so
   * the caller can do a single `for-of` over the
   * candidate invoices with O(1) Set lookups.
   */
  async getActivePausesForCustomers(
    companyId: string,
    customerIds: string[],
    now: Date = new Date(),
  ): Promise<{
    pausedCustomerIds: Set<string>
    pausedInvoiceIds: Set<string>
  }> {
    if (customerIds.length === 0) {
      return { pausedCustomerIds: new Set(), pausedInvoiceIds: new Set() }
    }
    // Tier 64: The where clause mixes a top-level
    // `OR` (pausedUntil null OR >= now) with an `AND`
    // clause that has its own `OR` (customerId IN
    // candidate set OR invoiceId IS NOT NULL). The
    // earlier nested form (AND: [{ OR: [...] }])
    // silently swallowed the candidate-filter under
    // some Prisma versions — the SQL came out as
    // "cancelledAt IS NULL AND (pausedFrom <= now
    // AND ...)" with the customer/invoice filter
    // dropped, returning 0 rows.
    //
    // Workaround: split into two parallel findMany
    // calls (one for customer-level, one for
    // invoice-level) and merge. Each query has a
    // flat, unambiguous structure that maps 1:1 to
    // the SQL Prisma generates.
    const [customerPauses, invoicePauses] = await Promise.all([
      this.prisma.mahnungspause.findMany({
        where: {
          companyId,
          cancelledAt: null,
          pausedFrom: { lte: now },
          OR: [{ pausedUntil: null }, { pausedUntil: { gte: now } }],
          customerId: { in: customerIds },
        },
        select: { customerId: true },
      }),
      this.prisma.mahnungspause.findMany({
        where: {
          companyId,
          cancelledAt: null,
          pausedFrom: { lte: now },
          OR: [{ pausedUntil: null }, { pausedUntil: { gte: now } }],
          invoiceId: { not: null },
        },
        select: { invoiceId: true },
      }),
    ])
    const pausedCustomerIds = new Set<string>(
      customerPauses.map((p) => p.customerId).filter((x): x is string => !!x),
    )
    const pausedInvoiceIds = new Set<string>(
      invoicePauses.map((p) => p.invoiceId).filter((x): x is string => !!x),
    )
    return { pausedCustomerIds, pausedInvoiceIds }
  }

  /**
   * Create a Mahnungspause. Exactly one of customerId
   * / invoiceId is required. pausedFrom defaults to
   * now. pausedUntil defaults to NULL (open-ended).
   */
  async create(
    companyId: string,
    createdById: string | undefined,
    input: {
      customerId?: string | null
      invoiceId?: string | null
      reason: string
      pausedFrom?: Date
      pausedUntil?: Date | null
    },
  ) {
    if (!input.reason?.trim()) {
      throw new BadRequestException('reason ist erforderlich')
    }
    const hasCustomer = !!input.customerId
    const hasInvoice = !!input.invoiceId
    if (hasCustomer === hasInvoice) {
      throw new BadRequestException(
        'Genau eins von customerId oder invoiceId ist erforderlich',
      )
    }
    if (input.pausedUntil && input.pausedFrom) {
      if (input.pausedUntil < input.pausedFrom) {
        throw new BadRequestException(
          'pausedUntil muss nach pausedFrom liegen',
        )
      }
    }

    // Verify the target exists in this company.
    if (hasCustomer) {
      const c = await this.prisma.customer.findFirst({
        where: { id: input.customerId!, companyId },
        select: { id: true },
      })
      if (!c) throw new BadRequestException('Kunde nicht gefunden')
    } else {
      const i = await this.prisma.invoice.findFirst({
        where: { id: input.invoiceId!, companyId },
        select: { id: true },
      })
      if (!i) throw new BadRequestException('Rechnung nicht gefunden')
    }

    return this.prisma.mahnungspause.create({
      data: {
        companyId,
        customerId: input.customerId ?? null,
        invoiceId: input.invoiceId ?? null,
        reason: input.reason.trim(),
        pausedFrom: input.pausedFrom ?? new Date(),
        pausedUntil: input.pausedUntil ?? null,
        createdById: createdById ?? null,
      },
      include: {
        customer: { select: { id: true, name: true, customerNumber: true } },
        invoice: {
          select: { id: true, invoiceNumber: true, total: true, dueDate: true },
        },
        createdBy: { select: { id: true, email: true } },
      },
    })
  }

  /**
   * Soft-cancel a Mahnungspause. The row stays for
   * audit. cancellation timestamp = now.
   */
  async cancel(companyId: string, id: string) {
    const p = await this.prisma.mahnungspause.findFirst({
      where: { id, companyId },
    })
    if (!p) throw new NotFoundException('Mahnungspause nicht gefunden')
    if (p.cancelledAt) {
      // Idempotent: cancelling an already-cancelled
      // pause is a no-op. Don't 400 — the UI can call
      // this twice without harm.
      return this.prisma.mahnungspause.findUnique({ where: { id } })
    }
    return this.prisma.mahnungspause.update({
      where: { id },
      data: { cancelledAt: new Date() },
    })
  }

  /**
   * Extend / shorten pausedUntil. Only the end date
   * is mutable — pausedFrom and reason are immutable
   * (audit-stable). pausedUntil can be set to NULL
   * to re-open an open-ended pause.
   */
  async update(
    companyId: string,
    id: string,
    patch: { pausedUntil?: Date | null; reason?: string },
  ) {
    const p = await this.prisma.mahnungspause.findFirst({
      where: { id, companyId },
    })
    if (!p) throw new NotFoundException('Mahnungspause nicht gefunden')
    if (p.cancelledAt) {
      throw new BadRequestException(
        'Eine beendete Mahnungspause kann nicht mehr geändert werden',
      )
    }
    if (patch.pausedUntil != null && patch.pausedUntil < p.pausedFrom) {
      throw new BadRequestException(
        'pausedUntil muss nach pausedFrom liegen',
      )
    }
    return this.prisma.mahnungspause.update({
      where: { id },
      data: {
        pausedUntil: patch.pausedUntil === undefined ? undefined : patch.pausedUntil,
        reason: patch.reason?.trim() ?? undefined,
      },
    })
  }
}
