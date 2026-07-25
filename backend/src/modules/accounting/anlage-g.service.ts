import { Injectable, BadRequestException } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import { Response } from 'express'
import PDFDocument from 'pdfkit'

/**
 * Tier 100: Anlage G — Einkünfte aus
 * Gewerbebetrieb (§ 15 EStG).
 *
 * The German tax filing for gewerbliche
 * Einzelunternehmen (and Personengesellschaften
 * where the einkommensteuer-pflichtige Gesellschafter
 * attaches Anlage G to their Einkommensteuer-
 * erklärung). Pairs with the EÜR — the EÜR is the
 * generic "what came in / what went out" form, Anlage
 * G adds the gewerbe-spezifische adjustments on top.
 *
 * Three big-picture differences from Anlage S / V:
 *   1. The bottom line is NOT "Umsatzerlöse −
 *      Betriebsausgaben" — it's that PLUS the
 *      § 8/9 GewStG Hinzurechnungs-/Kürzungs-
 *      mechanism that derives the gewerbesteuer-
 *      pflichtige Gewerbeertrag. A typical
 *      Handwerker has lots of "Aufwendungen
 *      für dauerhafte Miete" — 25% of those
 *      are HINZU gerechnet, then the 100.000 EUR
 *      Freibetrag is KÜRZT, then × Steuermesszahl
 *      3.5% × Hebesatz 400% = ~Gewerbesteuer.
 *   2. Kz 4100-4900 are gewerbesteuer-spezifische
 *      Hinzurechnungen / Kürzungen. v1 only
 *      computes the 25% Hinzurechnung on Miete /
 *      Pacht / Leasing (4100) — the rest is
 *      placeholder ("Berater ergänzt aus Verträgen").
 *   3. The Kennziffern 2100-2900 are an internal
 *      namespace (not BMF's actual Zeile numbers
 *      in the printable Anlage G form). The Berater
 *      maps them to the BMF Zeile positions when
 *      transcribing the VORSCHAU into the actual
 *      ElsterForm / PDF form.
 *
 * v1 heuristic: All paid/sent/overdue invoices in
 * the year are treated as gewerbliche Umsatzerlöse.
 * The expense side uses the same Expense.category
 * string vocabulary as EÜR / Anlage S / Anlage V —
 * the user's existing categorization carries over
 * (Material, Personal, Miete, etc.).
 *
 * The opt-in flag `Company.settings.anlageG ===
 * true` gates whether the report is generated at
 * all (the user enables Anlage G on a per-company
 * basis when the company is a Gewerbe). For non-
 * Gewerbe companies (e.g. pure Freelancer with
 * only Anlage S, or pure Vermieter with only
 * Anlage V), the Anlage G section is silent
 * (count = 0) and the Berater packager skips it.
 *
 * Output: per-Kennziffer lines (Umsatzerlöse +
 * Betriebsausgaben) + per-side subtotals +
 * Gewinn/Verlust + Hinzurechnungen/Kürzungen +
 * Gewerbeertrag + Gewerbesteuer-Schätzung (very
 * rough) + disclaimer + footer.
 *
 * The Kennziffern 2100-4900 are an internal
 * namespace (not BMF's actual Zeile numbers in
 * the printable Anlage G form). The Berater
 * maps them to the BMF Zeile positions when
 * transcribing the VORSCHAU into the actual
 * ElsterForm / PDF form.
 */
export interface AnlageGLine {
  kennziffer: string
  label: string
  amount: number
  source?: 'computed' | 'placeholder'
  note?: string
}

export interface AnlageGResult {
  year: number
  companyId: string
  einnahmen: AnlageGLine[]
  betriebsausgaben: AnlageGLine[]
  hinzurechnungen: AnlageGLine[]
  kurzungen: AnlageGLine[]
  totals: {
    einnahmenTotal: number
    betriebsausgabenTotal: number
    gewinnVorKorrektur: number // einnahmen - betriebsausgaben
    hinzurechnungenTotal: number
    kurzungenTotal: number
    gewerbeertrag: number // gewinnVorKorrektur + hinzu - kurzungen
    freibetrag: number // § 11 Abs. 1 GewStG: 100.000 EUR
    gewerbeertragNachFreibetrag: number
    gewerbesteuerMesszahl: number // 0.035 (3.5%)
    hebesatz: number // default 400 (Münster, etc.)
    gewerbesteuerSchaetzung: number // gerundet
  }
  counts: {
    invoices: number
    expenses: number
    matchedMieteExpenses: number
  }
  generatedAt: string
  disclaimer: string
}

// Tier 100: Anlage G revenue Kennziffern 2100-2190.
// v1 uses VAT-status matchers similar to Anlage S
// / V: 19% USt vs 7% USt vs § 19 UStG Kleinunter-
// nehmer. ReverseCharge goes to 2150 (igLeistungen).
const EINNAHMEN_LINES: Array<{ kz: string; label: string; matcher: (inv: any) => boolean }> = [
  {
    kz: '2110',
    label: 'Umsatzerlöse 19% USt (Standard-Besteuerung)',
    matcher: (inv) => Number(inv.totalVat) > 0 && Number(inv.subtotal) > 0 && !inv.reverseCharge,
  },
  {
    kz: '2120',
    label: 'Umsatzerlöse 7% USt (ermäßigt)',
    matcher: (inv) =>
      Number(inv.subtotal) > 0 &&
      Number(inv.totalVat) > 0 &&
      Math.abs(Number(inv.totalVat) / Number(inv.subtotal) - 0.07) < 0.01,
  },
  {
    kz: '2130',
    label: 'Umsatzerlöse nach § 19 UStG (Kleinunternehmer, 0% USt)',
    matcher: (inv) => Number(inv.totalVat) === 0 && Number(inv.subtotal) > 0 && !inv.reverseCharge,
  },
  {
    kz: '2150',
    label: 'Innergemeinschaftliche Lieferungen / igLeistungen (§ 25b UStG, Reverse Charge)',
    matcher: (inv) => inv.reverseCharge === true,
  },
  {
    kz: '2190',
    label: 'Sonstige Erlöse (Gutschriften, Nebenerlöse, Provisionen)',
    matcher: () => false, // fallback
  },
]

// Tier 100: Anlage G Betriebsausgaben 2200-2890.
// Mirrors the Anlage S / EÜR categorization but with
// additional § 8/9 GewStG-relevant lines (Miete/Pacht
// 2200 — these are HINZU gerechnet at 25% in 4100).
const BETRIEBSAUSGABEN_LINES: Array<{ kz: string; label: string; matcher: (exp: any) => boolean }> = [
  {
    kz: '2200',
    label: 'Miete, Pacht, Leasing (Geschäftsräume, Maschinen, Fahrzeuge)',
    matcher: (exp) => /^(Miete|Pacht|Leasing)/i.test(exp.category || ''),
  },
  {
    kz: '2300',
    label: 'Personalaufwand (Löhne, Gehälter, Sozialversicherung)',
    matcher: (exp) => /^(Personal|Lohn|Gehalt|Sozialversicherung)/i.test(exp.category || ''),
  },
  {
    kz: '2400',
    label: 'Material / Wareneinsatz / Fremdleistungen',
    matcher: (exp) =>
      /^(Material|Wareneinsatz|Fremdleistung|Beschaffung)/i.test(exp.category || ''),
  },
  {
    kz: '2500',
    label: 'AfA auf Sachanlagen / GWG / immaterielle Wirtschaftsgüter',
    matcher: (exp) =>
      /^(AfA|Abschreibung|GWG)/i.test(exp.category || ''),
  },
  {
    kz: '2600',
    label: 'Fahrzeugkosten (Kfz-Steuer, Versicherung, Reparatur, Kraftstoff)',
    matcher: (exp) => /^(Fahrzeug|Kfz|Kraftstoff|Tankkosten)/i.test(exp.category || ''),
  },
  {
    kz: '2700',
    label: 'Reise- und Bewirtungskosten (Geschäftsreisen, Verpflegung)',
    matcher: (exp) => /^(Reise|Bewirtung)/i.test(exp.category || ''),
  },
  {
    kz: '2800',
    label: 'Werbe- und Marketingkosten (Anzeigen, Online-Werbung, Drucksachen)',
    matcher: (exp) => /^(Werbung|Marketing)/i.test(exp.category || ''),
  },
  {
    kz: '2850',
    label: 'Beratung / Steuer / Recht / Buchhaltung',
    matcher: (exp) => /^(Beratung|Steuer|Recht|Buchhaltung|Steuerberatung)/i.test(exp.category || ''),
  },
  {
    kz: '2860',
    label: 'Kommunikation / Büro / Porto / EDV',
    matcher: (exp) => /^(Kommunikation|Büro|Porto|EDV|Telefon|Internet)/i.test(exp.category || ''),
  },
  {
    kz: '2870',
    label: 'Versicherungen (Berufshaftpflicht, Betriebsversicherung)',
    matcher: (exp) => /^(Versicherung|Haftpflicht|Betriebsversicherung)/i.test(exp.category || ''),
  },
  {
    kz: '2880',
    label: 'Fortbildung / Fachliteratur',
    matcher: (exp) => /^(Fortbildung|Fachliteratur)/i.test(exp.category || ''),
  },
  {
    kz: '2890',
    label: 'Sonstige Betriebsausgaben',
    matcher: (exp) => true, // catch-all fallback
  },
]

// Tier 100: Anlage G Hinzurechnungen § 8 GewStG 4100-4900.
// v1 only computes 4100 (25% Hinzurechnung der
// Finanzierungsanteile von Miet-/Pacht-/Leasing-
// aufwendungen). The other Hinzurechnungen
// (z.B. Verlustanteile aus Beteiligungen, 50%
// Schuldzinsen-Hinzurechnung) are placeholders.
const HINZURECHNUNGEN_LINES: Array<{
  kz: string
  label: string
  matcher?: (betriebsausgaben: AnlageGLine[]) => number
  note?: string
}> = [
  {
    kz: '4100',
    label:
      'Hinzurechnung 25% der Miet-/Pacht-/Leasing-Aufwendungen (§ 8 Nr. 7 GewStG — Finanzierungsanteil)',
    matcher: (ba) => {
      const miete = ba.find((l) => l.kennziffer === '2200')?.amount || 0
      return miete * 0.25
    },
  },
  {
    kz: '4200',
    label: 'Hinzurechnung 50% der Schuldzinsen bei Gesellschafter-Darlehen (§ 8 Nr. 1a GewStG)',
    note: 'Schuldzinsen-Hinzurechnung — in de-invoice nicht erfasst. Berater ergänzt aus Darlehensverträgen.',
  },
  {
    kz: '4300',
    label: 'Hinzurechnung Verlustanteile aus Beteiligungen an Mitunternehmerschaften (§ 8 Nr. 8 GewStG)',
    note: 'Mitunternehmer-Verlustanteile — in de-invoice nicht erfasst. Berater ergänzt aus Beteiligungsbilanzen.',
  },
  {
    kz: '4400',
    label:
      'Hinzurechnung Aufsichtsrats-/ Beiratsvergütungen (§ 8 Nr. 4 GewStG, nur Organgesellschaften)',
    note: 'Aufsichtsrats-Vergütungen — in de-invoice nicht erfasst. Berater ergänzt.',
  },
  {
    kz: '4500',
    label: 'Hinzurechnung typisch stille Einlagen + Genussrechtskapital (§ 8 Nr. 3 GewStG)',
    note: 'Typisch stille Einlagen — in de-invoice nicht erfasst. Berater ergänzt.',
  },
  {
    kz: '4900',
    label: 'Sonstige Hinzurechnungen (§ 8 GewStG Rest)',
    note: 'Sonstige Hinzurechnungen — Berater ergänzt aus dem Gewerbesteuergesetz.',
  },
]

// Tier 100: Anlage G Kürzungen § 9 GewStG 5000-5900.
// v1 only computes 5100 (Kürzung Kfz-Nutzungsanteil
// if the user has a reiner Pkw mit privater Nutzung).
// The rest are placeholders.
const KURZUNGEN_LINES: Array<{
  kz: string
  label: string
  matcher?: (betriebsausgaben: AnlageGLine[]) => number
  note?: string
}> = [
  {
    kz: '5100',
    label: 'Kürzung Kfz-Nutzungsanteil 50% der laufenden Kfz-Kosten (privater Anteil)',
    matcher: (ba) => {
      const kfz = ba.find((l) => l.kennziffer === '2600')?.amount || 0
      return kfz * 0.5
    },
  },
  {
    kz: '5200',
    label: 'Kürzung Grundstückserträge 1,2% des Einheitswerts (§ 9 Nr. 1 GewStG)',
    note: 'Grundstücks-Kürzung — in de-invoice nicht erfasst (kein Einheitswert). Berater ergänzt aus Einheitswertbescheid.',
  },
  {
    kz: '5300',
    label: 'Kürzung Gewinnanteile aus Beteiligungen an Mitunternehmerschaften (§ 9 Nr. 2 GewStG)',
    note: 'Mitunternehmer-Gewinnanteile — in de-invoice nicht erfasst. Berater ergänzt aus Beteiligungsbilanzen.',
  },
  {
    kz: '5400',
    label: 'Kürzung ausländische Betriebsstätten-Ergebnisse (§ 9 Nr. 3 GewStG)',
    note: 'Ausländische Betriebsstätten — in de-invoice nicht erfasst. Berater ergänzt.',
  },
  {
    kz: '5900',
    label: 'Sonstige Kürzungen (§ 9 GewStG Rest)',
    note: 'Sonstige Kürzungen — Berater ergänzt aus dem Gewerbesteuergesetz.',
  },
]

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

@Injectable()
export class AnlageGService {
  constructor(private prisma: PrismaService) {}

  /**
   * Compute the Anlage G for the year. Returns
   * the report JSON. The controller wraps this
   * in the year-defaults + auth handling.
   *
   * v1: All paid/sent/overdue invoices in the
   * year are gewerbliche Umsatzerlöse. Expense
   * categorization follows the Anlage S / EÜR
   * pattern. § 8/9 GewStG Korrekturen: only
   * 4100 (25% Hinzurechnung Miete/Pacht) and
   * 5100 (50% Kürzung Kfz-Nutzungsanteil) are
   * computed; the rest is placeholder.
   */
  async compute(companyId: string, year: number): Promise<AnlageGResult> {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }

    const yearStart = new Date(year, 0, 1)
    const yearEnd = new Date(year, 11, 31, 23, 59, 59, 999)

    // Pull every invoice in the year (any status
    // that contributed to revenue). Drafts are
    // excluded — they're not billable yet. v1: no
    // per-customer filtering. The user opts in via
    // Company.settings.anlageG === true on the
    // controller side.
    const invoices = await this.prisma.invoice.findMany({
      where: {
        companyId,
        issueDate: { gte: yearStart, lte: yearEnd },
        status: { in: ['paid', 'sent', 'overdue'] },
      },
      select: {
        subtotal: true,
        totalVat: true,
        reverseCharge: true,
      },
    })

    // Betriebsausgaben (Expense rows). Exclude
    // Storno / 'voided' — those go to negative
    // operating expenses but in v1 we keep the
    // book entries clean.
    const expenses = await this.prisma.expense.findMany({
      where: {
        companyId,
        invoiceDate: { gte: yearStart, lte: yearEnd },
        status: { in: ['booked', 'deductible'] },
      },
      select: {
        netAmount: true,
        category: true,
      },
    })

    // Bucket revenues by Kennziffer. First match
    // wins. Gutschriften (negative subtotal) reduce
    // Kz 2110 directly — symmetric to Anlage S / V
    // / EÜR.
    const einnahmenBuckets = new Map<string, number>()
    for (const def of EINNAHMEN_LINES) einnahmenBuckets.set(def.kz, 0)
    for (const inv of invoices) {
      const subtotal = Number(inv.subtotal)
      if (subtotal < 0) {
        // Gutschrift (CN) — reduce Kz 2110 directly
        einnahmenBuckets.set('2110', (einnahmenBuckets.get('2110') || 0) + subtotal)
        continue
      }
      const matched = EINNAHMEN_LINES.find((d) => d.matcher(inv))
      const kz = matched?.kz || '2190'
      einnahmenBuckets.set(kz, (einnahmenBuckets.get(kz) || 0) + subtotal)
    }

    // Bucket expenses. The Sonstige 2890 is the
    // fallback for any expense that doesn't match
    // a specific bucket — same convention as Anlage
    // S / EÜR. v1: 2890 catches everything NOT
    // matched above because it's a true fallback.
    // (In Anlage S, the Sonstige was true-fallback
    // too.)
    const matchedKz = new Set<string>()
    const betriebsausgabenBuckets = new Map<string, number>()
    for (const def of BETRIEBSAUSGABEN_LINES) betriebsausgabenBuckets.set(def.kz, 0)
    for (const exp of expenses) {
      // Try to match a specific Kz (2200-2880) first.
      const matched = BETRIEBSAUSGABEN_LINES.slice(0, -1).find((d) =>
        d.matcher(exp),
      )
      let kz: string
      if (matched) {
        kz = matched.kz
      } else {
        // 2890 fallback — only if not already counted
        if (matchedKz.has(exp.category || '')) continue
        kz = '2890'
        matchedKz.add(exp.category || '')
      }
      betriebsausgabenBuckets.set(
        kz,
        (betriebsausgabenBuckets.get(kz) || 0) + Number(exp.netAmount),
      )
    }

    // Build the einnahmen + betriebsausgaben lines
    // in BMF order. Net amount for expenses is
    // typically negative (e.g. -119.00 for a 19%
    // USt invoice with subtotal 100), so the
    // per-line amount stays negative.
    const einnahmen: AnlageGLine[] = EINNAHMEN_LINES.map((d) => ({
      kennziffer: d.kz,
      label: d.label,
      amount: round2(einnahmenBuckets.get(d.kz) || 0),
    }))
    const betriebsausgaben: AnlageGLine[] = BETRIEBSAUSGABEN_LINES.map((d) => ({
      kennziffer: d.kz,
      label: d.label,
      amount: round2(betriebsausgabenBuckets.get(d.kz) || 0),
    }))

    const einnahmenTotal = einnahmen.reduce((s, l) => s + l.amount, 0)
    const betriebsausgabenTotal = betriebsausgaben.reduce(
      (s, l) => s + l.amount,
      0,
    )
    const gewinnVorKorrektur = round2(einnahmenTotal + betriebsausgabenTotal)

    // Hinzurechnungen / Kürzungen — the § 8/9
    // GewStG Korrekturen. v1 computes 4100 + 5100
    // from the betriebsausgaben totals; the rest
    // is placeholder for the Berater.
    const hinzurechnungen: AnlageGLine[] = HINZURECHNUNGEN_LINES.map((d) => {
      const amount = d.matcher ? round2(d.matcher(betriebsausgaben)) : 0
      return {
        kennziffer: d.kz,
        label: d.label,
        amount,
        source: d.matcher ? 'computed' : 'placeholder',
        note: d.note,
      }
    })
    const kurzungen: AnlageGLine[] = KURZUNGEN_LINES.map((d) => {
      const amount = d.matcher ? round2(d.matcher(betriebsausgaben)) : 0
      return {
        kennziffer: d.kz,
        label: d.label,
        amount,
        source: d.matcher ? 'computed' : 'placeholder',
        note: d.note,
      }
    })
    const hinzurechnungenTotal = hinzurechnungen.reduce((s, l) => s + l.amount, 0)
    const kurzungenTotal = kurzungen.reduce((s, l) => s + l.amount, 0)

    // Gewerbeertrag = Gewinn/Verlust + Hinzu −
    // Kürzungen. Per § 7 GewStG ist der Gewerbeertrag
    // der Ausgangspunkt für die Gewerbesteuer.
    // Freibetrag 100.000 EUR (§ 11 Abs. 1 GewStG)
    // gilt NUR für Einzelunternehmen und
    // Personengesellschaften — Kapitalgesellschaften
    // (GmbH/AG) haben KEINEN Freibetrag. v1: assume
    // Einzelunternehmen / Personengesellschaft
    // (100k EUR Freibetrag).
    const gewerbeertrag = round2(
      gewinnVorKorrektur + hinzurechnungenTotal - kurzungenTotal,
    )
    const freibetrag = 100000
    const gewerbeertragNachFreibetrag = round2(
      Math.max(0, gewerbeertrag - freibetrag),
    )

    // Gewerbesteuer-Schätzung:
    //   Messbetrag = Gewerbeertrag × Steuermesszahl
    //   GewSt = Messbetrag × Hebesatz / 100
    //   Default Hebesatz 400 (Münster, etc.). The
    //   user adjusts via Company.settings.hebESatz
    //   if their Gemeinde uses a different Hebesatz.
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { settings: true },
    })
    const settings = (company?.settings as any) || {}
    const hebesatz =
      typeof settings.hebesatz === 'number' && settings.hebesatz > 0
        ? settings.hebesatz
        : 400
    const gewerbesteuerMesszahl = 0.035
    const gewerbesteuerSchaetzung = round2(
      gewerbeertragNachFreibetrag * gewerbesteuerMesszahl * hebesatz,
    )

    // Diagnostics: count of Miete / Pacht / Leasing
    // expenses — these are the ones that feed 4100.
    const matchedMieteExpenses = expenses.filter((e) =>
      /^(Miete|Pacht|Leasing)/i.test(e.category || ''),
    ).length

    return {
      year,
      companyId,
      einnahmen,
      betriebsausgaben,
      hinzurechnungen,
      kurzungen,
      totals: {
        einnahmenTotal: round2(einnahmenTotal),
        betriebsausgabenTotal: round2(betriebsausgabenTotal),
        gewinnVorKorrektur,
        hinzurechnungenTotal: round2(hinzurechnungenTotal),
        kurzungenTotal: round2(kurzungenTotal),
        gewerbeertrag,
        freibetrag,
        gewerbeertragNachFreibetrag,
        gewerbesteuerMesszahl,
        hebesatz,
        gewerbesteuerSchaetzung,
      },
      counts: {
        invoices: invoices.length,
        expenses: expenses.length,
        matchedMieteExpenses,
      },
      generatedAt: new Date().toISOString(),
      disclaimer:
        'Diese Vorschau wurde automatisch aus Ihren Buchungen generiert. ' +
        'Anlage G ist für Einkünfte aus Gewerbebetrieb (§ 15 EStG) — ' +
        'bei Kapitalgesellschaften (GmbH/AG) ist stattdessen die Körperschaftsteuererklärung ' +
        'KSt 1 abzugeben. Die § 8/9 GewStG Hinzurechnungen / Kürzungen sind ' +
        'nur teilweise aus den Buchungsdaten ableitbar (Kz 4100 / 5100). ' +
        'Die restlichen Hinzurechnungen (Schuldzinsen, Mitunternehmer-Verlustanteile, ' +
        'stille Einlagen) und Kürzungen (Grundstückserträge, Mitunternehmer-Gewinnanteile) ' +
        'muss der Steuerberater aus dem Gewerbesteuergesetz und den Verträgen ergänzen. ' +
        'Die Gewerbesteuer-Schätzung ist SEHR grob (default Hebesatz 400 %) — bitte ' +
        'vor der Einreichung vom Steuerberater prüfen lassen.',
    }
  }

  /**
   * Render the Anlage G as a GoBD-style A4 PDF.
   * Same layout family as Anlage S / V: header +
   * 4 tables (Einnahmen + Betriebsausgaben +
   * Hinzurechnungen + Kürzungen) + Gewinn/Verlust
   * + Gewerbeertrag + Freibetrag + Gewerbesteuer-
   * Schätzung + disclaimer + footer.
   */
  async renderPdf(companyId: string, year: number, res: Response): Promise<void> {
    const data = await this.compute(companyId, year)
    const company = await this.prisma.company.findUnique({ where: { id: companyId } })

    const doc = new PDFDocument({ size: 'A4', margin: 40 })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="Anlage-G-${year}.pdf"`,
    )
    doc.pipe(res)

    // Header
    doc
      .fontSize(18)
      .font('Helvetica-Bold')
      .text(`Anlage G ${year} — VORSCHAU`, { align: 'left' })
      .moveDown(0.2)
    doc
      .fontSize(10)
      .font('Helvetica')
      .text(
        `Einkünfte aus Gewerbebetrieb (§ 15 EStG) — ${company?.name || companyId}`,
      )
      .moveDown(1)

    // Einnahmen block
    doc.fontSize(12).font('Helvetica-Bold').text('Umsatzerlöse / Erlöse')
    doc.moveDown(0.3)
    this.renderTable(doc, data.einnahmen, data.totals.einnahmenTotal, 'Einnahmen')
    doc.moveDown(0.8)

    // Betriebsausgaben block
    doc.fontSize(12).font('Helvetica-Bold').text('Betriebsausgaben')
    doc.moveDown(0.3)
    this.renderTable(
      doc,
      data.betriebsausgaben,
      data.totals.betriebsausgabenTotal,
      'Betriebsausgaben',
    )
    doc.moveDown(0.8)

    // Gewinn/Verlust — red/green. Typical
    // Gewerbe is in the profit zone (positive
    // = Gewinn); loss is rare but happens in
    // Gründerjahren.
    doc.fontSize(13).font('Helvetica-Bold')
    const gewinn = data.totals.gewinnVorKorrektur
    doc
      .fillColor(gewinn >= 0 ? '#047857' : '#b91c1c')
      .text(
        gewinn >= 0
          ? `Gewinn: ${this.fmtEur(gewinn)} €`
          : `Verlust: ${this.fmtEur(Math.abs(gewinn))} €`,
      )
      .fillColor('#000')
    doc.moveDown(1.2)

    // Hinzurechnungen block
    doc
      .fontSize(12)
      .font('Helvetica-Bold')
      .text('Hinzurechnungen (§ 8 GewStG)')
    doc.moveDown(0.3)
    this.renderTable(
      doc,
      data.hinzurechnungen,
      data.totals.hinzurechnungenTotal,
      'Hinzurechnungen',
    )
    doc.moveDown(0.8)

    // Kürzungen block
    doc.fontSize(12).font('Helvetica-Bold').text('Kürzungen (§ 9 GewStG)')
    doc.moveDown(0.3)
    this.renderTable(doc, data.kurzungen, data.totals.kurzungenTotal, 'Kürzungen')
    doc.moveDown(1)

    // Gewerbeertrag + Freibetrag + Schätzung
    doc.fontSize(13).font('Helvetica-Bold').text('Gewerbeertrag + Gewerbesteuer')
    doc.moveDown(0.3)
    doc.fontSize(10).font('Helvetica')
    doc.text(
      `Gewerbeertrag (vor Freibetrag): ${this.fmtEur(data.totals.gewerbeertrag)} €`,
    )
    doc.text(
      `./. Freibetrag § 11 Abs. 1 GewStG (Einzelunternehmen / PersG): ${this.fmtEur(
        data.totals.freibetrag,
      )} €`,
    )
    doc.text(
      `= Gewerbeertrag nach Freibetrag: ${this.fmtEur(
        data.totals.gewerbeertragNachFreibetrag,
      )} €`,
    )
    doc.text(
      `× Steuermesszahl: ${(data.totals.gewerbesteuerMesszahl * 100).toFixed(1)} %`,
    )
    doc.text(
      `× Hebesatz (default): ${data.totals.hebesatz} %`,
    )
    doc
      .fillColor('#b91c1c')
      .font('Helvetica-Bold')
      .text(
        `= Gewerbesteuer-Schätzung: ${this.fmtEur(
          data.totals.gewerbesteuerSchaetzung,
        )} €`,
      )
      .fillColor('#000')
    doc.moveDown(1)

    // Disclaimer
    doc
      .fontSize(8)
      .font('Helvetica-Oblique')
      .fillColor('#666')
      .text(data.disclaimer, { width: 515 })
      .fillColor('#000')

    // Footer
    doc
      .fontSize(7)
      .font('Helvetica')
      .fillColor('#999')
      .text(
        `Erstellt: ${new Date(data.generatedAt).toLocaleString('de-DE')}  |  ` +
          `Rechnungen: ${data.counts.invoices}  |  Ausgaben: ${data.counts.expenses}  |  ` +
          `Miete-/Pacht-Buchungen: ${data.counts.matchedMieteExpenses}  |  ` +
          `de-invoice · Anlage G Vorschau`,
        { align: 'center' },
      )
      .fillColor('#000')

    doc.end()
  }

  private renderTable(
    doc: PDFKit.PDFDocument,
    lines: AnlageGLine[],
    total: number,
    blockLabel: string,
  ): void {
    const tableTop = doc.y
    const colKz = 40
    const colAmount = 420

    // Header
    doc.fontSize(9).font('Helvetica-Bold')
    doc.text('Kz', colKz, tableTop, { continued: true })
    doc.text('Bezeichnung', colKz + 35, tableTop, { continued: true })
    doc.text('Betrag (€)', colAmount, tableTop, { width: 135, align: 'right' })
    doc.moveDown(0.3)

    // Body
    doc.font('Helvetica')
    for (const l of lines) {
      const y = doc.y
      doc.fontSize(9)
      doc.text(l.kennziffer, colKz, y)
      doc.text(l.label, colKz + 35, y, { width: 320 })
      doc.text(this.fmtEur(l.amount), colAmount, y, {
        width: 135,
        align: 'right',
      })
      doc.moveDown(0.2)
      if (l.note) {
        doc
          .fontSize(7)
          .fillColor('#666')
          .text(`Hinweis: ${l.note}`, colKz + 35, doc.y, { width: 380 })
          .fillColor('#000')
          .fontSize(9)
        doc.moveDown(0.2)
      }
    }

    // Total
    doc.moveTo(colKz, doc.y).lineTo(555, doc.y).stroke()
    doc.moveDown(0.2)
    doc.font('Helvetica-Bold').fontSize(10)
    doc.text(`Summe ${blockLabel}`, colKz + 35, doc.y, { width: 320 })
    doc.text(this.fmtEur(total), colAmount, doc.y, {
      width: 135,
      align: 'right',
    })
    doc.font('Helvetica').fontSize(9)
  }

  private fmtEur(n: number): string {
    return new Intl.NumberFormat('de-DE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n)
  }
}
