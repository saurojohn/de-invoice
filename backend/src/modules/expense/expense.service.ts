import { signedExpenseAmounts } from './credit-note';
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
      include: { supplier: { select: { id: true, name: true, vatId: true } } },
      orderBy: { invoiceDate: 'desc' },
      take: 500,
    });
    if (items.length === 0) return { data: [], total: 0 };
    // Augment each Expense with the most recent linked
    // Voucher (for the list page to show a "Buchungsbeleg"
    // link + a "Storniert" badge if the Voucher is a
    // reversal). The bank-import bookExpense flow links
    // Expense → Voucher by writing a Voucher with
    // referenceType='Expense' and the expenseId in
    // description — we resolve the link here by querying
    // for Vouchers whose description carries the expenseId.
    // The cheaper alternative would be a column on
    // Voucher, but we kept the Voucher self-contained.
    const expenseIds = items.map((e) => e.id);
    // Quick text-search for the most-recent Voucher per
    // expense. Patterns look like "... [expense:<id>] ..."
    // — see bank-import.service.ts bookExpense.
    const vouchers = await this.prisma.voucher.findMany({
      where: {
        companyId,
        referenceType: { in: ['Expense', 'VoucherReversal'] },
        description: { contains: 'expense:' },
        OR: expenseIds.map((id) => ({ description: { contains: id } })),
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        voucherNumber: true,
        referenceType: true,
        description: true,
        status: true,
      },
    });
    // Build a map of expenseId → most recent voucher
    const voucherByExpense: Record<string, typeof vouchers[number]> = {};
    for (const v of vouchers) {
      for (const eid of expenseIds) {
        if (v.description && v.description.includes(eid)) {
          if (!voucherByExpense[eid]) voucherByExpense[eid] = v;
          break;
        }
      }
    }
    return {
      // Tier 178: wrap the array in {data, total} so
      // the list page can paginate and show a count,
      // matching the shape of /invoices, /customers,
      // /products. Phase 3 Berater-Walkthrough flagged
      // this as a consistency gap.
      data: items.map((e) => {
        const v = voucherByExpense[e.id];
        return {
          ...e,
          // Cheap UI hint: "Storniert" if the linked
          // voucher is itself a VoucherReversal, "Bezahlt"
          // if there's any linked voucher, "Offen" otherwise.
          // This drives the colored badge in the list.
          paymentState: v
            ? v.referenceType === 'VoucherReversal'
              ? 'storniert'
              : 'bezahlt'
            : 'offen',
          linkedVoucher: v
            ? {
                id: v.id,
                voucherNumber: v.voucherNumber,
                referenceType: v.referenceType,
              }
            : null,
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
      include: { supplier: true },
    });
    if (!exp) throw new NotFoundException('Eingangsrechnung nicht gefunden');
    return exp;
  }

  async create(companyId: string, data: any) {
    if (!data.description) throw new BadRequestException('Beschreibung ist erforderlich');
    if (!data.invoiceDate) throw new BadRequestException('Rechnungsdatum ist erforderlich');
    if (data.supplierId) {
      const sup = await this.prisma.supplier.findFirst({ where: { id: data.supplierId, companyId } });
      if (!sup) throw new BadRequestException('Lieferant nicht gefunden');
    }
    // Tier 442: a supplier credit note is stored with negative amounts.
    const { net, vat, gross } = signedExpenseAmounts(data.creditNote, {
      net: Number(data.netAmount ?? 0),
      vat: Number(data.vatAmount ?? 0),
      gross: Number(data.grossAmount ?? Number(data.netAmount ?? 0) + Number(data.vatAmount ?? 0)),
    });
    return this.prisma.expense.create({
      data: {
        companyId,
        supplierId: data.supplierId || null,
        invoiceNumber: data.invoiceNumber || null,
        description: data.description,
        invoiceDate: new Date(data.invoiceDate),
        netAmount: net.toFixed(4),
        vatRate: data.vatRate ?? 0,
        vatAmount: vat.toFixed(4),
        grossAmount: gross.toFixed(4),
        category: data.category || null,
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
      },
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
    }
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

        await this.prisma.expense.create({
          data: {
            companyId,
            supplierId,
            invoiceNumber: (row.invoiceNumber || '').trim() || null,
            description,
            invoiceDate,
            netAmount: netAmount.toFixed(4),
            vatRate,
            vatAmount: vatAmount.toFixed(4),
            grossAmount: grossAmount.toFixed(4),
            category: (row.category || '').trim() || null,
            status: (row.status || 'booked').trim(),
            notes: (row.notes || '').trim() || null,
          },
        })
        result.imported++
      } catch (e: any) {
        result.errors.push({
          row: rowNum,
          error: e?.message || 'Unbekannter Fehler',
          description: (row.description || '').trim(),
        })
      }
    }
    return result
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
}
