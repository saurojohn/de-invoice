import { bewirtungNachweisFehlt } from '../accounting/expense-cost';
import { assertPeriodOpen, filedPeriodOf, filedPeriodMessage } from '../reports/filed-period';
import { signedExpenseAmounts } from './credit-note';
import { assertNoDuplicateExpense, duplicateExpenseMessage, findDuplicateExpense, withExpenseNumberLock } from './expense-duplicate'
import { expenseLockReasons } from './expense-lock';
/**
 * Expense (Eingangsrechnung) — vendor bills received.
 *
 * In the bank-import flow, the user can attribute a
 * debit transaction to a supplier by linking an
 * Expense row. The Expense carries the supplier,
 * invoice number, invoice date, net/VAT/gross
 * amounts, and VAT rate — exactly what the
 * DATEV UStVA / Vorsteuer reporting needs.
 *
 * For the bank-import flow, an Expense is created
 * "open" (status = 'booked' meaning the user has
 * entered it, awaiting payment), then bookExpense
 * marks it fully 'booked' once the bank txn lands
 * and the GoBD voucher is written.
 */

import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { assertNotFuture } from '../../common/business-date';
import { assertExpenseAmounts, expenseAmountsError } from './amounts';
import { checkTaxLines } from './tax-lines';
import { notAnExpense } from '../accounting/expense-cost';

@Injectable()
export class ExpenseService {
  constructor(private prisma: PrismaService) {}

  async findAll(companyId: string, opts: { supplierId?: string; status?: string; search?: string } = {}) {
    const where: any = { companyId };
    if (opts.supplierId) where.supplierId = opts.supplierId;
    if (opts.status) where.status = opts.status;
    if (opts.search) {
      where.OR = [
        { invoiceNumber: { contains: opts.search, mode: 'insensitive' } },
        { description: { contains: opts.search, mode: 'insensitive' } },
      ];
    }
    const items = await this.prisma.expense.findMany({
      where,
      include: {
        supplier: { select: { id: true, name: true, vatId: true } },
        // Tier 581: the VAT lines of an expense with several rates
        taxLines: { select: { vatRate: true, netAmount: true, vatAmount: true, position: true }, orderBy: { position: 'asc' } },
      },
      orderBy: { invoiceDate: 'desc' },
      take: 500,
    });
    if (items.length === 0) return { data: [], total: 0 };
    // Tier 447: the payment state comes from the expense itself (paidAt —
    // bank, SEPA, cash book), not from bank vouchers alone. The voucher search
    // said "offen" for an expense paid by SEPA or in cash, and "bezahlt" for
    // one whose bank booking had been reversed: the Storno's description
    // carries no "[expense:<id>]" tag, so "storniert" never matched.
    // linkedVoucher is the bank-import booking tagged with the expense id
    // (bank-import.service.ts bookExpense) — the one that pays it, else the
    // latest reversed one.
    const expenseIds = items.map((e) => e.id);
    const vouchers = await this.prisma.voucher.findMany({
      where: {
        companyId,
        referenceType: 'Expense',
        OR: expenseIds.map((id) => ({ description: { contains: `[expense:${id}]` } })),
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        voucherNumber: true,
        referenceType: true,
        description: true,
        _count: { select: { reversals: true } },
      },
    });
    const locks = await expenseLockReasons(this.prisma, companyId, items);
    return {
      // Tier 178: wrap the array in {data, total} so
      // the list page can paginate and show a count,
      // matching the shape of /invoices, /customers,
      // /products. Phase 3 Berater-Walkthrough flagged
      // this as a consistency gap.
      data: items.map((e) => {
        const own = vouchers.filter((v) => (v.description || '').includes(`[expense:${e.id}]`));
        const active = own.find((v) => v._count.reversals === 0);
        const reversed = own.find((v) => v._count.reversals > 0);
        const v = active ?? reversed;
        return {
          ...e,
          // An unreversed bank booking pays it too: bookings before Tier 425
          // set no paidAt (expense-lock.ts treats them alike).
          paymentState: e.paidAt || active ? 'bezahlt' : reversed ? 'storniert' : 'offen',
          linkedVoucher: v
            ? { id: v.id, voucherNumber: v.voucherNumber, referenceType: v.referenceType }
            : null,
          lockReason: locks.get(e.id) ?? null,
          bewirtungNachweisFehlt: bewirtungNachweisFehlt(e), // Tier 539
        };
      }),
      // Tier 178: total = total rows the list page
      // would see if it asked for all pages. With
      // take: 500 hard-coded above, we lose the
      // ability to do a real COUNT — but for the
      // typical case (< 500 expenses per year) total
      // equals items.length. For larger data sets
      // a future tier should drop the `take: 500`
      // and add a separate prisma.expense.count.
      total: items.length,
    };
  }

  async findOne(id: string, companyId: string) {
    const exp = await this.prisma.expense.findFirst({
      where: { id, companyId },
      include: {
        supplier: true,
        taxLines: { select: { vatRate: true, netAmount: true, vatAmount: true, position: true }, orderBy: { position: 'asc' } },
      },
    });
    if (!exp) throw new NotFoundException('Eingangsrechnung nicht gefunden');
    return exp;
  }

  async create(companyId: string, data: any) {
    // Tier 573: check-for-duplicate and insert as one step (expense-duplicate.ts)
    return withExpenseNumberLock(companyId, data?.supplierId, data?.invoiceNumber, () => this.createChecked(companyId, data));
  }

  private async createChecked(companyId: string, data: any) {
    if (!data.description) throw new BadRequestException('Beschreibung ist erforderlich');
    if (!data.invoiceDate) throw new BadRequestException('Rechnungsdatum ist erforderlich');
    // Tier 677 / 682: a loan's repayment and a tax on income are no expenses (expense-cost.ts)
    const none = notAnExpense(data.category);
    if (none) throw new BadRequestException(none);
    assertNotFuture(data.invoiceDate, 'Das Rechnungsdatum') // Tier 515
    assertNotFuture(data.paidAt, 'Das Zahldatum')
    if (data.supplierId) {
      const sup = await this.prisma.supplier.findFirst({ where: { id: data.supplierId, companyId } });
      if (!sup) throw new BadRequestException('Lieferant nicht gefunden');
    }
    // Tier 489: the same supplier invoice twice is refused (409)
    await assertNoDuplicateExpense(this.prisma, companyId, data.supplierId, data.invoiceNumber, !!data.creditNote, data.confirmDuplicate === true)
    // Tier 581: several VAT rates on one invoice — the amounts are the lines' sums.
    let taxRows: ReturnType<typeof checkTaxLines>['rows'] = [];
    let net: number, vat: number, gross: number;
    let rate = Number(data.vatRate ?? 0);
    if (data.taxLines !== undefined && data.taxLines !== null) {
      if (data.isIntraEU || data.isReverseCharge) {
        throw new BadRequestException('Steuerzeilen gibt es nicht bei § 13b / innergemeinschaftlichem Erwerb — dort weist die Rechnung keine Steuer aus.');
      }
      const checked = checkTaxLines(data.taxLines, !!data.creditNote, { net: data.netAmount, vat: data.vatAmount, gross: data.grossAmount });
      ({ net, vat, gross, rate } = checked);
      taxRows = checked.rows;
    } else {
      // Tier 442: a supplier credit note is stored with negative amounts.
      ({ net, vat, gross } = signedExpenseAmounts(data.creditNote, {
        net: Number(data.netAmount ?? 0),
        vat: Number(data.vatAmount ?? 0),
        gross: Number(data.grossAmount ?? Number(data.netAmount ?? 0) + Number(data.vatAmount ?? 0)),
      }));
      assertExpenseAmounts({ net, vat, gross, rate }); // Tier 523
    }
    await assertPeriodOpen(this.prisma, companyId, [data.invoiceDate], 'das Erfassen einer Eingangsrechnung'); // Tier 537
    return this.prisma.expense.create({
      data: {
        companyId,
        supplierId: data.supplierId || null,
        invoiceNumber: data.invoiceNumber || null,
        description: data.description,
        invoiceDate: new Date(data.invoiceDate),
        netAmount: net.toFixed(4),
        vatRate: rate,
        vatAmount: vat.toFixed(4),
        grossAmount: gross.toFixed(4),
        ...(taxRows.length ? { taxLines: { create: taxRows.map((l) => ({ ...l, companyId })) } } : {}),
        category: data.category || null,
        giftRecipient: data.giftRecipient?.trim() || null, // Tier 503
        bewirtungAnlass: data.bewirtungAnlass?.trim() || null, // Tier 539
        bewirtungTeilnehmer: data.bewirtungTeilnehmer?.trim() || null,
        // Tier 179: persist the SKR03 Sachkonto the
        // caller passed. Trim + max 20 chars to match
        // the AccountNumber convention used elsewhere
        // (the DTO would do this in a strict refactor;
        // for Tier 179 we sanitise inline).
        accountNumber:
          typeof data.accountNumber === 'string' && data.accountNumber.trim()
            ? data.accountNumber.trim().slice(0, 20)
            : null,
        isIntraEU: !!data.isIntraEU,
        isReverseCharge: !!data.isReverseCharge,
        status: data.status || 'booked',
        notes: data.notes || null,
        // Tier 454: paid by card / privately (CreateExpenseDto.paidAt).
        paidAt: data.paidAt ? new Date(data.paidAt) : null,
      },
      include: { taxLines: { select: { vatRate: true, netAmount: true, vatAmount: true, position: true }, orderBy: { position: 'asc' } } },
    });
  }

  /**
   * Bulk-import expenses (Eingangsrechnungen) from a
   * CSV-like row array.
   *
   * The supplier is resolved by name (case-insensitive
   * trim) so the user can type "Müller GmbH" in the
   * CSV and have it match the existing supplier row.
   * If no supplier matches and the row has a name,
   * we auto-create one (lightweight: name + vatId if
   * provided) — that's what the user expects from
   * a "drop in 50 invoices I haven't entered yet"
   * workflow.
   *
   * If neither name nor supplierId is supplied, the
   * row is rejected (we can't store an anonymous
   * expense in GoBD).
   *
   * Date parsing: the importer accepts ISO (YYYY-MM-DD)
   * and the common German format DD.MM.YYYY. Anything
   * else → row error.
   *
   * Amounts: netAmount is required, vatAmount and
   * grossAmount are derived (vatRate × net) when
   * missing. vatRate defaults to 0.19.
   */
  async importBulk(
    companyId: string,
    rows: ImportExpenseRow[],
  ): Promise<ImportExpenseResult> {
    const result: ImportExpenseResult = {
      total: rows.length,
      imported: 0,
      skipped: 0,
      errors: [],
      merged: [],
    }
    // Tier 739: every row is checked first, then the rows of one invoice are
    // booked together (see the grouping below the loop).
    const prepared: PreparedImportRow[] = []
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] || {}
      const rowNum = i + 2
      try {
        const description = (row.description || '').trim()
        if (!description) {
          result.errors.push({ row: rowNum, error: 'Beschreibung fehlt' })
          continue
        }
        const invoiceDate = this.parseDate(row.invoiceDate)
        if (!invoiceDate) {
          result.errors.push({
            row: rowNum,
            error: `Ungültiges Rechnungsdatum: ${row.invoiceDate || '(leer)'}`,
            description,
          })
          continue
        }

        // Resolve supplier — by ID first (explicit),
        // then by name (auto-create if needed).
        let supplierId: string | null = null
        const explicitId = (row.supplierId || '').trim()
        if (explicitId) {
          const sup = await this.prisma.supplier.findFirst({
            where: { id: explicitId, companyId },
          })
          if (!sup) {
            result.errors.push({
              row: rowNum,
              error: `Lieferant-ID nicht gefunden: ${explicitId}`,
              description,
            })
            continue
          }
          supplierId = sup.id
        } else {
          const name = (row.supplierName || '').trim()
          if (name) {
            const existing = await this.prisma.supplier.findFirst({
              where: { companyId, name: { equals: name, mode: 'insensitive' } },
            })
            if (existing) {
              supplierId = existing.id
            } else {
              // Auto-create supplier — common case for
              // first-time bulk imports where the user
              // hasn't entered suppliers yet.
              // `address` is required (NOT NULL in the
              // DB) — default to an empty object so the
              // INSERT doesn't blow up. The user can
              // edit it later from the Suppliers page.
              const created = await this.prisma.supplier.create({
                data: {
                  companyId,
                  name,
                  vatId: (row.supplierVatId || '').trim() || null,
                  address: {},
                },
              })
              supplierId = created.id
            }
          } else {
            result.errors.push({
              row: rowNum,
              error: 'Lieferant fehlt (Name oder ID erforderlich)',
              description,
            })
            continue
          }
        }

        const netAmount = parseFloat(
          String(row.netAmount ?? '').trim().replace(',', '.'),
        )
        // Tier 442: a negative row is a supplier credit note — all its amounts
        // are negative (expense/credit-note.ts). It used to be refused.
        if (Number.isNaN(netAmount)) {
          result.errors.push({
            row: rowNum,
            error: `Ungültiger Nettobetrag: ${row.netAmount || '(leer)'}`,
            description,
          })
          continue
        }
        const vatRate = parseFloat(
          String(row.vatRate ?? '0.19').trim().replace(',', '.'),
        ) || 0
        // vatAmount: prefer explicit, otherwise compute
        // from rate × net (rounded to 4 decimals to match
        // Prisma @db.Decimal(12,4)).
        const vatAmountRaw =
          row.vatAmount !== undefined && row.vatAmount !== ''
            ? parseFloat(String(row.vatAmount).trim().replace(',', '.'))
            : Math.round(netAmount * vatRate * 10000) / 10000
        // Tier 442: a credit note's VAT is negative too, whichever sign the
        // row gave it — before the gross is derived from net + VAT.
        const vatAmount = signedExpenseAmounts(netAmount < 0, {
          net: netAmount, vat: Number.isNaN(vatAmountRaw) ? 0 : vatAmountRaw, gross: 0,
        }).vat
        const grossAmount = signedExpenseAmounts(netAmount < 0, {
          net: netAmount,
          vat: vatAmount,
          gross:
            row.grossAmount !== undefined && row.grossAmount !== ''
              ? parseFloat(String(row.grossAmount).trim().replace(',', '.'))
              : Math.round((netAmount + vatAmount) * 10000) / 10000,
        }).gross

        // Tier 537: a row dated into a submitted UStVA period — reported.
        const filed = await filedPeriodOf(this.prisma, companyId, invoiceDate)
        if (filed) {
          result.errors.push({ row: rowNum, error: filedPeriodMessage(filed, 'das Erfassen einer Eingangsrechnung'), description })
          continue
        }
        // Tier 677 / 682: a loan's repayment, a tax on income — reported, not imported.
        const none = notAnExpense(row.category)
        if (none) {
          result.errors.push({ row: rowNum, error: none, description })
          continue
        }
        // Tier 523: amounts that do not belong together — reported, not imported.
        const amountsError = expenseAmountsError({ net: netAmount, vat: vatAmount, gross: grossAmount, rate: Number(vatRate) })
        if (amountsError) {
          result.errors.push({ row: rowNum, error: amountsError, description })
          continue
        }
        prepared.push({
          rowNum,
          description,
          invoiceDate,
          invoiceNumber: (row.invoiceNumber || '').trim() || null,
          supplierId: supplierId!,
          net: netAmount,
          rate: vatRate,
          vat: vatAmount,
          gross: grossAmount,
          category: (row.category || '').trim() || null,
          status: (row.status || 'booked').trim(),
          notes: (row.notes || '').trim() || null,
        })
      } catch (e: any) {
        result.errors.push({
          row: rowNum,
          error: e?.message || 'Unbekannter Fehler',
          description: (row.description || '').trim(),
        })
      }
    }

    // Tier 739: rows of the same supplier, number and date are one invoice —
    // the way sevDesk, lexoffice and DATEV export an invoice with 19 % and 7 %:
    // a row per rate. They become one expense with a VAT line per rate
    // (tax-lines.ts). Until now the second row was refused as a duplicate of
    // the first, and only the first rate was booked. A row without a number
    // cannot be told apart and stays an expense of its own.
    const groups: PreparedImportRow[][] = []
    const byKey = new Map<string, PreparedImportRow[]>()
    for (const p of prepared) {
      const key = p.invoiceNumber
        ? [p.supplierId, p.invoiceNumber.toLowerCase(), p.invoiceDate.toISOString().slice(0, 10), p.net < 0 ? 'credit' : 'invoice'].join('|')
        : null
      const g = key ? byKey.get(key) : undefined
      if (g) {
        // a row repeated word for word is a mistake of the file, not a second
        // line of the invoice — it would double the amount
        const twin = g.find((o) => o.description === p.description && o.net === p.net && o.rate === p.rate && o.vat === p.vat)
        if (twin) {
          result.errors.push({ row: p.rowNum, error: `Die Zeile wiederholt Zeile ${twin.rowNum} (dieselbe Rechnung ${p.invoiceNumber}, dieselben Beträge) und wurde nicht importiert.`, description: p.description })
          continue
        }
        g.push(p)
        continue
      }
      const fresh = [p]
      if (key) byKey.set(key, fresh)
      groups.push(fresh)
    }
    for (const g of groups) {
      try {
        if (g.length === 1) await this.importOne(companyId, g[0])
        else result.merged!.push(await this.importInvoiceRows(companyId, g))
        result.imported += g.length
      } catch (e: any) {
        for (const p of g) result.errors.push({ row: p.rowNum, error: e?.message || 'Unbekannter Fehler', description: p.description })
      }
    }
    return result
  }

  /** One row, one expense — as the import always did. */
  private async importOne(companyId: string, p: PreparedImportRow) {
    // Tier 489: a bill entered before (same supplier, same number) is
    // not imported again — the row is reported instead.
    const dup = await findDuplicateExpense(this.prisma, companyId, p.supplierId, p.invoiceNumber, p.net < 0)
    if (dup) throw new BadRequestException(duplicateExpenseMessage(dup))
    await this.prisma.expense.create({
      data: {
        companyId,
        supplierId: p.supplierId,
        invoiceNumber: p.invoiceNumber,
        description: p.description,
        invoiceDate: p.invoiceDate,
        netAmount: p.net.toFixed(4),
        vatRate: p.rate,
        vatAmount: p.vat.toFixed(4),
        grossAmount: p.gross.toFixed(4),
        category: p.category,
        status: p.status,
        notes: p.notes,
      },
    })
  }

  /**
   * Tier 739 — the rows of one invoice: one expense, a VAT line per rate
   * (rows of the same rate are added up), through create() so that every
   * rule of a hand-entered expense with lines holds.
   */
  private async importInvoiceRows(companyId: string, g: PreparedImportRow[]): Promise<NonNullable<ImportExpenseResult['merged']>[number]> {
    const first = g[0]
    const rowList = g.map((p) => p.rowNum).join(', ')
    const categories = [...new Set(g.map((p) => p.category).filter(Boolean))]
    if (categories.length > 1) {
      throw new BadRequestException(
        `Die Zeilen ${rowList} gehören zur Rechnung ${first.invoiceNumber}, haben aber verschiedene Kategorien (${categories.join(', ')}). ` +
          'Eine Ausgabe hat eine Kategorie — bitte eine Kategorie für alle Zeilen der Rechnung angeben.',
      )
    }
    const creditNote = first.net < 0
    const byRate = new Map<number, { rate: number; net: number; vat: number }>()
    for (const p of g) {
      const k = Math.round(p.rate * 10000)
      const l = byRate.get(k) ?? { rate: p.rate, net: 0, vat: 0 }
      l.net = Math.round((l.net + Math.abs(p.net)) * 10000) / 10000
      l.vat = Math.round((l.vat + Math.abs(p.vat)) * 10000) / 10000
      byRate.set(k, l)
    }
    const lines = [...byRate.values()].sort((a, b) => b.rate - a.rate)
    const description = [...new Set(g.map((p) => p.description))].join(' / ').slice(0, 500)
    const notes = [...new Set(g.map((p) => p.notes).filter(Boolean))].join('; ') || null
    const base = {
      supplierId: first.supplierId,
      invoiceNumber: first.invoiceNumber,
      invoiceDate: first.invoiceDate.toISOString().slice(0, 10),
      description,
      category: first.category ?? categories[0] ?? null,
      status: first.status,
      notes,
      creditNote,
    }
    if (lines.length === 1) {
      const l = lines[0]
      await this.create(companyId, { ...base, netAmount: l.net, vatRate: l.rate, vatAmount: l.vat, grossAmount: Math.round((l.net + l.vat) * 10000) / 10000 })
    } else {
      await this.create(companyId, { ...base, taxLines: lines.map((l) => ({ vatRate: l.rate, netAmount: l.net, vatAmount: l.vat })) })
    }
    return { rows: g.map((p) => p.rowNum), invoiceNumber: first.invoiceNumber!, rates: lines.map((l) => l.rate) }
  }

  /**
   * Parse a date string in either ISO (YYYY-MM-DD) or
   * German (DD.MM.YYYY) format. Returns null on failure
   * — the caller turns that into a row-level error.
   *
   * We don't pull in date-fns / dayjs for this — the
   * two formats cover ~99% of real-world CSVs and the
   * parser is 15 lines.
   */
  private parseDate(s: any): Date | null {
    if (!s) return null
    const str = String(s).trim()
    // ISO YYYY-MM-DD
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str)
    if (iso) {
      const d = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00.000Z`)
      return Number.isNaN(d.getTime()) ? null : d
    }
    // German DD.MM.YYYY
    const de = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(str)
    if (de) {
      const d = new Date(
        `${de[3]}-${de[2].padStart(2, '0')}-${de[1].padStart(2, '0')}T00:00:00.000Z`,
      )
      return Number.isNaN(d.getTime()) ? null : d
    }
    return null
  }
}

export interface ImportExpenseRow {
  description?: string
  invoiceDate?: string
  invoiceNumber?: string
  supplierId?: string
  supplierName?: string
  supplierVatId?: string
  netAmount?: string | number
  vatRate?: string | number
  vatAmount?: string | number
  grossAmount?: string | number
  category?: string
  status?: string
  notes?: string
}

export interface ImportExpenseResult {
  total: number
  imported: number
  skipped: number
  errors: Array<{ row: number; error: string; description?: string }>
  /** Tier 739: rows booked together as one invoice (one expense) */
  merged?: Array<{ rows: number[]; invoiceNumber: string; rates: number[] }>
}

/** Tier 739: an import row, checked, before it is booked */
interface PreparedImportRow {
  rowNum: number
  description: string
  invoiceDate: Date
  invoiceNumber: string | null
  supplierId: string
  net: number
  rate: number
  vat: number
  gross: number
  category: string | null
  status: string
  notes: string | null
}
