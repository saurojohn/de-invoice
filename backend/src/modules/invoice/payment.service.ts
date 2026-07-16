import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { WebhookService } from '../webhook/webhook.service';
import { ReminderService } from '../reminder/reminder.service';
// Tier 58: when a Payment.amount exceeds the invoice's remaining
// open balance, the overage flows to the customer's credit
// balance (Kundenguthaben) ledger. The PaymentService creates
// the Payment row at the full bank amount (so the bank-rec
// audit is exact) and asks CreditBalanceService to book the
// overage.
import { CreditBalanceService } from '../customer/credit-balance.service';

@Injectable()
export class PaymentService {
  constructor(
    private prisma: PrismaService,
    private webhooks: WebhookService,
    // Tier 37: PaymentService flips the invoice to 'paid' when
    // the sum of payments reaches the open balance. At that
    // exact moment we also void any open Mahnungen for the
    // invoice — the customer just paid, the dunning letters
    // are moot. The ReminderService retains the audit rows
    // (cancelledAt stamp + reason="invoice paid") so the
    // GoBD trail shows the history exactly as it happened.
    private reminders: ReminderService,
    // Tier 58: see class-level comment above.
    private creditBalance: CreditBalanceService,
  ) {}

  /**
   * List all payments for an invoice, newest first.
   * Sum of payments is what the user has actually paid so far
   * (the invoice's `total` minus this sum = outstanding amount).
   */
  async listForInvoice(invoiceId: string, companyId: string) {
    // Verify invoice belongs to this company (defence-in-depth)
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, companyId },
      select: { id: true },
    });
    if (!invoice) throw new NotFoundException('Rechnung nicht gefunden');
    return this.prisma.payment.findMany({
      where: { invoiceId },
      orderBy: { paymentDate: 'desc' },
    });
  }

  /**
   * Record a payment against an invoice.
   *
   * Auto-transitions the invoice status to "paid" if the total of all
   * recorded payments (including this one) covers or exceeds the invoice
   * total. CN invoices are excluded — for a credit note, the underlying
   * reversal is itself the "payment".
   */
  async create(
    invoiceId: string,
    companyId: string,
    data: {
      amount: number;
      paymentDate: Date;
      paymentMethod: string;
      reference?: string;
      notes?: string;
      receiptNumber?: string;
    },
  ) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, companyId },
    });
    if (!invoice) throw new NotFoundException('Rechnung nicht gefunden');
    if (invoice.type === 'CN') {
      throw new BadRequestException(
        'Gutschriften können nicht direkt bezahlt werden — sie werden mit dem offenen Saldo der Originalrechnung verrechnet.'
      );
    }
    if (!data.amount || data.amount <= 0) {
      throw new BadRequestException('Betrag muss größer als 0 sein');
    }
    if (!data.paymentDate) {
      throw new BadRequestException('Zahldatum ist erforderlich');
    }
    if (!data.paymentMethod) {
      throw new BadRequestException('Zahlungsweg ist erforderlich');
    }

    const payment = await this.prisma.payment.create({
      data: {
        invoiceId,
        amount: data.amount,
        paymentDate: new Date(data.paymentDate),
        paymentMethod: data.paymentMethod,
        reference: data.reference,
        notes: data.notes,
        receiptNumber: data.receiptNumber,
      },
    });

    // Auto-update invoice status if fully paid
    const payments = await this.prisma.payment.findMany({
      where: { invoiceId },
      select: { amount: true },
    });
    const totalPaid = payments.reduce((s, p) => s + Number(p.amount), 0);
    const invoiceTotal = Number(invoice.total);

    // Tier 58: detect overpayment. The customer paid more
    // than the invoice's outstanding amount — the overage
    // (totalPaid - invoiceTotal) becomes credit balance.
    // We do this AFTER the payment row is inserted so the
    // SUM(amount) includes the new payment.
    //
    // We call recordOverpayment for INV/RCV invoices only
    // (not CN — a CN is itself a refund and any overage on
    // a CN would be a bank-import mis-attribution; the
    // service throws on CN payments above).
    const overage = totalPaid - invoiceTotal;
    if (
      overage > 0.005 &&
      (invoice.type === 'INV' || invoice.type === 'RCV')
    ) {
      try {
        await this.creditBalance.recordOverpayment(
          invoice.companyId,
          invoice.customerId,
          payment.id,
          overage,
          invoice.invoiceNumber,
        )
      } catch (err: any) {
        // Soft-fail: log to ErrorEvent but don't 500
        // the payment endpoint. The Payment row is
        // already persisted; the credit balance is
        // a derived view. The user can re-trigger
        // the overage recording from a "repair"
        // button if the audit demands it.
        try {
          await this.prisma.errorEvent.create({
            data: {
              source: 'backend',
              kind: 'manual',
              message: `Credit-balance overpayment record failed for invoice ${invoice.invoiceNumber}, payment ${payment.id}: ${err?.message ?? err}`,
              stack: err?.stack,
              fingerprint: `credit-overpayment-${payment.id}`,
              companyId: invoice.companyId,
            },
          })
        } catch {
          // Ignore secondary failures.
        }
      }
    }

    // Only INV/PI/RCV get status updates; PI is non-binding so we keep
    // it as "sent" even after payment.
    if (invoice.type === 'INV' && totalPaid >= invoiceTotal - 0.01) {
      // Tier 37: before flipping the status, cancel any
      // open Mahnungen so the dashboard / Mahnhistorie no
      // longer lists them as "open" once the customer
      // paid. Wrapped in try/catch — the payment itself
      // succeeded, the status flip is the source of truth,
      // so a Mahnung-cancel failure shouldn't 500 the
      // payment endpoint.
      try {
        await this.reminders.cancelOpenMahnungenForInvoice(
          invoice.companyId,
          invoiceId,
          { reason: 'invoice paid' },
        )
      } catch (err: any) {
        // Soft-fail: log to ErrorEvent (best-effort) but
        // don't block the payment.
        try {
          await this.prisma.errorEvent.create({
            data: {
              source: 'backend',
              kind: 'manual',
              message: `Mahnung auto-cancel failed for invoice ${invoice.invoiceNumber}: ${err?.message ?? err}`,
              stack: err?.stack,
              fingerprint: `mahnung-autocancel-${invoiceId}`,
              companyId: invoice.companyId,
            },
          })
        } catch {
          // Ignore secondary failures.
        }
      }

      await this.prisma.invoice.update({
        where: { id: invoiceId },
        data: { status: 'paid' },
      });
    }

    // Fire payment.received webhook. We don't await
    // (fire-and-forget). The eventId is the payment
    // id so receivers can dedupe (e.g. if our
    // retry worker re-delivers after a backend
    // restart).
    //
    // We deliberately do NOT also fire
    // invoice.paid here — the invoice update
    // above happens via the model, not via
    // updateStatus(), so the invoice.paid
    // hook in invoice.service.ts doesn't
    // fire automatically. Receivers can
    // listen to BOTH 'payment.received' and
    // 'invoice.paid' and dedupe on their end.
    // OR they can just listen to
    // 'payment.received' which is the more
    // reliable signal (a payment is always
    // recorded; an invoice status change
    // is implicit).
    this.webhooks
      .emit({
        id: `pay_${payment.id}`,
        type: 'payment.received',
        occurredAt: new Date().toISOString(),
        companyId,
        data: {
          id: payment.id,
          invoiceId: payment.invoiceId,
          invoiceNumber: invoice.invoiceNumber,
          amount: Number(payment.amount),
          currency: payment.currency,
          paymentDate: payment.paymentDate,
          paymentMethod: payment.paymentMethod,
          fullyPaid: invoice.type === 'INV' && totalPaid >= invoiceTotal - 0.01,
        },
      })
      .catch((err) => console.error('webhook emit(payment.received) failed:', err))

    return payment;
  }

  /**
   * Remove a payment. Used to correct mistakes. We re-evaluate the
   * invoice status afterwards — if the remaining total drops below the
   * invoice total, status goes back to "sent".
   */
  async delete(paymentId: string, companyId: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { invoice: { select: { companyId: true, total: true, type: true } } },
    });
    if (!payment || payment.invoice.companyId !== companyId) {
      throw new NotFoundException('Zahlung nicht gefunden');
    }
    await this.prisma.payment.delete({ where: { id: paymentId } });

    // Recompute status
    if (payment.invoice.type === 'INV') {
      const remaining = await this.prisma.payment.findMany({
        where: { invoiceId: payment.invoiceId },
        select: { amount: true },
      });
      const totalPaid = remaining.reduce((s, p) => s + Number(p.amount), 0);
      if (totalPaid < Number(payment.invoice.total) - 0.01) {
        await this.prisma.invoice.update({
          where: { id: payment.invoiceId },
          data: { status: 'sent' },
        });
      }
    }
    return { ok: true };
  }
}
