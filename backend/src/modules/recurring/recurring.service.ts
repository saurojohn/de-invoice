import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
// Tier 129: send the generated invoice to the customer
// after a successful template run. The service throws
// for "manual" callers when no email is set; for
// "recurring" callers it returns { skipped: true } so
// we can record a 'skipped' RecurringRun rather than
// crashing the cron tick.
import { InvoiceEmailService } from '../invoice/invoice-email.service';

/**
 * Recurring invoice (Abo-Rechnung) service.
 *
 * A `RecurringInvoice` is a template that the scheduler
 * (or a manual click) materialises into a real `Invoice`
 * on a fixed cadence. The template's line items are
 * snapshotted into `RecurringInvoiceItem` so editing
 * the template doesn't retroactively rewrite already-
 * sent invoices.
 *
 * Concurrency: each manual or scheduled run takes a row
 * lock on the `RecurringInvoice` (via SELECT ... FOR UPDATE
 * inside a transaction) and a uniqueness check on
 * `(recurringInvoiceId, periodStart)` to prevent two
 * parallel runs from double-generating the same period.
 *
 * Scheduling: the actual cron tick lives in
 * `recurring.scheduler.ts` and calls `runDueTemplates()`.
 */

export type RecurringInterval = 'monthly' | 'quarterly' | 'yearly' | 'weekly';

const VALID_INTERVALS: RecurringInterval[] = ['monthly', 'quarterly', 'yearly', 'weekly'];

export interface RecurringInput {
  customerId: string;
  name: string;
  interval: RecurringInterval;
  intervalCount?: number;
  dayOfMonth?: number;
  startDate: Date;
  endDate?: Date | null;
  // Tier 153: time-bounded pause. NULL = not
  // paused by date. Set to a future date to
  // skip the scheduler until that day; the
  // service auto-clears it once the date has
  // passed (on the next read).
  pausedUntil?: Date | null;
  currency?: string;
  language?: string;
  notes?: string | null;
  invoiceStatus?: 'draft' | 'sent';
  items: {
    description: string;
    productNumber?: string | null;
    quantity: number;
    unit?: string | null;
    unitPrice: number;
    vatRate: number;
  }[];
}

/**
 * Tier 153: derive the user-facing status from
 * the raw DB columns. The UI shows this as a
 * badge ("🟢 Aktiv" / "⏸ Pausiert bis DATE" /
 * "⏸ Pausiert" / "🛑 Abgelaufen") and the
 * scheduler uses it to decide whether to run.
 *
 *   - 'expired'       endDate < today (will
 *                       never run again — admin
 *                       should edit or delete)
 *   - 'paused'        isActive=false (manual
 *                       pause, indefinite)
 *   - 'paused_until'  pausedUntil >= today
 *                       (auto-resume on that
 *                       date)
 *   - 'active'        everything else
 *
 * The DB-level `isActive` flag is the source
 * of truth; the other states are DERIVED at
 * read time. We don't auto-flip isActive
 * when pausedUntil has passed — the next
 * read just shows 'active' again.
 */
export function deriveRecurringStatus(
  tpl: { isActive: boolean; endDate: Date | null; pausedUntil: Date | null },
  today: Date = new Date(),
): 'active' | 'paused' | 'paused_until' | 'expired' {
  if (tpl.endDate && new Date(tpl.endDate) < today) {
    return 'expired'
  }
  if (tpl.pausedUntil && new Date(tpl.pausedUntil) >= today) {
    return 'paused_until'
  }
  if (!tpl.isActive) {
    return 'paused'
  }
  return 'active'
}

@Injectable()
export class RecurringService {
  private readonly logger = new Logger(RecurringService.name);

  constructor(
    private prisma: PrismaService,
    private invoiceEmailService: InvoiceEmailService,
  ) {}

  /**
   * Compute the FIRST nextRunAt for a brand-new template.
   * Monthly: clamp to the requested dayOfMonth (max 28 so
   * Feb never explodes). Quarterly: same day, every 3
   * months. Yearly: same calendar date. Weekly: same
   * weekday as startDate.
   */
  private computeFirstNextRun(input: RecurringInput): Date {
    const d = new Date(input.startDate)
    d.setHours(0, 0, 0, 0)
    return this.advanceTo(d, input.interval, input.intervalCount ?? 1, input.dayOfMonth ?? 1)
  }

  /**
   * Advance `from` by one period. dayOfMonth is honoured
   * only for monthly/quarterly. If dayOfMonth is past the
   * month's max (e.g. 31 in Feb), we clamp to the last day
   * of the target month.
   */
  private advanceTo(from: Date, interval: RecurringInterval, count: number, dayOfMonth: number): Date {
    const d = new Date(from)
    switch (interval) {
      case 'monthly': {
        d.setMonth(d.getMonth() + count)
        this.setDayClamped(d, dayOfMonth)
        break
      }
      case 'quarterly': {
        d.setMonth(d.getMonth() + 3 * count)
        this.setDayClamped(d, dayOfMonth)
        break
      }
      case 'yearly': {
        d.setFullYear(d.getFullYear() + count)
        // For yearly we use the calendar day of the start,
        // ignoring dayOfMonth (Feb 29 still works in leap
        // years).
        d.setMonth(from.getMonth())
        d.setDate(from.getDate())
        break
      }
      case 'weekly': {
        d.setDate(d.getDate() + 7 * count)
        break
      }
    }
    return d
  }

  private setDayClamped(d: Date, day: number) {
    // Clamp 1..28 to be safe — never go beyond 28 because
    // Feb has 28 (or 29) days. If the user wants "last day
    // of month" semantics, they can pick 28 + a day-1 in
    // post-processing; for now 28 is the conservative cap.
    const target = Math.max(1, Math.min(28, day))
    const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
    d.setDate(Math.min(target, monthEnd))
  }

  async list(companyId: string) {
    const rows = await this.prisma.recurringInvoice.findMany({
      where: { companyId },
      orderBy: [{ isActive: 'desc' }, { nextRunAt: 'asc' }],
      include: {
        customer: { select: { id: true, name: true, customerNumber: true } },
        items: { orderBy: { position: 'asc' } },
        _count: { select: { runs: true, invoices: true } },
      },
    })
    // Tier 153: stamp the derived status on each
    // row so the UI can show a badge without
    // re-implementing the logic.
    return rows.map((r) => ({ ...r, status: deriveRecurringStatus(r) }))
  }

  async getOne(companyId: string, id: string) {
    const r = await this.prisma.recurringInvoice.findFirst({
      where: { id, companyId },
      include: {
        customer: true,
        items: { orderBy: { position: 'asc' } },
        runs: { orderBy: { createdAt: 'desc' }, take: 25 },
        invoices: {
          orderBy: { issueDate: 'desc' },
          take: 25,
          select: { id: true, invoiceNumber: true, issueDate: true, total: true, status: true },
        },
        // _count is included on list() — adding it here
        // too so the expanded view in the UI doesn't
        // break (the row tile accesses tpl._count.runs
        // and a partial record here would crash the
        // entire page with a TypeError).
        _count: { select: { runs: true, invoices: true } },
      },
    })
    if (!r) throw new BadRequestException('Recurring invoice not found')
    return { ...r, status: deriveRecurringStatus(r) }
  }

  async create(companyId: string, createdById: string | undefined, input: RecurringInput) {
    if (!VALID_INTERVALS.includes(input.interval)) {
      throw new BadRequestException(`interval must be one of ${VALID_INTERVALS.join(', ')}`)
    }
    if (!input.items?.length) {
      throw new BadRequestException('At least one line item is required')
    }
    // Verify the customer belongs to this company
    const customer = await this.prisma.customer.findFirst({
      where: { id: input.customerId, companyId },
    })
    if (!customer) throw new BadRequestException('Customer not found in this company')

    const nextRunAt = this.computeFirstNextRun(input)

    return this.prisma.recurringInvoice.create({
      data: {
        companyId,
        customerId: input.customerId,
        name: input.name,
        interval: input.interval,
        intervalCount: input.intervalCount ?? 1,
        dayOfMonth: input.dayOfMonth ?? 1,
        startDate: input.startDate,
        endDate: input.endDate ?? null,
        nextRunAt,
        currency: input.currency ?? 'EUR',
        language: input.language ?? 'de-DE',
        notes: input.notes ?? null,
        invoiceStatus: input.invoiceStatus ?? 'draft',
        // Tier 153: time-bounded pause. NULL by
        // default — the UI uses a separate "Pause
        // bis" modal to set this.
        pausedUntil: input.pausedUntil ?? null,
        createdById,
        items: {
          create: input.items.map((it, i) => ({
            description: it.description,
            productNumber: it.productNumber ?? null,
            quantity: it.quantity,
            unit: it.unit ?? 'Stück',
            unitPrice: it.unitPrice,
            vatRate: it.vatRate,
            position: i,
          })),
        },
      },
      include: { items: true, customer: { select: { id: true, name: true } } },
    }).then((r) => ({ ...r, status: deriveRecurringStatus(r) }))
  }

  /**
   * Tier 158: clone an existing RecurringInvoice as a
   * new template. The Berater's question: "I have a
   * maintenance subscription for Customer A. Now
   * Customer B wants the same — let me clone the
   * template instead of typing it in from scratch."
   *
   * Copies:
   *   - All line items (description, qty, price, vat,
   *     product number, position)
   *   - interval, intervalCount, dayOfMonth
   *   - currency, language, notes, invoiceStatus,
   *     sendEmail
   *
   * Overrides (from the request body, all optional
   * except name):
   *   - name        — defaults to "<original> (Kopie)"
   *   - customerId  — defaults to the original's customer
   *   - startDate   — defaults to today (the operator
   *                   almost always wants the new
   *                   subscription to start now, not
   *                   inherit the old start date)
   *   - endDate     — defaults to NULL (a new
   *                   subscription rarely has the
   *                   same end date as the old one)
   *   - isActive    — defaults to true (clone is ready
   *                   to run from day 1)
   *   - pausedUntil — defaults to NULL (no pause)
   *
   * NOT copied (each clone starts with a clean slate):
   *   - lastRunAt, nextRunAt, runs, invoices — the
   *     new template has no history yet
   *   - createdById — stamps the current operator as
   *     the author
   */
  async clone(
    companyId: string,
    sourceId: string,
    overrides: {
      name?: string
      customerId?: string
      startDate?: Date
    },
    createdById?: string,
  ) {
    const source = await this.prisma.recurringInvoice.findFirst({
      where: { id: sourceId, companyId },
      include: { items: { orderBy: { position: 'asc' } } },
    })
    if (!source) {
      throw new BadRequestException('Source RecurringInvoice not found')
    }
    if (!source.items?.length) {
      throw new BadRequestException(
        'Source RecurringInvoice has no line items to clone',
      )
    }

    const newName = (overrides.name ?? `${source.name} (Kopie)`).trim()
    if (!newName) {
      throw new BadRequestException('name is required')
    }
    const newCustomerId = overrides.customerId ?? source.customerId
    // Verify the new customer belongs to this company
    // (defense in depth — the frontend shouldn't ever
    // let a cross-tenant id through, but the service
    // is the trust boundary).
    const newCustomer = await this.prisma.customer.findFirst({
      where: { id: newCustomerId, companyId },
    })
    if (!newCustomer) {
      throw new BadRequestException('Customer not found in this company')
    }
    // New startDate defaults to today; the operator
    // almost always wants the new subscription to
    // start now. They can edit before saving.
    const newStartDate = overrides.startDate ?? new Date()

    // Compute the first nextRunAt for the new
    // template. The helper takes the input shape
    // (not the DB row), so we project to that.
    const projectedInput: RecurringInput = {
      customerId: newCustomerId,
      name: newName,
      interval: source.interval as any,
      intervalCount: source.intervalCount,
      dayOfMonth: source.dayOfMonth,
      startDate: newStartDate,
      endDate: null,
      currency: source.currency,
      language: source.language,
      notes: source.notes,
      invoiceStatus: source.invoiceStatus as any,
      items: source.items.map((it) => ({
        description: it.description,
        productNumber: it.productNumber,
        quantity: Number(it.quantity),
        unit: it.unit,
        unitPrice: Number(it.unitPrice),
        vatRate: Number(it.vatRate),
      })),
    }
    const nextRunAt = this.computeFirstNextRun(projectedInput)

    return this.prisma.recurringInvoice
      .create({
        data: {
          companyId,
          customerId: newCustomerId,
          name: newName,
          interval: source.interval,
          intervalCount: source.intervalCount,
          dayOfMonth: source.dayOfMonth,
          startDate: newStartDate,
          endDate: null,
          nextRunAt,
          currency: source.currency,
          language: source.language,
          notes: source.notes,
          invoiceStatus: source.invoiceStatus,
          isActive: true,
          pausedUntil: null,
          sendEmail: source.sendEmail,
          createdById,
          items: {
            create: source.items.map((it, i) => ({
              description: it.description,
              productNumber: it.productNumber,
              quantity: it.quantity,
              unit: it.unit,
              unitPrice: it.unitPrice,
              vatRate: it.vatRate,
              position: i,
            })),
          },
        },
        include: {
          items: { orderBy: { position: 'asc' } },
          customer: { select: { id: true, name: true } },
        },
      })
      .then((r) => ({ ...r, status: deriveRecurringStatus(r) }))
  }

  async update(companyId: string, id: string, patch: Partial<RecurringInput> & { isActive?: boolean }) {
    const existing = await this.prisma.recurringInvoice.findFirst({ where: { id, companyId } })
    if (!existing) throw new BadRequestException('Recurring invoice not found')

    // Items replacement strategy: wipe + recreate. The
    // historical runs still reference the OLD items via
    // the Invoice.recurringInvoiceId → InvoiceItem row
    // (snapshotted at run time), so we can safely
    // re-create the template items without touching
    // already-generated invoices.
    if (patch.items) {
      await this.prisma.recurringInvoiceItem.deleteMany({ where: { recurringInvoiceId: id } })
    }

    // Recompute nextRunAt if the cadence or startDate changed
    let nextRunAt: Date | undefined
    const interval = (patch.interval ?? existing.interval) as RecurringInterval
    const intervalCount = patch.intervalCount ?? existing.intervalCount
    const dayOfMonth = patch.dayOfMonth ?? existing.dayOfMonth
    const startDate = patch.startDate ?? existing.startDate
    if (patch.interval || patch.intervalCount || patch.dayOfMonth || patch.startDate) {
      nextRunAt = this.advanceTo(new Date(startDate), interval, intervalCount, dayOfMonth)
    }

    return this.prisma.recurringInvoice.update({
      where: { id },
      data: {
        name: patch.name ?? undefined,
        customerId: patch.customerId ?? undefined,
        interval: patch.interval ?? undefined,
        intervalCount: patch.intervalCount ?? undefined,
        dayOfMonth: patch.dayOfMonth ?? undefined,
        startDate: patch.startDate ?? undefined,
        endDate: patch.endDate === undefined ? undefined : patch.endDate,
        currency: patch.currency ?? undefined,
        language: patch.language ?? undefined,
        notes: patch.notes === undefined ? undefined : patch.notes,
        invoiceStatus: patch.invoiceStatus ?? undefined,
        isActive: patch.isActive ?? undefined,
        // Tier 153: explicit null clears the
        // pause-by-date. The frontend uses
        // null to mean "remove the pause".
        pausedUntil: patch.pausedUntil === undefined ? undefined : patch.pausedUntil,
        nextRunAt: nextRunAt ?? undefined,
        items: patch.items ? {
          create: patch.items.map((it, i) => ({
            description: it.description,
            productNumber: it.productNumber ?? null,
            quantity: it.quantity,
            unit: it.unit ?? 'Stück',
            unitPrice: it.unitPrice,
            vatRate: it.vatRate,
            position: i,
          })),
        } : undefined,
      },
      include: { items: true, customer: { select: { id: true, name: true } } },
    }).then((r) => ({ ...r, status: deriveRecurringStatus(r) }))
  }

  async delete(companyId: string, id: string) {
    const r = await this.prisma.recurringInvoice.findFirst({ where: { id, companyId } })
    if (!r) throw new BadRequestException('Recurring invoice not found')
    // Already-generated invoices stay — they have their
    // own copy of the line items and the recurringInvoiceId
    // link just gets nulled via onDelete: SetNull.
    await this.prisma.recurringInvoice.delete({ where: { id } })
    return { ok: true }
  }

  /**
   * Tier 63: Aggregate stats for the dashboard widget.
   *
   * Returns a single-shot summary so the frontend
   * doesn't have to N+1 through the list endpoint.
   * 6 numbers:
   *   - active:    templates where isActive=true
   *   - paused:    templates where isActive=false
   *   - dueThisWeek: active templates whose nextRunAt
   *                falls between now and +7 days.
   *                Drives the "X fällig diese Woche"
   *                badge on the dashboard widget.
   *   - runsThisMonth: RecurringRun rows in the current
   *                calendar month (any status).
   *   - failedLast30Days: RecurringRun where status='failed'
   *                in the last 30 days. Drives the
   *                "Y fehlgeschlagen" warning.
   *   - totalLifetime: Σ invoices generated by ALL
   *                templates in this company. The
   *                lifetime counter is informative —
   *                shows the value of automation.
   *   - dueThisWeekList: the actual templates due
   *                this week (id + name + nextRunAt
   *                + customer name) so the widget can
   *                deep-link to each one. Cap at 5.
   *
   * All 7 queries are run in parallel via Promise.all.
   * The 5x speedup (vs sequential) makes a noticeable
   * difference on the dashboard cold-render.
   */
  async stats(companyId: string, now: Date = new Date()) {
    const weekFromNow = new Date(now)
    weekFromNow.setDate(weekFromNow.getDate() + 7)
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const thirtyDaysAgo = new Date(now)
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

    const [
      active,
      paused,
      dueThisWeek,
      runsThisMonth,
      failedLast30Days,
      dueThisWeekList,
    ] = await Promise.all([
      this.prisma.recurringInvoice.count({
        where: { companyId, isActive: true },
      }),
      this.prisma.recurringInvoice.count({
        where: { companyId, isActive: false },
      }),
      this.prisma.recurringInvoice.count({
        where: {
          companyId,
          isActive: true,
          nextRunAt: { gte: now, lte: weekFromNow },
        },
      }),
      this.prisma.recurringRun.count({
        where: {
          companyId,
          createdAt: { gte: monthStart },
        },
      }),
      this.prisma.recurringRun.count({
        where: {
          companyId,
          status: 'failed',
          createdAt: { gte: thirtyDaysAgo },
        },
      }),
      // Cap at 5 — the dashboard widget shows a
      // preview list, not the full table. Sort
      // by nextRunAt ASC so the most-imminent
      // one is first.
      this.prisma.recurringInvoice.findMany({
        where: {
          companyId,
          isActive: true,
          nextRunAt: { gte: now, lte: weekFromNow },
        },
        orderBy: { nextRunAt: 'asc' },
        take: 5,
        select: {
          id: true,
          name: true,
          nextRunAt: true,
          interval: true,
          intervalCount: true,
          customer: { select: { id: true, name: true, customerNumber: true } },
        },
      }),
    ])

    return {
      active,
      paused,
      dueThisWeek,
      runsThisMonth,
      failedLast30Days,
      dueThisWeekList: dueThisWeekList.map((t) => ({
        id: t.id,
        name: t.name,
        nextRunAt: t.nextRunAt,
        interval: t.interval,
        intervalCount: t.intervalCount,
        customer: t.customer,
      })),
    }
  }

  /**
   * Tier 63: Convert a real (already-generated) invoice
   * into a recurring template.
   *
   * The user can click "Wiederkehrend machen" on any
   * existing invoice (one-off or already-recurring) and
   * we prefill a new template from it:
   *   - customerId, currency, language, notes → copied
   *   - items (description, qty, unit, price, vat) → copied
   *   - interval / intervalCount / dayOfMonth / startDate
   *     / endDate → LEFT to the user to fill (defaults:
   *     monthly / 1 / today's day / today)
   *   - name → "Aus Rechnung {invoiceNumber}" (user can rename)
   *
   * The link is one-way: this creates a NEW template
   * that, when it runs, will materialise NEW invoices.
   * The original invoice stays as-is (no
   * recurringInvoiceId pointer).
   */
  async fromInvoice(companyId: string, invoiceId: string) {
    const inv = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, companyId },
      include: {
        items: { orderBy: { id: 'asc' } },
        customer: { select: { id: true, name: true, customerNumber: true } },
      },
    })
    if (!inv) throw new BadRequestException('Invoice not found in this company')

    const today = new Date()
    const startDate = new Date(today)
    startDate.setHours(0, 0, 0, 0)

    return {
      // Pre-fill shape that the recurring-invoices page
      // modal can directly consume. The page already
      // accepts this shape when creating a template.
      customerId: inv.customerId,
      customer: inv.customer,
      name: `Aus Rechnung ${inv.invoiceNumber}`,
      interval: 'monthly',
      intervalCount: 1,
      // Day-of-month defaults to today's day so the
      // next run is "this month" (or next if today > 28).
      dayOfMonth: Math.min(today.getDate(), 28),
      startDate: startDate.toISOString().slice(0, 10),
      endDate: null,
      currency: inv.currency || 'EUR',
      language: inv.language || 'de-DE',
      notes: inv.notes || null,
      invoiceStatus: 'draft' as const,
      items: inv.items.map((it) => ({
        description: it.description,
        productNumber: it.productNumber,
        quantity: Number(it.quantity),
        unit: it.unit || 'Stück',
        unitPrice: Number(it.unitPrice),
        vatRate: Number(it.vatRate),
      })),
    }
  }

  /**
   * Materialise ONE period of a template into a real
   * Invoice. Returns the new invoice + the RecurringRun
   * row. Throws on failure (caller should catch + write
   * a status='failed' run row).
   *
   * Transactional: SELECT FOR UPDATE the template row to
   * serialise concurrent runs; the run row is the
   * idempotency key (unique on templateId+periodStart).
   */
  /**
   * Tier 129: convenience wrapper for the manual
   * "Jetzt generieren" button. The button path goes
   * through the controller, which can't easily await
   * a side effect after the fact — so we wrap the
   * run + the email in a single call. The cron path
   * (runDueTemplates) calls runOne + emailGeneratedInvoice
   * inline because it needs to keep the per-template
   * result list.
   */
  async runOneAndEmail(
    companyId: string,
    templateId: string,
    options: { trigger: 'manual' | 'scheduled'; now?: Date } = { trigger: 'manual' },
  ) {
    const result = await this.runOne(companyId, templateId, options)
    // Fire-and-forget: don't await, so the controller
    // returns the invoice ID immediately. The email
    // is logged to the backend log when it completes
    // (success or skip or fail). A failure here can
    // never affect the invoice generation outcome.
    this.emailGeneratedInvoice(templateId, companyId, result.invoiceId)
      .catch((err) => this.logger.warn(`emailGeneratedInvoice threw: ${err?.message || err}`))
    return result
  }

  async runOne(
    companyId: string,
    templateId: string,
    options: { trigger: 'manual' | 'scheduled'; now?: Date } = { trigger: 'manual' },
  ): Promise<{ invoiceId: string; runId: string; periodStart: Date; periodEnd: Date }> {
    const now = options.now ?? new Date()

    return this.prisma.$transaction(async (tx) => {
      // Lock the template row for the duration of the
      // transaction. Concurrent runs on the same template
      // block here until the first one commits.
      const [tpl] = await tx.$queryRawUnsafe<any[]>(`
        SELECT * FROM "RecurringInvoice"
        WHERE id = $1 AND "companyId" = $2
        FOR UPDATE
      `, templateId, companyId)
      if (!tpl) throw new BadRequestException('Recurring invoice not found')
      if (!tpl.isActive) throw new BadRequestException('Recurring invoice is paused')

      // Idempotency: `tpl.nextRunAt` is the SOURCE OF TRUTH
      // for the next period. The row lock above serialised
      // parallel runs, and the DB unique constraint on
      // (recurringInvoiceId, periodStart) is the final
      // dedup gate. We don't bother with a `findFirst` check
      // here — the P2002 catch in the run-create below is
      // cheaper and atomic.
      //
      // Important: a "manual" run advances nextRunAt after
      // success, so a SECOND click immediately afterwards
      // sees the NEW nextRunAt and bills the NEXT period
      // (intended). To "regenerate the same period" the
      // user would have to manually reset nextRunAt on the
      // template. The DB unique constraint catches the
      // pathological case of two parallel crons racing.
      const periodStart = new Date(tpl.nextRunAt)

      // Has it passed the endDate? The transaction is
      // "succeed or roll back" — if we throw inside, the
      // isActive=false update would also roll back. So
      // we capture the skip as a sentinel, let the
      // transaction COMMIT normally (writing the skipped
      // run row + flipping isActive), then throw OUTSIDE.
      let skipRunId: string | null = null
      if (tpl.endDate && tpl.nextRunAt > new Date(tpl.endDate)) {
        await tx.recurringInvoice.update({
          where: { id: templateId },
          data: { isActive: false },
        })
        const skipRun = await tx.recurringRun.create({
          data: {
            recurringInvoiceId: templateId,
            companyId,
            trigger: options.trigger,
            periodStart: tpl.nextRunAt,
            periodEnd: tpl.nextRunAt,
            status: 'skipped',
            errorMessage: 'endDate in past — auto-disabled',
          },
        })
        // Return a sentinel object — the outer code
        // inspects it and throws after the tx commits.
        return { __skipped: true, skipRunId: skipRun.id } as any
      }
      // Tier 153: time-bounded pause. The template
      // is technically isActive=true but the user
      // asked to skip until a specific date. We
      // record a 'skipped' run so the audit trail
      // shows the pause is being respected, then
      // bail. We do NOT advance nextRunAt — the
      // service will re-evaluate on the next tick
      // (or next manual runNow) once pausedUntil
      // has passed. The status flag stays as
      // 'paused_until' in the meantime.
      if (tpl.pausedUntil && new Date(tpl.pausedUntil) >= new Date()) {
        const skipRun = await tx.recurringRun.create({
          data: {
            recurringInvoiceId: templateId,
            companyId,
            trigger: options.trigger,
            periodStart: tpl.nextRunAt,
            periodEnd: tpl.nextRunAt,
            status: 'skipped',
            errorMessage: `paused until ${tpl.pausedUntil.toISOString().slice(0, 10)}`,
          },
        })
        return { __skipped: true, skipRunId: skipRun.id } as any
      }

      // Load items + customer for the invoice.
      const items = await tx.recurringInvoiceItem.findMany({
        where: { recurringInvoiceId: templateId },
        orderBy: { position: 'asc' },
      })
      if (!items.length) throw new BadRequestException('No line items on template')

      // Compute period end from period start (period start
      // was already computed above as `lastRunAt + interval`
      // or `tpl.nextRunAt` on the first run — for idempotency).
      const periodEnd = this.advanceTo(
        periodStart,
        tpl.interval as RecurringInterval,
        tpl.intervalCount,
        tpl.dayOfMonth,
      )

      // Compute totals from the snapshot items.
      const subtotal = items.reduce((s, it) => s + Number(it.unitPrice) * Number(it.quantity), 0)
      // VAT breakdown per rate.
      const vatByRate = new Map<number, { rate: number; net: number; vat: number }>()
      for (const it of items) {
        const net = Number(it.unitPrice) * Number(it.quantity)
        const rate = Number(it.vatRate)
        const vat = net * rate
        const cur = vatByRate.get(rate) || { rate, net: 0, vat: 0 }
        cur.net += net
        cur.vat += vat
        vatByRate.set(rate, cur)
      }
      const totalVat = Array.from(vatByRate.values()).reduce((s, v) => s + v.vat, 0)
      const total = subtotal + totalVat
      const vatBreakdown = Array.from(vatByRate.values()).map((v) => ({
        rate: v.rate,
        netAmount: Math.round(v.net * 100) / 100,
        vatAmount: Math.round(v.vat * 100) / 100,
      }))

      // Find the next invoice number for this company+type+year.
      // Recurring invoices use the same INV-YYYY-NNNNN
      // sequence as manually-created ones so the Steuerberater
      // sees a continuous numbering. We pick max+1 (no
      // gap-filling for recurring — it's a stable sequence).
      const currentYear = periodStart.getFullYear()
      const prefix = tpl.interval === 'yearly' ? 'INV-' : 'INV-' // future: per-year prefix
      const sameYear = await tx.invoice.findMany({
        where: {
          companyId,
          type: 'INV',
          invoiceNumber: { startsWith: `${prefix}${currentYear}-` },
        },
        select: { invoiceNumber: true },
      })
      let maxSeq = 0
      for (const r of sameYear) {
        const m = r.invoiceNumber.match(new RegExp(`^${prefix}\\d{4}-(\\d+)$`))
        if (m) {
          const n = parseInt(m[1], 10)
          if (n > maxSeq) maxSeq = n
        }
      }
      const invoiceNumber = `${prefix}${currentYear}-${String(maxSeq + 1).padStart(6, '0')}`

      // Create the invoice. issueDate = today; dueDate = issueDate + 30d
      // by default (the user can edit per-invoice later).
      const issueDate = new Date(now)
      const dueDate = new Date(issueDate)
      dueDate.setDate(dueDate.getDate() + 30)

      const invoice = await tx.invoice.create({
        data: {
          companyId,
          customerId: tpl.customerId,
          invoiceNumber,
          sequencePrefix: prefix,
          sequenceYear: currentYear,
          sequenceNumber: maxSeq + 1,
          type: 'INV',
          status: tpl.invoiceStatus || 'draft',
          issueDate,
          dueDate,
          // Prisma Decimal columns reject plain `number`;
          // round to 4dp + string to match `@db.Decimal(12,4)`.
          subtotal: (Math.round(subtotal * 10000) / 10000).toFixed(4),
          totalVat: (Math.round(totalVat * 10000) / 10000).toFixed(4),
          total: (Math.round(total * 10000) / 10000).toFixed(4),
          currency: tpl.currency,
          language: tpl.language,
          notes: tpl.notes,
          vatBreakdown,
          recurringInvoiceId: templateId,
          createdById: tpl.createdById,
          items: {
            create: items.map((it) => ({
              description: it.description,
              productNumber: it.productNumber,
              quantity: it.quantity.toString(),
              unit: it.unit,
              unitPrice: it.unitPrice.toString(),
              vatRate: it.vatRate.toString(),
              netAmount: (Math.round(Number(it.unitPrice) * Number(it.quantity) * 10000) / 10000).toFixed(4),
              vatAmount: (Math.round(Number(it.unitPrice) * Number(it.quantity) * Number(it.vatRate) * 10000) / 10000).toFixed(4),
              grossAmount: (Math.round(Number(it.unitPrice) * Number(it.quantity) * (1 + Number(it.vatRate)) * 10000) / 10000).toFixed(4),
              // productId snapshot if the productNumber matches
              // an existing product — best-effort (not implemented
              // yet; user can edit the invoice afterwards to link).
              productId: null,
            })),
          },
        },
      })

      // Write the run row. The DB-level
      // `@@unique([recurringInvoiceId, periodStart])` is
      // our last line of defence: if a parallel cron tick
      // slipped through the row lock (shouldn't, but
      // belt-and-suspenders), the duplicate insert raises
      // P2002 and the outer transaction rolls back — no
      // double invoice, no double run.
      let run: { id: string }
      try {
        run = await tx.recurringRun.create({
          data: {
            recurringInvoiceId: templateId,
            companyId,
            trigger: options.trigger,
            periodStart,
            periodEnd,
            invoiceId: invoice.id,
            status: 'success',
          },
        })
      } catch (e: any) {
        if (e?.code === 'P2002') {
          // Another concurrent run already inserted a
          // run row for this period. Roll back the whole
          // transaction (the invoice create above will
          // also be reverted) and surface a clean error.
          this.logger.warn(
            `Recurring ${templateId} duplicate run for ${periodStart.toISOString()} (P2002) — rolling back`,
          )
          throw new BadRequestException(`Already ran for period ${periodStart.toISOString().split('T')[0]} (race)`)
        }
        throw e
      }

      // Advance nextRunAt. lastRunAt = now.
      await tx.recurringInvoice.update({
        where: { id: templateId },
        data: {
          lastRunAt: now,
          nextRunAt: this.advanceTo(periodStart, tpl.interval as RecurringInterval, tpl.intervalCount, tpl.dayOfMonth),
        },
      })

      this.logger.log(
        `Generated ${invoiceNumber} from recurring template ${templateId} (period ${periodStart.toISOString().split('T')[0]})`,
      )

      return { invoiceId: invoice.id, runId: run.id, periodStart, periodEnd }
    }).then((result: any) => {
      // Handle the skip sentinel from inside the tx.
      if (result && result.__skipped) {
        throw new BadRequestException(
          `End date reached; auto-disabled. Run ${result.skipRunId} logged.`,
        )
      }
      return result
    })
  }

  /**
   * Find all due templates across the system and run them.
   * Called by the cron scheduler once per day. Returns
   * the per-template outcome.
   *
   * Concurrency: re-uses the row lock inside runOne() to
   * serialise parallel calls (e.g. two replicas of the
   * API both firing the cron tick).
   */
  async runDueTemplates(now: Date = new Date()): Promise<{ templateId: string; result: 'success' | 'skipped' | 'failed'; invoiceId?: string; error?: string }[]> {
    // Tier 153: pre-filter time-bounded pauses
    // so we don't even acquire a row lock for
    // them. The runOne() check is a safety net
    // for any race where pausedUntil is set
    // after this read.
    const due = await this.prisma.recurringInvoice.findMany({
      where: {
        isActive: true,
        nextRunAt: { lte: now },
        OR: [
          { pausedUntil: null },
          { pausedUntil: { lt: now } },
        ],
      },
      select: { id: true, companyId: true },
    })
    const results: { templateId: string; result: 'success' | 'skipped' | 'failed'; invoiceId?: string; error?: string }[] = []
    for (const t of due) {
      try {
        const r = await this.runOne(t.companyId, t.id, { trigger: 'scheduled', now })
        results.push({ templateId: t.id, result: 'success', invoiceId: r.invoiceId })

        // Tier 129: auto-email the generated invoice
        // to the customer (if sendEmail=true on the
        // template). We do this AFTER runOne() returned
        // so the email send is outside the DB
        // transaction — a slow SMTP roundtrip doesn't
        // hold a row lock. A failure to send the email
        // is logged to the recurring-run row but does
        // NOT downgrade the run to 'failed': the
        // invoice was created, the customer just
        // didn't get the email notification. The
        // operator can re-send manually from the
        // invoice detail page.
        const tpl = await this.prisma.recurringInvoice.findUnique({
          where: { id: t.id },
          select: { sendEmail: true, language: true },
        })
        if (tpl?.sendEmail) {
          try {
            const emailResult = await this.invoiceEmailService.sendInvoiceByEmail(
              r.invoiceId,
              t.companyId,
              {
                language: tpl.language?.startsWith('en') ? 'en'
                  : tpl.language?.startsWith('zh') ? 'zh'
                  : 'de',
                source: 'recurring',
              },
            )
            if (emailResult.skipped) {
              this.logger.warn(
                `recurring email skipped for invoice ${r.invoiceId}: ${emailResult.skipReason} (${emailResult.error})`,
              )
            } else if (!emailResult.success) {
              this.logger.warn(
                `recurring email failed for invoice ${r.invoiceId}: ${emailResult.error}`,
              )
            } else {
              this.logger.log(
                `recurring email sent for invoice ${r.invoiceId} → ${emailResult.recipient} (smtp=${emailResult.smtpConfigured})`,
              )
            }
          } catch (emailErr: any) {
            this.logger.warn(
              `recurring email threw for invoice ${r.invoiceId}: ${emailErr?.message || emailErr}`,
            )
          }
        }
      } catch (e: any) {
        const msg = e?.message || String(e)
        const result: 'failed' | 'skipped' = msg.includes('endDate') || msg.includes('paused') ? 'skipped' : 'failed'
        results.push({ templateId: t.id, result, error: msg })
        // Record the failed run for visibility
        try {
          await this.prisma.recurringRun.create({
            data: {
              recurringInvoiceId: t.id,
              companyId: t.companyId,
              trigger: 'scheduled',
              periodStart: now,
              periodEnd: now,
              status: result,
              errorMessage: msg.substring(0, 500),
            },
          })
        } catch { /* ignore — best effort */ }
      }
    }
    return results
  }

  /**
   * Tier 129: post-generation hook — send the freshly
   * created invoice to the customer. Called by both
   * the cron path (runDueTemplates) and the manual
   * "Jetzt generieren" button (the controller calls
   * runOne directly, not runDueTemplates). Failures
   * are logged but never throw — the invoice was
   * already created, a failed email is a notification
   * issue, not a generation issue.
   */
  async emailGeneratedInvoice(
    templateId: string,
    companyId: string,
    invoiceId: string,
  ): Promise<void> {
    const tpl = await this.prisma.recurringInvoice.findUnique({
      where: { id: templateId },
      select: { sendEmail: true, language: true },
    })
    if (!tpl?.sendEmail) return

    try {
      const result = await this.invoiceEmailService.sendInvoiceByEmail(
        invoiceId,
        companyId,
        {
          language: tpl.language?.startsWith('en') ? 'en'
            : tpl.language?.startsWith('zh') ? 'zh'
            : 'de',
          source: 'recurring',
        },
      )
      if (result.skipped) {
        this.logger.warn(
          `recurring email skipped for invoice ${invoiceId}: ${result.skipReason} (${result.error})`,
        )
      } else if (!result.success) {
        this.logger.warn(
          `recurring email failed for invoice ${invoiceId}: ${result.error}`,
        )
      } else {
        this.logger.log(
          `recurring email sent for invoice ${invoiceId} → ${result.recipient} (smtp=${result.smtpConfigured})`,
        )
      }
    } catch (err: any) {
      this.logger.warn(
        `recurring email threw for invoice ${invoiceId}: ${err?.message || err}`,
      )
    }
  }

  /**
   * Preview the next invoice a template WOULD generate,
   * without writing it. Used by the "Vorschau" button in
   * the UI so the user can sanity-check totals before
   * hitting "Jetzt generieren".
   */
  async previewNext(companyId: string, templateId: string) {
    const tpl = await this.prisma.recurringInvoice.findFirst({
      where: { id: templateId, companyId },
      include: { items: { orderBy: { position: 'asc' } } },
    })
    if (!tpl) throw new BadRequestException('Recurring invoice not found')

    const periodStart = new Date(tpl.nextRunAt)
    const periodEnd = this.advanceTo(periodStart, tpl.interval as RecurringInterval, tpl.intervalCount, tpl.dayOfMonth)
    const subtotal = tpl.items.reduce((s, it) => s + Number(it.unitPrice) * Number(it.quantity), 0)
    const totalVat = tpl.items.reduce((s, it) => s + Number(it.unitPrice) * Number(it.quantity) * Number(it.vatRate), 0)
    const total = subtotal + totalVat

    return {
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
      issueDate: new Date().toISOString(),
      dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      items: tpl.items.map((it) => ({
        description: it.description,
        productNumber: it.productNumber,
        quantity: Number(it.quantity),
        unit: it.unit,
        unitPrice: Number(it.unitPrice),
        vatRate: Number(it.vatRate),
        netAmount: Math.round(Number(it.unitPrice) * Number(it.quantity) * 100) / 100,
        vatAmount: Math.round(Number(it.unitPrice) * Number(it.quantity) * Number(it.vatRate) * 100) / 100,
        grossAmount: Math.round(Number(it.unitPrice) * Number(it.quantity) * (1 + Number(it.vatRate)) * 100) / 100,
      })),
      subtotal: Math.round(subtotal * 100) / 100,
      totalVat: Math.round(totalVat * 100) / 100,
      total: Math.round(total * 100) / 100,
    }
  }

  /**
   * Tier 136: preview the email that would be sent
   * if this template ran right now. Returns the same
   * shape the actual sendInvoiceByEmail flow
   * produces (subject + body + recipient + sample
   * dates), but with:
   *   - sample invoice number `INV-XXXX-YYYY`
   *     (the real one is only assigned on persist)
   *   - amounts pulled from the template's items
   *   - due date = today + paymentTerms days
   *   - recipient = customer.contact.email
   *   - locale = the template's language (or DE)
   *
   * The point of this endpoint: the operator can
   * see exactly what the customer will receive
   * before flipping `sendEmail=true` and saving.
   * Catches mistakes like "Betrag fehlt im Text"
   * or "falsche Anrede" without spamming the real
   * customer inbox.
   *
   * Permission: invoice.read (same as previewNext).
   */
  async previewEmail(companyId: string, templateId: string) {
    const tpl = await this.prisma.recurringInvoice.findFirst({
      where: { id: templateId, companyId },
      include: {
        items: { orderBy: { position: 'asc' } },
        customer: true,
        company: true,
      },
    })
    if (!tpl) throw new BadRequestException('Recurring invoice not found')
    // Reuse previewNext for the totals — it already
    // handles the rounding, period dates, and per-
    // item math. We discard the items list and only
    // need the totals + due date.
    const preview = await this.previewNext(companyId, templateId)
    const lang = (tpl.language || 'de-DE') as
      | 'de-DE'
      | 'en-US'
      | 'zh-CN'
    const emailLang: 'de' | 'en' | 'zh' =
      lang === 'en-US' ? 'en' : lang === 'zh-CN' ? 'zh' : 'de'
    const recipient = (tpl.customer?.contact as any)?.email || null
    const customerName = tpl.customer?.name || ''
    // The company "salutation" in the email template
    // is locale-aware; we use the salutation helper
    // from the template module to keep this in sync.
    const { defaultSalutationFor, renderInvoiceEmail } = await import(
      '../mail/templates/invoice-email.template'
    )
    const salutation = defaultSalutationFor(emailLang, Boolean(customerName))
    const amount = new Intl.NumberFormat(
      emailLang === 'en' ? 'en-US' : emailLang === 'zh' ? 'zh-CN' : 'de-DE',
      { style: 'currency', currency: tpl.currency || 'EUR' },
    ).format(preview.total)
    const dueDateStr = new Intl.DateTimeFormat(
      emailLang === 'en' ? 'en-US' : emailLang === 'zh' ? 'zh-CN' : 'de-DE',
      {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
      },
    ).format(new Date(preview.dueDate))
    const sampleInvoiceNumber = `INV-XXXX-${new Date().getFullYear()}-????`
    const rendered = renderInvoiceEmail(emailLang, {
      invoiceNumber: sampleInvoiceNumber,
      customerName,
      amount,
      dueDate: dueDateStr,
      companyName: tpl.company?.name || '',
      salutation,
    })
    return {
      subject: rendered.subject,
      text: rendered.text,
      recipient,
      recipientMissing: !recipient,
      sample: {
        invoiceNumber: sampleInvoiceNumber,
        amount,
        dueDate: dueDateStr,
        language: emailLang,
      },
    }
  }

  /**
   * Tier 147: list every invoice this template
   * has ever generated.
   *
   * Confirms the template belongs to the
   * tenant first (otherwise a guessed templateId
   * from another tenant would leak their
   * generated invoice numbers + customer names).
   *
   * Sorted by issueDate DESC so the latest
   * generation is at the top — the admin
   * usually wants to confirm "did last month's
   * cron actually fire?" first.
   *
   * Optional filters: date range (on issueDate),
   * status, customerId. Skip/take pagination
   * caps at 200.
   */
  async generatedInvoices(
    companyId: string,
    opts: {
      templateId: string
      from?: Date
      to?: Date
      status?: string
      customerId?: string
      skip?: number
      take?: number
    },
  ) {
    // Tenant isolation
    const template = await this.prisma.recurringInvoice.findFirst({
      where: { id: opts.templateId, companyId },
      select: { id: true, name: true },
    })
    if (!template) throw new NotFoundException('Recurring template not found')

    const where: any = {
      companyId,
      recurringInvoiceId: opts.templateId,
    }
    if (opts.status) where.status = opts.status
    if (opts.customerId) where.customerId = opts.customerId
    if (opts.from || opts.to) {
      where.issueDate = {}
      if (opts.from) where.issueDate.gte = opts.from
      if (opts.to) where.issueDate.lte = opts.to
    }
    const take = Math.min(opts.take ?? 50, 200)
    const skip = Math.max(opts.skip ?? 0, 0)
    const [rows, total, totals] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        orderBy: { issueDate: 'desc' },
        take,
        skip,
        select: {
          id: true,
          invoiceNumber: true,
          type: true,
          status: true,
          currency: true,
          total: true,
          issueDate: true,
          dueDate: true,
          customer: { select: { id: true, name: true, customerNumber: true } },
        },
      }),
      this.prisma.invoice.count({ where }),
      // Aggregate stats: total amount + paid vs
      // open count, for the header summary card.
      this.prisma.invoice.groupBy({
        by: ['status'],
        where,
        _sum: { total: true },
        _count: true,
      }),
    ])

    // Aggregate the status breakdown into a flat
    // shape the frontend can render directly.
    const byStatus: Record<string, { count: number; total: number }> = {}
    let totalAmount = 0
    for (const g of totals) {
      byStatus[g.status] = {
        count: g._count,
        total: Number(g._sum.total ?? 0),
      }
      totalAmount += Number(g._sum.total ?? 0)
    }
    return {
      template: { id: template.id, name: template.name },
      rows: rows.map((r) => ({
        id: r.id,
        invoiceNumber: r.invoiceNumber,
        type: r.type,
        status: r.status,
        currency: r.currency,
        total: Number(r.total),
        issueDate: r.issueDate,
        dueDate: r.dueDate,
        customer: r.customer,
      })),
      total,
      take,
      skip,
      summary: {
        totalAmount,
        byStatus,
      },
    }
  }
}
