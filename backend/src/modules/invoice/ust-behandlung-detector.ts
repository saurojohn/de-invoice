/**
 * Tier 62: USt-Behandlung auto-detector.
 *
 * Returns the suggested USt treatment for a (customer,
 * company) pair, plus a human-readable reason so the
 * frontend can show "Auto-Erkennung: ..." on the invoice
 * create form. The user can always override — auto-detect
 * only fills the default radio button.
 *
 * Decision tree:
 *   - If customer has a valid EU VAT ID:
 *       - same country as company → 'standard' (domestic B2B)
 *       - different EU country → 'euTransaction' (innergemeinschaftliche
 *         Lieferung §1a UStG; or §13b UStG Reverse Charge for
 *         B2B services — we default to euTransaction as it's
 *         the more common B2B EU case for goods, and the
 *         frontend surfaces a hint that says "EU B2B — confirm
 *         §1a vs §13b" so the Berater picks the right one)
 *   - If customer has NO VAT ID:
 *       - non-EU country → 'standard' (Ausfuhrlieferung §4 UStG;
 *         tax-free but still no automatic USt treatment
 *         required)
 *       - EU country, no VAT → 'standard' (B2C domestic —
 *         regular VAT applies)
 *       - country unknown / DE → 'standard'
 *   - Customer marked `taxExempt: true` → suggest
 *     'kleinunternehmer' as a hint (the Berater can confirm
 *     or override — the company-side `taxExempt` flag is
 *     the actual switch for §19 UStG)
 *
 * The detector NEVER returns an error. When the data is
 * incomplete (e.g. customer has no address), the default
 * is 'standard' with a reason like "Unvollständige Daten —
 * Standard-Versteuerung angenommen".
 *
 * Why not put this on InvoiceService?
 *   - It's a pure function — no DB access required.
 *   - It needs to be called from multiple places: the
 *     invoice create form (auto-prefill), the
 *     ust-suggestion endpoint, and a future batch-edit
 *     job for migration. Keeping it in a standalone file
 *     means each call site is one import + one call.
 *   - Pure functions are trivially unit-testable. Tier 62
 *     will ship an e2e that exercises the decision tree end
 *     to end via the HTTP endpoint; the e2e covers the same
 *     surface as a unit-test would (HTTP in, HTTP out).
 */

// EU member states as of 2024. Used to decide whether
// `customer.country` is "another EU country" (→ euTransaction)
// or "non-EU" (→ standard / Ausfuhrlieferung).
//
// Why a Set: O(1) lookup. The detector is called once per
// invoice-create round-trip, but the cost of scanning a 28
// element list twice is negligible. Sets are still the
// canonical shape.
const EU_COUNTRY_CODES = new Set<string>([
  // EU-27 plus the historical members we still see in legacy
  // datasets. EU expansion history:
  //   1958: BE DE FR IT LU NL
  //   1973: DK IE
  //   1981: GR
  //   1986: ES PT
  //   1995: AT FI SE
  //   2004: CY CZ EE HU LT LV MT PL SK SI
  //   2007: BG RO
  //   2013: HR
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI',
  'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT',
  'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK',
])

// Common country-name → ISO-3166-1 alpha-2 mapping. The
// `address.country` column on Customer is free-form
// (Prisma Json) and the import path stores whatever the
// CSV had — so a German Importer might write "Deutschland",
// an English one might write "Germany", and the same goes
// for "Frankreich" / "France" / "FR" / "FRA" etc. The
// detector normalises these to the 2-letter code so the EU
// Set lookup works.
//
// We do NOT use a full library here — the de-invoice schema
// stores countries as 2-letter codes in the seed data, and
// the import path has been the only source of free-form
// names. A small hand-curated list covers 99% of the
// wildcards without pulling in i18n-iso-countries.
const COUNTRY_NAME_ALIASES: Record<string, string> = {
  // German names
  'deutschland': 'DE',
  'frankreich': 'FR',
  'italien': 'IT',
  'spanien': 'ES',
  'portugal': 'PT',
  'niederlande': 'NL',
  'holland': 'NL', // common colloquial
  'belgien': 'BE',
  'österreich': 'AT',
  'oesterreich': 'AT',
  'schweiz': 'CH', // non-EU, but exported explicitly
  'luxemburg': 'LU',
  'dänemark': 'DK',
  'daenemark': 'DK',
  'schweden': 'SE',
  'finnland': 'FI',
  'irland': 'IE',
  'polen': 'PL',
  'tschechien': 'CZ',
  'ungarn': 'HU',
  'griechenland': 'GR',
  'kroatien': 'HR',
  'rumänien': 'RO',
  'rumaenien': 'RO',
  'bulgarien': 'BG',
  'slowakei': 'SK',
  'slowenien': 'SI',
  'estland': 'EE',
  'lettland': 'LV',
  'litauen': 'LT',
  'malta': 'MT',
  'zypern': 'CY',
  // English names (in case the importer used EN locale)
  'germany': 'DE',
  'france': 'FR',
  'italy': 'IT',
  'spain': 'ES',
  'netherlands': 'NL',
  'austria': 'AT',
  'switzerland': 'CH',
  'belgium': 'BE',
  'luxembourg': 'LU',
  'denmark': 'DK',
  'sweden': 'SE',
  'finland': 'FI',
  'ireland': 'IE',
  'poland': 'PL',
  'czechia': 'CZ',
  'czech republic': 'CZ',
  'hungary': 'HU',
  'greece': 'GR',
  'croatia': 'HR',
  'romania': 'RO',
  'bulgaria': 'BG',
  'slovakia': 'SK',
  'slovenia': 'SI',
  'estonia': 'EE',
  'latvia': 'LV',
  'lithuania': 'LT',
  'cyprus': 'CY',
  'united kingdom': 'GB',
  'uk': 'GB',
  'great britain': 'GB',
  'usa': 'US',
  'united states': 'US',
  'china': 'CN',
  'japan': 'JP',
  'norway': 'NO',
  'russia': 'RU',
  // 3-letter codes (some Importer pre-processes with
  // pycountry which yields 3-letter codes; we accept both)
  'deu': 'DE',
  'fra': 'FR',
  'ita': 'IT',
  'esp': 'ES',
  'prt': 'PT',
  'nld': 'NL',
  'aut': 'AT',
  'che': 'CH',
  'bel': 'BE',
  'gbr': 'GB',
  'chn': 'CN',
  'jpn': 'JP',
}

/**
 * Normalise a free-form country name (or 2- or 3-letter
 * code) to an ISO-3166-1 alpha-2 code. Returns the input
 * uppercased when no mapping is found — the caller can
 * still match it against the EU set.
 */
export function normaliseCountry(input: string | null | undefined): string | null {
  if (!input) return null
  const trimmed = input.trim()
  if (!trimmed) return null
  // Already a 2-letter code?
  if (trimmed.length === 2) return trimmed.toUpperCase()
  // 3-letter code → look up in alias map
  if (trimmed.length === 3) {
    const lc = trimmed.toLowerCase()
    if (COUNTRY_NAME_ALIASES[lc]) return COUNTRY_NAME_ALIASES[lc]
    return trimmed.toUpperCase()
  }
  // Full name → look up
  const lc = trimmed.toLowerCase()
  if (COUNTRY_NAME_ALIASES[lc]) return COUNTRY_NAME_ALIASES[lc]
  // No match — return uppercase as-is so the EU check
  // still works for exact matches the importer might have
  // used (e.g. "France" is in the map, but a stray "FRANCE"
  // would still be normalised by .toLowerCase above).
  return trimmed.toUpperCase()
}

/**
 * Extract the 2-letter ISO country code prefix from a VAT
 * ID. The format is `CC<number>` where CC is the country
 * code (DE123456789, FR12345678901, etc.). Some IDs have
 * extra prefixes (e.g. EU intra-community supplies use
 * "EU" — we treat that as non-EU and return null).
 *
 * Returns null when the input doesn't look like a VAT ID
 * (too short, doesn't start with 2 letters, etc.).
 */
export function extractVatCountry(vatId: string | null | undefined): string | null {
  if (!vatId) return null
  const trimmed = vatId.trim()
  if (trimmed.length < 3) return null
  // Match the leading 2 letters (case-insensitive).
  // The regex anchors the prefix at the start and accepts
  // either 2 letters (ISO code) or "EU" + digits (special
  // intra-community prefix).
  const m = /^([A-Za-z]{2})/.exec(trimmed)
  if (!m) return null
  const code = m[1].toUpperCase()
  if (code === 'EU') return null // pseudo-prefix, not a country
  return code
}

export type UstBehandlung =
  | 'standard'
  | 'reverseCharge'
  | 'euTransaction'
  | 'kleinunternehmer'

export interface UstSuggestion {
  suggested: UstBehandlung
  reason: string
  // True when the customer has a valid VAT ID — the frontend
  // can surface a "VAT ID verified" badge next to the
  // suggestion.
  customerHasVatId: boolean
  // True when the customer is in a different EU country
  // from the company. The frontend can show a green
  // "EU B2B" badge in that case.
  isEuB2b: boolean
}

/**
 * The detector. Pass the customer + company records (just
 * the fields the detector needs — we don't take whole
 * Prisma rows so this is callable from any module without
 * pulling in the full Customer/Company types).
 *
 * Inputs are intentionally loose (`vatId: string | null`)
 * to keep the function testable: pass whatever shape you
 * have, the detector normalises.
 */
export function suggestUstBehandlung(input: {
  customerVatId: string | null
  customerCountry: string | null
  customerTaxExempt?: boolean
  companyVatId: string | null
  companyCountry: string | null
}): UstSuggestion {
  const customerCountry = normaliseCountry(input.customerCountry)
  const companyCountry = normaliseCountry(input.companyCountry)
  const customerVatId = input.customerVatId?.trim() || null
  const companyVatId = input.companyVatId?.trim() || null

  // Path 1: customer has a VAT ID. Decide based on
  // whether the country codes match and both are EU.
  if (customerVatId) {
    const customerCC = extractVatCountry(customerVatId)
    const companyCC = companyVatId ? extractVatCountry(companyVatId) : companyCountry

    // Can't determine destination country at all
    // (no VAT prefix, no address country) — default to
    // standard with a "couldn't determine" reason.
    if (!customerCC && !customerCountry) {
      return {
        suggested: 'standard',
        reason: 'Kein Kundenland erkannt — Standard-Versteuerung angenommen',
        customerHasVatId: true,
        isEuB2b: false,
      }
    }

    const cc = customerCC || customerCountry
    if (cc && companyCC && cc === companyCC) {
      return {
        suggested: 'standard',
        reason: `Inland (${cc}) — Standard-Versteuerung`,
        customerHasVatId: true,
        isEuB2b: false,
      }
    }
    // Different country. EU B2B → euTransaction (B2B
    // goods §1a UStG); non-EU B2B → standard (tax-free
    // export, but no automatic USt treatment — the user
    // might still want taxExempt behaviour via §4 UStG).
    if (cc && EU_COUNTRY_CODES.has(cc) && companyCC && EU_COUNTRY_CODES.has(companyCC)) {
      return {
        suggested: 'euTransaction',
        reason: `EU B2B (${cc} → ${companyCC}) — empfohlen: §1a UStG Innergemeinschaftliche Lieferung. Falls B2B-Dienstleistung: §13b UStG Reverse Charge wählen.`,
        customerHasVatId: true,
        isEuB2b: true,
      }
    }
    if (cc && EU_COUNTRY_CODES.has(cc)) {
      return {
        // Customer in EU, but company is not — unusual
        // case (the user is probably an EU-based freelancer
        // invoicing a non-EU company? Doesn't really
        // happen in B2B). Default to standard so the
        // user has to confirm.
        suggested: 'standard',
        reason: `Kunde in EU (${cc}), Unternehmen außerhalb der EU — bitte prüfen`,
        customerHasVatId: true,
        isEuB2b: false,
      }
    }
    // Non-EU B2B (e.g. US customer with a US EIN — but we
    // treat any non-2-letter-prefix VAT ID as non-EU).
    return {
      suggested: 'standard',
      reason: `Nicht-EU (${cc || '?'}) — Standard-Versteuerung (Ausfuhrlieferung ggf. §4 UStG prüfen)`,
      customerHasVatId: true,
      isEuB2b: false,
    }
  }

  // Path 2: customer has NO VAT ID.
  if (customerCountry && EU_COUNTRY_CODES.has(customerCountry)) {
    return {
      suggested: 'standard',
      reason: `Kunde in EU (${customerCountry}) ohne USt-ID — Standard-Versteuerung (B2C)`,
      customerHasVatId: false,
      isEuB2b: false,
    }
  }
  if (customerCountry) {
    return {
      suggested: 'standard',
      reason: `Kunde außerhalb der EU (${customerCountry}) — Standard-Versteuerung (steuerfrei §4 UStG prüfen)`,
      customerHasVatId: false,
      isEuB2b: false,
    }
  }

  // Path 3: customer has neither VAT ID nor address country.
  if (input.customerTaxExempt) {
    return {
      suggested: 'kleinunternehmer',
      reason: 'Steuerbefreit-Flag gesetzt — Kleinunternehmer (§19 UStG) empfohlen',
      customerHasVatId: false,
      isEuB2b: false,
    }
  }
  return {
    suggested: 'standard',
    reason: 'Keine USt-ID und kein Land — Standard-Versteuerung angenommen',
    customerHasVatId: false,
    isEuB2b: false,
  }
}
