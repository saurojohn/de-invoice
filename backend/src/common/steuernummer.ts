import { BadRequestException } from '@nestjs/common'

/**
 * Tier 734 — the Steuernummer in the 13-digit form ELSTER takes
 * ("bundeseinheitliches Schema für ELSTER").
 *
 * The tax office prints it in its Land's own form („Standardschema"), e.g.
 * Bayern „181/815/08155". ELSTER wants the four-digit Bundesfinanzamtsnummer,
 * a 0, then district, distinguishing number and check digit:
 * 9181 0 815 0815 5. The leading digits of the Finanzamt's number are not
 * printed (Bayern „9", Brandenburg / Sachsen / Sachsen-Anhalt „3", …), so the
 * Land is needed: a 10- or 11-digit number fits several Länder.
 *
 * Before, `normaliseSteuernummer` (elster.service.ts) appended „00" to an
 * 11-digit number and put „0" before and „00" after a 10-digit one — no Land
 * writes it so: Bayern's 181/815/08155 became 1818150815500 instead of
 * 9181081508155, a number of another Finanzamt or none.
 *
 * Table: Wikipedia „Steuernummer" (table „Aufbau"), Lexware help „Steuernummer"
 * (20.02.2026) and rechtlogisch/steuernummer (MIT), which agree but for the
 * Saarland's printed form (10 or 11 digits — both lead to the same 13). The
 * check digit is not verified here.
 */

export const BUNDESLAENDER = ['BW', 'BY', 'BE', 'BB', 'HB', 'HH', 'HE', 'MV', 'NI', 'NW', 'RP', 'SL', 'SN', 'ST', 'SH', 'TH'] as const
export type Bundesland = (typeof BUNDESLAENDER)[number]

export const BUNDESLAND_NAMEN: Record<Bundesland, string> = {
  BW: 'Baden-Württemberg', BY: 'Bayern', BE: 'Berlin', BB: 'Brandenburg', HB: 'Bremen', HH: 'Hamburg',
  HE: 'Hessen', MV: 'Mecklenburg-Vorpommern', NI: 'Niedersachsen', NW: 'Nordrhein-Westfalen',
  RP: 'Rheinland-Pfalz', SL: 'Saarland', SN: 'Sachsen', ST: 'Sachsen-Anhalt', SH: 'Schleswig-Holstein', TH: 'Thüringen',
}

/**
 * Per Land: the printed form (for the message), and how its digits become the
 * Bundesfinanzamtsnummer — `lead` + the printed Finanzamt digits — and the
 * leading digits that number has in this Land (`bufa`).
 */
const SCHEMA: Record<Bundesland, { printed: string; forms: Array<{ len: number; lead: string; fa: number; skip?: number }>; bufa: string }> = {
  BW: { printed: 'FFBBB/UUUUP', forms: [{ len: 10, lead: '28', fa: 2 }], bufa: '28' },
  BY: { printed: 'FFF/BBB/UUUUP', forms: [{ len: 11, lead: '9', fa: 3 }], bufa: '9' },
  BE: { printed: 'FF/BBB/UUUUP', forms: [{ len: 10, lead: '11', fa: 2 }], bufa: '11' },
  BB: { printed: 'FFF/BBB/UUUUP', forms: [{ len: 11, lead: '3', fa: 3 }], bufa: '30' },
  HB: { printed: 'FF BBB UUUUP', forms: [{ len: 10, lead: '24', fa: 2 }], bufa: '24' },
  HH: { printed: 'FF/BBB/UUUUP', forms: [{ len: 10, lead: '22', fa: 2 }], bufa: '22' },
  // printed with a leading 0 that is not part of the number
  HE: { printed: '0FF BBB UUUUP', forms: [{ len: 11, lead: '26', fa: 2, skip: 1 }, { len: 10, lead: '26', fa: 2 }], bufa: '26' },
  MV: { printed: 'FFF/BBB/UUUUP', forms: [{ len: 11, lead: '4', fa: 3 }], bufa: '40' },
  NI: { printed: 'FF/BBB/UUUUP', forms: [{ len: 10, lead: '23', fa: 2 }], bufa: '23' },
  // a four-digit district, a three-digit distinguishing number
  NW: { printed: 'FFF/BBBB/UUUP', forms: [{ len: 11, lead: '5', fa: 3 }], bufa: '5' },
  RP: { printed: 'FF/BBB/UUUUP', forms: [{ len: 10, lead: '27', fa: 2 }], bufa: '27' },
  SL: { printed: 'FFF/BBB/UUUUP', forms: [{ len: 11, lead: '1', fa: 3 }, { len: 10, lead: '10', fa: 2 }], bufa: '10' },
  SN: { printed: 'FFF/BBB/UUUUP', forms: [{ len: 11, lead: '3', fa: 3 }], bufa: '32' },
  ST: { printed: 'FFF/BBB/UUUUP', forms: [{ len: 11, lead: '3', fa: 3 }], bufa: '31' },
  SH: { printed: 'FF BBB UUUUP', forms: [{ len: 10, lead: '21', fa: 2 }], bufa: '21' },
  TH: { printed: 'FFF/BBB/UUUUP', forms: [{ len: 11, lead: '4', fa: 3 }], bufa: '41' },
}

export function isBundesland(v: unknown): v is Bundesland {
  return typeof v === 'string' && (BUNDESLAENDER as readonly string[]).includes(v)
}

/**
 * The 13-digit ELSTER form of `taxId`, or why there is none. A number given
 * in the 13-digit (or the 12-digit federal) form is taken as it is when its
 * fifth digit is the 0 and — with a Land — its Finanzamt is one of that Land.
 */
export function elsterSteuernummerOrProblem(taxId: string | null | undefined, land: string | null | undefined): { value: string } | { problem: string } {
  const raw = (taxId ?? '').trim()
  if (!raw) return { problem: 'Steuernummer im Firmenprofil fehlt. Bitte unter „Einstellungen“ ergänzen.' }
  const digits = raw.replace(/[\s/.-]/g, '')
  if (!/^\d+$/.test(digits)) return { problem: `Die Steuernummer ${raw} enthält andere Zeichen als Ziffern, Leerzeichen und „/“.` }
  const schema = isBundesland(land) ? SCHEMA[land] : null
  const ofLand = (n: string) => !schema || n.startsWith(schema.bufa)
  const landName = isBundesland(land) ? BUNDESLAND_NAMEN[land] : ''
  if (digits.length === 13 || digits.length === 12) {
    const n = digits.length === 12 ? `${digits.slice(0, 4)}0${digits.slice(4)}` : digits
    if (n[4] !== '0') return { problem: `Die 13-stellige Steuernummer ${raw} hat an der fünften Stelle keine 0 — so schreibt ELSTER sie nicht.` }
    if (!ofLand(n)) return { problem: `Die Steuernummer ${raw} ist keine eines Finanzamts in ${landName} (dort beginnt sie mit ${schema!.bufa}).` }
    return { value: n }
  }
  if (!schema) {
    return { problem: `Für die 13-stellige ELSTER-Steuernummer fehlt das Bundesland des Finanzamts — bitte unter „Einstellungen“ wählen (die Steuernummer ${raw} passt zu mehreren Ländern).` }
  }
  const form = schema.forms.find((f) => f.len === digits.length)
  if (!form) {
    return { problem: `Die Steuernummer ${raw} passt nicht zu ${landName}: dort hat sie ${schema.forms.map((f) => f.len).join(' oder ')} Ziffern (${schema.printed}).` }
  }
  const d = digits.slice(form.skip ?? 0)
  if (form.skip && digits[0] !== '0') return { problem: `Die Steuernummer ${raw} passt nicht zu ${landName}: dort beginnt sie mit 0 (${schema.printed}).` }
  const n = `${form.lead}${d.slice(0, form.fa)}0${d.slice(form.fa)}`
  if (n.length !== 13 || !ofLand(n)) {
    return { problem: `Die Steuernummer ${raw} ist keine eines Finanzamts in ${landName} (${schema.printed}; die Finanzamtsnummer beginnt dort mit ${schema.bufa}).` }
  }
  return { value: n }
}

/** The 13-digit ELSTER Steuernummer, or a 400 saying what is missing. */
export function elsterSteuernummer(taxId: string | null | undefined, land: string | null | undefined): string {
  const r = elsterSteuernummerOrProblem(taxId, land)
  if ('problem' in r) throw new BadRequestException(r.problem)
  return r.value
}
