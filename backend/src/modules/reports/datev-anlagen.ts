/**
 * Tier 437 — the SKR03 accounts of a fixed asset and of its AfA, by the
 * asset's type.
 *
 * `Asset.bilanzKonto` is the balance-sheet position the app groups by
 * (0100–0500), not a DATEV account, so the export cannot use it. The AfA of
 * an asset is booked "AfA-Konto an Anlagekonto".
 */
export interface AnlagenKonten {
  anlage: string
  afa: string
}

export const SKR03_ANLAGEN: Record<string, AnlagenKonten> = {
  Software: { anlage: '0027', afa: '4822' },            // EDV-Software / Abschreibungen auf immaterielle VG
  Grundstueck: { anlage: '0065', afa: '4830' },         // unbebaute Grundstücke (no AfA)
  Gebaeude: { anlage: '0090', afa: '4831' },            // Geschäftsbauten / Abschreibungen auf Gebäude
  Maschine: { anlage: '0210', afa: '4830' },            // Maschinen / Abschreibungen auf Sachanlagen
  Fahrzeug: { anlage: '0320', afa: '4832' },            // Pkw / Abschreibungen auf Kfz
  Betriebsausstattung: { anlage: '0400', afa: '4830' }, // Betriebsausstattung
  GWG: { anlage: '0480', afa: '4860' },                 // GWG / Abschreibungen auf aktivierte GWG
  Sonstiges: { anlage: '0400', afa: '4830' },
}

export const SKR03_ANLAGEN_NAMES: Record<string, string> = {
  '0027': 'EDV-Software',
  '0065': 'Unbebaute Grundstücke',
  '0090': 'Geschäftsbauten',
  '0210': 'Maschinen',
  '0320': 'Pkw',
  '0400': 'Betriebsausstattung',
  '0480': 'Geringwertige Wirtschaftsgüter',
  '2310': 'Anlagenabgänge Sachanlagen (Restbuchwert bei Buchverlust)', // Tier 440
  '4822': 'Abschreibungen auf immaterielle Vermögensgegenstände',
  '4830': 'Abschreibungen auf Sachanlagen',
  '4831': 'Abschreibungen auf Gebäude',
  '4832': 'Abschreibungen auf Kfz',
  '4860': 'Abschreibungen auf aktivierte, geringwertige Wirtschaftsgüter',
}

export function anlagenKonten(type: string | null | undefined): AnlagenKonten {
  return SKR03_ANLAGEN[type ?? ''] ?? SKR03_ANLAGEN.Sonstiges
}
