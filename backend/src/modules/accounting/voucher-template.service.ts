/**
 * VoucherTemplate — per-company saved "Buchungssatz
 * presets" that the Berater can one-click into the
 * manual Voucher modal.
 *
 * Example: a Berater creates a "Bankgebühren" template
 * with two lines: 1200 Bank debit, 4970 Bankgebühren
 * credit. Next time they need to book a bank fee, they
 * pick the template in the modal — the lines are
 * pre-filled (account IDs resolved, amounts blank) and
 * they only need to type the amount and the date.
 *
 * The amount is intentionally NOT stored on the
 * template, otherwise re-applying the template would
 * always create the same posting (wrong — bank fees
 * vary by month). The account numbers ARE stored, so
 * a template survives a chart-of-accounts renumbering
 * (we resolve accountNumber → accountId at apply time).
 */

import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface TemplateLineInput {
  accountNumber: string
  // "debit" or "credit" — the side this line goes on
  // in the template. The user flips the sides as
  // needed when applying (a debit template is just a
  // convention).
  side: 'debit' | 'credit'
  // VAT rate as a decimal (0.19 for 19%, 0.07 for 7%).
  // When the Berater applies the template with a
  // non-zero VAT, the apply endpoint will produce
  // a 3-line Voucher (Aufwand + Vorsteuer + Bank) —
  // the template's lines cover the first and last;
  // the Vorsteuer line is added by the apply logic.
  vatRate?: number
}

export interface ApplyResult {
  lines: {
    accountId: string
    accountNumber: string
    debit: number
    credit: number
    description: string
  }[]
  description: string
  // Pattern placeholders that the user must still
  // fill in, e.g. {counterparty}. Empty when the
  // pattern is fully resolved.
  unfilledPlaceholders: string[]
}

@Injectable()
export class VoucherTemplateService {
  constructor(private prisma: PrismaService) {}

  async findAll(companyId: string) {
    return this.prisma.voucherTemplate.findMany({
      where: { companyId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async findOne(id: string, companyId: string) {
    const t = await this.prisma.voucherTemplate.findFirst({
      where: { id, companyId },
    });
    if (!t) throw new NotFoundException('Vorlage nicht gefunden');
    return t;
  }

  async create(companyId: string, data: any) {
    if (!data.name) throw new BadRequestException('Name ist erforderlich');
    if (!data.linesJson) throw new BadRequestException('linesJson ist erforderlich');
    // Validate that the linesJson parses — we don't
    // validate the accountNumbers yet (the Berater
    // might be creating a template that references
    // accounts the company hasn't seeded). At apply
    // time we resolve what we can and surface a
    // helpful error for the rest.
    let lines: TemplateLineInput[];
    try {
      lines = JSON.parse(data.linesJson);
    } catch {
      throw new BadRequestException('linesJson ist kein gültiges JSON');
    }
    if (!Array.isArray(lines) || lines.length < 2) {
      throw new BadRequestException('Vorlage muss mindestens 2 Positionen haben');
    }
    // Each line must have a side; debit+credit of 0
    // at template time is fine (amounts are filled
    // at apply).
    for (const l of lines) {
      if (!l.accountNumber) {
        throw new BadRequestException('Jede Position braucht eine Kontonummer');
      }
      if (l.side !== 'debit' && l.side !== 'credit') {
        throw new BadRequestException('Position-Side muss "debit" oder "credit" sein');
      }
    }
    return this.prisma.voucherTemplate.create({
      data: {
        companyId,
        name: data.name,
        description: data.description || null,
        linesJson: JSON.stringify(lines),
        descriptionPattern: data.descriptionPattern || null,
        sortOrder: data.sortOrder ?? 0,
      },
    });
  }

  async update(id: string, companyId: string, data: any) {
    await this.findOne(id, companyId);
    // Same validation as create
    if (data.linesJson !== undefined) {
      try {
        const parsed = JSON.parse(data.linesJson);
        if (!Array.isArray(parsed) || parsed.length < 2) {
          throw new BadRequestException('Vorlage muss mindestens 2 Positionen haben');
        }
      } catch {
        throw new BadRequestException('linesJson ist kein gültiges JSON');
      }
    }
    return this.prisma.voucherTemplate.update({
      where: { id },
      data: {
        name: data.name,
        description: data.description,
        linesJson: data.linesJson,
        descriptionPattern: data.descriptionPattern,
        sortOrder: data.sortOrder,
      },
    });
  }

  async remove(id: string, companyId: string) {
    await this.findOne(id, companyId);
    return this.prisma.voucherTemplate.delete({ where: { id } });
  }

  /**
   * Resolve a template into a set of modal-ready lines
   * for a SPECIFIC amount and date. The amount is
   * applied to the side marked "debit" (with the
   * counter-side auto-balancing); if the template has
   * multiple debit/credit lines, the amount is split
   * proportionally by line count (rare in practice —
   * templates usually have one of each).
   *
   * For templates with a non-zero VAT rate on the
   * debit side, a third "Vorsteuer" line is added
   * with the appropriate Vorsteuer account (1576 for
   * 19% / 1577 for 7%) and the Bank line's credit
   * is the gross amount (net + VAT). The whole thing
   * is balanced automatically.
   *
   * Description placeholders ({month}, {year},
   * {counterparty}) are substituted at apply time.
   * Unresolved placeholders are returned in
   * `unfilledPlaceholders` so the modal can prompt
   * the user to fill them.
   */
  async applyTemplate(
    templateId: string,
    companyId: string,
    applyData: {
      amount: number
      date: string
      counterparty?: string
      description?: string
    },
  ): Promise<ApplyResult> {
    const template = await this.findOne(templateId, companyId);
    if (!applyData.amount || applyData.amount <= 0) {
      throw new BadRequestException('Betrag muss > 0 sein');
    }
    const lines: TemplateLineInput[] = JSON.parse(template.linesJson);
    const amount = applyData.amount;
    // Fetch the company accounts so we can resolve
    // accountNumber → accountId.
    const accounts = await this.prisma.account.findMany({
      where: { companyId },
      select: { id: true, accountNumber: true, name: true },
    });
    const byNumber: Record<string, typeof accounts[number]> = {};
    for (const a of accounts) byNumber[a.accountNumber] = a;
    // First, build the basic 2-line booking (one debit
    // side, one credit side). If multiple lines per
    // side, the amount is split evenly.
    const debitLines = lines.filter((l) => l.side === 'debit');
    const creditLines = lines.filter((l) => l.side === 'credit');
    if (debitLines.length === 0 || creditLines.length === 0) {
      throw new BadRequestException(
        'Vorlage braucht mindestens eine Soll- und eine Haben-Position',
      );
    }
    const result: ApplyResult['lines'] = [];
    // Detect if any debit line has a VAT rate — that
    // signals a 3-line Vorsteuer booking.
    const debitWithVat = debitLines.find((l) => l.vatRate && l.vatRate > 0);
    if (debitWithVat) {
      // net = amount / (1 + vatRate)
      const vatRate = debitWithVat.vatRate!;
      const net = amount / (1 + vatRate);
      const vat = amount - net;
      // Find the right Vorsteuer account for the
      // rate. SKR03: 1576 (19%), 1577 (7%).
      const vorsteuerNumber = Math.abs(vatRate - 0.19) < 0.001
        ? '1576'
        : Math.abs(vatRate - 0.07) < 0.001
        ? '1577'
        : '1576'; // fallback
      const vorsteuerAcct = byNumber[vorsteuerNumber];
      if (!vorsteuerAcct) {
        throw new BadRequestException(
          `Vorsteuer-Konto ${vorsteuerNumber} nicht im Kontenplan — bitte zuerst anlegen`,
        );
      }
      // Each debit line gets its share of the NET
      // amount (proportional to count if multiple).
      const perDebitShare = net / debitLines.length;
      for (const dl of debitLines) {
        const acct = byNumber[dl.accountNumber];
        if (!acct) {
          throw new BadRequestException(
            `Konto ${dl.accountNumber} aus Vorlage nicht im Kontenplan`,
          );
        }
        result.push({
          accountId: acct.id,
          accountNumber: acct.accountNumber,
          debit: perDebitShare,
          credit: 0,
          description: '',
        });
      }
      // Single Vorsteuer line
      result.push({
        accountId: vorsteuerAcct.id,
        accountNumber: vorsteuerAcct.accountNumber,
        debit: vat,
        credit: 0,
        description: `Vorsteuer ${(vatRate * 100).toFixed(0)}%`,
      });
      // Credit side (typically one Bank line) gets
      // the GROSS amount (= user-entered amount).
      const perCreditShare = amount / creditLines.length;
      for (const cl of creditLines) {
        const acct = byNumber[cl.accountNumber];
        if (!acct) {
          throw new BadRequestException(
            `Konto ${cl.accountNumber} aus Vorlage nicht im Kontenplan`,
          );
        }
        result.push({
          accountId: acct.id,
          accountNumber: acct.accountNumber,
          debit: 0,
          credit: perCreditShare,
          description: '',
        });
      }
    } else {
      // Simple 2+ line booking without VAT. The
      // user's amount goes to the credit side (the
      // "Bank" side of a typical expense); the debit
      // side carries the same total.
      const perDebitShare = amount / debitLines.length;
      for (const dl of debitLines) {
        const acct = byNumber[dl.accountNumber];
        if (!acct) {
          throw new BadRequestException(
            `Konto ${dl.accountNumber} aus Vorlage nicht im Kontenplan`,
          );
        }
        result.push({
          accountId: acct.id,
          accountNumber: acct.accountNumber,
          debit: perDebitShare,
          credit: 0,
          description: '',
        });
      }
      const perCreditShare = amount / creditLines.length;
      for (const cl of creditLines) {
        const acct = byNumber[cl.accountNumber];
        if (!acct) {
          throw new BadRequestException(
            `Konto ${cl.accountNumber} aus Vorlage nicht im Kontenplan`,
          );
        }
        result.push({
          accountId: acct.id,
          accountNumber: acct.accountNumber,
          debit: 0,
          credit: perCreditShare,
          description: '',
        });
      }
    }
    // Substitute description placeholders. Supported:
    //   {month}        → "06" (zero-padded)
    //   {year}         → "2026"
    //   {counterparty} → applyData.counterparty or "" (placeholder stays unfilled if not supplied)
    let description = applyData.description ?? template.descriptionPattern ?? template.name;
    const unfilledPlaceholders: string[] = [];
    const month = (applyData.date || new Date().toISOString()).slice(5, 7);
    const year = (applyData.date || new Date().toISOString()).slice(0, 4);
    // Track unfilled placeholders BEFORE substitution
    // — once we substitute, the {name} is gone from
    // the string. Scan for any known placeholder
    // names that the user didn't supply.
    const knownPlaceholders: Array<{ name: string; value: string }> = [
      { name: 'month', value: month },
      { name: 'year', value: year },
      {
        name: 'counterparty',
        value: applyData.counterparty || '',
      },
    ];
    for (const p of knownPlaceholders) {
      if (
        description.includes(`{${p.name}}`) &&
        !p.value
      ) {
        unfilledPlaceholders.push(p.name);
      }
    }
    description = description
      .replace(/\{month\}/g, month)
      .replace(/\{year\}/g, year)
      .replace(/\{counterparty\}/g, applyData.counterparty || '');
    return { lines: result, description, unfilledPlaceholders };
  }
}
