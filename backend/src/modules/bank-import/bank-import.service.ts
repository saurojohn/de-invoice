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
import type { ParsedStatement, ParsedTransaction } from './parsers';

@Injectable()
export class BankImportService {
  private readonly logger = new Logger(BankImportService.name);
  constructor(
    private prisma: PrismaService,
    private paymentService: PaymentService,
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
        transactions: { orderBy: { valueDate: 'asc' } },
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
  async generateSuggestions(companyId: string, statementId: string) {
    const stmt = await this.getStatement(companyId, statementId);
    if (!stmt) throw new BadRequestException('Kontoauszug nicht gefunden');
    let total = 0;
    for (const txn of stmt.transactions) {
      // Skip if a match already exists
      const existing = await this.prisma.bankReconciliation.findFirst({
        where: { bankTransactionId: txn.id, companyId },
      });
      if (existing) continue;
      const { candidates } = await this.getCandidates(companyId, txn.id);
      if (candidates.length === 0) continue;
      const top = candidates[0];
      await this.prisma.bankReconciliation.create({
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
      total++;
    }
    return { generated: total };
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

    // Flip reconciliation to confirmed.
    await this.prisma.bankReconciliation.update({
      where: { id: reconciliationId },
      data: {
        status: 'confirmed',
        appliedAmount: applied.toFixed(4),
      },
    });

    this.logger.log(
      `confirmed match recon=${reconciliationId} invoice=${recon.invoiceId} payment=${payment.id} amount=${applied}`,
    );
    return { reconciliationId, paymentId: payment.id, appliedAmount: applied };
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
  async listReconciliations(companyId: string, statementId: string) {
    return this.prisma.bankReconciliation.findMany({
      where: { companyId, bankTransaction: { statementId } },
      include: {
        invoice: { select: { invoiceNumber: true, total: true, customer: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }
}
