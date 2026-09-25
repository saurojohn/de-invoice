import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AccountService } from './account.service';
import { WebhookService } from '../webhook/webhook.service';
// Tier 26.3: SKR03 Sachkonten auto-inference for
// uncategorised VoucherLines. Best-effort — runs
// on create when the user omits the accountId and
// provides a description. The fallback (no
// description / no match) is a null line, which
// the UI surfaces as "(noch zu kategorisieren)".
import { applyExpenseInference } from '../reports/datev-sachkonto-inference';

interface CreateVoucherDto {
  companyId: string;
  date: Date;
  description?: string;
  referenceType?: string;
  // Default 'posted' for auto-generated vouchers
  // (BankReconciliation / Expense) and the typical
  // Berater manual entry. 'draft' is reserved for
  // unfinished in-progress vouchers.
  status?: 'draft' | 'posted';
  createdById?: string;
  // Tier 253: optional caller-supplied
  // voucherNumber. Honored by create() when
  // present; otherwise auto-generated.
  voucherNumber?: string;
  lines: {
    // Tier 256: accountId is optional here too
    // so the Sachkonten auto-inference (Tier 26)
    // can pass null + a description and have the
    // service infer the SKR03 account.
    accountId?: string | null;
    description?: string;
    debit?: number;
    credit?: number;
    vatRate?: number;
    vatAmount?: number;
    // Tier 41: per-line DATEV Kostenstelle 1 + Kostenträger.
    // Free-form, same as Invoice.costCenter. The frontend
    // auto-fills these from /vouchers/cost-center-suggestion
    // (most-used per accountId), but the user can override
    // before save.
    costCenter?: string;
    costObject?: string;
  }[];
}

@Injectable()
export class VoucherService {
  constructor(
    private prisma: PrismaService,
    private accountService: AccountService,
    private webhooks: WebhookService,
  ) {}

  /**
   * Tier 377: every accountId on a line must be an Account of this company.
   * Nothing checked it: company A's POST /accounting/vouchers with tenant B's
   * account id answered 201 and the VoucherLine pointed at B's account
   * (measured); an id that exists nowhere hit the foreign key → 500.
   */
  private async assertAccountsBelongTo(companyId: string, lines: Array<{ accountId?: string | null }>) {
    const ids = [...new Set(lines.map((l) => l.accountId).filter((id): id is string => !!id))];
    if (ids.length === 0) return;
    const found = await this.prisma.account.count({ where: { companyId, id: { in: ids } } });
    if (found !== ids.length) {
      throw new BadRequestException('Sachkonto nicht gefunden (nicht in dieser Firma)');
    }
  }

  async create(dto: CreateVoucherDto) {
    await this.assertAccountsBelongTo(dto.companyId, dto.lines);
    // Validate debits = credits
    const totalDebit = dto.lines.reduce((sum, l) => sum + (l.debit || 0), 0);
    const totalCredit = dto.lines.reduce((sum, l) => sum + (l.credit || 0), 0);
    
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      throw new BadRequestException('Soll und Haben müssen ausgeglichen sein');
    }

    // Tier 253: if the caller supplied a
    // voucherNumber (e.g. the e2e tests need
    // a known prefix for cleanup), honor it.
    // Otherwise auto-generate a default.
    const voucherNumber =
      dto.voucherNumber ||
      (await this.generateVoucherNumber(dto.companyId, dto.date));

    const created = await this.prisma.voucher.create({
      data: {
        companyId: dto.companyId,
        voucherNumber,
        date: dto.date,
        description: dto.description,
        referenceType: dto.referenceType,
        // Default to 'posted' — manual Vouchers
        // created by the Berater are immediately
        // final (drafts would be visible in the
        // journal and confusing).
        status: dto.status ?? 'posted',
        createdById: dto.createdById,
        lines: {
          create: dto.lines.map((line, idx) => ({
            accountId: line.accountId,
            description: line.description,
            debit: line.debit || 0,
            credit: line.credit || 0,
            vatRate: line.vatRate,
            vatAmount: line.vatAmount,
            // Tier 41: cost-center stamps. Trim + null-out
            // empty strings so the column read is consistent
            // with Invoice.costCenter (NULL rather than "").
            costCenter: line.costCenter?.trim() || null,
            costObject: line.costObject?.trim() || null,
            sortOrder: idx,
          })),
        },
      },
      include: {
        lines: {
          include: { account: true },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });

    // Tier 26.3: run the SKR03 Sachkonten
    // auto-inference on any line that's still
    // uncategorised (accountId === null).
    // The inference is best-effort — it returns
    // null for an empty/missing description, in
    // which case the line stays uncategorised
    // and the user can pick the accountId in
    // the UI. The create returns the inferred
    // account on the response (via the same
    // line.account include) so the caller sees
    // the resolution immediately.
    for (const line of created.lines) {
      if (!line.accountId && line.description) {
        await applyExpenseInference(
          this.prisma, line.id, line.description,
        )
      }
    }
    // Re-read so the response includes the
    // newly-assigned accountId values.
    const refreshed = await this.prisma.voucher.findUnique({
      where: { id: created.id },
      include: {
        lines: {
          include: { account: true },
          orderBy: { sortOrder: 'asc' },
        },
      },
    })
    if (refreshed) {
      // Mutate the local `created` so the rest
      // of this method (webhook emit, return
      // value) sees the inferred accounts.
      ;(created as any).lines = refreshed.lines
    }

    // Fire voucher.created. Manual
    // vouchers are always 'posted' on
    // create (no draft phase), so we
    // fire 'voucher.posted' too —
    // receivers that subscribe to
    // ONLY 'voucher.posted' will
    // receive it. Receivers that
    // want both signals can
    // subscribe to both event types.
    //
    // Why two events for one action?
    //   - voucher.created: "a new
    //     voucher row appeared in the
    //     DB" (always fires)
    //   - voucher.posted: "a voucher
    //     transitioned to posted
    //     status" (fires for manual
    //     vouchers + would fire on
    //     a future draft→posted
    //     transition)
    // The dual event is forward-
    // looking: when we add a draft
    // workflow (Berater composing a
    // multi-line voucher over
    // multiple days), the create
    // event stays the same but
    // posted becomes a real status
    // transition.
    this.webhooks
      .emit({
        id: `vou_${created.id}`,
        type: 'voucher.created',
        occurredAt: new Date().toISOString(),
        companyId: dto.companyId,
        data: {
          id: created.id,
          voucherNumber: created.voucherNumber,
          date: created.date,
          description: created.description,
          status: created.status,
          referenceType: created.referenceType,
          lineCount: created.lines.length,
          // Tier 214: sum via Prisma.Decimal so we don't lose precision
          // on 4+ decimal-place amounts. The .toNumber() at the end
          // rounds to float64 once, after the full sum.
          totalDebit: created.lines.reduce(
            (s, l) => s.plus(l.debit),
            new Prisma.Decimal(0),
          ).toNumber(),
          totalCredit: created.lines.reduce(
            (s, l) => s.plus(l.credit),
            new Prisma.Decimal(0),
          ).toNumber(),
        },
      })
      .catch((err) => console.error('webhook emit(voucher.created) failed:', err))

    if (created.status === 'posted') {
      this.webhooks
        .emit({
          id: `vou_${created.id}_posted_${created.createdAt?.getTime() ?? Date.now()}`,
          type: 'voucher.posted',
          occurredAt: new Date().toISOString(),
          companyId: dto.companyId,
          data: {
            id: created.id,
            voucherNumber: created.voucherNumber,
            date: created.date,
            description: created.description,
            referenceType: created.referenceType,
          },
        })
        .catch((err) => console.error('webhook emit(voucher.posted) failed:', err))
    }

    return created;
  }

  /**
   * GoBD Korrekturbeleg (Storno-Buchung) for a manual
   * Voucher. The original is NEVER mutated — instead
   * a new Voucher is created with:
   *   - voucherNumber = originalNumber + "-S<n>"
   *     where n is the next sequence for that
   *     original. This keeps the human-readable
   *     pairing ("BK-2026-0001 ↔ BK-2026-0001-S1")
   *     so the Berater can spot the relationship
   *     in the journal.
   *   - date = today (the day of the correction)
   *   - referenceType = 'VoucherReversal'
   *   - description prefixed with "Storno: " and
   *     optionally "Grund: <reason>"
   *   - lines with debit ↔ credit SWAPPED
   *     (so a 100 debit becomes 100 credit).
   *     A negation of all amounts nets the books
   *     back to zero across the original + Storno.
   *   - reversedById = original.id
   *
   * Why a NEW voucher, not a status flip:
   *   GoBD §146 AO + §257 HGB require bookkeeping
   *   records to be immutable once posted. The
   *   correction is a SEPARATE entry, not an edit
   *   of the original. This pattern matches the
   *   existing bank-import reopenMatch behavior.
   */
  async createReversal(
    originalId: string,
    companyId: string,
    reason?: string,
  ) {
    const original = await this.findOne(originalId, companyId);
    if (!original) {
      throw new NotFoundException(`Voucher ${originalId} not found`);
    }
    // Don't allow reversing a voucher that's
    // already a Storno of something else (chain
    // of corrections would muddy the audit).
    // The user should reverse the ORIGINAL.
    if (original.reversedById) {
      throw new BadRequestException(
        'Bereits ein Korrekturbeleg — Storno nur vom Originalbeleg aus möglich',
      );
    }
    // Tier 446: a bank reconciliation also recorded a Payment and linked the
    // invoice (voucherRefId). A Storno of the voucher alone left the invoice
    // paid in the app and unpaid in DATEV. Its undo takes back all three.
    if (original.referenceType === 'BankReconciliation') {
      throw new BadRequestException(
        'Dieser Beleg gehört zu einer Bankzuordnung. Nehmen Sie die Zuordnung im Bankimport mit „Rückgängig“ zurück — das storniert den Beleg und löscht die Zahlung.',
      );
    }
    // Idempotency: if there's already a reversal
    // for this Voucher, return it instead of
    // creating a duplicate. The list view + the
    // user can both click "Stornieren" multiple
    // times.
    const existing = await this.prisma.voucher.findFirst({
      where: {
        companyId,
        referenceType: 'VoucherReversal',
        reversedById: originalId,
      },
    });
    if (existing) {
      return this.findOne(existing.id, companyId);
    }

    // Compute the suffix -S1, -S2, … based on
    // existing reversals of this original.
    const existingReversals = await this.prisma.voucher.count({
      where: {
        companyId,
        reversedById: originalId,
      },
    });
    const seq = existingReversals + 1;
    const newVoucherNumber = `${original.voucherNumber}-S${seq}`;

    // Build description prefix.
    const reasonPart = reason ? ` Grund: ${reason}` : '';
    const newDescription = `Storno: ${original.voucherNumber}${reasonPart}`;

    const reversal = await this.prisma.voucher.create({
      data: {
        companyId,
        voucherNumber: newVoucherNumber,
        date: new Date(),
        description: newDescription,
        referenceType: 'VoucherReversal',
        status: 'posted',
        reversedById: originalId,
        // Negate every line. Soll ↔ Haben swap so
        // the new Voucher has the same accounts but
        // opposite amounts — the two together net
        // to zero in the books.
        lines: {
          create: original.lines.map((l) => ({
            accountId: l.accountId,
            description: l.description
              ? `Storno: ${l.description}`
              : 'Storno',
            debit: Number(l.credit),
            credit: Number(l.debit),
            vatRate: l.vatRate,
            vatAmount: l.vatAmount,
            sortOrder: l.sortOrder,
          })),
        },
      },
      include: {
        lines: {
          include: { account: true },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });

    // Tier 444: a Storno of a bank booking takes the payment back too.
    await this.releaseBankBooking(companyId, original);

    // Fire voucher.reversed. The
    // eventId embeds the original
    // voucher id + the reversal id,
    // so receivers that already
    // processed the original
    // voucher can find the
    // corresponding Storno easily.
    // We also include originalVoucherId
    // in data for receivers that
    // don't want to parse the
    // eventId.
    this.webhooks
      .emit({
        id: `vou_${originalId}_reversed_by_${reversal.id}`,
        type: 'voucher.reversed',
        occurredAt: new Date().toISOString(),
        companyId,
        data: {
          reversalId: reversal.id,
          reversalVoucherNumber: reversal.voucherNumber,
          originalVoucherId: originalId,
          originalVoucherNumber: original.voucherNumber,
          reason: reason ?? null,
        },
      })
       .catch((err) => console.error('webhook emit(voucher.reversed) failed:', err))

    return reversal;
  }

  /**
   * Tier 444 — a Storno of a bank-import expense booking (book-expense) took
   * the booking back but not what it did outside the journal: the bank
   * transaction kept `voucherId` → the reversed voucher, so it could never be
   * booked again ("bereits als Aufwand gebucht"), and the expense tagged
   * `[expense:<id>]` stayed paid — owed nothing in the balance sheet, not in
   * the SEPA run, paid in DATEV from `paidAt`, and locked (Tier 443).
   *
   * Only this payment is taken back: `paidAt` is cleared when it is the
   * booking's value date and nothing else pays the expense (a SEPA batch,
   * an unreversed cash-book Ausgabe). A correction (/correct) is not a Storno
   * of the payment and does not come here.
   */
  private async releaseBankBooking(
    companyId: string,
    original: { id: string; date: Date; description: string | null; referenceType: string | null },
  ) {
    if (original.referenceType !== 'Expense' && original.referenceType !== 'BankTransaction') return;
    await this.prisma.bankTransaction.updateMany({
      where: { companyId, voucherId: original.id },
      data: { voucherId: null },
    });
    // Tier 452: a Skonto credit note written with this payment goes with it.
    await this.prisma.expense.deleteMany({
      where: { companyId, notes: { contains: `[skonto-voucher:${original.id}]` } },
    });
    const expenseId = /\[expense:([0-9a-f-]{36})\]/.exec(original.description || '')?.[1];
    if (!expenseId) return;
    const paidInCash = await this.prisma.cashBookEntry.count({
      where: { companyId, expenseId, reversesId: null, reversedBy: null },
    });
    if (paidInCash > 0) return;
    await this.prisma.expense.updateMany({
      where: { id: expenseId, companyId, paidBySepaBatchId: null, paidAt: original.date },
      data: { paidAt: null },
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // TIER 42: Korrektur (Correction Voucher)
  // ──────────────────────────────────────────────────────────────────
  //
  // A posted Voucher is immutable under §146 AO (GoBD): it
  // can't be overwritten or mutated in place. The user
  // correcting a typo on a Bank-fee booking has to walk a
  // three-step path:
  //
  //   1. Reverse the original  (creates BK-2026-0042-S1)
  //   2. Manually create the correct Voucher with new lines
  //   3. Verify Soll = Haben on the new Voucher
  //
  // Tier 42 collapses all three into a single RPC. The
  // user edits the lines in a dialog, hits "Korrigieren",
  // and the backend atomically:
  //
  //   - reverses the original  (same logic as createReversal)
  //   - creates a NEW posted Voucher carrying the user's
  //     edited lines, date=today, description prefixed
  //     with "Korrektur: BK-…" for traceability
  //   - references the reversal via referencesRelation-like
  //     fields so the audit trail shows the chain
  //
  // Everything in one Postgres transaction so a partial
  // failure rolls back both halves. The reversal Voucher
  // keeps its own customer-visible voucherNumber
  // (`<orig>-S<seq>`); the correction gets a fresh number
  // (`<orig>-K<seq>`) so it shows up in the journal as a
  // separate Buchung.
  //
  // Why K-corretion rather than chaining via reversedById:
  //   K-Voucher is a brand new Buchung, not a Storno
  //   itself. reversedById on the original Voucher is left
  //   untouched (so the Storno relationship stays clear);
  //   the linkage between Storno and Korrektur is captured
  //   via referenceType='VoucherCorrection' on the K line,
  //   + a `referenceVoucherId` field stored in the
  //   description ("Korrektur zu <orig>-S<seq>"). A future
  //   schema migration could promote that to a column if
  //   chain-walking becomes a hot path; for now text in the
  //   description + reversedById reverse-edges is enough.

  async correct(
    originalId: string,
    companyId: string,
    correction: {
      date: Date;
      description?: string;
      lines: Array<{
        accountId: string;
        debit?: number;
        credit?: number;
        description?: string;
        vatRate?: number;
        vatAmount?: number;
        costCenter?: string;
        costObject?: string;
      }>;
      reason?: string;
    },
  ) {
    const original = await this.findOne(originalId, companyId);
    if (!original) {
      throw new NotFoundException(`Voucher ${originalId} not found`);
    }
    // The original must NOT already be reversed — if it
    // is, the user has to either reverse the reversal
    // (which we don't support) or edit the K-Booking
    // directly. Going down the same path twice would
    // double-net the books.
    if (original.reversedById) {
      throw new BadRequestException(
        'Original ist bereits storniert — bitte den Korrekturbeleg direkt editieren.',
      );
    }
    // Validation: at least 2 lines, Soll = Haben, every line has an accountId.
    if (correction.lines.length < 2) {
      throw new BadRequestException('Mindestens 2 Positionen erforderlich');
    }
    if (correction.lines.some((l) => !l.accountId)) {
      throw new BadRequestException('Jede Position benötigt eine Sachkonto');
    }
    const totalDebit = correction.lines.reduce(
      (s, l) => s + (l.debit || 0),
      0,
    );
    const totalCredit = correction.lines.reduce(
      (s, l) => s + (l.credit || 0),
      0,
    );
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      throw new BadRequestException(
        'Soll und Haben müssen im Korrekturbeleg ausgeglichen sein',
      );
    }
    await this.assertAccountsBelongTo(companyId, correction.lines);

    // Allocate new voucher numbers BEFORE the transaction
    // (using separate counters per suffix so Storno + Korrektur
    //  each get their own monotonic sequence).
    const existingReversals = await this.prisma.voucher.count({
      where: {
        companyId,
        reversedById: originalId,
      },
    });
    const stornoSeq = existingReversals + 1;
    const reversalNumber = `${original.voucherNumber}-S${stornoSeq}`;

    // K-correction numbers live alongside the same year-prefix
    // system as create-voucher does: BK-<year>-<seq>. We
    // suffix with -K<stornoSeq> so the file system view groups
    // them together without polluting the BK counter.
    const stornoKseq = `${stornoSeq}`; // tie to Storno sequence
    const correctionNumber = `${original.voucherNumber}-K${stornoKseq}`;

    // The correction voucher DOES NOT replace the original
    // (which is immutable per §146 AO). The reversal created
    // by this transaction nets the original to zero; the
    // K-voucher carries the corrected economic impact.
    // Both book to today's date, so the books reflect
    // the correction as of the running month.

    // Build the description prefix.
    const reasonPart = correction.reason ? ` Grund: ${correction.reason}` : '';
    const stornoDescription = `Storno zu ${original.voucherNumber}${reasonPart}`;
    const correctionDescription =
      (correction.description || `Korrektur zu ${reversalNumber}`) +
      `${reasonPart}`;

    // RUN IN TRANSACTION. Either both land or neither does.
    // Prisma supports interactive transactions; we use the
    // array form because the work is bounded.
    const [storno, corrected] = await this.prisma.$transaction([
      // The Storno mirrors the original with negated amounts.
      // We inline the reversal here (instead of calling
      // createReversal()) because:
      //   - createReversal emits the webhook OUTSIDE the
      //     transaction, which would race with the K-voucher
      //     commit
      //   - we want the Storno + K-voucher to commit as one
      //     unit so a partial failure doesn't leave a half-
      //     baked correction
      this.prisma.voucher.create({
        data: {
          companyId,
          voucherNumber: reversalNumber,
          date: correction.date || new Date(),
          description: stornoDescription,
          referenceType: 'VoucherReversal',
          status: 'posted',
          reversedById: originalId,
          lines: {
            create: original.lines.map((l) => ({
              accountId: l.accountId,
              description: l.description
                ? `Storno: ${l.description}`
                : 'Storno',
              debit: Number(l.credit),
              credit: Number(l.debit),
              vatRate: l.vatRate,
              vatAmount: l.vatAmount,
              costCenter: l.costCenter,
              costObject: l.costObject,
              sortOrder: l.sortOrder,
            })),
          },
        },
        include: { lines: true },
      }),
      // The correction Voucher carries the user's edited lines.
      this.prisma.voucher.create({
        data: {
          companyId,
          voucherNumber: correctionNumber,
          date: correction.date || new Date(),
          description: correctionDescription,
          // New enum-ish marker — webhooks can subscribe to it
          // separately if they want to notify on corrections.
          referenceType: 'VoucherCorrection',
          status: 'posted',
          // Don't set reversedById — the K voucher is a new
          // booking, not a Storno of anything.
          lines: {
            create: correction.lines.map((l, idx) => ({
              accountId: l.accountId,
              description: l.description,
              debit: l.debit || 0,
              credit: l.credit || 0,
              vatRate: l.vatRate,
              vatAmount: l.vatAmount,
              costCenter: l.costCenter?.trim() || null,
              costObject: l.costObject?.trim() || null,
              sortOrder: idx,
            })),
          },
        },
        include: { lines: true },
      }),
    ]);

    // Fire webhooks AFTER successful commit. We emit two
    // events:
    //   - voucher.reversed (for the original's reversal)
    //   - voucher.created  (for the new correction)
    // Receivers that listen on both get the full chain;
    // receivers that only listen on one get the half they
    // care about.
    const reversalVoucherId = (storno as any).id;
    this.webhooks
      .emit({
        id: `vou_${originalId}_corrected_by_${reversalVoucherId}_${(corrected as any).id}`,
        type: 'voucher.reversed',
        occurredAt: new Date().toISOString(),
        companyId,
        data: {
          originalVoucherId: originalId,
          reversalVoucherId,
          correctionVoucherId: (corrected as any).id,
          reason: correction.reason,
        },
      })
      .catch((err) => console.error('webhook emit(correct) failed:', err));
    this.webhooks
      .emit({
        id: `vou_correction_${(corrected as any).id}`,
        type: 'voucher.created',
        occurredAt: new Date().toISOString(),
        companyId,
        data: {
          voucherId: (corrected as any).id,
          correctionForVoucherId: originalId,
        },
      })
      .catch((err) => console.error('webhook emit(voucher.created) failed:', err));

    // Return both halves. The frontend uses `correction` to
    // navigate to the new Voucher, and `reversal` for the
    // audit chain (renders the Storno below the K link).
    return {
      reversal: storno,
      correction: corrected,
      // Open the door for a future chain-walk: from the
      // original's id, you can find both the Storno
      // (reversedById === originalId) and the K (any Voucher
      // whose referenceType === 'VoucherCorrection' AND
      // description starts with 'Korrektur zu <reversalNumber>').
    };
  }

  async findAll(
    companyId: string,
    filters?: {
      startDate?: Date
      endDate?: Date
      status?: string
      referenceType?: string
      search?: string
      take?: number
      skip?: number
    },
  ) {
    const where: any = { companyId };
    if (filters?.startDate || filters?.endDate) {
      where.date = {};
      if (filters.startDate) where.date.gte = filters.startDate;
      if (filters.endDate) where.date.lte = filters.endDate;
    }
    if (filters?.status) {
      where.status = filters.status;
    }
    if (filters?.referenceType) {
      where.referenceType = filters.referenceType;
    }
    if (filters?.search) {
      // Substring match on voucherNumber — the Beleg
      // IDs follow a structured pattern (BK-YYYY-NNNN
      // for our auto-generated ones, legacy ones may
      // be anything) so a contains-search covers all
      // the realistic cases.
      where.voucherNumber = { contains: filters.search, mode: 'insensitive' };
    }

    // The list page doesn't need the full line breakdown
    // (each line could be 5+ KB; pulling 100 vouchers
    // is 500 KB+). Fetch the lightweight summary +
    // the account ids on the lines so the list page
    // can show the "first account" badge.
    const items = await this.prisma.voucher.findMany({
      where,
      orderBy: [{ date: 'desc' }, { voucherNumber: 'desc' }],
      take: filters?.take ?? 200,
      skip: filters?.skip ?? 0,
      include: {
        lines: {
          select: {
            debit: true,
            credit: true,
            account: { select: { accountNumber: true, name: true } },
          },
        },
      },
    });

    // For each voucher compute: totalDebit, totalCredit,
    // primaryAccount (the Sachkonto / expense or revenue
    // account — NOT the bank Gegenkonto), and a balanced
    // flag. Cheap to do in-memory since the line list is
    // already loaded.
    //
    // Bug history (e2e/09-vouchers-list.sh): original
    // implementation picked the line with the largest
    // single amount, which made 1200 (Bank) win over
    // 4900 (Aufwand) on a typical Expense voucher —
    // because credit 119 > debit 100. The "primary
    // account" is meant to be the operational account,
    // not the cash clearing account. We now skip lines
    // whose account name is a known clearing pattern
    // (Bank / Kasse / Geld / Postbank / Verrechnung),
    // then fall back to any line if every line is a
    // clearing account.
    const isClearingAccount = (name: string): boolean => {
      const n = name.toLowerCase();
      return (
        n.includes('bank') ||
        n.includes('kasse') ||
        n.includes('geld') ||
        n.includes('postbank') ||
        n.includes('verrechnung') ||
        n.includes('schwebend')
      );
    };
    const enriched = items.map((v) => {
      let totalDebit = 0;
      let totalCredit = 0;
      let primaryNumber = '—';
      let primaryMaxAmount = -1;
      let fallbackNumber = '—';
      let fallbackMaxAmount = -1;
      for (const l of v.lines) {
        const d = Number(l.debit);
        const c = Number(l.credit);
        totalDebit += d;
        totalCredit += c;
        // Tier 26.3: an uncategorised VoucherLine
        // (l.account === null) is skipped here. The
        // "primary account" of a Voucher is the
        // largest NON-clearing line — if no line
        // has an accountId yet, the Voucher is
        // still in the "draft, needs categorisation"
        // state and the primaryNumber stays "—".
        // The UI surfaces this so the user can
        // click into the Voucher and assign.
        if (!l.account) continue;
        // Always track the absolute-largest fallback so
        // a 100%-clearing voucher (e.g. inter-bank
        // transfer 1200→1210) still gets a primary.
        const amount = Math.max(d, c);
        if (amount > fallbackMaxAmount) {
          fallbackMaxAmount = amount;
          fallbackNumber = l.account.accountNumber;
        }
        if (isClearingAccount(l.account.name)) continue;
        if (amount > primaryMaxAmount) {
          primaryMaxAmount = amount;
          primaryNumber = l.account.accountNumber;
        }
      }
      // If every line was a clearing account, use the
      // largest one as a sane fallback. Otherwise the
      // largest-clearing line would silently shadow the
      // real Sachkonto.
      if (primaryMaxAmount < 0) primaryNumber = fallbackNumber;
      return {
        id: v.id,
        voucherNumber: v.voucherNumber,
        date: v.date,
        description: v.description,
        referenceType: v.referenceType,
        status: v.status,
        createdAt: v.createdAt,
        totalDebit: totalDebit.toFixed(2),
        totalCredit: totalCredit.toFixed(2),
        balanced: Math.abs(totalDebit - totalCredit) < 0.01,
        primaryAccount: primaryNumber,
      };
    });

    // Total count for pagination (separate query so
    // the page knows the dataset size).
    const total = await this.prisma.voucher.count({ where });
    return { items: enriched, total };
  }

  async findOne(id: string, companyId: string) {
    const voucher = await this.prisma.voucher.findFirst({
      where: { id, companyId },
      include: {
        lines: {
          include: { account: true },
          orderBy: { sortOrder: 'asc' },
        },
        // Audit-trail links: the Voucher may be the
        // cash side of a BankReconciliation, a
        // BankTransaction expense booking, a
        // BankReconciliation reversal (Storno), or
        // the legacy invoice-side path. Each Voucher
        // is reachable from one of these — the
        // detail page renders the links so the
        // Berater can pivot in either direction.
        bankReconciliations: {
          select: {
            id: true,
            status: true,
            appliedAmount: true,
            invoice: { select: { id: true, invoiceNumber: true, total: true } },
            bankTransaction: {
              select: {
                id: true,
                valueDate: true,
                amount: true,
                counterpartyName: true,
                purpose: true,
                endToEndId: true,
                statement: { select: { id: true, fileName: true, format: true } },
              },
            },
          },
        },
        reversalOf: {
          select: {
            id: true,
            status: true,
            appliedAmount: true,
            invoice: { select: { id: true, invoiceNumber: true } },
            bankTransaction: {
              select: { id: true, valueDate: true, amount: true, counterpartyName: true },
            },
          },
        },
        bankTransactions: {
          select: {
            id: true,
            valueDate: true,
            amount: true,
            counterpartyName: true,
            purpose: true,
            statement: { select: { id: true, fileName: true, format: true } },
          },
        },
        invoiceRef: { select: { id: true, invoiceNumber: true, total: true } },
        // Back-relation: when THIS Voucher is the
        // original of a Korrekturbeleg, this list
        // contains the Storno vouchers pointing
        // back at it. Empty on a Voucher that
        // hasn't been corrected.
        reversals: {
          select: {
            id: true,
            voucherNumber: true,
            date: true,
          },
        },
      },
    });
    if (!voucher) {
      throw new NotFoundException('Buchungsbeleg nicht gefunden');
    }
    return voucher;
  }

  /**
   * Backwards-compat shim for the legacy
   * PUT /api/v1/accounting/vouchers/:id/status?status=voided
   * route. The old behavior was to mutate status
   * directly — that violates GoBD §146 AO. The new
   * behavior is to create a Storno-Buchung (Korrekturbeleg)
   * via createReversal, and return it. The original
   * Voucher stays in the journal with status='posted'
   * so the audit trail is preserved.
   *
   * Why a wrapper, not a deprecated method:
   *   the existing frontend flow uses this endpoint.
   *   Routing the call through createReversal keeps
   *   the GoBD guarantee in one place — every Storno
   *   goes through the same code path.
   */
  async void(id: string, companyId: string, reason?: string) {
    return this.createReversal(id, companyId, reason);
  }

  async generateFromInvoice(invoiceId: string, companyId: string) {
    // Check if voucher already exists for this invoice
    const existingVoucher = await this.prisma.voucher.findFirst({
      where: { companyId, invoiceRef: { id: invoiceId } },
    });
    if (existingVoucher) {
      return existingVoucher;
    }

    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, companyId },
      include: {
        items: true,
        customer: true,
      },
    });
    if (!invoice) {
      throw new NotFoundException('Rechnung nicht gefunden');
    }

    const lines: CreateVoucherDto['lines'] = [];
    const total = parseFloat(invoice.total.toString());
    const totalVat = parseFloat(invoice.totalVat.toString());
    const subtotal = total - totalVat;

    if (invoice.reverseCharge || invoice.euTransaction) {
      // EU cross-border: no VAT entry (reverse charge)
      // Debit: Receivables
      const receivablesAccount = await this.accountService.getOrCreateAccount(
        companyId, '1400', 'Forderungen aus Lieferungen und Leistungen', 'asset'
      );
      lines.push({
        accountId: receivablesAccount.id,
        description: `Forderungen aus Rechnung ${invoice.invoiceNumber}`,
        debit: total,
      });

      // Credit: Sales Revenue
      const salesAccount = await this.accountService.getOrCreateAccount(
        companyId, '4200', 'Umsatzerlöse 19%', 'revenue'
      );
      lines.push({
        accountId: salesAccount.id,
        description: `Umsatzerlöse Rechnung ${invoice.invoiceNumber}`,
        credit: total,
      });
    } else {
      // Domestic: with VAT
      // Debit: Receivables (total including VAT)
      const receivablesAccount = await this.accountService.getOrCreateAccount(
        companyId, '1400', 'Forderungen aus Lieferungen und Leistungen', 'asset'
      );
      lines.push({
        accountId: receivablesAccount.id,
        description: `Forderungen aus Rechnung ${invoice.invoiceNumber}`,
        debit: total,
      });

      // Credit: Sales Revenue (net amount)
      const salesAccount = await this.accountService.getOrCreateAccount(
        companyId, '4200', 'Umsatzerlöse 19%', 'revenue'
      );
      lines.push({
        accountId: salesAccount.id,
        description: `Umsatzerlöse Rechnung ${invoice.invoiceNumber}`,
        credit: subtotal,
      });

      // Credit: VAT Liability
      const vatAccount = await this.accountService.getOrCreateAccount(
        companyId, '2200', 'Umsatzsteuer', 'liability'
      );
      lines.push({
        accountId: vatAccount.id,
        description: `Umsatzsteuer Rechnung ${invoice.invoiceNumber}`,
        credit: totalVat,
      });
    }

    return this.prisma.voucher.create({
      data: {
        companyId,
        voucherNumber: await this.generateVoucherNumber(companyId, invoice.issueDate),
        date: invoice.issueDate,
        description: `Verkauf Rechnung ${invoice.invoiceNumber}`,
        referenceType: 'invoice',
        status: 'posted',
        invoiceRef: { connect: { id: invoiceId } },
        lines: {
          create: lines.map((line, idx) => ({
            accountId: line.accountId,
            description: line.description,
            debit: line.debit || 0,
            credit: line.credit || 0,
            sortOrder: idx,
          })),
        },
      },
      include: {
        lines: {
          include: { account: true },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });
  }

  private async generateVoucherNumber(companyId: string, date: Date): Promise<string> {
    const year = date.getFullYear();
    const prefix = `BK-${year}-`;

    // Find highest sequence for this year
    const lastVoucher = await this.prisma.voucher.findFirst({
      where: {
        companyId,
        voucherNumber: { startsWith: prefix },
      },
      orderBy: { voucherNumber: 'desc' },
    });

    let nextNum = 1;
    if (lastVoucher) {
       const lastNum = parseInt(lastVoucher.voucherNumber.replace(prefix, ''), 10);
      nextNum = lastNum + 1;
    }

    return `${prefix}${nextNum.toString().padStart(4, '0')}`;
  }

  // ─────────────────────────────────────────────────────
  // TIER 41: cost-center suggestion
  // ─────────────────────────────────────────────────────
  //
  // The Berater typically books the same Sachkonto many
  // times a month — and uses the same Kostenstelle for
  // most of those bookings (e.g. Sachkonto 4970 "Bank
  // fees" almost always lands on Kostenstelle "100" in
  // a single-tenant company). Tier 41 ships:
  //
  //   - suggestCostCenter(companyId, accountId) →
  //       { costCenter, costObject, totalLines }
  //       returns the top-1 most-used cost-center stamp
  //       across the company's VoucherLines on this
  //       Sachkonto. Used by the Voucher form as a
  //       one-click "use last time" auto-fill.
  //
  //   - listCostCenters(companyId, accountId) →
  //       array of distinct { costCenter, costObject, count }
  //       sorted by count desc. Used by the Voucher form
  //       as a dropdown ("you've used these N times on
  //       this account").
  //
  // Both are read-only — they don't write any audit row.
  // The user's final choice lands on the VoucherLine via
  // the regular create() path.

  /**
   * Return the top-1 most-used cost-center pair on this
   * account for the given company. If multiple
   * cost-centers are tied, the most-recent one wins.
   */
  async suggestCostCenter(
    companyId: string,
    accountId: string,
    prefix?: string,
    costObjectPrefix?: string,
  ) {
    // Tier 49: optional `prefix` narrows the candidate
    // pool to (costCenter startsWith prefix,
    // costObject startsWith costObjectPrefix). Both
    // are case-insensitive. Empty string means "no
    // filter" (matches all rows). We use Prisma's
    // `contains` with mode:'insensitive' rather than
    // `startsWith` to dodge the case-sensitivity
    // mode interaction (Prisma docs note that
    // startsWith with mode is supported on Postgres
    // but contains is more reliably cross-version).
    const where: any = {
      accountId,
      voucher: { companyId },
      costCenter: { not: null },
    }
    if (prefix && prefix.trim()) {
      where.costCenter = {
        not: null,
        contains: prefix.trim(),
        mode: 'insensitive',
      }
    }
    if (costObjectPrefix && costObjectPrefix.trim()) {
      where.costObject = {
        contains: costObjectPrefix.trim(),
        mode: 'insensitive',
      }
    }
    const rows = await this.prisma.voucherLine.findMany({
      where,
      select: {
        costCenter: true,
        costObject: true,
        voucher: { select: { date: true } },
      },
      orderBy: { voucher: { date: 'desc' } },
      take: 100, // last 100 stamps; groupBy counts frequency
    })
    const counts = new Map<
      string,
      { costCenter: string; costObject: string | null; count: number; lastDate: Date }
    >()
    for (const r of rows) {
      const cc = (r.costCenter || '').trim()
      if (!cc) continue
      const ko = (r.costObject || '').trim() || null
      const key = `${cc}|${ko || ''}`
      const cur = counts.get(key) || {
        costCenter: cc,
        costObject: ko,
        count: 0,
        lastDate: r.voucher.date,
      }
      cur.count += 1
      if (r.voucher.date > cur.lastDate) cur.lastDate = r.voucher.date
      counts.set(key, cur)
    }
    if (counts.size === 0) {
      return {
        costCenter: null,
        costObject: null,
        totalLines: 0,
        sampledLines: rows.length,
      }
    }
    const sorted = Array.from(counts.values()).sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count
      return b.lastDate.getTime() - a.lastDate.getTime()
    })
    const top = sorted[0]
    return {
      costCenter: top.costCenter,
      costObject: top.costObject,
      // totalLines = how many VoucherLines on this account
      // have ANY stamp (incl. ones we didn't surface).
      totalLines: rows.length,
      // sampledLines = how many of those carry a stamp
      // (the rest have null costCenter).
      sampledLines: rows.length,
    }
  }

  /**
   * List the distinct (costCenter, costObject) pairs the
   * company has ever stamped on this Sachkonto, ranked
   * by usage desc. The Berater form renders this as a
   * dropdown so the user sees "you used VERTRIEB-100
   * 28 times, SERVICE-200 4 times" — at a glance.
   */
  async listCostCenters(
    companyId: string,
    accountId: string,
    prefix?: string,
    costObjectPrefix?: string,
    take: number = 20,
  ) {
    // Tier 49: optional `prefix` narrows the candidate
    // pool to (costCenter startsWith prefix,
    // costObject startsWith costObjectPrefix). Both
    // are case-insensitive. Empty string means "no
    // filter" (matches all rows). Same pattern as
    // suggestCostCenter above.
    const where: any = {
      accountId,
      voucher: { companyId },
      costCenter: { not: null },
    }
    if (prefix && prefix.trim()) {
      where.costCenter = {
        not: null,
        contains: prefix.trim(),
        mode: 'insensitive',
      }
    }
    if (costObjectPrefix && costObjectPrefix.trim()) {
      where.costObject = {
        contains: costObjectPrefix.trim(),
        mode: 'insensitive',
      }
    }
    // Same defensive filter as above (companyId via
    // Voucher relation, NULL stamps excluded).
    const rows = await this.prisma.voucherLine.findMany({
      where,
      select: {
        costCenter: true,
        costObject: true,
        voucher: { select: { date: true } },
      },
      orderBy: { voucher: { date: 'desc' } },
    })
    const counts = new Map<
      string,
      { costCenter: string; costObject: string | null; count: number; lastUsedAt: Date }
    >()
    for (const r of rows) {
      const cc = (r.costCenter || '').trim()
      if (!cc) continue
      const ko = (r.costObject || '').trim() || null
      const key = `${cc}|${ko || ''}`
      const cur = counts.get(key) || {
        costCenter: cc,
        costObject: ko,
        count: 0,
        lastUsedAt: r.voucher.date,
      }
      cur.count += 1
      if (r.voucher.date > cur.lastUsedAt) cur.lastUsedAt = r.voucher.date
      counts.set(key, cur)
    }
    return Array.from(counts.values())
      .sort((a, b) => b.count - a.count || b.lastUsedAt.getTime() - a.lastUsedAt.getTime())
      .slice(0, take)
  }
}