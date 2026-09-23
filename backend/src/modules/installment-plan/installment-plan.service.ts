import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { PaymentService } from '../invoice/payment.service'
import { syncInstallments, endPlanPause } from './installment-sync'
import {
  CreateInstallmentPlanDto,
  PayInstallmentDto,
} from './installment-plan.dto'

/**
 * Tier 51: InstallmentPlan service.
 *
 * Money invariants enforced here:
 *   - sum(Installment.amount) == Plan.totalAmount
 *     (splitEvenly divides; the LAST installment
 *     gets the rounding remainder so the sum is
 *     exact even when the divisor doesn't divide
 *     cleanly).
 *   - 0 <= Installment.paidAmount <= Installment.amount
 *
 * Lifecycle:
 *   - Plan.status = 'active' on create, 'completed'
 *     when all installments are paid, 'cancelled'
 *     when the Berater voids the plan (GoBD: the
 *     row stays, just status flips).
 *   - Installment.status is recomputed on every
 *     paidAmount change AND on the overdue-cron
 *     (out of scope here — that hook lives in
 *     MahnungService).
 */
@Injectable()
export class InstallmentPlanService {
  constructor(
    private prisma: PrismaService,
    // Tier 429: a paid Rate is a payment of the invoice.
    private payments: PaymentService,
  ) {}

  /**
   * List every Ratenplan for the company. Used by
   * the dashboard "offene Raten" widget. Filterable
   * by status (?status=active is the default).
   */
  async list(companyId: string, status?: string) {
    const where: any = { companyId }
    if (status) where.status = status
    return this.prisma.installmentPlan.findMany({
      where,
      orderBy: { firstDueDate: 'asc' },
      include: {
        customer: {
          select: { id: true, name: true, customerNumber: true },
        },
        invoice: {
          select: { id: true, invoiceNumber: true, total: true, status: true },
        },
        installments: {
          orderBy: { sequenceNumber: 'asc' },
        },
      },
    })
  }

  /**
   * Open plans (status=active) for a specific
   * customer. Used by the customer detail page
   * + the customer-statement PDF so the Berater
   * sees "what's still owed" per customer.
   */
  async findByInvoice(invoiceId: string, companyId: string) {
    return this.prisma.installmentPlan.findFirst({
      where: { invoiceId, companyId },
      include: {
        installments: { orderBy: { sequenceNumber: 'asc' } },
        customer: { select: { id: true, name: true, customerNumber: true } },
      },
    })
  }

  /**
   * Tier 65: Auto-Ratenplan suggestion.
   *
   * Returns whether the invoice is a good candidate
   * for a Ratenplan (installment plan), with sane
   * defaults pre-filled. The frontend renders a
   * banner on the invoice detail page when
   * `suggest=true`.
   *
   * Decision tree:
   *   1. Invoice must be in 'sent' status
   *      (drafts aren't ready to be paid; paid /
   *      cancelled / voided don't need a plan).
   *   2. No existing Ratenplan on this invoice
   *      (1:1 — a plan already exists).
   *   3. No active Ratenplan for the same customer
   *      (the customer is already in a plan; we
   *      don't stack plans on the same customer).
   *   4. Total amount >= RATENPLAN_THRESHOLD
   *      (default €500 — enough that 3+ monthly
   *      Raten make the customer's life easier
   *      and the Berater's dunning noise drops).
   *
   * Returns the full suggestion payload (pre-filled
   * defaults) so the frontend can pre-populate the
   * create modal without a second round-trip.
   */
  async getRatenplanSuggestion(invoiceId: string, companyId: string) {
    // Tier 65: hardcoded threshold. Future: read
    // from Company.bankInfo.ratenplanThreshold
    // (when the Company module grows a settings
    // page). For now the simplest possible config
    // is good enough — most Mittelstand set the
    // threshold at "what's uncomfortable to pay
    // in one shot", which is typically €500-1000.
    const THRESHOLD = 500

    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, companyId },
      include: {
        customer: { select: { id: true, name: true } },
        payments: { select: { amount: true } },
      },
    })
    if (!invoice) {
      throw new NotFoundException('Rechnung nicht gefunden')
    }

    // 1+2+3: eligibility checks
    const existingPlan = await this.prisma.installmentPlan.findFirst({
      where: { invoiceId: invoice.id },
      select: { id: true },
    })
    const customerPlan = invoice.customerId
      ? await this.prisma.installmentPlan.findFirst({
          where: {
            customerId: invoice.customerId,
            companyId,
            status: 'active',
          },
          select: { id: true },
        })
      : null
    // Tier 429: the plan covers what is still open — the total less the
    // payments and credit notes so far (a part-paid invoice was split over
    // its full total, so the customer was asked for the paid part again).
    // An overdue invoice qualifies too; it is the usual case for a plan, and
    // it was refused ("Status overdue, nicht sent").
    const total = Math.round(
      (Number(invoice.total) - invoice.payments.reduce((s, p) => s + Number(p.amount ?? 0), 0)) * 100,
    ) / 100
    const payable = invoice.status === 'sent' || invoice.status === 'overdue'
    const eligible =
      payable &&
      !existingPlan &&
      !customerPlan &&
      total >= THRESHOLD

    // Default: 3 monthly Raten, first due in 14 days.
    // The 14-day cushion lets the customer get the
    // PDF + the Mahnung pause auto-set in Tier 64
    // before the first Rate hits.
    const firstDue = new Date()
    firstDue.setDate(firstDue.getDate() + 14)

    return {
      eligible,
      threshold: THRESHOLD,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      totalAmount: total,
      currency: invoice.currency || 'EUR',
      hasExistingPlan: !!existingPlan,
      hasCustomerActivePlan: !!customerPlan,
      reason: !eligible
        ? !invoice.customerId
          ? 'Rechnung hat keinen Kunden'
          : !payable
          ? `Rechnung ist im Status "${invoice.status}" — ein Ratenplan braucht eine offene Rechnung`
          : existingPlan
          ? 'Für diese Rechnung existiert bereits ein Ratenplan'
          : customerPlan
          ? 'Kunde hat bereits einen aktiven Ratenplan'
          : `Rechnungsbetrag ${total.toFixed(2)} ${invoice.currency || 'EUR'} liegt unter dem Schwellenwert von ${THRESHOLD} EUR`
        : `${total.toFixed(2)} ${invoice.currency || 'EUR'} liegt über dem Schwellenwert von ${THRESHOLD} EUR — Ratenplan anbieten`,
      defaults: eligible
        ? {
            installmentCount: 3,
            intervalDays: 30,
            firstDueDate: firstDue.toISOString().slice(0, 10),
            notes: 'Ratenplan-Vorschlag',
          }
        : null,
    }
  }

  /**
   * Tier 65: create a Ratenplan from an invoice with
   * defaults, AND auto-create a customer-level
   * Mahnungspause (Tier 64) so the dunning loop is
   * silenced while the plan runs.
   *
   * The two operations are wrapped in a single
   * transaction so we never end up with "plan
   * created but no pause" (the customer would get
   * Mahnungen the next day).
   *
   * The existing create() method is used for the
   * Ratenplan itself (single source of truth for
   * the math), and the Mahnungspause is inserted
   * alongside in the same transaction.
   */
  async createFromInvoice(
    companyId: string,
    createdById: string | undefined,
    invoiceId: string,
    options: {
      installmentCount: number
      firstDueDate: string
      intervalDays?: number
      notes?: string
      // Optional override: if the Berater wants to
      // suppress the auto-pause (e.g. they're
      // creating a 1-month Ratenplan and a pause
      // would be overkill), pass `autoPause: false`.
      autoPause?: boolean
      // Optional override: the Mahnungspause
      // reason text. Default = "Ratenplan aktiv".
      pauseReason?: string
    },
  ) {
    // Verify the invoice is eligible via the
    // suggestion helper (single source of truth for
    // the checks — keeps the e2e and the controller
    // consistent).
    const suggestion = await this.getRatenplanSuggestion(
      invoiceId,
      companyId,
    )
    if (!suggestion.eligible) {
      throw new BadRequestException(
        `Ratenplan kann nicht erstellt werden: ${suggestion.reason}`,
      )
    }
    if (options.installmentCount < 2) {
      throw new BadRequestException('Mindestens 2 Raten erforderlich')
    }

    // Run the existing create() (which itself
    // wraps a transaction), then a follow-up
    // transaction for the Mahnungspause. We don't
    // try to nest them — the existing create() is
    // self-contained and the risk of a half-built
    // state from a Ratenplan-without-pause is
    // mitigated by the catch below rolling back
    // the plan via prisma.delete if the pause
    // insertion fails.
    const plan = await this.create(companyId, {
      invoiceId,
      installmentCount: options.installmentCount,
      totalAmount: suggestion.totalAmount,
      firstDueDate: options.firstDueDate,
      intervalDays: options.intervalDays ?? 30,
      notes: options.notes ?? 'Ratenplan-Vorschlag',
    })
    if (options.autoPause !== false) {
      try {
        // Tier 429: the pause covers this invoice only — it was put on the
        // whole customer, so their other invoices were not dunned either —
        // and it ends by itself when the plan completes or is cancelled
        // (installment-sync.ts); it was open-ended until someone deleted it.
        await this.prisma.mahnungspause.create({
          data: {
            companyId,
            customerId: null,
            invoiceId: suggestion.invoiceId,
            reason: options.pauseReason ?? 'Ratenplan aktiv',
            pausedFrom: new Date(),
            pausedUntil: null,
            createdById: createdById ?? null,
          },
        })
      } catch (e) {
        // Rollback the plan if the pause failed.
        // The user sees a 500 with a clear message
        // and the plan is gone — better than a
        // half-built state.
        await this.prisma.installmentPlan.delete({
          where: { id: plan.id },
        })
        throw e
      }
    }
    return plan
  }

  async listForCustomer(customerId: string, companyId: string) {
    return this.prisma.installmentPlan.findMany({
      where: { customerId, companyId, status: 'active' },
      orderBy: { firstDueDate: 'asc' },
      include: {
        invoice: { select: { invoiceNumber: true, total: true } },
        installments: {
          orderBy: { sequenceNumber: 'asc' },
        },
      },
    })
  }

  /**
   * Single-plan read with every Ratenstatus
   * recomputed against today. Cheaper than the
   * DB-cron because we only need it on detail
   * views, and we want the data fresh.
   */
  async findOne(id: string, companyId: string) {
    const plan = await this.prisma.installmentPlan.findFirst({
      where: { id, companyId },
      include: {
        customer: { select: { id: true, name: true, customerNumber: true } },
        invoice: { select: { id: true, invoiceNumber: true, total: true, status: true } },
        installments: { orderBy: { sequenceNumber: 'asc' } },
      },
    })
    if (!plan) throw new NotFoundException('Ratenplan nicht gefunden')
    return plan
  }

  /**
   * Create a Ratenplan on an existing Invoice.
   * Splits the total into N equal Raten; the
   * LAST Raten gets the rounding remainder so the
   * sum is exact (gross = totalAmount to the cent).
   *
   * Refuses if:
   *   - the invoice already has a plan (1:1)
   *   - the invoice is not in a state where plans
   *     make sense (e.g. already voided)
   *   - the installmentCount is < 2
   *   - the firstDueDate is in the past (no
   *     retroactive plans — the Berater is
   *     promising the customer a future schedule)
   */
  async create(companyId: string, dto: CreateInstallmentPlanDto) {
    // Resolve the invoice + its customer in one
    // query so the FK chain (Plan → Invoice →
    // Customer) is consistent.
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: dto.invoiceId, companyId },
      include: { customer: { select: { id: true } }, payments: { select: { amount: true } } },
    })
    if (!invoice) {
      throw new NotFoundException('Rechnung nicht gefunden')
    }
    if (invoice.status === 'voided' || invoice.status === 'cancelled') {
      throw new BadRequestException(
        'Ratenplan kann nicht auf eine stornierte Rechnung gelegt werden',
      )
    }
    // 1:1 — a Ratenplan already exists for this invoice.
    const existing = await this.prisma.installmentPlan.findUnique({
      where: { invoiceId: invoice.id },
    })
    if (existing) {
      throw new BadRequestException(
        'Für diese Rechnung existiert bereits ein Ratenplan',
      )
    }
    if (dto.installmentCount < 2) {
      throw new BadRequestException('Mindestens 2 Raten erforderlich')
    }
    // Tier 429: a plan cannot ask for more than is still open.
    const openCents = Math.round(Number(invoice.total) * 100)
      - invoice.payments.reduce((s, p) => s + Math.round(Number(p.amount ?? 0) * 100), 0)
    if (openCents <= 0) {
      throw new BadRequestException('Die Rechnung ist bereits vollständig bezahlt')
    }
    if (Math.round(dto.totalAmount * 100) > openCents) {
      throw new BadRequestException(
        `Der Ratenplan (${dto.totalAmount.toFixed(2)}) übersteigt den offenen Betrag der Rechnung (${(openCents / 100).toFixed(2)})`,
      )
    }
    const firstDue = new Date(dto.firstDueDate)
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    if (firstDue < today) {
      throw new BadRequestException(
        'Erste Fälligkeit darf nicht in der Vergangenheit liegen',
      )
    }
    const interval = dto.intervalDays ?? 30

    // Split the total into N equal Raten. The LAST
    // one absorbs the rounding remainder so the sum
    // equals totalAmount to the cent.
    const totalCents = Math.round(dto.totalAmount * 100)
    const baseCents = Math.floor(totalCents / dto.installmentCount)
    const remainder = totalCents - baseCents * dto.installmentCount
    const installmentsData: Array<{
      sequenceNumber: number
      dueDate: Date
      amount: number
    }> = []
    for (let i = 0; i < dto.installmentCount; i++) {
      const amountCents = baseCents + (i === dto.installmentCount - 1 ? remainder : 0)
      // firstDue + i*intervalDays
      const due = new Date(firstDue)
      due.setDate(due.getDate() + i * interval)
      installmentsData.push({
        sequenceNumber: i + 1,
        dueDate: due,
        amount: amountCents / 100,
      })
    }

    // Create the plan + all installments in a single
    // transaction. If any Raten insert fails, the
    // plan rollbacks and we don't end up with a
    // half-built schedule.
    return this.prisma.$transaction(async (tx) => {
      const plan = await tx.installmentPlan.create({
        data: {
          companyId,
          customerId: invoice.customer.id,
          invoiceId: invoice.id,
          totalAmount: dto.totalAmount,
          installmentCount: dto.installmentCount,
          intervalDays: interval,
          firstDueDate: firstDue,
          status: 'active',
          notes: dto.notes || null,
        },
      })
      // Bulk insert — one round trip.
      await tx.installment.createMany({
        data: installmentsData.map((inst) => ({
          planId: plan.id,
          sequenceNumber: inst.sequenceNumber,
          dueDate: inst.dueDate,
          amount: inst.amount,
          paidAmount: 0,
          status: 'open',
        })),
      })
      return tx.installmentPlan.findUniqueOrThrow({
        where: { id: plan.id },
        include: {
          installments: { orderBy: { sequenceNumber: 'asc' } },
        },
      })
    })
  }

  /**
   * Mark a single Rate as paid (full or partial).
   * The service bumps `paidAmount` and re-derives
   * both the Installment.status AND the parent
   * Plan.status:
   *   - all installments paid → Plan.status='completed'
   *   - any installment partial → Installment.status='partial'
   *   - paidAmount == amount → Installment.status='paid'
   */
  async payInstallment(
    planId: string,
    installmentId: string,
    companyId: string,
    dto: PayInstallmentDto,
  ) {
    const inst = await this.prisma.installment.findFirst({
      where: { id: installmentId, planId, plan: { companyId } },
      include: { plan: { select: { id: true, invoiceId: true, status: true } } },
    })
    if (!inst) {
      throw new NotFoundException('Rate nicht gefunden')
    }
    if (inst.status === 'paid') {
      throw new BadRequestException('Rate ist bereits vollständig bezahlt')
    }
    if (inst.status === 'cancelled' || inst.plan.status === 'cancelled') {
      throw new BadRequestException('Rate wurde storniert')
    }
    // Tier 429: the money is a payment of the invoice — recorded there, by
    // the same service as any other payment (status, Skonto, overpayment
    // credit), and the Raten are recomputed from the invoice's payments
    // (installment-sync.ts). An amount above the Rate covers the next ones
    // instead of being cut off.
    await this.payments.create(inst.plan.invoiceId, companyId, {
      amount: dto.amount,
      paymentDate: dto.paidAt ? new Date(dto.paidAt) : new Date(),
      paymentMethod: dto.paymentMethod || 'bank_transfer',
      reference: `Rate ${inst.sequenceNumber}`,
    })
    await syncInstallments(this.prisma, inst.plan.invoiceId)
    return this.prisma.installmentPlan.findUniqueOrThrow({
      where: { id: planId },
      include: { installments: { orderBy: { sequenceNumber: 'asc' } } },
    })
  }

  /**
   * Soft-cancel the plan. We keep the rows for
   * the GoBD audit trail but flip the status so
   * dashboards and the customer statement stop
   * showing the open Raten.
   */
  async cancel(id: string, companyId: string) {
    const plan = await this.findOne(id, companyId)
    return this.prisma.$transaction(async (tx) => {
      await tx.installmentPlan.update({
        where: { id: plan.id },
        data: { status: 'cancelled' },
      })
      // Mark all open installments as cancelled too
      // so Mahnung doesn't try to chase them.
      await tx.installment.updateMany({
        where: { planId: plan.id, status: { in: ['open', 'partial', 'overdue'] } },
        data: { status: 'cancelled' },
      })
      // Tier 429: dunning resumes for the invoice.
      await endPlanPause(tx, companyId, plan.invoiceId, plan.createdAt)
      return tx.installmentPlan.findUniqueOrThrow({
        where: { id: plan.id },
        include: { installments: { orderBy: { sequenceNumber: 'asc' } } },
      })
    })
  }

  /**
   * Daily-cron hook: walk every active plan, flip
   * any open/partial Installment whose dueDate is
   * in the past to 'overdue'. The plan itself
   * stays 'active' (the customer is still
   * expected to pay — overdue ≠ cancelled).
   *
   * Called from the Mahnung service's daily
   * scheduler; not exposed via the controller.
   */
  async refreshOverdueStatuses() {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    return this.prisma.installment.updateMany({
      where: {
        status: { in: ['open', 'partial'] },
        dueDate: { lt: today },
      },
      data: { status: 'overdue' },
    })
  }
}
