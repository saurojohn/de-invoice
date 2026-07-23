/**
 * Tier 88: E-Bilanz (XBRL) mapping table.
 *
 * Maps our internal report positions (from tiers
 * 81 Bilanz + 82 G+V + 83 Anlagenverzeichnis +
 * 84 Anhang) to the BMF eBilanz-in-xtml
 * taxonomy element IDs (the "GCD" — General
 * Commercial Domain — from BMF Taxonomy 6.7).
 *
 * v1 only covers the positions we can actually
 * compute from our existing data. The rest of
 * the BMF taxonomy is left as a placeholder;
 * the Berater fills those values in their
 * ELSTER client.
 *
 * Element ID naming convention follows the
 * standard XBRL tuple structure:
 *   bs.ass.fixAss.tangAss.othTangAss
 * (balance sheet / assets / fixed assets /
 *  tangible assets / other tangible assets)
 *
 * For G+V, the German GKV is mapped to the
 * ISO English taxonomy:
 *   is.rev.netSales  ← § 275 HGB Pos 1
 *   is.exp.employeeBenef  ← § 275 HGB Pos 6a
 *
 * v2 work:
 *   - Microsig taxonomy (small corps)
 *   - PK (Personengesellschaften)
 *   - Bilanzierungshilfen / Sonderposten
 *   - RAP (Rechnungsabgrenzungsposten)
 *   - Deferred tax breakdown
 */

export type MappingSource =
  // BilanzService position keys (tier 81)
  | "bilanz.aktiva.fixass.intang"
  | "bilanz.aktiva.fixass.grundstuecke"
  | "bilanz.aktiva.fixass.maschinen"
  | "bilanz.aktiva.fixass.betriebsausstattung"
  | "bilanz.aktiva.currass.forderungen"
  | "bilanz.aktiva.currass.liquide"
  | "bilanz.passiva.cred.tradl"
  | "bilanz.passiva.cred.kundenguthaben"
  | "bilanz.passiva.equity.subscribed"
  | "bilanz.passiva.equity.saldoposten"
  // G+V Service position keys (tier 82)
  | "guv.umsatzerloese"
  | "guv.sonstigeErtrage"
  | "guv.materialaufwand"
  | "guv.personalaufwand"
  | "guv.afa"
  | "guv.sonstigeAufwendungen"
  | "guv.zinsaufwendungen"
  | "guv.jahresueberschuss"
  // Anlagenverzeichnis (tier 83) — the
  // asset pool summary for Bilanz +
  // AfA total for G+V 7a (already in
  // guv.afa via tier 87 booked path)
  | "assets.totalAK"
  | "assets.totalBuchwert"
  | "assets.totalAfA"
  // Anhang (tier 84) — narrative, not
  // numeric; included as XML comment
  | "anhang.narrative"
  // Manual (Berater fills in)
  | "manual.placeholder"

export interface EBilanzMapping {
  /** BMF taxonomy element ID, e.g. "de-gcd:bs.ass.fixAss.tangAss.othTangAss" */
  elementId: string
  /** Human-readable label for the VORSCHAU table */
  label: string
  /** Which tier's data feeds this position */
  source: MappingSource
  /** BMF section: Bilanz-Aktiva / Bilanz-Passiva / G+V / Sonstige */
  section: "bilanzAktiva" | "bilanzPassiva" | "guv" | "sonstige"
  /** Whether v1 can compute this from our data; false = Berater fills */
  computed: boolean
  /** v2 / future-compute hint */
  note?: string
}

/**
 * v1 mapping table. ~30 positions, covering
 * the data we have + placeholders for the
 * Berater. The element IDs match the BMF
 * Taxonomy 6.7 GCD (general commercial
 * domain) — the published canonical names
 * from the BMF eBilanz-in-xtml reference.
 */
export const EBILANZ_MAPPING: EBilanzMapping[] = [
  // ===== Bilanz Aktiva =====
  {
    elementId: "de-gcd:bs.ass.fixAss.intangAss",
    label: "Immaterialielle Vermögensgegenstände",
    source: "bilanz.aktiva.fixass.intang",
    section: "bilanzAktiva",
    computed: true,
  },
  {
    elementId: "de-gcd:bs.ass.fixAss.tangAss.propAndBuild",
    label: "Grundstücke und Bauten",
    source: "bilanz.aktiva.fixass.grundstuecke",
    section: "bilanzAktiva",
    computed: true,
  },
  {
    elementId: "de-gcd:bs.ass.fixAss.tangAss.plantAndMach",
    label: "Maschinen",
    source: "bilanz.aktiva.fixass.maschinen",
    section: "bilanzAktiva",
    computed: true,
  },
  {
    elementId: "de-gcd:bs.ass.fixAss.tangAss.othTangAss",
    label: "Sonstige Sachanlagen / Betriebsausstattung",
    source: "bilanz.aktiva.fixass.betriebsausstattung",
    section: "bilanzAktiva",
    computed: true,
  },
  {
    elementId: "de-gcd:bs.ass.currAssets.tradeReceivables",
    label: "Forderungen aus Lieferungen und Leistungen",
    source: "bilanz.aktiva.currass.forderungen",
    section: "bilanzAktiva",
    computed: true,
  },
  {
    elementId: "de-gcd:bs.ass.currAssets.cashAndCashEquivalents",
    label: "Kassenbestand und Bankguthaben",
    source: "bilanz.aktiva.currass.liquide",
    section: "bilanzAktiva",
    computed: true,
  },
  // ===== Bilanz Passiva =====
  {
    elementId: "de-gcd:bs.liab.cred.tradeLiabilities",
    label: "Verbindlichkeiten aus Lieferungen und Leistungen",
    source: "bilanz.passiva.cred.tradl",
    section: "bilanzPassiva",
    computed: true,
  },
  {
    elementId: "de-gcd:bs.liab.cred.othLiab",
    label: "Sonstige Verbindlichkeiten (Kundenguthaben)",
    source: "bilanz.passiva.cred.kundenguthaben",
    section: "bilanzPassiva",
    computed: true,
    note: "v1 fasst positive Kundenguthaben unter 'Sonstige Verbindlichkeiten' zusammen. v2 trennt nach § 266 HGB 4600-4800.",
  },
  {
    elementId: "de-gcd:bs.equity.subscribedCapital",
    label: "Gezeichnetes Kapital",
    source: "bilanz.passiva.equity.subscribed",
    section: "bilanzPassiva",
    computed: false,
    note: "Stammkapital aus Company-Setup, in v1 nicht ausgewiesen. Berater füllt manuell.",
  },
  {
    elementId: "de-gcd:bs.equity.retainedEarnings",
    label: "Eigenkapital-Saldoposten (Bilanzgleichung)",
    source: "bilanz.passiva.equity.saldoposten",
    section: "bilanzPassiva",
    computed: true,
    note: "Saldoposten — Bilanzgleichung. Berater ersetzt durch reales Eigenkapital.",
  },
  // ===== G+V =====
  {
    elementId: "de-gcd:is.rev.netSales",
    label: "Umsatzerlöse (§ 275 HGB Pos 1)",
    source: "guv.umsatzerloese",
    section: "guv",
    computed: true,
  },
  {
    elementId: "de-gcd:is.rev.othOperRev",
    label: "Sonstige betriebliche Erträge (§ 275 HGB Pos 4)",
    source: "guv.sonstigeErtrage",
    section: "guv",
    computed: true,
  },
  {
    elementId: "de-gcd:is.exp.costOfMaterials",
    label: "Materialaufwand (§ 275 HGB Pos 5a)",
    source: "guv.materialaufwand",
    section: "guv",
    computed: true,
  },
  {
    elementId: "de-gcd:is.exp.employeeBenef",
    label: "Personalaufwand (§ 275 HGB Pos 6a)",
    source: "guv.personalaufwand",
    section: "guv",
    computed: true,
  },
  {
    elementId: "de-gcd:is.exp.deprecAndAmort",
    label: "Abschreibungen auf Sachanlagen (§ 275 HGB Pos 7a)",
    source: "guv.afa",
    section: "guv",
    computed: true,
    note: "Gebucht aus Anlagenverzeichnis (tier 87) wenn vorhanden, sonst berechnet.",
  },
  {
    elementId: "de-gcd:is.exp.othOperExp",
    label: "Sonstige betriebliche Aufwendungen (§ 275 HGB Pos 8)",
    source: "guv.sonstigeAufwendungen",
    section: "guv",
    computed: true,
  },
  {
    elementId: "de-gcd:is.fin.exp.fromInterest",
    label: "Zinsen und ähnliche Aufwendungen (§ 275 HGB Pos 13)",
    source: "guv.zinsaufwendungen",
    section: "guv",
    computed: true,
  },
  {
    elementId: "de-gcd:is.netIncLoss",
    label: "Jahresüberschuss / Jahresfehlbetrag (§ 275 HGB Pos 17)",
    source: "guv.jahresueberschuss",
    section: "guv",
    computed: true,
  },
  // ===== Anhang / Sonstige =====
  {
    elementId: "anhang.narrative",
    label: "Anhang (§ 284 HGB) — als PDF beigefügt",
    source: "anhang.narrative",
    section: "sonstige",
    computed: true,
    note: "Anhang wird nicht in XBRL kodiert (narrative). Anhang.pdf als Attachment.",
  },
  {
    elementId: "manual.placeholder",
    label: "Steuerrückstellungen, RAP, Sonderposten",
    source: "manual.placeholder",
    section: "sonstige",
    computed: false,
    note: "In v1 nicht ausgewiesen. Berater füllt manuell im ELSTER-Client.",
  },
]

/**
 * Returns the count of positions that v1
 * can actually compute from our data. Used
 * by the frontend "X von Y Pflichtpositionen
 * berechnet" summary.
 */
export function mappingStats() {
  const total = EBILANZ_MAPPING.length
  const computed = EBILANZ_MAPPING.filter((m) => m.computed).length
  const bySection = EBILANZ_MAPPING.reduce(
    (acc, m) => {
      acc[m.section] = (acc[m.section] || 0) + 1
      return acc
    },
    {} as Record<string, number>,
  )
  return { total, computed, bySection }
}
