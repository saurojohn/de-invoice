/**
 * Tier 417 — which UStVA / UStJA amount goes into which Kennzahl.
 *
 * Checked against the official 2026 form models (BMF-Schreiben of
 * 29.12.2025): "Umsatzsteuer-Voranmeldung 2026" (USt 1 A, GZ III C 3 -
 * S 7344/00039/007/036) and "Umsatzsteuererklärung 2026" (USt 2 A).
 *
 * The app used its own numbering, taken from nowhere: 19 % / 7 % bases in
 * "Kz 20 / 21" with tax in "Kz 26 / 27", § 13b in "Kz 36", other exempt sales
 * in "Kz 44" (the form's Kz 44 is new vehicles), input tax in "Kz 56 / 57 /
 * 59 / 60" (Kz 60 is § 13b *sales*) and the amount payable in **"Kz 81" — on
 * the form, Kz 81 is the 19 % tax base**. Anyone transcribing those numbers
 * into ELSTER would have declared their Zahllast as turnover.
 *
 * Only what the app actually knows is mapped. Zero-rated sales without an
 * igL / § 13b / export classification ("otherExempt") have no single annual
 * Kennzahl — the USt 2 A splits them by exemption provision — so the annual
 * mapping leaves them without a number; the monthly form's Kz 48 covers them.
 */
import type { UstvaData } from './ustva.service'

export interface KzEntry {
  /** the Kennzahl, or '' where the form line has none */
  kz: string
  label: string
  value: number
  /** base = Bemessungsgrundlage (whole euros on the form), tax = Steuer, amount = other */
  kind: 'base' | 'tax' | 'amount'
  /** for a base whose tax the form puts on the same line (e.g. Kz 81, 177) */
  tax?: number
}

const r2 = (n: number) => Math.round(n * 100) / 100
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6

function byRate(d: UstvaData) {
  const at = (rate: number) => d.salesByRate.find((x) => near(x.rate, rate))
  const others = d.salesByRate.filter((x) => !near(x.rate, 0.19) && !near(x.rate, 0.07) && x.rate > 0)
  const igAt = (rate: number) => d.intraEuAcquisitionsByRate.find((x) => near(x.rate, rate))
  const igOthers = d.intraEuAcquisitionsByRate.filter((x) => !near(x.rate, 0.19) && !near(x.rate, 0.07))
  const sum = (xs: Array<{ net: number; vat: number }>) => ({
    net: r2(xs.reduce((a, b) => a + b.net, 0)),
    vat: r2(xs.reduce((a, b) => a + b.vat, 0)),
  })
  return {
    s19: at(0.19) ?? { net: 0, vat: 0 },
    s7: at(0.07) ?? { net: 0, vat: 0 },
    sOther: sum(others),
    ig19: igAt(0.19) ?? { net: 0, vat: 0 },
    ig7: igAt(0.07) ?? { net: 0, vat: 0 },
    igOther: sum(igOthers),
    vstInvoices: r2(d.vorsteuer.from19 + d.vorsteuer.from7 + d.vorsteuer.fromOther),
  }
}

/** USt 1 A 2026 — Umsatzsteuer-Voranmeldung. */
export function ustvaKennzahlen(d: UstvaData): KzEntry[] {
  const b = byRate(d)
  return [
    { kz: '81', label: 'Steuerpflichtige Umsätze zum Steuersatz von 19 %', value: b.s19.net, kind: 'base', tax: b.s19.vat },
    { kz: '86', label: 'Steuerpflichtige Umsätze zum Steuersatz von 7 %', value: b.s7.net, kind: 'base', tax: b.s7.vat },
    { kz: '35', label: 'Steuerpflichtige Umsätze zu anderen Steuersätzen', value: b.sOther.net, kind: 'base' },
    { kz: '36', label: 'Steuer zu Kz 35', value: b.sOther.vat, kind: 'tax' },
    { kz: '41', label: 'Innergemeinschaftliche Lieferungen an Abnehmer mit USt-IdNr.', value: d.igL, kind: 'base' },
    { kz: '43', label: 'Weitere steuerfreie Umsätze mit Vorsteuerabzug (z. B. Ausfuhrlieferungen)', value: d.export, kind: 'base' },
    { kz: '48', label: 'Steuerfreie Umsätze ohne Vorsteuerabzug', value: d.otherExempt, kind: 'base' },
    { kz: '89', label: 'Steuerpflichtige innergemeinschaftliche Erwerbe zum Steuersatz von 19 %', value: b.ig19.net, kind: 'base', tax: b.ig19.vat },
    { kz: '93', label: 'Steuerpflichtige innergemeinschaftliche Erwerbe zum Steuersatz von 7 %', value: b.ig7.net, kind: 'base', tax: b.ig7.vat },
    { kz: '95', label: 'Innergemeinschaftliche Erwerbe zu anderen Steuersätzen', value: b.igOther.net, kind: 'base' },
    { kz: '98', label: 'Steuer zu Kz 95', value: b.igOther.vat, kind: 'tax' },
    { kz: '46', label: '§ 13b Abs. 1: sonstige Leistungen eines im übrigen Gemeinschaftsgebiet ansässigen Unternehmers', value: d.reverseChargeEuServices.net, kind: 'base' },
    { kz: '47', label: 'Steuer zu Kz 46', value: d.reverseChargeEuServices.vat, kind: 'tax' },
    { kz: '84', label: '§ 13b: andere Leistungen (Abs. 2 Nr. 1, 2, 4 bis 12)', value: d.reverseChargeOther.net, kind: 'base' },
    { kz: '85', label: 'Steuer zu Kz 84', value: d.reverseChargeOther.vat, kind: 'tax' },
    { kz: '60', label: 'Steuerpflichtige Umsätze, für die der Leistungsempfänger die Steuer nach § 13b Abs. 5 schuldet', value: d.reverseChargeSales, kind: 'base' },
    { kz: '21', label: 'Nicht steuerbare sonstige Leistungen gemäß § 18b Satz 1 Nr. 2', value: d.euServicesSales, kind: 'base' },
    { kz: '45', label: 'Übrige nicht steuerbare Umsätze (Leistungsort nicht im Inland)', value: d.nonTaxableOther, kind: 'base' },
    { kz: '66', label: 'Vorsteuerbeträge aus Rechnungen von anderen Unternehmern', value: b.vstInvoices, kind: 'tax' },
    { kz: '61', label: 'Vorsteuerbeträge aus dem innergemeinschaftlichen Erwerb von Gegenständen', value: d.vorsteuer.fromIgE, kind: 'tax' },
    { kz: '67', label: 'Vorsteuerbeträge aus Leistungen im Sinne des § 13b', value: d.vorsteuer.fromReverseCharge, kind: 'tax' },
    { kz: '83', label: 'Verbleibende Umsatzsteuer-Vorauszahlung / verbleibender Überschuss', value: d.differenzbetrag, kind: 'amount' },
  ]
}

/** USt 2 A 2026 — Umsatzsteuererklärung (annual), from the year's UStVA data summed. */
export function ustjaKennzahlen(d: UstvaData): KzEntry[] {
  const b = byRate(d)
  return [
    { kz: '177', label: 'Lieferungen und sonstige Leistungen zu 19 %', value: b.s19.net, kind: 'base', tax: b.s19.vat },
    { kz: '275', label: 'Lieferungen und sonstige Leistungen zu 7 %', value: b.s7.net, kind: 'base', tax: b.s7.vat },
    { kz: '155', label: 'Umsätze zu anderen Steuersätzen', value: b.sOther.net, kind: 'base' },
    { kz: '156', label: 'Steuer zu Kz 155', value: b.sOther.vat, kind: 'tax' },
    { kz: '741', label: 'Innergemeinschaftliche Lieferungen an Abnehmer mit USt-IdNr.', value: d.igL, kind: 'base' },
    { kz: '752', label: 'Ausfuhrlieferungen (§ 4 Nr. 1 Buchst. a)', value: d.export, kind: 'base' },
    { kz: '', label: 'Sonstige steuerfreie Umsätze — nach der Befreiungsvorschrift zuzuordnen', value: d.otherExempt, kind: 'base' },
    { kz: '781', label: 'Steuerpflichtige innergemeinschaftliche Erwerbe zu 19 %', value: b.ig19.net, kind: 'base', tax: b.ig19.vat },
    { kz: '793', label: 'Steuerpflichtige innergemeinschaftliche Erwerbe zu 7 %', value: b.ig7.net, kind: 'base', tax: b.ig7.vat },
    { kz: '798', label: 'Innergemeinschaftliche Erwerbe zu anderen Steuersätzen', value: b.igOther.net, kind: 'base' },
    { kz: '799', label: 'Steuer zu Kz 798', value: b.igOther.vat, kind: 'tax' },
    { kz: '846', label: '§ 13b Abs. 1: sonstige Leistungen eines im übrigen Gemeinschaftsgebiet ansässigen Unternehmers', value: d.reverseChargeEuServices.net, kind: 'base' },
    { kz: '847', label: 'Steuer zu Kz 846', value: d.reverseChargeEuServices.vat, kind: 'tax' },
    { kz: '877', label: '§ 13b: andere Leistungen (Abs. 2 Nr. 1, 2, 4 bis 12)', value: d.reverseChargeOther.net, kind: 'base' },
    { kz: '878', label: 'Steuer zu Kz 877', value: d.reverseChargeOther.vat, kind: 'tax' },
    { kz: '209', label: 'Steuerpflichtige Umsätze, für die der Leistungsempfänger die Steuer nach § 13b Abs. 5 schuldet', value: d.reverseChargeSales, kind: 'base' },
    { kz: '721', label: 'Nicht steuerbare sonstige Leistungen gemäß § 18b Satz 1 Nr. 2', value: d.euServicesSales, kind: 'base' },
    { kz: '205', label: 'Übrige nicht steuerbare Umsätze (Leistungsort nicht im Inland)', value: d.nonTaxableOther, kind: 'base' },
    { kz: '320', label: 'Vorsteuerbeträge aus Rechnungen von anderen Unternehmern', value: b.vstInvoices, kind: 'tax' },
    { kz: '761', label: 'Vorsteuerbeträge aus innergemeinschaftlichen Erwerben von Gegenständen', value: d.vorsteuer.fromIgE, kind: 'tax' },
    { kz: '467', label: 'Vorsteuerbeträge aus Leistungen im Sinne des § 13b', value: d.vorsteuer.fromReverseCharge, kind: 'tax' },
  ]
}

/** Sum monthly UStVA results into one period (the UStJA's input). */
export function sumUstva(months: UstvaData[], base: Pick<UstvaData, 'companyId' | 'year' | 'periodLabel'>): UstvaData {
  const rates = new Map<number, { net: number; vat: number; label: string }>()
  const igRates = new Map<number, { net: number; vat: number }>()
  const z = { net: 0, vat: 0 }
  const acc: UstvaData = {
    ...base,
    salesByRate: [],
    igL: 0, export: 0, otherExempt: 0,
    reverseChargeSales: 0, euServicesSales: 0, nonTaxableOther: 0,
    reverseCharge: 0,
    intraEuAcquisitions: { ...z }, intraEuAcquisitionsByRate: [],
    reverseChargeEuServices: { ...z }, reverseChargeOther: { ...z },
    vorsteuer: { from19: 0, from7: 0, fromIgE: 0, fromReverseCharge: 0, fromOther: 0, total: 0 },
    umsatzsteuer: 0, vorsteuerSum: 0, differenzbetrag: 0,
    counts: { invoices: 0, expenses: 0 },
  }
  for (const m of months) {
    for (const s of m.salesByRate) {
      const e = rates.get(s.rate) ?? { net: 0, vat: 0, label: s.label }
      e.net += s.net; e.vat += s.vat
      rates.set(s.rate, e)
    }
    for (const s of m.intraEuAcquisitionsByRate) {
      const e = igRates.get(s.rate) ?? { net: 0, vat: 0 }
      e.net += s.net; e.vat += s.vat
      igRates.set(s.rate, e)
    }
    for (const k of ['igL', 'export', 'otherExempt', 'reverseChargeSales', 'euServicesSales', 'nonTaxableOther', 'reverseCharge', 'umsatzsteuer', 'vorsteuerSum', 'differenzbetrag'] as const) {
      acc[k] += m[k]
    }
    for (const k of ['intraEuAcquisitions', 'reverseChargeEuServices', 'reverseChargeOther'] as const) {
      acc[k].net += m[k].net; acc[k].vat += m[k].vat
    }
    for (const k of ['from19', 'from7', 'fromIgE', 'fromReverseCharge', 'fromOther', 'total'] as const) {
      acc.vorsteuer[k] += m.vorsteuer[k]
    }
    acc.counts.invoices += m.counts.invoices
    acc.counts.expenses += m.counts.expenses
  }
  acc.salesByRate = [...rates.entries()]
    .map(([rate, v]) => ({ rate, label: v.label, net: r2(v.net), vat: r2(v.vat) }))
    .sort((a, b) => b.rate - a.rate)
  acc.intraEuAcquisitionsByRate = [...igRates.entries()]
    .map(([rate, v]) => ({ rate, net: r2(v.net), vat: r2(v.vat) }))
    .sort((a, b) => b.rate - a.rate)
  for (const k of ['igL', 'export', 'otherExempt', 'reverseChargeSales', 'euServicesSales', 'nonTaxableOther', 'reverseCharge', 'umsatzsteuer', 'vorsteuerSum', 'differenzbetrag'] as const) {
    acc[k] = r2(acc[k])
  }
  return acc
}
