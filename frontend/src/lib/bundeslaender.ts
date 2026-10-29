/**
 * Tier 734 — the Länder a company's Finanzamt can be in, as the backend takes
 * them (Company.bundesland, backend common/steuernummer.ts). The Land turns
 * the Steuernummer as printed into ELSTER's 13-digit form.
 */
export const BUNDESLAENDER: Array<[code: string, name: string]> = [
  ["BW", "Baden-Württemberg"], ["BY", "Bayern"], ["BE", "Berlin"], ["BB", "Brandenburg"], // i18n-ok: the names of the Länder
  ["HB", "Bremen"], ["HH", "Hamburg"], ["HE", "Hessen"], ["MV", "Mecklenburg-Vorpommern"], // i18n-ok: the names of the Länder
  ["NI", "Niedersachsen"], ["NW", "Nordrhein-Westfalen"], ["RP", "Rheinland-Pfalz"], ["SL", "Saarland"], // i18n-ok: the names of the Länder
  ["SN", "Sachsen"], ["ST", "Sachsen-Anhalt"], ["SH", "Schleswig-Holstein"], ["TH", "Thüringen"], // i18n-ok: the names of the Länder
]
