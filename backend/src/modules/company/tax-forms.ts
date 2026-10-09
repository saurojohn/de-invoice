/**
 * Tier 643 — which of the accounting page's forms a company files.
 *
 * The page listed all nineteen for everyone: a GmbH was offered Anlage N
 * (wages), Anlage Kind and Anlage R (pensions) — annexes of a natural
 * person's income tax return — next to its KSt 1, and a freelancer the
 * corporation tax return. By legal form (company/rechtsform.ts) and the way
 * the profit is determined (company/gewinnermittlung.ts):
 *
 *   everyone            the Berater package, UStJA, the GoBD archive
 *   a corporation       KSt 1, GewSt, Bilanz, G+V, Anhang, E-Bilanz
 *   a sole trader       Anlage G, GewSt, the annexes of the owner's own return
 *   a freelancer        Anlage S, the annexes of the owner's own return
 *   a partnership       GewSt where it is a trade (not GbR / PartG by default);
 *                       its partners' annexes are theirs, not the company's
 *   EÜR or Bilanz       by the profit determination; the Anhang (§ 264 HGB)
 *                       for corporations and the GmbH & Co. KG (§ 264a)
 *
 * An unknown legal form says nothing: every form applies, as before.
 */
import { isKapitalgesellschaft, resolveRechtsform } from './rechtsform'
import { resolveGewinnermittlung } from './gewinnermittlung'

export const TAX_FORMS = [
  'beraterPackager', 'euer', 'anlageS', 'anlageV', 'anlageKAP', 'anlageG', 'anlageN', 'kst1',
  'anlageR', 'anlageKind', 'anlageSO', 'anlageAUS', 'ustja', 'gewst', 'bilanz', 'guv', 'anhang',
  'ebilanz', 'gobdArchive',
] as const
export type TaxForm = (typeof TAX_FORMS)[number]

const PERSONAL: TaxForm[] = ['anlageV', 'anlageKAP', 'anlageN', 'anlageR', 'anlageKind', 'anlageSO', 'anlageAUS']

export function applicableTaxForms(company: {
  rechtsform?: string | null
  gewinnermittlung?: string | null
  settings?: unknown
  legalName?: string | null
  name?: string | null
}) {
  const { rechtsform, source } = resolveRechtsform(company)
  const gewinnermittlung = resolveGewinnermittlung(company).art
  if (!rechtsform) {
    return { rechtsform: null, rechtsformSource: null, gewinnermittlung, forms: [...TAX_FORMS] as TaxForm[], other: [] as TaxForm[] }
  }
  const yes = new Set<TaxForm>(['beraterPackager', 'ustja', 'gobdArchive'])
  const add = (...forms: TaxForm[]) => forms.forEach((f) => yes.add(f))
  if (isKapitalgesellschaft(rechtsform)) add('kst1', 'gewst', 'anhang')
  if (rechtsform === 'Einzelunternehmen') add('anlageG', 'gewst', ...PERSONAL)
  if (rechtsform === 'Freiberufler') add('anlageS', ...PERSONAL)
  if (['OHG', 'KG', 'GmbH & Co. KG'].includes(rechtsform)) add('gewst')
  if (rechtsform === 'GmbH & Co. KG') add('anhang')
  if (gewinnermittlung === 'bilanz') add('bilanz', 'guv', 'ebilanz')
  else add('euer')
  return {
    rechtsform,
    rechtsformSource: source,
    gewinnermittlung,
    forms: TAX_FORMS.filter((f) => yes.has(f)),
    other: TAX_FORMS.filter((f) => !yes.has(f)),
  }
}
