/**
 * Bank statement import service. Wraps the parsers,
 * persists the result, and runs the candidate matching
 * against open invoices.
 *
 * Candidate matching is intentionally simple in this
 * round (no automatic mark-as-paid). For each parsed
 * transaction we look for unpaid invoices whose total
 * matches the amount (±€0.01) AND whose dueDate is
 * within ±7 days of the transaction value date.
 * We also score a regex match on the purpose text
 * (looking for an invoice number like "INV-2026-...").
 *
 * The match score is 0-100; the frontend renders
 * the top 5 candidates per transaction. The user
 * can then confirm which one(s) to pay.
 */

import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { parseMt940 } from './mt940';
import { parseCamt053, detectFormat } from './camt053';
import { PaymentService } from '../invoice/payment.service';
import { VoucherService } from '../accounting/voucher.service';
import { resolveDatevAccounts } from '../reports/datev.service';
import type { ParsedStatement, ParsedTransaction } from './parsers';

@Injectable()
export class BankImportService {
  private readonly logger = new Logger(BankImportService.name);
  constructor(
    private prisma: PrismaService,
    private paymentService: PaymentService,
    private voucherService: VoucherService,
  ) {}

  /** Detect format, parse, persist. Returns the new
   *  BankStatement row (with transactions inline). */
  async importStatement(companyId: string, uploadedById: string | undefined, fileName: string, content: string) {
    if (!content || content.trim().length === 0) {
      throw new BadRequestException('Datei ist leer');
    }
    const format = detectFormat(content);
    let parsed: ParsedStatement[];
    try {
      if (format === 'mt940') {
        parsed = parseMt940(content);
      } else {
        parsed = parseCamt053(content);
      }
    } catch (e: any) {
      throw new BadRequestException(`Parser-Fehler: ${e?.message || e}`);
    }
    if (!parsed.length) {
      throw new BadRequestException('Keine Kontoauszüge in der Datei erkannt');
    }
    // For this round we only support single-statement
    // files. Multi-account MT940 (one :20: per account)
    // gets the first statement; the user can re-upload
    // the rest separately. The parser does the right
    // thing internally — this is just a UX choice.
    const stmt = parsed[0];

    // Persist. Use the format-appropriate date for the
    // period. If we have an opening/closing balance, we
    // also write those (helpful for the audit trail).
    const created = await this.prisma.bankStatement.create({
      data: {
        companyId,
        format,
        fileName,
        fileSize: content.length,
        accountIban: stmt.accountIban,
        bankName: stmt.bankName,
        periodFrom: stmt.periodFrom,
        periodTo: stmt.periodTo,
        openingBalance: stmt.openingBalance?.toFixed(4),
        closingBalance: stmt.closingBalance?.toFixed(4),
        rawContent: content,
        uploadedById,
        transactions: {
          create: stmt.transactions.map((t) => ({
            companyId,
            valueDate: t.valueDate,
            entryDate: t.entryDate,
            amount: t.amount.toFixed(4),
            currency: t.currency,
            counterpartyName: t.counterpartyName,
            counterpartyIban: t.counterpartyIban,
            purpose: t.purpose,
            endToEndId: t.endToEndId,
          })),
        },
      },
      include: { transactions: true },
    });
    // Strip rawContent (multi-KB MT940) from the
    // response — the frontend doesn't render it and
    // it can contain literal newlines that break JSON
    // encoding in some transport layers.
    const { rawContent: _omit, ...rest } = created as any;
    return rest;
  }

  /**
   * Parse a bank statement file WITHOUT persisting it.
   * Returns the parser-detected header metadata
   * (IBAN, bank, period, balances) and the first N
   * transactions so the frontend can show a preview
   * panel: "You're about to import 87 transactions
   * from Sparkasse Dreieich, IBAN DE32…33, period
   * 2026-05-01..2026-05-31, opening 12.345,67
   * closing 11.987,65." The user clicks "Import" only
   * after eyeballing the preview, which prevents
   * accidentally importing the wrong account's file.
   *
   * Take: how many transactions to include in the
   * preview (default 25). The total count is always
   * returned so the UI can show "... and 62 more" if
   * the file has more.
   */
  async previewStatement(content: string, take = 25) {
    if (!content || content.trim().length === 0) {
      throw new BadRequestException('Datei ist leer');
    }
    const format = detectFormat(content);
    let parsed: ParsedStatement[];
    try {
      if (format === 'mt940') {
        parsed = parseMt940(content);
      } else {
        parsed = parseCamt053(content);
      }
    } catch (e: any) {
      throw new BadRequestException(`Parser-Fehler: ${e?.message || e}`);
    }
    if (!parsed.length) {
      throw new BadRequestException('Keine Kontoauszüge in der Datei erkannt');
    }
    const stmt = parsed[0];
    // Sum debits and credits across all transactions
    // (not just the preview slice) so the user sees
    // the total inflow/outflow. A mismatched "open
    // vs. close balance" check is also returned —
    // it's a "durchschnittlicher Bankbestand"
    // reconciliation signal that catches corrupted
    // files early.
    let totalDebit = 0;
    let totalCredit = 0;
    for (const t of stmt.transactions) {
      if (t.amount < 0) totalDebit += Math.abs(t.amount);
      else totalCredit += t.amount;
    }
    const open = stmt.openingBalance ?? null;
    const close = stmt.closingBalance ?? null;
    // Sanity check: opening + credits - debits should
    // approximate the closing balance (within 0.01
    // for rounding). When it doesn't, the file is
    // either truncated or contains a different
    // account's transactions mixed in.
    let balanceCheck: 'ok' | 'mismatch' | 'unknown' = 'unknown';
    if (open !== null && close !== null) {
      const expected = open + totalCredit - totalDebit;
      balanceCheck = Math.abs(expected - close) < 0.01 ? 'ok' : 'mismatch';
    }
    // First N transactions for the preview pane.
    const sample = stmt.transactions.slice(0, take).map((t) => ({
      valueDate: t.valueDate,
      entryDate: t.entryDate,
      amount: t.amount.toString(),
      currency: t.currency,
      counterpartyName: t.counterpartyName,
      counterpartyIban: t.counterpartyIban,
      purpose: t.purpose,
      endToEndId: t.endToEndId,
    }));
    return {
      format,
      accountIban: stmt.accountIban,
      bankName: stmt.bankName,
      periodFrom: stmt.periodFrom,
      periodTo: stmt.periodTo,
      openingBalance: open?.toString() ?? null,
      closingBalance: close?.toString() ?? null,
      totalTransactions: stmt.transactions.length,
      totalDebit: totalDebit.toFixed(2),
      totalCredit: totalCredit.toFixed(2),
      balanceCheck,
      sampleTransactions: sample,
    };
  }

  /** List statements (most recent first). */
  async listStatements(companyId: string) {
    return this.prisma.bankStatement.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { transactions: true } } },
    });
  }

  /** Single statement with its transactions. */
  async getStatement(companyId: string, id: string) {
    return this.prisma.bankStatement.findFirst({
      where: { id, companyId },
      include: {
        transactions: {
          orderBy: { valueDate: 'asc' },
          // voucher: present for transactions that were
          // booked as an expense (BankTransaction.voucherId).
          // Reconciliations (the customer-payment path) carry
          // their own voucherId and aren't joined here.
          include: {
            voucher: { select: { id: true, voucherNumber: true, date: true } },
          },
        },
      },
    });
  }

  /** Delete a statement. Cascades to transactions
   *  (and to any candidate matches, which are
   *  "suggested" status only). */
  async deleteStatement(companyId: string, id: string) {
    const existing = await this.prisma.bankStatement.findFirst({ where: { id, companyId } });
    if (!existing) throw new BadRequestException('Kontoauszug nicht gefunden');
    // Delete candidate matches first (otherwise they'd
    // dangle without their parent txn).
    await this.prisma.bankReconciliation.deleteMany({
      where: {
        bankTransaction: { statementId: id },
        companyId,
      },
    });
    await this.prisma.bankStatement.delete({ where: { id } });
    return { ok: true };
  }

  /** For a given transaction, find candidate invoices
   *  ranked by match score (0-100). Returns the top 5. */
  async getCandidates(companyId: string, bankTransactionId: string) {
    const txn = await this.prisma.bankTransaction.findFirst({
      where: { id: bankTransactionId, companyId },
    });
    if (!txn) throw new BadRequestException('Transaktion nicht gefunden');

    const amount = Number(txn.amount);
    const valueDate = txn.valueDate;

    // Debit (money leaving the account) cannot match
    // a customer invoice (which is money owed to us).
    // The caller should use bookExpense() instead.
    if (amount < 0) {
      return { transaction: txn, candidates: [] };
    }

    // Open invoices: status = 'sent' (draft is too early,
    // paid/cancelled is final). We also include 'overdue'.
    const openInvoices = await this.prisma.invoice.findMany({
      where: {
        companyId,
        status: { in: ['sent', 'overdue'] },
      },
      include: {
        customer: { select: { name: true, customerNumber: true } },
      },
      orderBy: { issueDate: 'desc' },
      take: 200, // upper bound for the candidate pool
    });

    const candidates: Array<{
      invoiceId: string
      invoiceNumber: string
      customerName: string
      customerNumber: string | null
      total: number
      dueDate: string | null
      confidence: number
      matchReason: string
    }> = [];

    const purposeText = (txn.purpose || '') + ' ' + (txn.counterpartyName || '');

    for (const inv of openInvoices) {
      const total = Number(inv.total);
      const amtDelta = Math.abs(total - amount);
      const amtScore = amtDelta < 0.01 ? 60
        : amtDelta < 0.05 ? 35
        : amtDelta < 1.0 ? 15
        : 0;
      if (amtScore === 0) continue; // amount too far off

      // Date match: due date within ±7 days of value date
      let dateScore = 0;
      let dateReason = '';
      if (inv.dueDate) {
        const daysDiff = Math.abs(
          (new Date(inv.dueDate).getTime() - valueDate.getTime()) / (1000 * 60 * 60 * 24),
        );
        if (daysDiff <= 3) { dateScore = 30; dateReason = '±3d'; }
        else if (daysDiff <= 7) { dateScore = 20; dateReason = '±7d'; }
        else if (daysDiff <= 14) { dateScore = 10; dateReason = '±14d'; }
      }

      // Purpose match: invoice number regex
      let purposeScore = 0;
      let purposeReason = '';
      const invNumRe = new RegExp(inv.invoiceNumber.replace(/[-/]/g, '[-/]'), 'i');
      if (invNumRe.test(purposeText)) {
        purposeScore = 25;
        purposeReason = `invoice# ${inv.invoiceNumber} in purpose`;
      }

      // Counterparty name in purpose/counterparty field
      let nameScore = 0;
      if (txn.counterpartyName && inv.customer?.name) {
        const n1 = txn.counterpartyName.toLowerCase();
        const n2 = inv.customer.name.toLowerCase();
        if (n1 === n2 || n1.includes(n2) || n2.includes(n1)) {
          nameScore = 10;
        }
      }

      const confidence = Math.min(100, amtScore + dateScore + purposeScore + nameScore);
      if (confidence < 30) continue; // not worth showing

      const reasonParts: string[] = [`amount ${amtScore}`];
      if (dateReason) reasonParts.push(`date ${dateReason}`);
      if (purposeReason) reasonParts.push(purposeReason);
      if (nameScore > 0) reasonParts.push('name match');

      candidates.push({
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        customerName: inv.customer?.name || '—',
        customerNumber: inv.customer?.customerNumber || null,
        total,
        dueDate: inv.dueDate ? inv.dueDate.toISOString().slice(0, 10) : null,
        confidence,
        matchReason: reasonParts.join(' + '),
      });
    }

    // Sort by confidence desc, then by invoice number
    candidates.sort((a, b) => b.confidence - a.confidence || a.invoiceNumber.localeCompare(b.invoiceNumber));
    return { transaction: txn, candidates: candidates.slice(0, 5) };
  }

  /** Run candidate matching for every transaction in a
   *  statement that doesn't already have a saved match.
   *  Used by the frontend "auto-suggest" button. */
  /**
   * Run candidate matching for every transaction in a
   * statement that doesn't already have a saved match.
   *
   * `autoConfirmThreshold` (0-100): when a candidate's
   * confidence is ≥ threshold, the match is auto-
   * confirmed (writes the Payment, flips the
   * reconciliation to "confirmed", books the GoBD
   * voucher — the full flow). The user still sees the
   * result in the Zuordnungen panel; the difference is
   * no manual Bestätigen click.
   *
   * 0 (default) = the original behaviour: write a
   * "suggested" recon and wait for the user. ≥80 is
   * the recommended safe value for SKR03 (date ±3d
   * + amount exact = 90 typical; date ±7d + amount
   * exact = 80). ≥95 means purpose-invoice# matched.
   */
  async generateSuggestions(
    companyId: string,
    statementId: string,
    opts: { autoConfirmThreshold?: number; userId?: string } = {},
  ) {
    const stmt = await this.getStatement(companyId, statementId);
    if (!stmt) throw new BadRequestException('Kontoauszug nicht gefunden');

    const threshold = Math.max(0, Math.min(100, opts.autoConfirmThreshold ?? 0));
    let suggested = 0;
    let autoConfirmed = 0;
    let errors = 0;

    for (const txn of stmt.transactions) {
      try {
        // Skip if a match already exists. We DON'T
        // auto-confirm an already-suggested recon even
        // when the threshold is set — the user might
        // have already seen the suggestion in the UI
        // and chosen to defer. To re-run the auto-
        // confirm pass, reject the suggestion first.
        const existing = await this.prisma.bankReconciliation.findFirst({
          where: { bankTransactionId: txn.id, companyId },
        });
        if (existing) continue;

        // Skip debit txns (they don't match customer
        // invoices — getCandidates returns []).
        if (Number(txn.amount) < 0) continue;

        const { candidates } = await this.getCandidates(companyId, txn.id);
        if (candidates.length === 0) continue;
        const top = candidates[0];

        // Write the suggestion
        const created = await this.prisma.bankReconciliation.create({
          data: {
            companyId,
            bankTransactionId: txn.id,
            invoiceId: top.invoiceId,
            appliedAmount: top.total.toFixed(4),
            status: 'suggested',
            confidence: top.confidence,
            matchReason: top.matchReason,
          },
        });
        suggested++;

        // Auto-confirm when the threshold is set and
        // the top candidate clears it. confirmMatch
        // does the full Payment + Voucher + invoice
        // status flip, so the e2e is identical to a
        // manual confirm — just no user click.
        if (threshold > 0 && top.confidence >= threshold) {
          await this.confirmMatch(companyId, created.id, opts.userId);
          autoConfirmed++;
        }
      } catch (e: any) {
        errors++;
        this.logger.warn(
          `suggest failed for txn=${txn.id} stmt=${statementId}: ${e?.message || e}`,
        );
      }
    }

    return { generated: suggested, autoConfirmed, errors, threshold };
  }

  /**
   * Confirm a candidate match — creates a Payment
   * (so the invoice status auto-flips to "paid" via
   * PaymentService.create), and flips the reconciliation
   * row from "suggested" to "confirmed".
   *
   * The applied amount is the *lesser* of the
   * transaction amount and the invoice outstanding
   * amount, so overpayments are split (the user can
   * match the remainder to another invoice).
   *
   * Refuses to confirm a row that's already confirmed
   * or rejected (idempotency: rejecting twice is
   * fine but confirming twice would create a duplicate
   * Payment — better to throw and let the UI reload).
   */
  async confirmMatch(
    companyId: string,
    reconciliationId: string,
    userId: string | undefined,
  ) {
    const recon = await this.prisma.bankReconciliation.findFirst({
      where: { id: reconciliationId, companyId },
      include: {
        bankTransaction: true,
        invoice: { select: { id: true, total: true, type: true, status: true } },
      },
    });
    if (!recon) throw new NotFoundException('Zuordnung nicht gefunden');
    if (recon.status === 'confirmed') {
      throw new BadRequestException('Diese Zuordnung wurde bereits bestätigt');
    }
    if (recon.status === 'rejected') {
      throw new BadRequestException('Diese Zuordnung wurde abgelehnt — bitte einen neuen Vorschlag generieren');
    }
    if (recon.invoice.status === 'paid' || recon.invoice.status === 'cancelled') {
      throw new BadRequestException('Rechnung ist bereits abgeschlossen — keine Zahlung möglich');
    }
    if (recon.invoice.type === 'CN') {
      throw new BadRequestException('Gutschriften können nicht direkt bezahlt werden');
    }

    // Applied amount: min(transaction, invoice). For
    // partial payments the user would have to set
    // appliedAmount manually (not exposed in v1).
    const txnAmount = Number(recon.bankTransaction.amount);
    const invTotal = Number(recon.invoice.total);
    const applied = Math.min(txnAmount, invTotal);
    if (applied <= 0) {
      throw new BadRequestException('Betrag muss größer als 0 sein');
    }

    // Write the payment. PaymentService will auto-flip
    // the invoice to "paid" if the cumulative total of
    // payments covers the invoice total.
    const payment = await this.paymentService.create(
      recon.invoiceId,
      companyId,
      {
        amount: applied,
        paymentDate: recon.bankTransaction.valueDate,
        paymentMethod: 'Überweisung',
        reference: recon.bankTransaction.endToEndId || recon.bankTransaction.purpose || undefined,
        notes: `Auto-matched from bank statement ${recon.bankTransaction.statementId} (txn ${recon.bankTransactionId})`,
        receiptNumber: undefined,
      },
    );

    // Book a GoBD Voucher (Buchungsbeleg). The double-
    // entry posting for a customer payment is:
    //
    //   Debit  1200 Bank              applied
    //   Credit 1406 Forderung L+L     applied
    //
    // The VAT was already booked when the invoice was
    // issued, so no USt line is needed here.
    //
    // The voucher is linked back to the recon via
    // BankReconciliation.voucherId — that's the audit
    // trail showing the user (not the system) accepted
    // this booking.
    const voucher = await this.bookPaymentVoucher(
      companyId,
      applied,
      recon.bankTransaction.valueDate,
      recon.invoiceId,
      recon.bankTransaction.counterpartyName,
      recon.bankTransaction.purpose,
    );

    // Flip reconciliation to confirmed (with voucher link).
    await this.prisma.bankReconciliation.update({
      where: { id: reconciliationId },
      data: {
        status: 'confirmed',
        appliedAmount: applied.toFixed(4),
        voucherId: voucher.id,
      },
    });

    // Also link the voucher back to the invoice. The
    // DATEV export uses this to know "the cash side of
    // this paid invoice is in the Voucher, don't
    // double-emit it from the Invoice path".
    await this.prisma.invoice.update({
      where: { id: recon.invoiceId },
      data: { voucherRefId: voucher.id },
    });

    this.logger.log(
      `confirmed match recon=${reconciliationId} invoice=${recon.invoiceId} payment=${payment.id} voucher=${voucher.id} amount=${applied}`,
    );
    return {
      reconciliationId,
      paymentId: payment.id,
      voucherId: voucher.id,
      appliedAmount: applied,
    };
  }

  /**
   * Book the double-entry Voucher for a confirmed
   * customer payment. The booking is:
   *
   *   Debit  1200 Bank              applied
   *   Credit 1406 Forderung L+L     applied
   *
   * Account numbers come from the per-company DATEV
   * config (with SKR03 fallback). If the Account
   * rows don't exist yet for this company, we create
   * them on the fly (idempotent on accountNumber).
   */
  private async bookPaymentVoucher(
    companyId: string,
    amount: number,
    bookingDate: Date,
    invoiceId: string,
    counterpartyName: string | null,
    purpose: string | null,
  ) {
    // Resolve SKR03 / per-company accounts.
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { settings: true },
    });
    const settings = (company?.settings as any) || {};
    const accts = resolveDatevAccounts(settings.datev);

    // Find or create the Account rows we need.
    const bankAccount = await this.ensureAccount(companyId, accts.bank, 'Bank', 'asset', 'liquidity');
    const receivableAccount = await this.ensureAccount(
      companyId,
      accts.receivable,
      'Forderungen aus Lieferungen und Leistungen',
      'asset',
      'receivables',
    );

    // Voucher description. The counterparty + purpose
    // is the "Wer/Was" line on a Buchungsbeleg.
    const counterparty = counterpartyName || 'Kunde';
    const description = purpose
      ? `Zahlungseingang ${counterparty} — ${purpose}`
      : `Zahlungseingang ${counterparty}`;

    // We round to 4 decimal places to match the
    // Decimal(12,4) column. VoucherService will
    // re-validate debit == credit.
    const lines = [
      {
        accountId: bankAccount.id,
        description: `Bank ${counterparty}`,
        debit: amount,
        credit: 0,
      },
      {
        accountId: receivableAccount.id,
        description: `Forderung ausgeglichen`,
        debit: 0,
        credit: amount,
      },
    ];

    return this.voucherService.create({
      companyId,
      date: bookingDate,
      description,
      referenceType: 'BankReconciliation',
      lines,
    });
  }

  /** Idempotently create an Account row for a
   *  (company, accountNumber) pair. If it already
   *  exists, returns the existing row. The name/type
   *  passed in are only used for the create-on-first-
   *  run path; existing rows keep their stored name
   *  (the Berater might have edited it). */
  private async ensureAccount(
    companyId: string,
    accountNumber: string,
    name: string,
    type: string,
    category: string,
  ) {
    const existing = await this.prisma.account.findUnique({
      where: { companyId_accountNumber: { companyId, accountNumber } },
    });
    if (existing) return existing;
    return this.prisma.account.create({
      data: { companyId, accountNumber, name, type, category },
    });
  }

  /**
   * Reject a candidate match — flips the reconciliation
   * status to "rejected" so it won't show in the UI.
   * The user can re-run generateSuggestions to find
   * the next-best candidate.
   */
  async rejectMatch(companyId: string, reconciliationId: string) {
    const recon = await this.prisma.bankReconciliation.findFirst({
      where: { id: reconciliationId, companyId },
    });
    if (!recon) throw new NotFoundException('Zuordnung nicht gefunden');
    if (recon.status === 'confirmed') {
      throw new BadRequestException('Bereits bestätigt — kann nicht abgelehnt werden');
    }
    await this.prisma.bankReconciliation.update({
      where: { id: reconciliationId },
      data: { status: 'rejected' },
    });
    return { ok: true, reconciliationId };
  }

  /**
   * Reopen a confirmed match. GoBD-correct correction
   * path: the original Voucher stays in the books
   * (immutable per §146 AO), but we write a Storno-
   * Voucher with the opposite debit/credit so the
   * net effect on each account is zero. The original
   * Payment is removed via PaymentService.delete,
   * which also flips the invoice back to "sent"
   * when the remaining payment total falls below the
   * invoice total.
   *
   * The reconciliation status flips to "reopened" so
   * the audit trail shows the booking was undone —
   * the original is preserved (a GoBD reviewer can
   * still find the original Voucher and the Storno
   * Voucher linked from this recon).
   *
   * The flow:
   *   1. Find the recon + the original Payment +
   *      Voucher.
   *   2. Build a Storno Voucher (negative lines).
   *   3. Delete the Payment (flips invoice back).
   *   4. Flip recon status to "reopened", set
   *      `voucherId` to the Storno voucher (so the
   *      Zuordnungen panel shows the correction).
   *   5. Clear Invoice.voucherRefId so the DATEV
   *      Invoice path takes back the cash line.
   */
  async reopenMatch(companyId: string, reconciliationId: string) {
    const recon = await this.prisma.bankReconciliation.findFirst({
      where: { id: reconciliationId, companyId },
      include: {
        bankTransaction: true,
        invoice: { select: { id: true, total: true, type: true, status: true, voucherRefId: true } },
        voucher: { include: { lines: { include: { account: true }, orderBy: { sortOrder: 'asc' } } } },
      },
    });
    if (!recon) throw new NotFoundException('Zuordnung nicht gefunden');
    if (recon.status !== 'confirmed') {
      throw new BadRequestException('Nur bestätigte Zuordnungen können rückgängig gemacht werden');
    }
    if (!recon.voucher) {
      // Defensive — a confirmed recon should always
      // have a voucher. If not, the user is in an
      // inconsistent state.
      throw new BadRequestException('Bestätigte Zuordnung hat keinen Buchungsbeleg — kann nicht rückgängig gemacht werden');
    }

    // 1. Build the Storno Voucher. The original
    // Voucher is 2 lines (Bank 1200 debit +
    // Forderung 1406 credit). The Storno flips both
    // signs so each account nets to zero when
    // summed.
    const originalLines = recon.voucher.lines;
    const stornoLines = originalLines.map((l) => ({
      accountId: l.accountId,
      description: `Storno: ${l.description || ''}`.substring(0, 60),
      debit: Number(l.credit),  // swap
      credit: Number(l.debit),   // swap
    }));

    const stornoVoucher = await this.voucherService.create({
      companyId,
      date: recon.bankTransaction.valueDate,
      description: `Storno ${recon.voucher.voucherNumber} — ${recon.invoiceId ? 'Zuordnung rückgängig' : ''}`,
      referenceType: 'BankReconciliationReversal',
      lines: stornoLines,
    });

    // 2. Delete the original Payment. PaymentService
    // will also recompute the invoice status and
    // flip it back to "sent" when the remaining
    // total falls below the invoice total.
    // We need to find the Payment that the original
    // confirm wrote — easiest: the most recent
    // Payment on this invoice with a note matching
    // the auto-matched pattern.
    const originalPayment = await this.prisma.payment.findFirst({
      where: {
        invoiceId: recon.invoiceId,
        notes: { contains: recon.bankTransactionId },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (originalPayment) {
      await this.paymentService.delete(originalPayment.id, companyId);
    }

    // 3. Flip the recon back to 'suggested' (not
    // 'reopened') so the user can immediately re-
    // confirm or pick a different candidate. The
    // original Voucher id stays on voucherId (the
    // original is preserved for GoBD immutability);
    // the Storno id is stored on reversalVoucherId
    // for the audit trail. The UI shows both in the
    // Zuordnungen panel.
    await this.prisma.bankReconciliation.update({
      where: { id: reconciliationId },
      data: {
        status: 'suggested',
        reversalVoucherId: stornoVoucher.id,
        // Keep voucherId pointing at the original
        // Voucher so the audit panel can show "BK-A
        // was reverted by BK-B". When the user
        // re-confirms this recon, confirmMatch will
        // create a new Voucher and overwrite
        // voucherId (the original stays in the
        // books; this recon row just points at the
        // newest booking).
      },
    });

    // 4. Clear Invoice.voucherRefId so the DATEV
    // export's Invoice path takes back the cash
    // line (the Storno voucher + the Invoice
    // pass with no voucherRefId will produce
    // the right set of DATEV rows).
    if (recon.invoice.voucherRefId) {
      await this.prisma.invoice.update({
        where: { id: recon.invoiceId },
        data: { voucherRefId: null },
      });
    }

    this.logger.log(
      `reopened match recon=${reconciliationId} invoice=${recon.invoiceId} stornoVoucher=${stornoVoucher.id}`,
    );
    return {
      reconciliationId,
      originalVoucherId: recon.voucher.id,
      stornoVoucherId: stornoVoucher.id,
      paymentRemoved: !!originalPayment,
    };
  }

  /**
   * Manual match: the user picks an invoice from the
   * candidates list (or types an ID) without waiting
   * for the auto-suggest. Creates a Payment + a
   * confirmed reconciliation in one shot.
   *
   * If a "suggested" recon already exists for this
   * (txn, invoice) pair, confirm it instead of
   * creating a duplicate.
   */
  async manualMatch(
    companyId: string,
    bankTransactionId: string,
    invoiceId: string,
    userId: string | undefined,
  ) {
    const txn = await this.prisma.bankTransaction.findFirst({
      where: { id: bankTransactionId, companyId },
    });
    if (!txn) throw new NotFoundException('Transaktion nicht gefunden');

    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, companyId },
    });
    if (!invoice) throw new NotFoundException('Rechnung nicht gefunden');

    // Look for existing suggested recon
    const existing = await this.prisma.bankReconciliation.findFirst({
      where: { bankTransactionId, invoiceId, companyId },
    });
    if (existing) {
      if (existing.status === 'confirmed') {
        throw new BadRequestException('Diese Zuordnung wurde bereits bestätigt');
      }
      // Reuse the existing row
      return this.confirmMatch(companyId, existing.id, userId);
    }

    // Create fresh confirmed recon
    const created = await this.prisma.bankReconciliation.create({
      data: {
        companyId,
        bankTransactionId,
        invoiceId,
        appliedAmount: invoice.total.toString(),
        status: 'suggested', // create as suggested so confirmMatch can re-validate
        confidence: 0,
        matchReason: 'manual',
      },
    });
    return this.confirmMatch(companyId, created.id, userId);
  }

  /**
   * List all reconciliations for a statement — used by
   * the frontend to render the matching status panel
   * (suggested / confirmed / rejected counts).
   */
  /**
   * Book a debit bank transaction (money leaving the
   * account) as a GoBD expense voucher when no
   * matching vendor invoice is found.
   *
   * The standard booking is:
   *   Debit  4900 Aufwandskonto     amount + vat
   *   Debit  1576 Vorsteuer 19%     vat (if applicable)
   *   Credit 1200 Bank              amount + vat
   *
   * For now we only support expenses without VAT
   * (the user can edit the Voucher in the
   * Buchungsbeleg UI to add a VAT line — Vorsteuer
   * recovery is the Berater's call anyway). v1 books
   * the simple 2-line case:
   *   Debit  4900 Aufwand            amount
   *   Credit 1200 Bank               amount
   *
   * The transaction's `voucherId` is set so the UI
   * can show the Belegnummer in the txn list.
   */
  async bookExpense(
    companyId: string,
    bankTransactionId: string,
    userId: string | undefined,
    opts: {
      expenseAccountNumber?: string
      description?: string
      // Vendor bill / Eingangsrechnung path:
      // attach this booking to a Supplier + an
      // Expense row, and book Vorsteuer (input
      // VAT) when vatAmount > 0. When these are
      // omitted, the original 2-line booking
      // (expense + bank) is used.
      supplierId?: string
      expenseId?: string
      vatRate?: number
      vatAmount?: number
    } = {},
  ) {
    const txn = await this.prisma.bankTransaction.findFirst({
      where: { id: bankTransactionId, companyId },
    });
    if (!txn) throw new NotFoundException('Transaktion nicht gefunden');

    const amount = Number(txn.amount);
    if (amount >= 0) {
      throw new BadRequestException(
        'Diese Funktion ist nur für Ausgänge (negative Beträge). Eingänge bitte als Zuordnung zu einer Rechnung buchen.',
      );
    }

    // Refuse if a reconciliation already exists —
    // the user can either confirm it (invoice path) or
    // reject it first, then book as expense.
    const existingRecon = await this.prisma.bankReconciliation.findFirst({
      where: { bankTransactionId, companyId },
    });
    if (existingRecon) {
      throw new BadRequestException(
        'Diese Buchung hat bereits eine Zuordnung — bitte zuerst ablehnen, dann als Aufwand buchen.',
      );
    }

    // Refuse if already booked as expense (idempotency).
    if (txn.voucherId) {
      throw new BadRequestException('Diese Buchung wurde bereits als Aufwand gebucht');
    }

    // Resolve accounts (per-company DATEV config).
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { settings: true },
    });
    const settings = (company?.settings as any) || {};
    const accts = resolveDatevAccounts(settings.datev);

    const expenseNumber = opts.expenseAccountNumber || accts.expenseDefault;
    const bankAccount = await this.ensureAccount(companyId, accts.bank, 'Bank', 'asset', 'liquidity');
    const expenseAccount = await this.ensureAccount(
      companyId,
      expenseNumber,
      'Sonstige betriebliche Aufwendungen',
      'expense',
      'operating',
    );

    // absoluteValue — the voucher must always carry
    // positive debit/credit values per GoBD.
    const absAmount = Math.abs(amount);

    const counterparty = txn.counterpartyName || '—';
    const description = opts.description
      || txn.purpose
      || `Bankausgang ${counterparty}`;

    // VAT line (Vorsteuer) — only when the user
    // supplies a positive vatAmount. 0% VAT books
    // the legacy 2-line voucher.
    const vatAmount = Math.max(0, Number(opts.vatAmount ?? 0));
    const vatRate = Math.max(0, Number(opts.vatRate ?? 0));
    const netAmount = Math.max(0, absAmount - vatAmount);

    // Pick the right Vorsteuer account per the
    // VAT rate (19% / 7% / igE / reverse-charge).
    let vorsteuerNumber: string | null = null;
    if (vatAmount > 0) {
      if (Math.abs(vatRate - 0.19) < 0.001) vorsteuerNumber = accts.inputVat19;
      else if (Math.abs(vatRate - 0.07) < 0.001) vorsteuerNumber = accts.inputVat7;
      else if (Math.abs(vatRate - 0) < 0.001) vorsteuerNumber = null; // 0% has no Vorsteuer
      // (igE / reverse-charge flows are not in v1)
    }

    // Build the voucher lines. The simple case
    // (no VAT) is 2 lines. With Vorsteuer, it's 3.
    const lines: Array<{
      accountId: string
      description?: string
      debit: number
      credit: number
      vatRate?: number
      vatAmount?: number
    }> = [
      {
        accountId: expenseAccount.id,
        description: counterparty,
        debit: netAmount,
        credit: 0,
      },
    ]
    if (vorsteuerNumber) {
      const vorsteuerAccount = await this.ensureAccount(
        companyId,
        vorsteuerNumber,
        'Vorsteuer',
        'asset',
        'vat'
      )
      lines.push({
        accountId: vorsteuerAccount.id,
        description: `Vorsteuer ${(vatRate * 100).toFixed(0)}%`,
        debit: vatAmount,
        credit: 0,
        vatRate,
        vatAmount,
      })
    }
    lines.push({
      accountId: bankAccount.id,
      description: `Bank ${counterparty}`,
      debit: 0,
      credit: absAmount,
    })

    // When this voucher is tied to an existing Expense
    // row, append the expenseId to the description. The
    // /dashboard/expenses list page string-matches the
    // "[expense:<uuid>]" tag in voucher.description to
    // pivot back to the originating Eingangsrechnung.
    // Hidden in the PDF / DATEV but visible in the UI
    // audit trail — cheap linkage, no schema change.
    const expenseTag = opts.expenseId ? ` [expense:${opts.expenseId}]` : ''
    const voucher = await this.voucherService.create({
      companyId,
      date: txn.valueDate,
      description: description + expenseTag,
      referenceType: opts.expenseId ? 'Expense' : 'BankTransaction',
      lines,
    });

    // Link voucher back to the transaction.
    await this.prisma.bankTransaction.update({
      where: { id: bankTransactionId },
      data: { voucherId: voucher.id },
    });

    // Vendor-bill path: if an existing Expense was
    // selected, mark it as 'booked' and link the
    // voucher back to it. The Expense row already
    // holds the supplier + invoice# + dates — this
    // turn just makes the booking official.
    if (opts.expenseId) {
      await this.prisma.expense.update({
        where: { id: opts.expenseId, companyId },
        data: { status: 'booked' },
      });
    }

    this.logger.log(
      `booked expense txn=${bankTransactionId} voucher=${voucher.id} amount=${absAmount} account=${expenseNumber}${opts.expenseId ? ` expense=${opts.expenseId}` : ''}`,
    );
    return {
      transactionId: bankTransactionId,
      voucherId: voucher.id,
      appliedAmount: absAmount,
      vatAmount: vatAmount || undefined,
      netAmount: netAmount,
    };
  }

  /**
   * List all reconciliations for a statement — used by
   * the frontend to render the matching status panel
   * (suggested / confirmed / rejected counts).
   */
  async listReconciliations(companyId: string, statementId: string) {
    return this.prisma.bankReconciliation.findMany({
      where: { companyId, bankTransaction: { statementId } },
      include: {
        invoice: { select: { invoiceNumber: true, total: true, customer: { select: { name: true } } } },
        // The current booking voucher (or, if reopened,
        // the most recent one). NULL when the recon
        // hasn't been confirmed yet.
        voucher: { select: { id: true, voucherNumber: true, date: true } },
        // The Storno voucher (if any). The UI shows
        // "BK-A reverted by BK-B" when both are
        // present.
        reversalVoucher: { select: { id: true, voucherNumber: true, date: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }
}
