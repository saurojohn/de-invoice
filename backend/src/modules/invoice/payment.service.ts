import { ModuleRef } from '@nestjs/core';
import { besteuerungsartOn } from '../reports/ustva-ist';
import { paidSoFar } from './paid-so-far';
import { eurOfInvoiceAmount } from './eur-of-invoice';
import { taxedOnReceipt } from '../reports/supply-period';
import { assertBooksOpen, assertPeriodOpen } from '../reports/filed-period';
import { withKeyLock } from '../../common/key-lock';
import { InvoiceService } from './invoice.service';
import { assertManualPaymentMethod } from './payment-methods';
import { Injectable, NotFoundException, BadRequestException , ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CLAIM_TYPES, DOCUMENT_NAMES, isNonFiscal } from './document-scope';
import { ADVANCE_SETTLEMENT_METHOD, advanceReceived, settlingInvoice } from './advance';
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
import { syncInstallments } from '../installment-plan/installment-sync';
import { refreshOpenStatus } from './open-status';
import { businessDayIso, businessTodayDate, businessTodayIso } from '../../common/business-date';

/** Tier 854: the reason ReminderService gives a Mahnung it voids because its invoice was paid */
const PAID_MAHNUNG_REASON = 'invoice paid'

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
    // Tier 422: a Skonto is settled with a credit note (createCreditNote).
    private invoices: InvoiceService,
    // Tier 851: the Kassenbuch (resolved lazily — its module imports this one)
    private moduleRef: ModuleRef,
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
  /**
   * Tier 536 — the payment form's route. Decided by the user (06.10.2026):
   * the same payment submitted again within 10 seconds is refused. Measured
   * before: a double click (or a client's retry) recorded the payment twice
   * — the second one became customer credit, six clicks five credits. "The
   * same" is: this invoice, amount, date, method and reference. A real
   * second payment with the same details can be recorded a moment later.
   * System bookings (bank matches, Raten, credit notes) do not come here.
   */
  async createFromForm(
    invoiceId: string,
    companyId: string,
    data: Parameters<PaymentService['create']>[2],
  ) {
    return withKeyLock(`invoice:${invoiceId}`, async () => {
      const twin = await this.prisma.payment.findFirst({
        where: {
          invoiceId,
          invoice: { companyId },
          amount: data.amount,
          paymentDate: data.paymentDate,
          paymentMethod: data.paymentMethod,
          reference: data.reference ?? null,
          createdAt: { gte: new Date(Date.now() - 10_000) },
        },
        select: { id: true },
      });
      if (twin) {
        throw new ConflictException(
          'Diese Zahlung wurde gerade eben schon erfasst (gleicher Betrag, gleiches Datum, gleicher Zahlungsweg). ' +
          'Falls es wirklich eine zweite Zahlung ist, erfassen Sie sie in einigen Sekunden noch einmal.',
        );
      }
      return this.create(invoiceId, companyId, data);
    });
  }

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
      /** Tier 540: the EUR received for a payment of a foreign-currency invoice */
      eurAmount?: number;
      /** Tier 851: set by the Kassenbuch, which records the cash itself */
      fromCashBook?: boolean;
    },
  ) {
    // Tier 851: cash received for an invoice belongs in the Kassenbuch
    // (§ 146 Abs. 1 Satz 2 AO: cash receipts are recorded daily). A cash
    // payment entered on the invoice made the payment only. Measured: an
    // invoice of 2,78 € paid „bar“ — DATEV booked it on Kasse 1000, the
    // Kassenbuch and the balance sheet's Kassenbestand (619,00) never had it.
    // Where the company keeps its Kassenbuch here, the payment is entered
    // there, with every rule of the Kassenbuch (closed days, no future day),
    // and the Kassenbuch makes the payment.
    if (
      data.paymentMethod === 'cash' && !data.fromCashBook && data.amount > 0 &&
      (await this.prisma.cashBookEntry.count({ where: { companyId } })) > 0
    ) {
      const invoice = await this.prisma.invoice.findFirst({ where: { id: invoiceId, companyId }, select: { invoiceNumber: true } })
      if (!invoice) throw new NotFoundException('Rechnung nicht gefunden');
      // loaded here, not at the top: kassenbuch.service imports this file
      const { KassenbuchService } = require('../cashbook/kassenbuch.service') as typeof import('../cashbook/kassenbuch.service')
      const kassenbuch = this.moduleRef.get(KassenbuchService, { strict: false })
      const entry = await kassenbuch.createEntry(companyId, undefined, {
        businessDate: new Date(data.paymentDate),
        type: 'einnahme',
        description: `Zahlung Rechnung ${invoice.invoiceNumber}`,
        amount: data.amount,
        belegNumber: data.receiptNumber || data.reference || null,
        invoiceId,
        notes: data.notes || null,
      }) as { payment?: Awaited<ReturnType<PaymentService['createLocked']>> }
      if (!entry.payment) throw new BadRequestException('Die Barzahlung wurde nicht erfasst.')
      return entry.payment
    }
    // Tier 534: one at a time per invoice
    return withKeyLock(`invoice:${invoiceId}`, () => this.createLocked(invoiceId, companyId, data));
  }

  private async createLocked(
    invoiceId: string,
    companyId: string,
    data: {
      amount: number;
      paymentDate: Date;
      paymentMethod: string;
      reference?: string;
      notes?: string;
      receiptNumber?: string;
      /** Tier 540: the EUR received for a payment of a foreign-currency invoice */
      eurAmount?: number;
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
    // Tier 946: an invoice set "paid" by hand counts the part no payment
    // covers on its issue date (EÜR, Ist-Versteuerung: euer-zufluss.ts); a
    // payment recorded later takes that part to its own day — out of the issue
    // date's period. Measured (Ist): set "paid" in October, October submitted,
    // the bank payment entered with 12.11.: October's Kz 81 1 000 € → 0.
    const uncoveredOnIssue = invoice.status === 'paid' && CLAIM_TYPES.includes(invoice.type)
      && (await paidSoFar(this.prisma, invoiceId)) < Number(invoice.total) - 0.005
    const touched = [data.paymentDate, uncoveredOnIssue ? invoice.issueDate : null]
    const what = uncoveredOnIssue
      ? 'das Buchen einer Zahlung auf eine als bezahlt markierte Rechnung (ihr Betrag steht bisher am Rechnungsdatum)'
      : 'das Buchen einer Zahlung'
    // Tier 537: a payment moves VAT into its own period only where the tax is
    // owed on receipt — a company with Ist-Versteuerung (§ 20 UStG), and the
    // advance on a Proforma (§ 13 Abs. 1 Nr. 1 a Satz 4). A credit note
    // settling its invoice is no receipt. Tier 946: an applied credit is — the
    // overpayment counts when the credit pays an invoice (euer-zufluss.ts).
    const istOnIssue = (await besteuerungsartOn(this.prisma, companyId))(invoice.issueDate) === 'ist'
    if (!['Gutschrift', ADVANCE_SETTLEMENT_METHOD].includes(data.paymentMethod)
      && (invoice.type === 'PI' || (Number(invoice.totalVat) > 0 && !invoice.reverseCharge && taxedOnReceipt(invoice, data.paymentDate)) // Tier 921: before the supply (Mindest-Ist), where it carries VAT
        || istOnIssue)) { // Tier 908: taxed on receipt
      // the issue date is in a return only under Ist (a Soll return counts payment rows alone)
      await assertPeriodOpen(this.prisma, companyId, istOnIssue ? touched : [data.paymentDate], what);
    }
    // Tier 609: closed books take no cash booking, whatever the taxation —
    // a receipt is a booking of its day. (A credit note settling its invoice
    // is no receipt; Tier 946: an applied credit is.)
    if (!['Gutschrift', ADVANCE_SETTLEMENT_METHOD].includes(data.paymentMethod)) {
      await assertBooksOpen(this.prisma, companyId, touched, what);
    }
    // Tier 462: only an issued document takes a payment. A cancelled invoice
    // turned "paid" (the Storno undone, back in the UStVA), a draft went
    // straight to "paid" without ever being issued. Every way a payment is
    // booked comes through here.
    // Tier 610: a quote and a delivery note are no claim
    if (isNonFiscal(invoice.type)) {
      throw new BadRequestException(
        `Auf ein Dokument der Art „${DOCUMENT_NAMES[invoice.type]}“ wird keine Zahlung gebucht — wandeln Sie es in eine Rechnung um.`,
      );
    }
    if (invoice.status === 'draft') {
      throw new BadRequestException(
        'Die Rechnung ist noch ein Entwurf. Stellen Sie sie zuerst aus (Status „gesendet“), dann kann die Zahlung gebucht werden.',
      );
    }
    if (invoice.status === 'cancelled') {
      throw new BadRequestException(
        'Die Rechnung ist storniert und nimmt keine Zahlung mehr an. Geld, das der Kunde trotzdem gezahlt hat, ' +
        'buchen Sie als sein Guthaben (Kunde → Guthaben) und zahlen es aus oder verrechnen es.',
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
    // Tier 514: money cannot have arrived tomorrow. A payment dated 2030 was
    // booked — the invoice paid today, the income in the EÜR of 2030.
    if (businessDayIso(new Date(data.paymentDate)) > businessTodayIso()) {
      throw new BadRequestException('Das Zahldatum liegt in der Zukunft.');
    }
    // Tier 472: a settled Proforma takes no more money — the final invoice
    // has deducted what it had; later money is paid on the final invoice.
    if (invoice.type === 'PI') {
      const final = await settlingInvoice(this.prisma, companyId, invoiceId);
      if (final) {
        throw new BadRequestException(
          `Die Proforma-Rechnung ist mit der Schlussrechnung ${final.invoiceNumber} abgerechnet — ` +
          'buchen Sie weitere Zahlungen auf die Schlussrechnung.',
        );
      }
    }
    // 'Anzahlung' is the deduction issuing a final invoice books — once, and
    // only there.
    if (data.paymentMethod === ADVANCE_SETTLEMENT_METHOD) {
      const already = invoice.advanceInvoiceId
        ? await this.prisma.payment.count({ where: { invoiceId, paymentMethod: ADVANCE_SETTLEMENT_METHOD } })
        : 1;
      if (already > 0) {
        throw new BadRequestException(
          'Der Zahlungsweg „Anzahlung“ wird beim Ausstellen einer Schlussrechnung gebucht, nicht von Hand.',
        );
      }
    }

    let eurAmount: number | undefined
    if (data.eurAmount !== undefined && data.eurAmount !== null) {
      if (String(invoice.currency || 'EUR').toUpperCase() === 'EUR') {
        throw new BadRequestException('Ein Euro-Betrag wird nur bei einer Rechnung in fremder Währung erfasst.');
      }
      if (!(Number(data.eurAmount) > 0)) {
        throw new BadRequestException('Der eingegangene Euro-Betrag muss größer als 0 sein.');
      }
      eurAmount = Math.round(Number(data.eurAmount) * 100) / 100
      // Tier 902: the EUR received belongs to the amount paid. Measured: 100 USD
      // (invoice rate 1,1 — 90,91 €) entered as 100 000 € received was taken,
      // and the EÜR counted 100 000 € of income. A rate that moved, a bank's
      // fee or margin stay well inside a factor of 5 either way; a slipped
      // decimal point or a wrong field does not.
      const rate = Number(invoice.exchangeRate)
      if (rate > 0 && Number(data.amount) > 0) {
        const atRate = Number(data.amount) / rate
        if (eurAmount > atRate * 5 || eurAmount < atRate / 5) {
          const eur = (n: number) => n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
          throw new BadRequestException(
            `Der eingegangene Euro-Betrag (${eur(eurAmount)} €) passt nicht zu ${eur(Number(data.amount))} ${String(invoice.currency).toUpperCase()} — zum Kurs der Rechnung (${String(rate).replace('.', ',')}) wären es ${eur(atRate)} €. Bitte den Betrag prüfen.`,
          );
        }
      }
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
        // Tier 662: a payment is in the currency of its invoice. The column's
        // default stood on every row — the customer portal showed the payments
        // on a USD invoice in euros.
        currency: String(invoice.currency || 'EUR').toUpperCase(),
        // Tier 540: only for an invoice in a foreign currency — for a EUR
        // invoice the amount is the EUR amount.
        eurAmount: eurAmount ?? null,
      },
    });

    // Tier 422: a payment inside the Skonto window that leaves exactly the
    // Skonto open settles the invoice. Measured before: 1 166,20 € paid on a
    // 1 190 € invoice with 2 % Skonto left it "sent" with 23,80 € open — the
    // dunning run then chased the discount the customer was entitled to — and
    // the output tax stayed 190 €. A Skonto is a reduction of the price (§ 17
    // UStG); it is booked as a credit note dated the payment day, split over
    // the invoice's rates like a refund by amount (Tier 416), so the UStVA,
    // DATEV, the open balance and the dunning all see it.
    const skonto = await this.settleSkonto(invoice, companyId, new Date(data.paymentDate));

    // Auto-update invoice status if fully paid
    const payments = await this.prisma.payment.findMany({
      where: { invoiceId },
      select: { amount: true },
    });
    // (A credit note is already among the payments: createCreditNote books a
    // synthetic 'Gutschrift' payment for it.)
    const totalPaid = payments.reduce(
      (s, p) => s.plus(p.amount ?? new Prisma.Decimal(0)),
      new Prisma.Decimal(0),
    ).toNumber();
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
    // Tier 854: the part of THIS payment beyond the invoice. It was the sum of
    // all payments less the total, so every later payment of an overpaid
    // invoice credited the earlier overpayment again (100 € invoice, 110 €
    // then 5 €: a credit of 10 + 15 instead of 15).
    const overage = Math.min(Number(payment.amount), totalPaid - invoiceTotal);
    // Tier 854: what was paid beyond the invoice settles its dunning first —
    // the Mahngebühr, then the Verzugszinsen of the latest Mahnung (§ 367
    // BGB: costs, then interest). That is income, not the customer's credit.
    const dunning = overage > 0.005 && (invoice.type === 'INV' || invoice.type === 'RCV')
      ? await this.settleDunning(invoice, payment, overage)
      : 0;
    // Tier 938: the customer's credit is kept in EUR (CustomerCreditTransaction)
    // — the overage of a foreign-currency invoice is in its currency: converted
    // at the payment's rate (eurAmount / amount), else the invoice's. Measured:
    // 10 000 JPY over a JPY invoice became a credit of 10 000 €.
    const currency = String((invoice as any).currency || 'EUR').toUpperCase();
    const eurPerUnit = currency === 'EUR'
      ? 1
      : (payment as any).eurAmount != null && Number(payment.amount) > 0
        ? Number((payment as any).eurAmount) / Number(payment.amount)
        : Number((invoice as any).exchangeRate) > 0 ? 1 / Number((invoice as any).exchangeRate) : 1;
    const credit = Math.round((overage - dunning) * eurPerUnit * 100) / 100;
    if (
      credit > 0.005 &&
      (invoice.type === 'INV' || invoice.type === 'RCV')
    ) {
      try {
        await this.creditBalance.recordOverpayment(
          invoice.companyId,
          invoice.customerId,
          payment.id,
          credit,
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

    // Only claims (INV, RCV) get status updates; PI is non-binding so we keep
    // it as "sent" even after payment. Tier 459: a Quittung stayed "sent" when
    // paid in full — the comment said RCV, the check said INV only.
    if (CLAIM_TYPES.includes(invoice.type) && totalPaid >= invoiceTotal - 0.01) {
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
          { reason: PAID_MAHNUNG_REASON },
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
          fullyPaid: CLAIM_TYPES.includes(invoice.type) && totalPaid >= invoiceTotal - 0.01,
        },
      })
      .catch((err) => console.error('webhook emit(payment.received) failed:', err))

    // Tier 429: a Ratenplan on this invoice follows its payments.
    await syncInstallments(this.prisma, invoiceId);

    return skonto ? { ...payment, skonto } : payment;
  }

  /**
   * Tier 422: settle a Skonto when this payment brings the open balance down
   * to exactly the offered discount inside the window (issue date +
   * skontoDays, end of day). Returns the credit note's amount, or null.
   */
  private async settleSkonto(
    invoice: { id: string; type: string; status: string; total: any; issueDate: Date; skontoPercent: any; skontoDays: number | null },
    companyId: string,
    paymentDate: Date,
  ): Promise<{ amount: number; creditNoteId: string } | null> {
    const pct = Number(invoice.skontoPercent ?? 0);
    if (invoice.type !== 'INV' || !(pct > 0) || invoice.skontoDays == null) return null;
    const windowEnd = new Date(invoice.issueDate);
    windowEnd.setDate(windowEnd.getDate() + invoice.skontoDays);
    windowEnd.setHours(23, 59, 59, 999);
    if (paymentDate > windowEnd) return null;
    const total = Number(invoice.total);
    // Credit notes are among the payments (createCreditNote's synthetic
    // 'Gutschrift' payment), so the open balance is total − payments.
    const paid = await this.prisma.payment.aggregate({ where: { invoiceId: invoice.id }, _sum: { amount: true } });
    const open = Math.round((total - Number(paid._sum.amount ?? 0)) * 100) / 100;
    const discount = Math.round(total * pct) / 100;
    if (open < 0.01 || Math.abs(open - discount) > 0.011) return null;
    const cn = await this.invoices.createCreditNote(invoice.id, companyId, {
      amount: open,
      reason: `Skonto ${pct.toLocaleString('de-DE', { maximumFractionDigits: 2 })} %`,
      issueDate: paymentDate,
    });
    return { amount: open, creditNoteId: (cn as any).id };
  }

  /**
   * Tier 460 — the Skonto credit note a payment booked (settleSkonto, in the
   * same request: dated the payment day, created right after it) is
   * cancelled with the payment, and its offset on the invoice removed. It
   * stayed: the invoice showed the Skonto open-balance and the UStVA the
   * reduced tax although the payment that earned the Skonto was gone.
   */
  private async cancelSkontoOf(
    payment: { invoiceId: string; paymentDate: Date; createdAt: Date },
    companyId: string,
  ) {
    const from = payment.createdAt
    const to = new Date(from.getTime() + 60_000)
    const day = (d: Date) => d.toISOString().slice(0, 10)
    const cns = await this.prisma.invoice.findMany({
      where: {
        companyId,
        type: 'CN',
        referenceInvoiceId: payment.invoiceId,
        status: { not: 'cancelled' },
        notes: { contains: '— Skonto ' },
        createdAt: { gte: from, lte: to },
      },
      select: { id: true, invoiceNumber: true, issueDate: true },
    });
    for (const cn of cns.filter((c) => day(c.issueDate) === day(payment.paymentDate))) {
      await this.prisma.payment.deleteMany({
        where: { invoiceId: payment.invoiceId, paymentMethod: 'Gutschrift', reference: `CN ${cn.invoiceNumber}` },
      });
      await this.prisma.invoice.update({ where: { id: cn.id }, data: { status: 'cancelled' } });
    }
  }

  /**
   * Remove a payment. Used to correct mistakes. We re-evaluate the
   * invoice status afterwards — if the remaining total drops below the
   * invoice total, status goes back to "sent".
   */
  /**
   * Tier 475: an advance paid back — the order behind a Proforma fell
   * through. Booked as a negative payment on the Proforma dated the day the
   * money goes back: its tax and income come off in that period (§ 17 Abs. 2
   * Nr. 2 UStG, § 11 EStG), the period the advance was received stays as
   * filed. Deleting the payment instead took the advance out of the month it
   * arrived in.
   */
  async refundAdvance(
    proformaId: string,
    companyId: string,
    data: { amount: number; paymentDate: Date; paymentMethod: string; reference?: string; notes?: string },
  ) {
    const pi = await this.prisma.invoice.findFirst({ where: { id: proformaId, companyId } });
    if (!pi) throw new NotFoundException('Rechnung nicht gefunden');
    if (pi.type !== 'PI') {
      throw new BadRequestException('Eine Anzahlung wird nur auf einer Proforma-Rechnung zurückgezahlt.');
    }
    const final = await settlingInvoice(this.prisma, companyId, proformaId);
    if (final) {
      throw new BadRequestException(
        `Die Anzahlung ist mit der Schlussrechnung ${final.invoiceNumber} verrechnet — korrigieren Sie mit einer Gutschrift zur Schlussrechnung.`,
      );
    }
    if (!data.amount || data.amount <= 0) {
      throw new BadRequestException('Betrag muss größer als 0 sein');
    }
    if (!data.paymentDate || !data.paymentMethod) {
      throw new BadRequestException('Datum und Zahlungsweg sind erforderlich');
    }
    const received = await advanceReceived(this.prisma, proformaId);
    if (data.amount > received + 0.005) {
      throw new BadRequestException(
        `Es können höchstens ${received.toFixed(2)} zurückgezahlt werden (erhaltene Anzahlung).`,
      );
    }
    return this.prisma.payment.create({
      data: {
        invoiceId: proformaId,
        currency: String((pi as any).currency || 'EUR').toUpperCase(), // Tier 662
        amount: -Math.round(data.amount * 100) / 100,
        paymentDate: new Date(data.paymentDate),
        paymentMethod: data.paymentMethod,
        reference: data.reference,
        notes: data.notes ?? `Rückzahlung der Anzahlung ${pi.invoiceNumber}`,
      },
    });
  }

  /**
   * opts.resettleCreditNotes: false for the undo of an operation that failed
   * half-way (Tier 948 — it is no deletion the user asked for).
   */
  async delete(paymentId: string, companyId: string, opts: { resettleCreditNotes?: boolean } = {}) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { invoice: { select: { companyId: true, total: true, type: true, customerId: true, invoiceNumber: true, issueDate: true, deliveryDate: true, servicePeriodEnd: true, euTransaction: true, totalVat: true, reverseCharge: true, status: true, currency: true } } },
    });
    if (!payment || payment.invoice.companyId !== companyId) {
      throw new NotFoundException('Zahlung nicht gefunden');
    }
    // Tier 472: the advance settled by a final invoice stays settled — the
    // final invoice states the deduction; a correction is a credit note.
    if (payment.paymentMethod === ADVANCE_SETTLEMENT_METHOD) {
      throw new BadRequestException(
        'Die verrechnete Anzahlung gehört zur Schlussrechnung und kann nicht gelöscht werden. Korrigieren Sie mit einer Gutschrift.',
      );
    }
    // Tier 713: the settlement of an issued credit note stays — the credit
    // note is in the books (UStVA, EÜR, DATEV) and cannot be cancelled once
    // settled (Tier 461). Measured: the payment deleted, the credit note
    // stayed at −119 € and its invoice was open for the full 1 190 € again
    // (and dunned for it).
    if (payment.paymentMethod === 'Gutschrift' && /^CN /.test(payment.reference ?? '')) {
      const cn = await this.prisma.invoice.findFirst({
        where: { companyId, type: 'CN', invoiceNumber: (payment.reference ?? '').slice(3), status: { not: 'cancelled' } },
        select: { invoiceNumber: true },
      });
      if (cn) {
        throw new BadRequestException(
          `Die Verrechnung gehört zur Gutschrift ${cn.invoiceNumber} und kann nicht gelöscht werden — die Gutschrift ist ausgestellt. ` +
          'Ist sie falsch, stellen Sie eine neue Rechnung über den Betrag aus.',
        );
      }
    }
    if (payment.invoice.type === 'PI') {
      const final = await settlingInvoice(this.prisma, companyId, payment.invoiceId);
      if (final) {
        throw new BadRequestException(
          `Die Anzahlung ist mit der Schlussrechnung ${final.invoiceNumber} verrechnet und kann nicht gelöscht werden.`,
        );
      }
    }
    // Tier 946: a payment of an invoice set "paid" by hand — deleted, the
    // status goes back to open and the part no payment covered leaves the issue
    // date (EÜR, Ist). Measured: 500 € paid on 03.11. of a 1 190 € invoice set
    // paid on 10.10., October submitted, the payment deleted: October's
    // receipts 690 € → 0.
    if (payment.invoice.status === 'paid' && CLAIM_TYPES.includes(payment.invoice.type)
      && (await paidSoFar(this.prisma, payment.invoiceId)) < Number(payment.invoice.total) - 0.005) {
      const what = 'das Löschen einer Zahlung auf eine als bezahlt markierte Rechnung (ihr offener Teil steht am Rechnungsdatum)'
      if ((await besteuerungsartOn(this.prisma, companyId))(payment.invoice.issueDate) === 'ist') {
        await assertPeriodOpen(this.prisma, companyId, [payment.invoice.issueDate], what)
      } else {
        await assertBooksOpen(this.prisma, companyId, [payment.invoice.issueDate], what)
      }
    }
    // Tier 946: an applied credit ('Guthaben') too — it is income of its day
    // (euer-zufluss.ts). Its deletion went past a submitted month and closed
    // books (measured: October's Kz 81 lowered by 260,50 € after October was
    // submitted).
    if (payment.paymentMethod !== 'Gutschrift'
      && (payment.invoice.type === 'PI' || (Number(payment.invoice.totalVat) > 0 && !payment.invoice.reverseCharge && taxedOnReceipt(payment.invoice, payment.paymentDate)) // Tier 921
        || (await besteuerungsartOn(this.prisma, companyId))(payment.invoice.issueDate) === 'ist')) { // Tier 908
      await assertPeriodOpen(this.prisma, companyId, [payment.paymentDate], 'das Löschen einer Zahlung'); // Tier 537
    }
    if (payment.paymentMethod !== 'Gutschrift') {
      await assertBooksOpen(this.prisma, companyId, [payment.paymentDate], 'das Löschen einer Zahlung'); // Tier 609
    }
    // Tier 460: what the payment caused goes with it — its overpayment credit
    // (refused if already used), a credit it applied, its Skonto credit note.
    const credit = await this.creditBalance.paymentDeletion(companyId, payment);
    await credit.check();
    // Tier 948: worked out before the payment goes (the periods it touches)
    const resettle = opts.resettleCreditNotes !== false && CLAIM_TYPES.includes(payment.invoice.type)
      && !['Guthaben', 'Gutschrift'].includes(payment.paymentMethod)
      ? await this.resettlementPlan(companyId, payment)
      : null;
    await this.prisma.payment.delete({ where: { id: paymentId } });
    await credit.apply();
    await this.cancelSkontoOf(payment, companyId);

    // Recompute status (Tier 459: a Quittung too)
    if (CLAIM_TYPES.includes(payment.invoice.type)) {
      const remaining = await this.prisma.payment.findMany({
        where: { invoiceId: payment.invoiceId },
        select: { amount: true },
      });
      const totalPaid = remaining.reduce(
        (s, p) => s.plus(p.amount ?? new Prisma.Decimal(0)),
        new Prisma.Decimal(0),
      ).toNumber();
      if (totalPaid < Number(payment.invoice.total) - 0.01) {
        await this.prisma.invoice.update({
          where: { id: payment.invoiceId },
          data: { status: 'sent' },
        });
      }
    }
    // Tier 429: …and loses a Rate again when its payment is removed.
    await syncInstallments(this.prisma, payment.invoiceId);
    // Tier 711: past its due date it is „überfällig“ again, not „versendet“
    await refreshOpenStatus(this.prisma, companyId, payment.invoiceId);
    // Tier 948: a credit note issued while the invoice was paid became the
    // customer's credit (its overage, Tier 58) instead of settling it. The
    // payment gone, the invoice stood open for its whole amount while the
    // credit stayed (measured: 1 190 € open and dunned, 595 € credit, for
    // 595 € owed). The credit note now settles it after all — its 'Gutschrift'
    // settlement grows and the credit it left goes: no receipt, and the credit
    // note's refund part shrinks on its own date (checked above).
    const creditSettled = resettle ? await this.applyResettlement(companyId, payment.invoiceId, payment.invoice.customerId, resettle) : 0
    return { ok: true, ...(creditSettled > 0 ? { creditSettled } : {}) };
  }

  /**
   * Tier 948 — what the invoice's credit notes left with the customer as
   * credit, to settle the invoice with now that a payment goes: per credit
   * note the credit it left less what was moved back before, capped by the
   * customer's balance and by what will be open. Null when nothing is to do,
   * or when the credit note's own period is closed (the credit then stays).
   */
  private async resettlementPlan(
    companyId: string,
    payment: { id: string; amount: unknown; invoiceId: string; invoice: { customerId: string; type: string; total: unknown; currency?: string | null; issueDate: Date } },
  ): Promise<Array<{ cnId: string; cnNumber: string; inInvoiceCurrency: number; eur: number }> | null> {
    const creditNotes = await this.prisma.invoice.findMany({
      where: { companyId, type: 'CN', referenceInvoiceId: payment.invoiceId, status: { notIn: ['draft', 'cancelled'] } },
      select: { id: true, invoiceNumber: true, issueDate: true },
      orderBy: { issueDate: 'asc' },
    });
    if (!creditNotes.length) return null;
    const customerId = payment.invoice.customerId;
    const inv = await this.prisma.invoice.findFirst({ where: { id: payment.invoiceId, companyId }, select: { currency: true, total: true, eurTotal: true, exchangeRate: true } });
    if (!inv) return null;
    const eurOf = (units: number) => eurOfInvoiceAmount(inv, units);
    const unitsOf = (eur: number) => { const per = eurOf(1); return per > 0 ? Math.round((eur / per) * 100) / 100 : eur };
    let open = Math.round((Number(inv.total) - ((await paidSoFar(this.prisma, payment.invoiceId)) - Number(payment.amount))) * 100) / 100;
    const balance = await this.prisma.customerCreditTransaction.aggregate({ where: { companyId, customerId }, _sum: { amount: true } });
    let left = Number(balance._sum.amount ?? 0);
    const plan: Array<{ cnId: string; cnNumber: string; inInvoiceCurrency: number; eur: number }> = [];
    const ist = await besteuerungsartOn(this.prisma, companyId);
    for (const cn of creditNotes) {
      if (open <= 0.005 || left <= 0.005) break;
      const [given, movedBack] = await Promise.all([
        this.prisma.customerCreditTransaction.aggregate({ where: { companyId, customerId, type: 'gutschrift', referenceType: 'Invoice', referenceId: cn.id }, _sum: { amount: true } }),
        this.prisma.customerCreditTransaction.aggregate({ where: { companyId, customerId, type: 'apply', referenceType: 'CreditNote', referenceId: cn.id }, _sum: { amount: true } }),
      ]);
      const avail = Number(given._sum.amount ?? 0) + Number(movedBack._sum.amount ?? 0); // usages are negative
      const eur = Math.round(Math.min(avail, left, eurOf(open)) * 100) / 100;
      if (eur <= 0.005) continue;
      // its refund part shrinks on its date (EÜR; Ist: the return)
      const what = 'das Verrechnen einer Gutschrift mit ihrer wieder offenen Rechnung'
      try {
        if (ist(payment.invoice.issueDate) === 'ist') await assertPeriodOpen(this.prisma, companyId, [cn.issueDate], what);
        else await assertBooksOpen(this.prisma, companyId, [cn.issueDate], what);
      } catch {
        continue; // its period is closed: the credit stays with the customer
      }
      const units = Math.min(open, unitsOf(eur));
      plan.push({ cnId: cn.id, cnNumber: cn.invoiceNumber, inInvoiceCurrency: units, eur });
      open = Math.round((open - units) * 100) / 100;
      left = Math.round((left - eur) * 100) / 100;
    }
    return plan.length ? plan : null;
  }

  private async applyResettlement(
    companyId: string,
    invoiceId: string,
    customerId: string,
    plan: Array<{ cnId: string; cnNumber: string; inInvoiceCurrency: number; eur: number }>,
  ): Promise<number> {
    let settled = 0;
    for (const step of plan) {
      const done = await this.creditBalance.settleCreditNoteAgain(companyId, customerId, step.cnId, step.cnNumber, step.eur);
      if (!done) continue;
      const existing = await this.prisma.payment.findFirst({ where: { invoiceId, paymentMethod: 'Gutschrift', reference: `CN ${step.cnNumber}` }, select: { id: true, amount: true } });
      if (existing) {
        await this.prisma.payment.update({ where: { id: existing.id }, data: { amount: Math.round((Number(existing.amount) + step.inInvoiceCurrency) * 100) / 100 } });
      } else {
        const inv = await this.prisma.invoice.findFirst({ where: { id: invoiceId, companyId }, select: { currency: true } });
        await this.prisma.payment.create({
          data: {
            invoiceId,
            currency: String(inv?.currency || 'EUR').toUpperCase(),
            amount: step.inInvoiceCurrency,
            paymentDate: businessTodayDate(),
            paymentMethod: 'Gutschrift',
            reference: `CN ${step.cnNumber}`,
            notes: `Auto-verrechnet aus Gutschrift ${step.cnNumber}`,
          },
        });
      }
      settled = Math.round((settled + step.eur) * 100) / 100;
    }
    if (settled > 0) {
      const inv = await this.prisma.invoice.findFirst({ where: { id: invoiceId, companyId }, select: { total: true } });
      if (inv && (await paidSoFar(this.prisma, invoiceId)) >= Number(inv.total) - 0.005) {
        await this.prisma.invoice.update({ where: { id: invoiceId }, data: { status: 'paid' } });
      }
      await refreshOpenStatus(this.prisma, companyId, invoiceId);
    }
    return settled;
  }

  /**
   * Tier 854 — the Mahnkosten a payment settles: of what it paid beyond the
   * invoice, the Mahngebühr and the Verzugszinsen of the invoice's latest
   * Mahnung sent by the payment's day (not cancelled), less what earlier
   * payments already settled of them. Costs before interest (§ 367 BGB).
   * Measured before: a Mahnung of 5 € and 15,43 € interest paid with the
   * invoice — the 20,43 € became the customer's credit, which the next
   * invoice would have used up, and no income anywhere. Only for an invoice
   * in EUR (the Mahnung's amounts are in the invoice's currency). Returns
   * what it settled.
   */
  private async settleDunning(
    invoice: { id: string; companyId: string; currency?: string | null },
    payment: { id: string; paymentDate: Date },
    overage: number,
  ): Promise<number> {
    if (String(invoice.currency || 'EUR').toUpperCase() !== 'EUR') return 0
    const mahnung = await this.prisma.mahnung.findFirst({
      // not one the user withdrew; one made void because the invoice was paid
      // (cancelOpenMahnungenForInvoice) still claims its costs
      where: {
        invoiceId: invoice.id, companyId: invoice.companyId,
        sentAt: { lte: new Date(payment.paymentDate.getTime() + 86_399_999) },
        OR: [{ cancelledAt: null }, { cancelReason: PAID_MAHNUNG_REASON }],
      },
      orderBy: { sentAt: 'desc' },
      select: { id: true, mahngebuehr: true, verzugszins: true },
    })
    if (!mahnung) return 0
    const before = await this.prisma.dunningIncome.aggregate({
      where: { invoiceId: invoice.id, mahnungId: mahnung.id },
      _sum: { mahngebuehr: true, verzugszins: true },
    })
    const cents = (n: unknown) => Math.round(Number(n ?? 0) * 100)
    let left = cents(overage)
    const fee = Math.min(left, Math.max(0, cents(mahnung.mahngebuehr) - cents(before._sum.mahngebuehr)))
    left -= fee
    const interest = Math.min(left, Math.max(0, cents(mahnung.verzugszins) - cents(before._sum.verzugszins)))
    if (fee + interest <= 0) return 0
    await this.prisma.dunningIncome.create({
      data: {
        companyId: invoice.companyId,
        invoiceId: invoice.id,
        paymentId: payment.id,
        mahnungId: mahnung.id,
        date: new Date(`${businessDayIso(payment.paymentDate)}T00:00:00.000Z`),
        mahngebuehr: fee / 100,
        verzugszins: interest / 100,
      },
    })
    return (fee + interest) / 100
  }

  /** Tier 430: the payments a customer reported, newest first. */
  async listNotices(companyId: string, invoiceId?: string, status?: string) {
    return this.prisma.paymentNotice.findMany({
      where: {
        companyId,
        ...(invoiceId ? { invoiceId } : {}),
        ...(status ? { status } : {}),
      },
      include: { invoice: { select: { invoiceNumber: true, customer: { select: { name: true } } } } },
      orderBy: { reportedAt: 'desc' },
    });
  }

  /**
   * Tier 430: book a reported payment once the money is there — as an
   * ordinary payment (status, Skonto, Raten, overpayment credit).
   */
  async bookNotice(
    companyId: string,
    invoiceId: string,
    noticeId: string,
    data: { paymentDate?: string; amount?: number; paymentMethod?: string },
    userId?: string,
  ) {
    assertManualPaymentMethod(data.paymentMethod) // Tier 525
    const notice = await this.prisma.paymentNotice.findFirst({
      where: { id: noticeId, invoiceId, companyId },
    });
    if (!notice) throw new NotFoundException('Zahlungsmeldung nicht gefunden');
    if (notice.status !== 'open') {
      throw new BadRequestException('Die Zahlungsmeldung ist bereits erledigt');
    }
    const payment = await this.create(invoiceId, companyId, {
      amount: data.amount ?? Number(notice.amount),
      paymentDate: data.paymentDate ? new Date(data.paymentDate) : new Date(),
      paymentMethod: data.paymentMethod || 'bank_transfer',
      reference: `Zahlungsmeldung ${notice.source}`,
      notes: notice.note ?? undefined,
    });
    await this.prisma.paymentNotice.update({
      where: { id: notice.id },
      data: { status: 'booked', paymentId: payment.id, resolvedAt: new Date(), resolvedById: userId ?? null },
    });
    return payment;
  }

  /** Tier 430: the money did not arrive — the report is dismissed. */
  async dismissNotice(companyId: string, invoiceId: string, noticeId: string, userId?: string) {
    const notice = await this.prisma.paymentNotice.findFirst({
      where: { id: noticeId, invoiceId, companyId },
    });
    if (!notice) throw new NotFoundException('Zahlungsmeldung nicht gefunden');
    if (notice.status !== 'open') {
      throw new BadRequestException('Die Zahlungsmeldung ist bereits erledigt');
    }
    return this.prisma.paymentNotice.update({
      where: { id: notice.id },
      data: { status: 'dismissed', resolvedAt: new Date(), resolvedById: userId ?? null },
    });
  }

}
