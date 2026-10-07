/**
 * Tier 568 — the demo bank is not for a production installation.
 *
 * A mock connection ("Demo-Modus") writes three invented transactions
 * (`MOCK-…`) as a bank statement of format `fints-mock`. After that they are
 * bank transactions like any other: they are matched to open invoices and,
 * once confirmed, booked as payments. The checkbox was on by default in the
 * form and in the API (`mockMode ?? true`), in every environment — on a
 * production installation a user who did not untick it got invented money
 * they could book on real invoices.
 *
 * Now: allowed outside production (the specs and demos use it); in
 * production only with FINTS_ALLOW_MOCK=1.
 */
export function mockBankAllowed(): boolean {
  const flag = process.env.FINTS_ALLOW_MOCK
  if (flag === '1') return true
  if (flag === '0') return false
  return process.env.NODE_ENV !== 'production'
}

export const MOCK_BANK_REFUSED =
  'Der Demo-Modus (erfundene Bankumsätze) ist in dieser Installation nicht verfügbar. ' +
  'Für echte Kontobewegungen eine Bankverbindung ohne Demo-Modus anlegen oder Kontoauszüge importieren (MT940 / CAMT).'
