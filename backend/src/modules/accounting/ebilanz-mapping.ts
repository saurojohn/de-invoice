/**
 * Tier 88 + Tier 97: E-Bilanz (XBRL) mapping table.
 *
 * Maps our internal report positions (from tiers
 * 81 Bilanz + 82 G+V + 83 Anlagenverzeichnis +
 * 84 Anhang) to the BMF eBilanz-in-xtml
 * taxonomy element IDs (the "GCD" — General
 * Commercial Domain — from BMF Taxonomy 6.7).
 *
 * Tier 88 (v1) covered ~20 positions. Tier 97
 * (v2) expands to ~55 positions covering:
 *   - Bilanz-Aktiva: Anlagevermögen, Umlauf-
 *     vermögen, Aktive RAP, Aktive latente
 *     Steuern
 *   - Bilanz-Passiva: Eigenkapital (gezeich-
 *     netes + Rücklagen + Bilanzgewinn),
 *     Rückstellungen, Verbindlichkeiten
 *     (Kreditinstitute + Lieferungen + verb.
 *     Unternehmen), Passive RAP, Passive
 *     latente Steuern
 *   - G+V: Erträge (Umsatz + Bestandsverände-
 *     rungen + aktivierte Eigenleistungen +
 *     sonstige), Aufwendungen (Material +
 *     Personal + AfA + sonstige), Finanz-
 *     ergebnis (Beteiligungen + Wertpapiere +
 *     Zinserträge + Zinsaufwendungen +
 *     Abschreibungen Finanzanlagen), Steuern
 *     (Ertragsteuern + sonstige), Jahres-
 *     überschuss
 *   - Sonstige: Anhang, Lagebericht, Berichts-
 *     standard, Berichtszeitraum, Größenklasse
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
 * v3 (future) work:
 *   - Microsig taxonomy (small corps)
 *   - PK (Personengesellschaften) — separate
 *     vollständiger Anteil
 *   - Segment reporting
 *   - Deferred tax detail breakdown
 */

export type MappingSource =
  // BilanzService position keys (tier 81)
  | "bilanz.aktiva.fixass.intang"
  | "bilanz.aktiva.fixass.goodwill"
  | "bilanz.aktiva.fixass.grundstuecke"
  | "bilanz.aktiva.fixass.maschinen"
  | "bilanz.aktiva.fixass.betriebsausstattung"
  | "bilanz.aktiva.fixass.geleisteteAnzahlungen"
  | "bilanz.aktiva.fixass.finanzanlagen"
  | "bilanz.aktiva.currass.forderungen"
  | "bilanz.aktiva.currass.sonstige"
  | "bilanz.aktiva.currass.liquide"
  | "bilanz.aktiva.rap.aktive"
  | "bilanz.aktiva.latenteSteuern"
  | "bilanz.aktiva.summe"
  // Bilanz Passiva
  | "bilanz.passiva.cred.banken"
  | "bilanz.passiva.cred.tradl"
  | "bilanz.passiva.cred.anzahlungen"
  | "bilanz.passiva.cred.affil"
  | "bilanz.passiva.cred.kundenguthaben"
  | "bilanz.passiva.cred.sonstige"
  | "bilanz.passiva.rap.passive"
  | "bilanz.passiva.rueckstellungen"
  | "bilanz.passiva.latenteSteuern"
  | "bilanz.passiva.equity.subscribed"
  | "bilanz.passiva.equity.kapitalruecklage"
  | "bilanz.passiva.equity.gewinnruecklagen"
  | "bilanz.passiva.equity.bilanzgewinn"
  | "bilanz.passiva.equity.saldoposten"
  | "bilanz.passiva.summe"
  // G+V Service position keys (tier 82)
  | "guv.umsatzerloese"
  | "guv.bestandsveraenderungen"
  | "guv.eigenleistungen"
  | "guv.sonstigeErtrage"
  | "guv.materialaufwand"
  | "guv.personalaufwand"
  | "guv.afa"
  | "guv.sonstigeAufwendungen"
  | "guv.beteiligungsertrage"
  | "guv.wertpapierertraege"
  | "guv.sonstigeZinsertrage"
  | "guv.zinsaufwendungen"
  | "guv.afaFinanzanlagen"
  | "guv.ertraegeErtragsteuern" // negative (deducted from pre-tax profit)
  | "guv.sonstigeSteuern"
  | "guv.jahresueberschuss"
  | "guv.betriebsergebnis"
  | "guv.finanzergebnis"
  // Anlagenverzeichnis (tier 83)
  | "assets.totalAK"
  | "assets.totalBuchwert"
  | "assets.totalAfA"
  // Anhang (tier 84) — narrative
  | "anhang.narrative"
  // General information
  | "gen.berichtsstandard"
  | "gen.berichtszeitraum"
  | "gen.groessenklasse"
  // Manual (Berater fills in)
  | "manual.placeholder"

export interface EBilanzMapping {
  /** BMF taxonomy element ID, e.g. "de-gcd:bs.ass.fixAss.tangAss.othTangAss" */
  elementId: string
  /** Human-readable label for the VORSCHAU table */
  label: string
  /** Which tier's data feeds this position */
  source: MappingSource
  /**
   * BMF section. Tier 97 splits the v1
   * "bilanzAktiva/bilanzPassiva/guv/sonstige"
   * into sub-sections so the PDF / frontend
   * can group positions by HGB § 266 schema.
   *   - bilanzAktivaAnlage (Anlagevermögen)
   *   - bilanzAktivaUmlauf (Umlaufvermögen)
   *   - bilanzAktivaRap (Aktive RAP)
   *   - bilanzAktivaLatent (Aktive latente Steuern)
   *   - bilanzAktivaSumme (Summe Aktiva)
   *   - bilanzPassivaEigenkapital
   *   - bilanzPassivaRueckstellungen
   *   - bilanzPassivaVerbindlichkeiten
   *   - bilanzPassivaRap (Passive RAP)
   *   - bilanzPassivaLatent (Passive latente Steuern)
   *   - bilanzPassivaSumme (Summe Passiva)
   *   - guvErträge (Umsatzerlöse + Bestandsver. +
   *                 Eigenleistungen + sonstige)
   *   - guvAufwendungen (Material + Personal + AfA
   *                      + sonstige)
   *   - guvFinanzergebnis (Beteiligungen + WP +
   *                        Zinserträge + Zinsaufw +
   *                        AFA-Finanz)
   *   - guvSteuern (Ertrag + sonstige)
   *   - guvJahresergebnis (Jahresüberschuss)
   *   - sonstige (Anhang, Lagebericht, Info)
   */
  section:
    | "bilanzAktivaAnlage"
    | "bilanzAktivaUmlauf"
    | "bilanzAktivaRap"
    | "bilanzAktivaLatent"
    | "bilanzAktivaSumme"
    | "bilanzPassivaEigenkapital"
    | "bilanzPassivaRueckstellungen"
    | "bilanzPassivaVerbindlichkeiten"
    | "bilanzPassivaRap"
    | "bilanzPassivaLatent"
    | "bilanzPassivaSumme"
    | "guvErträge"
    | "guvAufwendungen"
    | "guvFinanzergebnis"
    | "guvSteuern"
    | "guvJahresergebnis"
    | "sonstige"
  /** Whether v2 can compute this from our data; false = Berater fills */
  computed: boolean
  /** Hint for the Berater or v3 */
  note?: string
}

/**
 * Tier 97: 55 positions covering the BMF GCD
 * 6.7 schema positions relevant to a typical
 * German SMB. The element IDs match the
 * published canonical names from the BMF
 * eBilanz-in-xtml reference. Positions marked
 * `computed: false` are placeholder values
 * the Berater fills in their ELSTER client
 * before submission.
 */
export const EBILANZ_MAPPING: EBilanzMapping[] = [
  // ===== Bilanz Aktiva — Anlagevermögen =====
  {
    elementId: "de-gcd:bs.ass.fixAss.intangAss",
    label: "Immaterialielle Vermögensgegenstände",
    source: "bilanz.aktiva.fixass.intang",
    section: "bilanzAktivaAnlage",
    computed: true,
  },
  {
    elementId: "de-gcd:bs.ass.fixAss.goodwill",
    label: "Geschäfts- oder Firmenwert",
    source: "bilanz.aktiva.fixass.goodwill",
    section: "bilanzAktivaAnlage",
    computed: false,
    note: "Aus Firmenwert-Akquisition; in de-invoice nicht erfasst. Berater füllt manuell.",
  },
  {
    elementId: "de-gcd:bs.ass.fixAss.tangAss.propAndBuild",
    label: "Grundstücke und Bauten",
    source: "bilanz.aktiva.fixass.grundstuecke",
    section: "bilanzAktivaAnlage",
    computed: true,
  },
  {
    elementId: "de-gcd:bs.ass.fixAss.tangAss.plantAndMach",
    label: "Maschinen",
    source: "bilanz.aktiva.fixass.maschinen",
    section: "bilanzAktivaAnlage",
    computed: true,
  },
  {
    elementId: "de-gcd:bs.ass.fixAss.tangAss.othTangAss",
    label: "Sonstige Sachanlagen / Betriebsausstattung",
    source: "bilanz.aktiva.fixass.betriebsausstattung",
    section: "bilanzAktivaAnlage",
    computed: true,
  },
  {
    elementId: "de-gcd:bs.ass.fixAss.tangAss.prepayments",
    label: "Geleistete Anzahlungen auf Sachanlagen",
    source: "bilanz.aktiva.fixass.geleisteteAnzahlungen",
    section: "bilanzAktivaAnlage",
    computed: false,
    note: "Anzahlungen auf Sachanlagen — de-invoice erfasst keine Anzahlungs-Buchungen. Berater füllt manuell.",
  },
  {
    elementId: "de-gcd:bs.ass.fixAss.finAss.sharesInAffil",
    label: "Anteile an verbundenen Unternehmen",
    source: "bilanz.aktiva.fixass.finanzanlagen",
    section: "bilanzAktivaAnlage",
    computed: false,
    note: "Beteiligungen — in de-invoice nicht erfasst. Berater füllt manuell.",
  },
  {
    elementId: "de-gcd:bs.ass.fixAss.finAss.othFinAss",
    label: "Sonstige Finanzanlagen",
    source: "bilanz.aktiva.fixass.finanzanlagen",
    section: "bilanzAktivaAnlage",
    computed: false,
    note: "Sonstige Finanzanlagen — in de-invoice nicht erfasst. Berater füllt manuell.",
  },
  // ===== Bilanz Aktiva — Umlaufvermögen =====
  {
    elementId: "de-gcd:bs.ass.currAssets.tradeReceivables",
    label: "Forderungen aus Lieferungen und Leistungen",
    source: "bilanz.aktiva.currass.forderungen",
    section: "bilanzAktivaUmlauf",
    computed: true,
  },
  {
    elementId: "de-gcd:bs.ass.currAssets.othReceivables",
    label: "Sonstige Vermögensgegenstände",
    source: "bilanz.aktiva.currass.sonstige",
    section: "bilanzAktivaUmlauf",
    computed: false,
    note: "Sonstige VG (z.B. Kautionen, Steuererstattungen) — in de-invoice nicht separat erfasst.",
  },
  {
    elementId: "de-gcd:bs.ass.currAssets.cashAndCashEquivalents",
    label: "Kassenbestand und Bankguthaben",
    source: "bilanz.aktiva.currass.liquide",
    section: "bilanzAktivaUmlauf",
    computed: true,
  },
  // ===== Bilanz Aktiva — Aktive RAP =====
  {
    elementId: "de-gcd:bs.ass.prepaidExp",
    label: "Aktive Rechnungsabgrenzungsposten",
    source: "bilanz.aktiva.rap.aktive",
    section: "bilanzAktivaRap",
    computed: true,
    note: "Aktive RAP — Annäherungsweise aus recurring invoices berechnet, deren Periode ins nächste Jahr reicht. Berater prüft.",
  },
  // ===== Bilanz Aktiva — Aktive latente Steuern =====
  {
    elementId: "de-gcd:bs.ass.deferredTax",
    label: "Aktive latente Steuern",
    source: "bilanz.aktiva.latenteSteuern",
    section: "bilanzAktivaLatent",
    computed: false,
    note: "Aktive latente Steuern — Steuerliche Bewertung, in de-invoice nicht erfasst. Berater füllt manuell.",
  },
  // ===== Bilanz Aktiva — Summe =====
  {
    elementId: "de-gcd:bs.ass.grossAssets",
    label: "Summe Aktiva",
    source: "bilanz.aktiva.summe",
    section: "bilanzAktivaSumme",
    computed: true,
    note: "Summe Aktiva = Bilanzgleichung (Passiva-Summe).",
  },
  // ===== Bilanz Passiva — Eigenkapital =====
  {
    elementId: "de-gcd:bs.equity.subscribedCapital",
    label: "Gezeichnetes Kapital",
    source: "bilanz.passiva.equity.subscribed",
    section: "bilanzPassivaEigenkapital",
    computed: false,
    note: "Stammkapital aus Company-Setup, in v2 nicht ausgewiesen. Berater füllt manuell.",
  },
  {
    elementId: "de-gcd:bs.equity.capitalReserve",
    label: "Kapitalrücklage",
    source: "bilanz.passiva.equity.kapitalruecklage",
    section: "bilanzPassivaEigenkapital",
    computed: false,
    note: "Kapitalrücklage — in de-invoice nicht erfasst. Berater füllt manuell.",
  },
  {
    elementId: "de-gcd:bs.equity.retainedEarningsReserve",
    label: "Gewinnrücklagen",
    source: "bilanz.passiva.equity.gewinnruecklagen",
    section: "bilanzPassivaEigenkapital",
    computed: false,
    note: "Gewinnrücklagen — in de-invoice nicht erfasst. Berater füllt manuell.",
  },
  {
    elementId: "de-gcd:bs.equity.netIncome",
    label: "Bilanzgewinn / Bilanzverlust",
    source: "bilanz.passiva.equity.bilanzgewinn",
    section: "bilanzPassivaEigenkapital",
    computed: true,
    note: "Bilanzgewinn = Jahresüberschuss aus G+V.",
  },
  {
    elementId: "de-gcd:bs.equity.retainedEarnings",
    label: "Eigenkapital-Saldoposten (Bilanzgleichung)",
    source: "bilanz.passiva.equity.saldoposten",
    section: "bilanzPassivaEigenkapital",
    computed: true,
    note: "Saldoposten — Bilanzgleichung. Berater ersetzt durch reale EK-Komponenten oben.",
  },
  // ===== Bilanz Passiva — Rückstellungen =====
  {
    elementId: "de-gcd:bs.liab.accr.provisionsForPensions",
    label: "Rückstellungen für Pensionen",
    source: "bilanz.passiva.rueckstellungen",
    section: "bilanzPassivaRueckstellungen",
    computed: false,
    note: "Pensionsrückstellungen — Versicherungsmathematische Bewertung. Berater füllt manuell.",
  },
  {
    elementId: "de-gcd:bs.liab.accr.taxProvisions",
    label: "Steuerrückstellungen",
    source: "bilanz.passiva.rueckstellungen",
    section: "bilanzPassivaRueckstellungen",
    computed: false,
    note: "Steuerrückstellungen — in de-invoice nicht erfasst. Berater füllt manuell.",
  },
  {
    elementId: "de-gcd:bs.liab.accr.othProvisions",
    label: "Sonstige Rückstellungen",
    source: "bilanz.passiva.rueckstellungen",
    section: "bilanzPassivaRueckstellungen",
    computed: false,
    note: "Sonstige Rückstellungen (z.B. für Gewährleistung, ausstehende Rechnungen) — in de-invoice nicht erfasst.",
  },
  // ===== Bilanz Passiva — Verbindlichkeiten =====
  {
    elementId: "de-gcd:bs.liab.cred.bankLoans",
    label: "Verbindlichkeiten gegenüber Kreditinstituten",
    source: "bilanz.passiva.cred.banken",
    section: "bilanzPassivaVerbindlichkeiten",
    computed: false,
    note: "Bankverbindlichkeiten — in de-invoice nicht erfasst. Berater füllt manuell.",
  },
  {
    elementId: "de-gcd:bs.liab.cred.advancesReceived",
    label: "Erhaltene Anzahlungen auf Bestellungen",
    source: "bilanz.passiva.cred.anzahlungen",
    section: "bilanzPassivaVerbindlichkeiten",
    computed: false,
    note: "Anzahlungen — in de-invoice nicht erfasst. Berater füllt manuell.",
  },
  {
    elementId: "de-gcd:bs.liab.cred.tradeLiabilities",
    label: "Verbindlichkeiten aus Lieferungen und Leistungen",
    source: "bilanz.passiva.cred.tradl",
    section: "bilanzPassivaVerbindlichkeiten",
    computed: true,
  },
  {
    elementId: "de-gcd:bs.liab.cred.affilLiab",
    label: "Verbindlichkeiten gegenüber verbundenen Unternehmen",
    source: "bilanz.passiva.cred.affil",
    section: "bilanzPassivaVerbindlichkeiten",
    computed: false,
    note: "Verbindlichkeiten gg. verb. Unternehmen — in de-invoice nicht erfasst. Berater füllt manuell.",
  },
  {
    elementId: "de-gcd:bs.liab.cred.othLiab",
    label: "Sonstige Verbindlichkeiten (Kundenguthaben)",
    source: "bilanz.passiva.cred.kundenguthaben",
    section: "bilanzPassivaVerbindlichkeiten",
    computed: true,
    note: "Sonstige Verbindlichkeiten — beinhaltet positive Kundenguthaben aus Überzahlungen (tier 58).",
  },
  {
    elementId: "de-gcd:bs.liab.cred.othLiabRemaining",
    label: "Sonstige Verbindlichkeiten (restliche)",
    source: "bilanz.passiva.cred.sonstige",
    section: "bilanzPassivaVerbindlichkeiten",
    computed: false,
    note: "Restliche sonstige Verbindlichkeiten (Steuern, Sozialversicherung) — in de-invoice nicht erfasst.",
  },
  // ===== Bilanz Passiva — Passive RAP =====
  {
    elementId: "de-gcd:bs.liab.deferredIncome",
    label: "Passive Rechnungsabgrenzungsposten",
    source: "bilanz.passiva.rap.passive",
    section: "bilanzPassivaRap",
    computed: false,
    note: "Passive RAP — in de-invoice nicht erfasst. Berater füllt manuell.",
  },
  // ===== Bilanz Passiva — Passive latente Steuern =====
  {
    elementId: "de-gcd:bs.liab.deferredTax",
    label: "Passive latente Steuern",
    source: "bilanz.passiva.latenteSteuern",
    section: "bilanzPassivaLatent",
    computed: false,
    note: "Passive latente Steuern — Steuerliche Bewertung, in de-invoice nicht erfasst. Berater füllt manuell.",
  },
  // ===== Bilanz Passiva — Summe =====
  {
    elementId: "de-gcd:bs.liab.grossLiabilities",
    label: "Summe Passiva",
    source: "bilanz.passiva.summe",
    section: "bilanzPassivaSumme",
    computed: true,
    note: "Summe Passiva = Bilanzgleichung (Aktiva-Summe).",
  },
  // ===== G+V — Erträge =====
  {
    elementId: "de-gcd:is.rev.netSales",
    label: "Umsatzerlöse (§ 275 HGB Pos 1)",
    source: "guv.umsatzerloese",
    section: "guvErträge",
    computed: true,
  },
  {
    elementId: "de-gcd:is.rev.chgInInv",
    label: "Bestandsveränderungen (§ 275 HGB Pos 2)",
    source: "guv.bestandsveraenderungen",
    section: "guvErträge",
    computed: true,
    note: "Bestandsveränderungen — 0 (de-invoice verwaltet kein Inventar).",
  },
  {
    elementId: "de-gcd:is.rev.othOwnWorkCap",
    label: "Andere aktivierte Eigenleistungen (§ 275 HGB Pos 3)",
    source: "guv.eigenleistungen",
    section: "guvErträge",
    computed: true,
    note: "Eigenleistungen — 0 (de-invoice aktiviert keine Eigenleistungen).",
  },
  {
    elementId: "de-gcd:is.rev.othOperRev",
    label: "Sonstige betriebliche Erträge (§ 275 HGB Pos 4)",
    source: "guv.sonstigeErtrage",
    section: "guvErträge",
    computed: true,
  },
  // ===== G+V — Aufwendungen =====
  {
    elementId: "de-gcd:is.exp.costOfMaterials",
    label: "Materialaufwand (§ 275 HGB Pos 5a)",
    source: "guv.materialaufwand",
    section: "guvAufwendungen",
    computed: true,
  },
  {
    elementId: "de-gcd:is.exp.employeeBenef",
    label: "Personalaufwand (§ 275 HGB Pos 6a)",
    source: "guv.personalaufwand",
    section: "guvAufwendungen",
    computed: true,
  },
  {
    elementId: "de-gcd:is.exp.deprecAndAmort",
    label: "Abschreibungen auf Sachanlagen (§ 275 HGB Pos 7a)",
    source: "guv.afa",
    section: "guvAufwendungen",
    computed: true,
    note: "Gebucht aus Anlagenverzeichnis (tier 87) wenn vorhanden, sonst berechnet.",
  },
  {
    elementId: "de-gcd:is.exp.othOperExp",
    label: "Sonstige betriebliche Aufwendungen (§ 275 HGB Pos 8)",
    source: "guv.sonstigeAufwendungen",
    section: "guvAufwendungen",
    computed: true,
  },
  // ===== G+V — Finanzergebnis =====
  {
    elementId: "de-gcd:is.fin.incFromPartic",
    label: "Erträge aus Beteiligungen (§ 275 HGB Pos 9)",
    source: "guv.beteiligungsertrage",
    section: "guvFinanzergebnis",
    computed: false,
    note: "Beteiligungserträge — in de-invoice nicht erfasst. Berater füllt manuell.",
  },
  {
    elementId: "de-gcd:is.fin.incFromSecLend",
    label: "Erträge aus anderen Wertpapieren (§ 275 HGB Pos 10)",
    source: "guv.wertpapierertraege",
    section: "guvFinanzergebnis",
    computed: false,
    note: "Wertpapiererträge — in de-invoice nicht erfasst. Berater füllt manuell.",
  },
  {
    elementId: "de-gcd:is.fin.othInterestInc",
    label: "Sonstige Zinsen und ähnliche Erträge (§ 275 HGB Pos 11)",
    source: "guv.sonstigeZinsertrage",
    section: "guvFinanzergebnis",
    computed: false,
    note: "Sonstige Zinserträge (z.B. Bankzinsen) — in de-invoice nicht separat erfasst. Berater füllt manuell.",
  },
  {
    elementId: "de-gcd:is.fin.exp.fromInterest",
    label: "Zinsen und ähnliche Aufwendungen (§ 275 HGB Pos 12)",
    source: "guv.zinsaufwendungen",
    section: "guvFinanzergebnis",
    computed: true,
    // Tier 97: from GuV position "13"
    // (§ 275 HGB Pos 13 = Zinsaufwendungen).
    note: "Zinsaufwand aus gebuchten Auslagen, Ratenplänen etc. (§ 275 HGB Pos 13).",
  },
  {
    elementId: "de-gcd:is.fin.exp.fromWriteDownsFin",
    label: "Abschreibungen auf Finanzanlagen (§ 275 HGB Pos 12)",
    source: "guv.afaFinanzanlagen",
    section: "guvFinanzergebnis",
    computed: false,
    note: "Abschreibungen auf Finanzanlagen — in de-invoice nicht erfasst. Berater füllt manuell.",
  },
  // ===== G+V — Steuern =====
  {
    elementId: "de-gcd:is.tax.incomeTax",
    label: "Steuern vom Einkommen und Ertrag (§ 275 HGB Pos 14)",
    source: "guv.ertraegeErtragsteuern",
    section: "guvSteuern",
    computed: false,
    note: "Ertragsteuern (Körperschaftsteuer, Gewerbesteuer) — in de-invoice nicht erfasst. Berater füllt manuell.",
  },
  {
    elementId: "de-gcd:is.tax.othTax",
    label: "Sonstige Steuern (§ 275 HGB Pos 16)",
    source: "guv.sonstigeSteuern",
    section: "guvSteuern",
    computed: false,
    note: "Sonstige Steuern (Kfz-Steuer, Grundsteuer) — in de-invoice nicht erfasst. Berater füllt manuell.",
  },
  // ===== G+V — Jahresergebnis =====
  {
    elementId: "de-gcd:is.netIncLoss",
    label: "Jahresüberschuss / Jahresfehlbetrag (§ 275 HGB Pos 17)",
    source: "guv.jahresueberschuss",
    section: "guvJahresergebnis",
    computed: true,
  },
  // ===== Sonstige — Anhang / Lagebericht / General info =====
  {
    elementId: "anhang.narrative",
    label: "Anhang (§ 284 HGB) — als PDF beigefügt",
    source: "anhang.narrative",
    section: "sonstige",
    computed: true,
    note: "Anhang wird nicht in XBRL kodiert (narrative). Anhang.pdf als Attachment.",
  },
  {
    elementId: "de-gcd:genInfo.reportingStandard",
    label: "Berichtsstandard (HGB / IFRS)",
    source: "gen.berichtsstandard",
    section: "sonstige",
    computed: false,
    note: "Berichtsstandard — HGB vorausgesetzt, in v2 nicht als XBRL-Fact kodiert. Berater bestätigt.",
  },
  {
    elementId: "de-gcd:genInfo.reportingPeriod",
    label: "Berichtszeitraum",
    source: "gen.berichtszeitraum",
    section: "sonstige",
    computed: false,
    note: "Berichtszeitraum — 01.01.-31.12. vorausgesetzt. Berater bestätigt abweichende Geschäftsjahre.",
  },
  {
    elementId: "de-gcd:genInfo.companySize",
    label: "Größenklasse (klein/mittel/groß)",
    source: "gen.groessenklasse",
    section: "sonstige",
    computed: false,
    note: "Größenklasse nach § 267 HGB — in de-invoice nicht erfasst. Berater klassifiziert.",
  },
  {
    elementId: "de-gcd:genInfo.lagebericht",
    label: "Lagebericht (§ 289 HGB)",
    source: "manual.placeholder",
    section: "sonstige",
    computed: false,
    note: "Lagebericht — in de-invoice nicht generiert. Berater erstellt manuell.",
  },
]

/**
 * Returns the count of positions that v2
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

/**
 * Section display titles for the PDF / frontend.
 * Tier 97: split Bilanz into 5 Aktiva + 5
 * Passiva sub-sections + 5 G+V sub-sections +
 * sonstige.
 */
export const SECTION_TITLE: Record<EBilanzMapping["section"], string> = {
  bilanzAktivaAnlage: "Aktiva — Anlagevermögen",
  bilanzAktivaUmlauf: "Aktiva — Umlaufvermögen",
  bilanzAktivaRap: "Aktiva — Rechnungsabgrenzungsposten",
  bilanzAktivaLatent: "Aktiva — Latente Steuern",
  bilanzAktivaSumme: "Aktiva — Summe",
  bilanzPassivaEigenkapital: "Passiva — Eigenkapital",
  bilanzPassivaRueckstellungen: "Passiva — Rückstellungen",
  bilanzPassivaVerbindlichkeiten: "Passiva — Verbindlichkeiten",
  bilanzPassivaRap: "Passiva — Rechnungsabgrenzungsposten",
  bilanzPassivaLatent: "Passiva — Latente Steuern",
  bilanzPassivaSumme: "Passiva — Summe",
  guvErträge: "G+V — Betriebliche Erträge",
  guvAufwendungen: "G+V — Betriebliche Aufwendungen",
  guvFinanzergebnis: "G+V — Finanzergebnis",
  guvSteuern: "G+V — Steuern",
  guvJahresergebnis: "G+V — Jahresergebnis",
  sonstige: "Sonstige — Anhang / Lagebericht / Generelle Infos",
}

/** Display order for sections (matches HGB § 266 order) */
export const SECTION_ORDER: EBilanzMapping["section"][] = [
  "bilanzAktivaAnlage",
  "bilanzAktivaUmlauf",
  "bilanzAktivaRap",
  "bilanzAktivaLatent",
  "bilanzAktivaSumme",
  "bilanzPassivaEigenkapital",
  "bilanzPassivaRueckstellungen",
  "bilanzPassivaVerbindlichkeiten",
  "bilanzPassivaRap",
  "bilanzPassivaLatent",
  "bilanzPassivaSumme",
  "guvErträge",
  "guvAufwendungen",
  "guvFinanzergebnis",
  "guvSteuern",
  "guvJahresergebnis",
  "sonstige",
]
