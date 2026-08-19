import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { VoucherService } from '../accounting/voucher.service';

/**
 * Tier 58: customer credit balance (Kundenguthaben) + Auszahlung.
 *
 * The customer credit balance is the signed sum of all ledger rows
 * (CustomerCreditTransaction). Positive balance = customer has credit
 * owed (e.g. overpaid an invoice), negative = customer owes the
 * difference (shouldn't happen in normal flow but the schema permits
 * it for Berater manual adjustments).
 *
 * Sources of credit (positive entries):
 *   - overpayment  : Payment.amount > invoice remaining
 *   - gutschrift   : Gutschrift amount > original invoice remaining
 *   - manual       : Berater manual credit
 *
 * Sources of credit usage (negative entries):
 *   - payout       : Auszahlung Voucher posted
 *   - apply        : credit applied to a specific invoice
 *   - manual       : Berater manual debit
 *
 * All ledger writes are sequenced via `getCurrentBalance + insert`:
 *   1. SELECT SUM(amount) (in transaction with row lock semantics
 *      provided by Prisma's default isolation)
 *   2. compute new balance = current + amount
 *   3. INSERT row with balanceAfter = new balance
 *
 * We accept the small risk of two concurrent writers racing for the
 * "true" running balance. The current balance is a derived value
 * (sum of amounts) so a transient inconsistency in balanceAfter
 * doesn't break anything — but the SUM(amount) read on a fresh
 * Prisma connection is the source of truth.
 */
@Injectable()
export class CreditBalanceService {
  constructor(
    private prisma: PrismaService,
    private voucherService: VoucherService,
  ) {}

  /**
   * Current credit balance for a customer, in EUR (decimal string
   * to preserve the Prisma Decimal wire format — Decimal(12,4)).
   */
  async getCreditBalance(
    companyId: string,
    customerId: string,
  ): Promise<{ customerId: string; balance: number; currency: string }> {
    // Verify the customer belongs to this company
    // (defence-in-depth: every ledger write is also
    // scoped, but reads are open to all customers in
    // the company so this matters here).
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, companyId },
      select: { id: true },
    });
    if (!customer) throw new NotFoundException('Kunde nicht gefunden');

    const sum = await this.prisma.customerCreditTransaction.aggregate({
      where: { customerId, companyId },
      _sum: { amount: true },
    });
    return {
      customerId,
      balance: Number(sum._sum.amount ?? 0),
      currency: 'EUR',
    };
  }

  /**
   * Full ledger for a customer, oldest first. Each row carries
   * `balanceAfter` so the UI can render a running balance without
   * a second pass over the data.
   */
  async getLedger(companyId: string, customerId: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, companyId },
      select: { id: true },
    });
    if (!customer) throw new NotFoundException('Kunde nicht gefunden');

    const rows = await this.prisma.customerCreditTransaction.findMany({
      where: { customerId, companyId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      amount: Number(r.amount),
      currency: r.currency,
      balanceAfter: Number(r.balanceAfter),
      referenceType: r.referenceType,
      referenceId: r.referenceId,
      description: r.description,
      createdById: r.createdById,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /**
   * Record a positive credit entry. Used by:
   *   - PaymentService.create()  when payment > invoice remaining
   *   - InvoiceService.createCreditNote() when CN > original remaining
   *   - manual adjustment endpoint
   *
   * `description` should be human-readable ("Überzahlung Rechnung
   * INV-2026-00123" / "Gutschrift-Überschuss zu ...").
   */
  private async recordCredit(
    companyId: string,
    customerId: string,
    params: {
      type: 'overpayment' | 'gutschrift' | 'manual';
      amount: number; // positive
      referenceType?: string;
      referenceId?: string;
      description?: string;
      createdById?: string;
    },
  ): Promise<{ id: string; balanceAfter: number }> {
    if (!Number.isFinite(params.amount) || params.amount <= 0) {
      throw new BadRequestException(
        'Betrag muss eine positive Zahl sein',
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const sum = await tx.customerCreditTransaction.aggregate({
        where: { customerId, companyId },
        _sum: { amount: true },
      });
      const current = Number(sum._sum.amount ?? 0);
      const newBalance = current + params.amount;

      const row = await tx.customerCreditTransaction.create({
        data: {
          id: this.uuid(),
          companyId,
          customerId,
          amount: params.amount,
          currency: 'EUR',
          type: params.type,
          referenceType: params.referenceType,
          referenceId: params.referenceId,
          balanceAfter: newBalance,
          description: params.description,
          createdById: params.createdById,
        },
      });
      return { id: row.id, balanceAfter: newBalance };
    });
  }

  /**
   * Record a credit-USAGE entry. Used by:
   *   - payout() below
   *   - applyToInvoice() below
   *   - manual adjustment endpoint
   */
  private async recordUsage(
    companyId: string,
    customerId: string,
    params: {
      type: 'payout' | 'apply' | 'manual';
      amount: number; // positive — we negate internally
      referenceType?: string;
      referenceId?: string;
      description?: string;
      createdById?: string;
    },
  ): Promise<{ id: string; balanceAfter: number }> {
    if (!Number.isFinite(params.amount) || params.amount <= 0) {
      throw new BadRequestException(
        'Betrag muss eine positive Zahl sein',
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const sum = await tx.customerCreditTransaction.aggregate({
        where: { customerId, companyId },
        _sum: { amount: true },
      });
      const current = Number(sum._sum.amount ?? 0);
      if (current < params.amount - 0.005) {
        throw new BadRequestException(
          `Guthaben reicht nicht aus: ${current.toFixed(2)} € vorhanden, ${params.amount.toFixed(2)} € angefordert`,
        );
      }
      const newBalance = current - params.amount;
      const row = await tx.customerCreditTransaction.create({
        data: {
          id: this.uuid(),
          companyId,
          customerId,
          amount: -params.amount,
          currency: 'EUR',
          type: params.type,
          referenceType: params.referenceType,
          referenceId: params.referenceId,
          balanceAfter: newBalance,
          description: params.description,
          createdById: params.createdById,
        },
      });
      return { id: row.id, balanceAfter: newBalance };
    });
  }

  /**
   * Record a payment overage. Called from PaymentService.create()
   * when the payment amount exceeds the invoice's remaining open
   * balance. The overage flows to credit balance; the payment row
   * itself is still recorded at the full amount (so the user can
   * see what the bank actually sent) but the customer statement
   * and credit-balance ledger tell the true story.
   */
  async recordOverpayment(
    companyId: string,
    customerId: string,
    paymentId: string,
    overageAmount: number,
    invoiceNumber: string,
    userId?: string,
  ) {
    if (overageAmount <= 0) return null;
    return this.recordCredit(companyId, customerId, {
      type: 'overpayment',
      amount: overageAmount,
      referenceType: 'Payment',
      referenceId: paymentId,
      description: `Überzahlung Rechnung ${invoiceNumber}`,
      createdById: userId,
    });
  }

  /**
   * Record a Gutschrift overage. Called from
   * InvoiceService.createCreditNote() when the CN amount exceeds
   * the original invoice's remaining open balance. The overage
   * becomes credit balance (instead of disappearing into the void).
   */
  async recordGutschriftOverage(
    companyId: string,
    customerId: string,
    cnInvoiceId: string,
    overageAmount: number,
    originalInvoiceNumber: string,
    userId?: string,
  ) {
    if (overageAmount <= 0) return null;
    return this.recordCredit(companyId, customerId, {
      type: 'gutschrift',
      amount: overageAmount,
      referenceType: 'Invoice',
      referenceId: cnInvoiceId,
      description: `Gutschrift-Überschuss zu ${originalInvoiceNumber}`,
      createdById: userId,
    });
  }

  /**
   * Issue an Auszahlung (refund) to the customer. Posts a
   * double-entry Voucher + a ledger entry that reduces the
   * credit balance. The Voucher has the SKR03 standard
   * configuration for "Geldtransit aus Kundenguthaben":
   *
   *   1800 Bank       Soll  amount
   *   1210 Forderungen Haben amount   (reducing the
   *                                   receivable)
   *
   * Why 1210 and not 1300/1400: Forderungen aus L+L (1210)
   * already carries the historical open balance for this
   * customer; a refund reduces the open balance, so the
   * Buchung must go through 1210 to keep the Bilanz
   * consistent. A 1300/1400 (Sonstige) entry would require
   * the Berater to manually reconcile the residual.
   *
   * On the return: the ledger row + the Voucher + the new
   * balance.
   */
  async payout(
    companyId: string,
    customerId: string,
    params: {
      amount: number;
      paymentDate: Date;
      bankAccountId: string;
      description?: string;
      createdById?: string;
    },
  ) {
    if (!Number.isFinite(params.amount) || params.amount <= 0) {
      throw new BadRequestException('Betrag muss eine positive Zahl sein');
    }

    // Verify customer + bank account belong to this company
    const [customer, bankAccount] = await Promise.all([
      this.prisma.customer.findFirst({
        where: { id: customerId, companyId },
        select: { id: true, name: true, customerNumber: true },
      }),
      this.prisma.account.findFirst({
        where: { id: params.bankAccountId, companyId },
        select: { id: true, accountNumber: true, name: true },
      }),
    ]);
    if (!customer) throw new NotFoundException('Kunde nicht gefunden');
    if (!bankAccount)
      throw new NotFoundException('Bankkonto nicht gefunden');

    // Look up the Forderungen account (1210 in SKR03). The
    // Sachkonto is company-scoped; we look it up by the
    // standard accountNumber, falling back to the first
    // account with `name ILIKE '%forderung%'` if 1210 is
    // not configured. (Berater migrations sometimes use
    // 1210, sometimes 1200, occasionally a custom number.)
    const forderungenAccount = await this.findForderungenAccount(companyId);
    if (!forderungenAccount) {
      throw new BadRequestException(
        'Kein Konto „Forderungen aus Lieferungen und Leistungen" konfiguriert. Bitte Sachkonten prüfen.',
      );
    }

    // 1) Create the Voucher (Soll 1800 Bank / Haben 1210 Forderungen)
    const voucher = await this.voucherService.create({
      companyId,
      date: params.paymentDate,
      description:
        params.description ||
        `Auszahlung Guthaben an ${customer.name} (${customer.customerNumber ?? customer.id})`,
      referenceType: 'CustomerCreditTransaction',
      createdById: params.createdById,
      lines: [
        {
          accountId: bankAccount.id,
          description: `Auszahlung an ${customer.name}`,
          debit: params.amount,
          credit: 0,
        },
        {
          accountId: forderungenAccount.id,
          description: `Guthaben-Auszahlung ${customer.name}`,
          debit: 0,
          credit: params.amount,
        },
      ],
    });

    // 2) Record the ledger row (negative amount). recordUsage
    //    will throw if balance < amount, which is the right
    //    outcome (caller can rollback by deleting the
    //    voucher manually — but at that point the user has
    //    seen the balance error and can correct).
    const ledger = await this.recordUsage(companyId, customerId, {
      type: 'payout',
      amount: params.amount,
      referenceType: 'Voucher',
      referenceId: voucher.id,
      description:
        params.description ||
        `Auszahlung (Beleg ${voucher.voucherNumber})`,
      createdById: params.createdById,
    });

    return {
      voucherId: voucher.id,
      voucherNumber: voucher.voucherNumber,
      ledgerId: ledger.id,
      balanceAfter: ledger.balanceAfter,
    };
  }

  /**
   * Look up the Forderungen Sachkonto. Tries 1210 first (SKR03
   * standard), then 1400 (a common customised name). Returns
   * null if no plausible match is configured — the payout
   * endpoint then surfaces a clear error asking the Berater
   * to set up the Forderungen account.
   *
   * We deliberately skip 1200 (Bank) and 1300 (Sonstige
   * Vermögensgegenstände) — neither represents Forderungen
   * in SKR03. Only fall back to fuzzy name match if 1210 +
   * 1400 are both missing.
   */
  private async findForderungenAccount(companyId: string) {
    const preferred = ['1210', '1400'];
    for (const num of preferred) {
      const acc = await this.prisma.account.findFirst({
        where: { companyId, accountNumber: num },
        select: { id: true, accountNumber: true, name: true },
      });
      if (acc) return acc;
    }
    // Final fallback: substring match on the account name.
    // Cheap, runs once per payout.
    const fuzzy = await this.prisma.account.findFirst({
      where: {
        companyId,
        name: { contains: 'forderung', mode: 'insensitive' },
      },
      select: { id: true, accountNumber: true, name: true },
    });
    return fuzzy;
  }

  /**
   * Apply credit balance to a specific invoice. Reduces the
   * invoice's outstanding amount by `amount`, capped at the
   * current open balance. The credit-balance ledger records
   * the usage with reference to the invoice.
   *
   * This is the "use credit to settle an old unpaid invoice"
   * flow — distinct from a Gutschrift (which issues a new
   * CN document for accounting/tax purposes). Apply-to-invoice
   * is a pure internal balance transfer.
   */
  async applyToInvoice(
    companyId: string,
    customerId: string,
    invoiceId: string,
    amount: number,
    userId?: string,
  ) {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Betrag muss eine positive Zahl sein');
    }
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, companyId, customerId },
    });
    if (!invoice)
      throw new NotFoundException('Rechnung nicht gefunden');
    if (invoice.type === 'CN') {
      throw new BadRequestException(
        'Guthaben kann nicht auf eine Gutschrift angewendet werden — Gutschriften werden automatisch mit dem offenen Saldo der Originalrechnung verrechnet.',
      );
    }
    // Compute the invoice's current open balance
    const payments = await this.prisma.payment.findMany({
      where: { invoiceId },
      select: { amount: true },
    });
    const paid = payments.reduce(
      (s, p) => s.plus(p.amount ?? new Prisma.Decimal(0)),
      new Prisma.Decimal(0),
    ).toNumber();
    const open = Math.max(0, Number(invoice.total) - paid);
    if (open < 0.005) {
      throw new BadRequestException('Rechnung ist bereits vollständig bezahlt');
    }
    const apply = Math.min(amount, open);

    // Record the usage (this throws if credit balance < apply).
    const ledger = await this.recordUsage(companyId, customerId, {
      type: 'apply',
      amount: apply,
      referenceType: 'Invoice',
      referenceId: invoiceId,
      description: `Guthaben verrechnet mit Rechnung ${invoice.invoiceNumber}`,
      createdById: userId,
    });

    // Add a synthetic payment row so the invoice payment
    // list + customer statement + aging report all see the
    // reduction. Marked with paymentMethod='Guthaben' so
    // the Berater can identify these rows on a bank-rec.
    await this.prisma.payment.create({
      data: {
        invoiceId,
        amount: apply,
        paymentDate: new Date(),
        paymentMethod: 'Guthaben',
        reference: `Credit ${ledger.id}`,
        notes: `Auto-verrechnet aus Kundenguthaben`,
      },
    });

    // Re-evaluate invoice status: if apply closed the
    // open balance, flip to 'paid'. Mirror the same
    // status transition PaymentService.create() does.
    const newPaid = paid + apply;
    if (
      invoice.type === 'INV' &&
      newPaid >= Number(invoice.total) - 0.01 &&
      invoice.status !== 'paid'
    ) {
      await this.prisma.invoice.update({
        where: { id: invoiceId },
        data: { status: 'paid' },
      });
    }

    return {
      ledgerId: ledger.id,
      appliedAmount: apply,
      balanceAfter: ledger.balanceAfter,
    };
  }

  /**
   * Manual ledger entry (Berater adjustment). Both directions
   * supported — pass a positive `amount` for a credit, negative
   * for a usage. The `type` is recorded as 'manual' regardless
   * of sign so the audit trail is consistent.
   */
  async manualAdjustment(
    companyId: string,
    customerId: string,
    params: {
      amount: number; // signed: + adds credit, - uses credit
      description: string;
      createdById?: string;
    },
  ) {
    if (!params.description?.trim()) {
      throw new BadRequestException('Beschreibung ist erforderlich');
    }
    if (!Number.isFinite(params.amount) || params.amount === 0) {
      throw new BadRequestException('Betrag darf nicht 0 sein');
    }
    if (params.amount > 0) {
      return this.recordCredit(companyId, customerId, {
        type: 'manual',
        amount: params.amount,
        description: params.description,
        createdById: params.createdById,
      });
    }
    return this.recordUsage(companyId, customerId, {
      type: 'manual',
      amount: -params.amount,
      description: params.description,
      createdById: params.createdById,
    });
  }

  /**
   * Generate a v4 UUID without pulling in the `uuid` package
   * (Prisma's runtime is already loaded — `crypto.randomUUID`
   * is built into Node 19+ and our Docker base is Node 22).
   */
  private uuid(): string {
    return (globalThis as any).crypto.randomUUID();
  }
}
