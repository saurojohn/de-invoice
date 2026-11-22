/**
 * Tier 850 — invoices that owe their tax out of the price.
 *
 * An invoice issued without VAT on a day the Kleinunternehmerregelung does not
 * cover is a taxed supply all the same: the price the customer agreed is the
 * gross, and the tax is in it (§ 10 Abs. 1 Satz 2 UStG). Such invoices come
 * about when the end of the regulation is set back over invoices already
 * issued (Tier 845 lists them). Measured on Tier 849: a § 19 invoice of
 * 1 190 € of August, the end set back to 30.06., stood in the UStVA as
 * 1 190 € of „sonstige steuerfreie Umsätze“ and in the EÜR on 4170 — the
 * 190 € owed were in no return.
 *
 * Decision (an accounting decision, § 10 Abs. 1, § 12 Abs. 1, § 13 Abs. 1
 * UStG): the reports take the tax out of the invoice's total at 19 %, in the
 * period of the invoice, until it is corrected. A 0 % line does not say
 * whether the supply would have had the reduced rate (§ 12 Abs. 2); the
 * general rate is the one that applies unless shown otherwise, and the
 * notice says so. The invoice itself is not changed (GoBD): the rate is kept
 * beside it, in `Invoice.taxOutOfPrice`, and set again whenever the period
 * changes. A credit note of such an invoice takes the same rate (Tier 844: a
 * correction follows what it corrects).
 */
import { asIssued } from './customer-as-issued'
import { businessDayIso } from '../../common/business-date'
import { KU_SELECT, KuCompany, kuOn } from '../../common/kleinunternehmer-period'
import { EXEMPTION_HINT } from './mandatory-details'
import { zeroRatedGround } from './zero-rated'

type Db = any

/** the general rate (§ 12 Abs. 1 UStG) */
export const TAX_OUT_OF_PRICE_RATE = 0.19

export interface UntaxedInvoice {
  id: string
  invoiceNumber: string
  issueDate: Date
  total: unknown
  eurTotal: unknown
}

/**
 * Issued invoices and receipts with no VAT at all, on a day § 19 does not
 * apply beside a § 19 period, that are no igL / § 13b / export and name no
 * exemption in their remarks (remarks that name § 19 name none). The oldest
 * first. A company that never had a § 19 period has none.
 */
export async function untaxedOnTaxedDays(db: Db, companyId: string, co: KuCompany): Promise<UntaxedInvoice[]> {
  const on = kuOn(co)
  const mode = co?.defaultVatMode === 'kleinunternehmer'
  const ab = co?.kleinunternehmerAb ? businessDayIso(co.kleinunternehmerAb) : null
  const bis = co?.kleinunternehmerBis ? businessDayIso(co.kleinunternehmerBis) : null
  const utc = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
  const ranges: Array<{ gt?: Date; lt?: Date }> = []
  if (mode) {
    if (!ab) return [] // a Kleinunternehmer since always
    ranges.push({ lt: utc(ab), ...(bis ? { gt: utc(bis) } : {}) })
  } else {
    if (!bis) return [] // never one
    ranges.push({ gt: utc(bis) })
    if (ab) ranges.push({ lt: utc(ab) })
  }
  const rows = await db.invoice.findMany({
    where: {
      companyId,
      type: { in: ['INV', 'RCV'] },
      status: { in: ['sent', 'paid', 'overdue'] },
      reverseCharge: false,
      euTransaction: false,
      totalVat: 0,
      subtotal: { gt: 0 },
      OR: ranges.map((r) => ({ issueDate: r })),
    },
    select: {
      id: true, invoiceNumber: true, issueDate: true, total: true, eurTotal: true, notes: true,
      reverseCharge: true, euTransaction: true,
      customer: { select: { address: true, vatId: true } },
      customerCountry: true, customerVatId: true, // Tier 928
    },
    orderBy: [{ issueDate: 'asc' }, { invoiceNumber: 'asc' }],
  })
  // Tier 928: the customer as on the day of issue
  return rows.map(asIssued).filter(
    (r: any) =>
      !on(r.issueDate) &&
      zeroRatedGround(r, (r.customer?.address as { country?: string } | null)?.country, r.customer?.vatId) === 'exempt' &&
      !EXEMPTION_HINT.test((r.notes ?? '').replace(/§\s*19(?!\d)/g, '')),
  )
}

/**
 * Sets `taxOutOfPrice` on the company's invoices that owe it (and on their
 * credit notes), and clears it where they no longer do. Called after the
 * Kleinunternehmer period has changed; safe to call at any time.
 */
export async function refreshTaxOutOfPrice(db: Db, companyId: string): Promise<{ set: number; cleared: number }> {
  const co = await db.company.findUnique({ where: { id: companyId }, select: KU_SELECT })
  const owing = (await untaxedOnTaxedDays(db, companyId, co)).map((r) => r.id)
  const notes = owing.length
    ? (await db.invoice.findMany({ where: { companyId, type: 'CN', referenceInvoiceId: { in: owing } }, select: { id: true } })).map((r: { id: string }) => r.id)
    : []
  const ids = [...owing, ...notes]
  const cleared = await db.invoice.updateMany({
    where: { companyId, taxOutOfPrice: { not: null }, ...(ids.length ? { id: { notIn: ids } } : {}) },
    data: { taxOutOfPrice: null },
  })
  const set = ids.length
    ? await db.invoice.updateMany({
      where: { companyId, id: { in: ids }, OR: [{ taxOutOfPrice: null }, { taxOutOfPrice: { not: TAX_OUT_OF_PRICE_RATE } }] },
      data: { taxOutOfPrice: TAX_OUT_OF_PRICE_RATE },
    })
    : { count: 0 }
  return { set: set.count, cleared: cleared.count }
}
