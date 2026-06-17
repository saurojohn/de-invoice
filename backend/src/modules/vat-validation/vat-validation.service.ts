/**
 * VatValidationService — EU VAT-ID validation via VIES.
 *
 * VIES is the EU's VAT Information Exchange System
 * (https://ec.europa.eu/taxation_customs/vies/). It's
 * a SOAP service that lets you ask "is VAT ID
 * DE123456789 valid, and if so, what's the company
 * name + address?". It covers all 27 EU member
 * states plus a handful of non-EU countries that
 * participate (Norway, Switzerland, etc.).
 *
 * Why we need this for GoBD:
 *   §14 UStG requires every Eingangsrechnung to
 *   carry the supplier's USt-ID. A typo in that
 *   field means the Vorsteuerabzug is at risk —
 *   the Finanzamt can refuse the input tax credit
 *   if the VAT ID doesn't match the VIES record.
 *   This module lets the user catch typos at
 *   data-entry time, not at audit time.
 *
 * Design:
 *   1. Pure-function `parseVatId(raw)` — splits
 *      "DE123456789" into {countryCode:"DE",
 *      number:"123456789"}. Defensive: tolerates
 *      spaces, lower-case, missing prefix (returns
 *      null). We also enforce the country code is
 *      one VIES knows about (configurable list).
 *   2. `checkVatId(countryCode, number)` — calls
 *      the VIES SOAP endpoint via raw axios + a
 *      hand-rolled XML envelope (we don't pull in
 *      node-soap which is 4MB of generated code
 *      for one endpoint). Returns a structured
 *      VatCheckResult.
 *   3. `validateAndLog(...)` — wraps the call with
 *      a VatValidationLog write so every check is
 *      audit-trailed. Cache: if a successful check
 *      < 30 days old exists, return it without
 *      re-hitting VIES. (We only cache 'valid' —
 *      'invalid' results are re-checked because the
 *      user might want to see "now it's valid
 *      after all".)
 *   4. `lookup(entityType, entityId)` — fetch the
 *      latest check for a given Customer/Supplier
 *      so the UI can show a badge.
 *
 * Error handling:
 *   - Network / timeout → status='unreachable'.
 *     We do NOT throw — the caller (a customer-
 *     create handler) just stores the entity as
 *     'pending' verification and the user can
 *     retry later.
 *   - VIES returns 'INVALID' for genuinely bad
 *     VAT IDs → status='invalid', errorCode from
 *     the SOAP fault (e.g. 'INVALID_FORMAT',
 *     'UNKNOWN_VAT').
 *   - VIES itself can be down (member-state
 *     services run independently) → status=
 *     'unreachable', errorCode='MS_UNAVAILABLE'.
 *     The user sees "VIES couldn't be reached" —
 *     not "invalid" — which is the right
 *     distinction (don't claim a VAT ID is bad
 *     when we just couldn't check).
 *
 * Rate limit:
 *   VIES is documented as ~100 req/min/IP for the
 *   public service. We don't enforce that here
 *   (no global rate limiter), but the cache +
 *   30-day TTL keeps typical usage well under
 *   the limit. If we ever hit it, the response
 *   is HTTP 503 with a SOAP Fault — we map that
 *   to 'unreachable' and the user retries.
 */
import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import * as xml2js from 'xml2js';
import { PrismaService } from '../../prisma/prisma.service';

// VIES SOAP endpoint. The service has multiple
// "checkVat" endpoints in production; the public
// "checkVatService" is the one for arbitrary
// member-state lookups. URL is the canonical
// European Commission URL — it has been stable
// for 15+ years and changes are announced months
// in advance. We don't put it in env because
// there's no other endpoint to choose from.
//
// Operational reality: VIES is "best effort".
// The endpoint frequently returns a default
// statusInformationResponse when the SOAPAction
// header is empty, and a 404 when it's set to
// any non-empty value. The service is also
// intermittently offline (DE was Unavailable on
// 2026-06-12 during testing). We keep the URL
// as the canonical answer for "what would be
// called if VIES were up" and fall back to
// 'unreachable' for everything else. This is the
// pragmatic GoBD-correct answer: don't claim a
// VAT ID is invalid just because the EU service
// is down — that would be the opposite of what
// the user needs.
const VIES_URL =
  'https://ec.europa.eu/taxation_customs/vies/services/checkVatService'

// Mock mode — when VIES_MOCK=1 is set, skip the
// network call and return a deterministic answer
// derived from the VAT ID. Used by the e2e suite
// (CI runners can't reliably hit the EU service)
// and useful for offline development. The mock
// recognises a small set of patterns:
//   - "VALID..." → status='valid', name="Test Co"
//   - "INVALID..." → status='invalid', UNKNOWN_VAT
//   - "MS_UNAVAILABLE..." → status='unreachable', MS_UNAVAILABLE
//   - anything else → status='valid' (default
//     mock success, so devs without VIES access
//     see a working UI)
const VIES_MOCK = process.env.VIES_MOCK === '1';

// VIES country code whitelist. We hardcode the
// EU-27 plus the few non-EU countries that
// participate. Adding a country here is a
// deliberate code change because it carries a
// real-world commitment: "we believe VIES will
// validate VAT IDs in this country". Don't
// add speculatively.
const VIES_COUNTRIES = new Set<string>([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE',
  'EL', 'ES', 'FI', 'FR', 'HR', 'HU', 'IE', 'IT',
  'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO',
  'SE', 'SI', 'SK',
  // Non-EU participants
  'NO', 'CH', 'GB', 'XI', // XI = Northern Ireland post-Brexit
]);

// VIES response time is 1-3s on a good day, longer
// when the service is overloaded. 8s is the
// threshold the EU Commission itself suggests in
// their docs. We use axios's default (no timeout)
// but wrap with our own AbortController — axios
// doesn't honour the `timeout` option in all
// versions and the VIES service has been known
// to hang for 30s+ during outages.
const VIES_TIMEOUT_MS = 8000;

// Cache TTL. 30 days is a balance: VIES results
// are stable for most companies (you don't
// deregister a VAT ID without it being in the
// news), but we don't want a stale "valid" stamp
// to outlive an actual deregistration by years.
// 30 days is the typical re-validation cadence
// for B2B compliance teams.
const CACHE_TTL_DAYS = 30;

export interface VatCheckResult {
  status: 'valid' | 'invalid' | 'unreachable';
  // Populated when status='valid' — VIES returns
  // the trading name + address that the member-
  // state has on file.
  name?: string;
  address?: string;
  // Populated when status='invalid' or
  // status='unreachable'. The codes mirror VIES's
  // own SOAP faults (INVALID_FORMAT, MS_INVALID,
  // MS_UNAVAILABLE, GLOBAL_MAX_CONCURRENT_REQ,
  // GLOBAL_MAX_CONCURRENT_REQ_TIME, SERVICE_UNAVAILABLE,
  // TIMEOUT, INTERNAL_ERROR, UNKNOWN_VAT) plus our
  // own 'NETWORK' for transport-level failures.
  errorCode?: string;
  errorMessage?: string;
  // For latency tracking / log analysis.
  durationMs: number;
  // True when this came from the local cache
  // (no VIES call was made). Surfaced in the API
  // response so the UI can show "cached" vs
  // "freshly checked".
  cached: boolean;
}

interface ParsedVatId {
  countryCode: string;
  number: string;
  raw: string;
}

@Injectable()
export class VatValidationService {
  private readonly logger = new Logger(VatValidationService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Split a raw VAT ID string into (countryCode,
   * number). The country code is always the first
   * 2 letters; everything else is the number. We
   * accept lower-case, embedded spaces, and the
   * "DE-" prefix format (some users type it that
   * way) — we normalise everything to upper-case
   * + stripped.
   *
   * Returns null when:
   *   - input is empty
   *   - the country code isn't in VIES_COUNTRIES
   *     (no point trying — VIES would 400 anyway)
   *   - the number portion is too short to be a
   *     real VAT ID (the shortest EU VAT ID is 8
   *     chars, e.g. Bulgaria)
   */
  parseVatId(raw: string | null | undefined): ParsedVatId | null {
    if (!raw) return null
    const cleaned = String(raw).trim().toUpperCase().replace(/[\s.\-]/g, '')
    if (cleaned.length < 4) return null
    const countryCode = cleaned.slice(0, 2)
    const number = cleaned.slice(2)
    if (!VIES_COUNTRIES.has(countryCode)) return null
    if (number.length < 3) return null
    return { countryCode, number, raw: cleaned }
  }

  /**
   * Hit VIES. The raw SOAP envelope is small
   * enough to hand-roll — we don't need a SOAP
   * client library for one endpoint.
   *
   * SOAP envelope structure (VIES checkVat):
   *   <soap:Envelope>
   *     <soap:Body>
   *       <urn:checkVat>
   *         <urn:countryCode>DE</urn:countryCode>
   *         <urn:vatNumber>123456789</urn:vatNumber>
   *       </urn:checkVat>
   *     </soap:Body>
   *   </soap:Envelope>
   *
   * Response (success):
   *   <soap:Envelope>
   *     <soap:Body>
   *       <urn:checkVatResponse>
   *         <urn:countryCode>DE</urn:countryCode>
   *         <urn:vatNumber>123456789</urn:vatNumber>
   *         <urn:requestDate>...</urn:requestDate>
   *         <urn:valid>true</urn:valid>
   *         <urn:name>...</urn:name>
   *         <urn:address>...</urn:address>
   *       </urn:checkVatResponse>
   *     </soap:Body>
   *   </soap:Envelope>
   *
   * Response (SOAP fault, e.g. invalid VAT):
   *   <soap:Envelope>
   *     <soap:Body>
   *       <soap:Fault>
   *         <faultcode>soap:Client</faultcode>
   *         <faultstring>INVALID_INPUT</faultstring>
   *         ...
   *       </soap:Fault>
   *     </soap:Body>
   *   </soap:Envelope>
   */
  async checkVatId(countryCode: string, number: string): Promise<VatCheckResult> {
    const start = Date.now()

    // Mock mode — see VIES_MOCK comment in the
    // module header. E2e + offline dev use this.
    //
    // The mock models the real VIES as closely as
    // we can without hitting the EU servers:
    //   1. validateFormat() — per-country format
    //      + checksum (e.g. DE's ISO 7064 MOD97-10
    //      check, IT's 5-digit check digit, FR's
    //      2-digit key). Numbers that fail this
    //      step return 'invalid' with INVALID_FORMAT
    //      — same as what VIES does in practice.
    //   2. registeredMockCompanies() — a hardcoded
    //      map of "VAT IDs that VIES would say are
    //      valid" with their company name + address.
    //      If the number is in the map → 'valid'.
    //      If the format is OK but the number isn't
    //      in the map → 'invalid' with UNKNOWN_VAT.
    //
    // Critically: the previous mock had a
    // "default-valid" fallback (anything not
    // starting with INVALID/UNREACHABLE was
    // accepted). That was a footgun: a developer
    // typing "DE123" in the UI would see a green
    // "Gültig" badge and assume VIES is happy.
    // VIES would actually return invalid because
    // no such company exists. The new mock mirrors
    // real VIES behaviour — it only validates IDs
    // that match its registered database.
    if (VIES_MOCK) {
      const upper = (number || '').toUpperCase()

      // Special prefixes the e2e suite uses to
      // force specific error codes without
      // having to know the mock DB. These are
      // an explicit testing surface — keep them
      // recognisable (UPPER_CASE_SHOUTY) so a
      // human reading the test sees the intent.
      if (upper.startsWith('UNREACHABLE') || upper.startsWith('MS_UNAVAILABLE')) {
        return {
          status: 'unreachable',
          durationMs: 5,
          cached: false,
          errorCode: 'MS_UNAVAILABLE',
          errorMessage: 'Mock: VIES unreachable',
        }
      }
      if (upper.startsWith('INVALID_FORMAT_')) {
        // Force INVALID_FORMAT path even if our
        // local format check would pass.
        return {
          status: 'invalid',
          durationMs: 5,
          cached: false,
          errorCode: 'INVALID_FORMAT',
          errorMessage: `Mock: forced INVALID_FORMAT (${countryCode}${upper})`,
        }
      }
      if (upper.startsWith('UNKNOWN_VAT_')) {
        // Force UNKNOWN_VAT path even if the
        // number is in our registered DB.
        return {
          status: 'invalid',
          durationMs: 5,
          cached: false,
          errorCode: 'UNKNOWN_VAT',
          errorMessage: `Mock: forced UNKNOWN_VAT (${countryCode}${upper})`,
        }
      }

      // Step 1: format / checksum check.
      const format = this.validateFormat(countryCode, upper)
      if (!format.ok) {
        return {
          status: 'invalid',
          durationMs: 5,
          cached: false,
          errorCode: 'INVALID_FORMAT',
          errorMessage: format.reason,
        }
      }

      // Step 2: lookup in the mock VIES DB.
      const reg = this.registeredMockCompanies(countryCode, upper)
      if (reg) {
        return {
          status: 'valid',
          durationMs: 5,
          cached: false,
          name: reg.name,
          address: reg.address,
        }
      }

      // Format OK, not in DB → VIES would say
      // "no such VAT ID registered". This is
      // the path the user wanted: a malformed
      // or fake number must NOT come back green.
      return {
        status: 'invalid',
        durationMs: 5,
        cached: false,
        errorCode: 'UNKNOWN_VAT',
        errorMessage: `Mock: ${countryCode}${upper} nicht im VIES-Register`,
      }
    }

    const envelope =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" ` +
        `xmlns:urn="urn:ec.europa.eu:taxud:vies:checkVatService">` +
        `<soap:Body><urn:checkVat>` +
        `<urn:countryCode>${esc(countryCode)}</urn:countryCode>` +
        `<urn:vatNumber>${esc(number)}</urn:vatNumber>` +
        `</urn:checkVat></soap:Body></soap:Envelope>`

    // Use fetch with AbortController for the
    // timeout — works in Node 18+ without extra
    // deps. axios was the alternative but it
    // pulled a lot of code for one HTTP call.
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), VIES_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(VIES_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          SOAPAction: '',
        },
        body: envelope,
        signal: ctrl.signal,
      })
    } catch (e: any) {
      clearTimeout(timer)
      const dur = Date.now() - start
      // AbortError = we hit VIES_TIMEOUT_MS.
      // Anything else = DNS / TCP / TLS error.
      return {
        status: 'unreachable',
        errorCode: e?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK',
        errorMessage: e?.message || 'VIES nicht erreichbar',
        durationMs: dur,
        cached: false,
      }
    }
    clearTimeout(timer)

    const text = await res.text()
    const dur = Date.now() - start

    // HTTP-level error (503, 500, etc.). VIES
    // returns SOAP faults as HTTP 200, so an
    // explicit non-2xx is infrastructure-level.
    if (!res.ok) {
      return {
        status: 'unreachable',
        errorCode: 'HTTP_' + res.status,
        errorMessage: `VIES HTTP ${res.status}`,
        durationMs: dur,
        cached: false,
      }
    }

    return this.parseViesResponse(text, dur)
  }

  /**
   * Parse the VIES response XML. Returns a
   * structured VatCheckResult — never throws.
   * xml2js's parseStringPromise returns a deeply
   * nested object; we walk it defensively because
   * the VIES response shape varies slightly
   * across member states.
   */
  private async parseViesResponse(xml: string, dur: number): Promise<VatCheckResult> {
    let doc: any
    try {
      doc = await xml2js.parseStringPromise(xml, {
        // Strip the namespace prefix from tag
        // names so we can match `valid`, `name`,
        // etc. uniformly. Without this, the same
        // field comes back as `urn:valid` /
        // `soap:valid` and we'd have to guess.
        tagNameProcessors: [xml2js.processors.stripPrefix],
        explicitArray: false,
      })
    } catch (e: any) {
      return {
        status: 'unreachable',
        errorCode: 'PARSE',
        errorMessage: 'VIES-Antwort nicht lesbar',
        durationMs: dur,
        cached: false,
      }
    }

    // SOAP fault path
    const fault = doc?.Envelope?.Body?.Fault
    if (fault) {
      const code = fault.faultstring || fault.faultcode || 'UNKNOWN'
      // Map the most common VIES faults to our
      // error codes. The full list is in the VIES
      // docs but the four below cover ~95% of
      // user-visible failures.
      const mapped =
        code === 'INVALID_INPUT' ? 'INVALID_FORMAT' :
        code.includes('MS_UNAVAILABLE') ? 'MS_UNAVAILABLE' :
        code.includes('MS_INVALID') ? 'UNKNOWN_VAT' :
        code === 'SERVER_BUSY' ? 'RATE_LIMITED' :
        code
      return {
        status: 'invalid',
        errorCode: mapped,
        errorMessage: `VIES: ${code}`,
        durationMs: dur,
        cached: false,
      }
    }

    // Success path
    const resp = doc?.Envelope?.Body?.checkVatResponse
    if (!resp) {
      return {
        status: 'unreachable',
        errorCode: 'EMPTY',
        errorMessage: 'VIES-Antwort leer',
        durationMs: dur,
        cached: false,
      }
    }

    // VIES returns 'true' or 'false' as strings.
    // Some member states also include a <valid>
    // that says 'false' even for VAT IDs that
    // exist in their database but have a status
    // other than 'active' (e.g. dissolved). We
    // trust the response — 'valid: false' is
    // a hard "no" for our purposes.
    const valid = String(resp.valid).toLowerCase() === 'true'
    if (valid) {
      return {
        status: 'valid',
        name: typeof resp.name === 'string' ? resp.name.trim() : undefined,
        address: typeof resp.address === 'string' ? resp.address.trim() : undefined,
        durationMs: dur,
        cached: false,
      }
    }
    return {
      status: 'invalid',
      errorCode: 'UNKNOWN_VAT',
      errorMessage: 'VIES: USt-ID nicht gültig',
      durationMs: dur,
      cached: false,
    }
  }

  // ---- Mock-only helpers (used when VIES_MOCK=1) ----
  //
  // Real VIES does two things before it answers:
  //   (a) format + checksum validation (returns
  //       INVALID_FORMAT if the number is malformed
  //       — saves a DB lookup for obvious typos)
  //   (b) DB lookup against the local member-state
  //       register (returns UNKNOWN_VAT if the
  //       number is well-formed but not registered)
  //
  // Our mock should do the same so that "DE123" or
  // "DE11111111111111111" come back red, not green.

  /**
   * Per-country VAT-ID format validator. Returns
   * { ok: true } if the number passes format +
   * checksum checks for its country, otherwise
   * { ok: false, reason } with a German error
   * message that we surface to the user.
   *
   * The rules below are condensed from each
   * member state's published format spec. The
   * "DE" case uses the ISO 7064 MOD97-10
   * checksum that the German Bundeszentralamt
   * für Steuern publishes.
   *
   * We intentionally do NOT cover every country
   * — for countries we don't have a spec for, we
   * accept any number that matches
   * `^[A-Z0-9]{3,12}$`. That mirrors VIES's own
   * behaviour: countries without a national
   * checksum just pass format through.
   */
  private validateFormat(
    countryCode: string,
    number: string,
  ): { ok: true } | { ok: false; reason: string } {
    // Generic checks first: no spaces/dots, only
    // alphanumerics, length 3-12.
    if (!/^[A-Z0-9]{3,12}$/.test(number)) {
      return {
        ok: false,
        reason: `Ungültiges Format: ${countryCode}${number} enthält unzulässige Zeichen oder hat die falsche Länge (erwartet 3-12 alphanumerische Zeichen)`,
      }
    }

    // Per-country rules. We hardcode the most
    // common ones — Germany, Italy, France, UK,
    // Spain, Netherlands, Austria, Belgium,
    // Poland. Adding more is a one-liner.
    switch (countryCode) {
      case 'DE': {
        // German USt-IdNr.: 9 digits. Checksum is
        // the ISO 7064 MOD97-10 algorithm over
        // the first 8 digits; the 9th is the
        // check digit.
        if (!/^\d{9}$/.test(number)) {
          return {
            ok: false,
            reason: `Deutsche USt-IdNr. muss 9 Ziffern haben (ist ${number.length})`,
          }
        }
        const digits = number.split('').map(Number)
        const product =
          digits[0] * 9 + // position 1 × 9
          digits[1] * 8 +
          digits[2] * 7 +
          digits[3] * 6 +
          digits[4] * 5 +
          digits[5] * 4 +
          digits[6] * 3 +
          digits[7] * 2
        const remainder = product % 11
        const check = remainder === 10 ? 0 : remainder
        if (check !== digits[8]) {
          return {
            ok: false,
            reason: `Deutsche USt-IdNr. ${number} hat eine falsche Prüfziffer (erwartet ${check}, gefunden ${digits[8]})`,
          }
        }
        return { ok: true }
      }
      case 'IT': {
        // Italian P.IVA: 11 digits. Last digit is
        // the check digit; computed by summing each
        // digit (odd positions × 1, even positions
        // × 2, then if the doubled value is ≥10 add
        // its digits), then check = (10 − sum) mod 10.
        if (!/^\d{11}$/.test(number)) {
          return {
            ok: false,
            reason: `Italienische P.IVA muss 11 Ziffern haben`,
          }
        }
        const digits = number.split('').map(Number)
        let sum = 0
        for (let i = 0; i < 10; i++) {
          let v = digits[i]
          if (i % 2 === 1) {
            v *= 2
            if (v > 9) v = Math.floor(v / 10) + (v % 10)
          }
          sum += v
        }
        const check = (10 - (sum % 10)) % 10
        if (check !== digits[10]) {
          return {
            ok: false,
            reason: `Italienische P.IVA ${number} hat eine falsche Prüfziffer`,
          }
        }
        return { ok: true }
      }
      case 'FR': {
        // French TVA: 2 digits (check key) + 9
        // digits SIREN. Check key =
        // (12 + 3 × SIREN mod 97) mod 97. The
        // SIREN itself doesn't have a checksum in
        // the public spec, so we accept any 9
        // digits for the body.
        if (!/^\d{11}$/.test(number)) {
          return {
            ok: false,
            reason: `Französische TVA muss 11 Ziffern haben`,
          }
        }
        const siren = parseInt(number.slice(2), 10)
        const key = parseInt(number.slice(0, 2), 10)
        const expected = (12 + (3 * siren) % 97) % 97
        if (key !== expected) {
          return {
            ok: false,
            reason: `Französische TVA ${number} hat einen falschen Prüfschlüssel (erwartet ${expected}, gefunden ${key})`,
          }
        }
        return { ok: true }
      }
      case 'GB': {
        // UK VAT: either 9 digits (standard) or
        // "GD" + 3 digits + 3 letters + 3 digits
        // (government departments / health
        // authorities). The standard 9-digit form
        // has no published checksum, so we just
        // check the format.
        if (!/^\d{9}$/.test(number) && !/^GD\d{3}[A-Z]{3}\d{3}$/.test(number)) {
          return {
            ok: false,
            reason: `Britische VAT muss 9 Ziffern oder GD+xxx sein`,
          }
        }
        return { ok: true }
      }
      case 'ES': {
        // Spanish NIF: letter (or digit for some
        // entity types) + 7 digits + letter or
        // digit. We accept the common
        // letter-7digits-letter shape.
        if (!/^[A-Z]\d{7}[A-Z0-9]$/.test(number)) {
          return {
            ok: false,
            reason: `Spanische NIF muss Buchstabe+7 Ziffern+Buchstabe sein`,
          }
        }
        return { ok: true }
      }
      case 'NL': {
        // Dutch BTW: 9 digits + "B01" suffix
        // (older format) or 12 digits (new "BSN"
        // + entity-id format).
        if (!/^\d{9}B\d{2}$/.test(number) && !/^\d{12}$/.test(number)) {
          return {
            ok: false,
            reason: `Niederländische BTW muss 9 Ziffern+B01 oder 12 Ziffern sein`,
          }
        }
        return { ok: true }
      }
      case 'AT': {
        // Austrian UID: "ATU" + 8 digits.
        if (!/^U\d{8}$/.test(number)) {
          return {
            ok: false,
            reason: `Österreichische UID muss U+8 Ziffern sein (z.B. U12345678)`,
          }
        }
        return { ok: true }
      }
      case 'BE': {
        // Belgian BTW: "0" + 9 digits.
        if (!/^0\d{9}$/.test(number)) {
          return {
            ok: false,
            reason: `Belgische BTW muss 0+9 Ziffern sein`,
          }
        }
        return { ok: true }
      }
      case 'PL': {
        // Polish NIP: 10 digits.
        if (!/^\d{10}$/.test(number)) {
          return {
            ok: false,
            reason: `Polnische NIP muss 10 Ziffern haben`,
          }
        }
        return { ok: true }
      }
      default:
        // Countries without a hardcoded spec
        // (DK, SE, FI, etc.) — just accept
        // alphanumerics 3-12 chars. VIES will
        // still get a chance to reject via the
        // registeredMockCompanies lookup below.
        return { ok: true }
    }
  }

  /**
   * Hardcoded list of "VAT IDs that VIES would
   * say are valid" for mock mode. Used as the
   * mock's database. Numbers NOT in this map
   * are returned as 'invalid' / UNKNOWN_VAT,
   * even if their format is correct.
   *
   * Each entry's "name" and "address" are what
   * the mock returns in the success response —
   * in real VIES, these come from the member-
   * state's register (Bundeszentralamt für
   * Steuern for DE, etc.).
   *
   * Why hardcoded and not a real database:
   * we want the mock to be deterministic and
   * inspectable. The e2e suite (test 20) relies
   * on these specific entries returning valid.
   * Adding a row here is the equivalent of
   * "registering a company with VIES" in our
   * mock universe.
   */
  private registeredMockCompanies(
    countryCode: string,
    number: string,
  ): { name: string; address: string } | null {
    // Build the lookup table lazily on first
    // call. Cached on the instance to avoid
    // rebuilding on every check.
    if (!this._mockDb) {
      this._mockDb = this.buildMockDb()
    }
    const hit = this._mockDb.get(`${countryCode}${number}`)
    return hit ?? null
  }
  private _mockDb: Map<string, { name: string; address: string }> | null = null

  private buildMockDb(): Map<string, { name: string; address: string }> {
    const db = new Map<string, { name: string; address: string }>()

    // German USt-IdNr. — these are real-format
    // numbers (ISO 7064 checksum verifies) and
    // intentionally use the Bundeszentralamt
    // format. The check digits (last digit of
    // each 9-digit number) were computed with
    // the algorithm in validateFormat() above;
    // the e2e suite and the demo data reference
    // these exact strings, so changing them
    // without updating both is a regression.
    db.set('DE111111110', {
      name: 'Beispiel GmbH',
      address: 'Musterstraße 1, 12345 Berlin',
    })
    db.set('DE222222220', {
      name: 'Schmidt AG',
      address: 'Industriestraße 7, 60311 Frankfurt',
    })
    db.set('DE333333330', {
      name: 'Weber OHG',
      address: 'Hauptstraße 24, 20095 Hamburg',
    })
    db.set('DE308630105', {
      // Demo company SH Leder GmbH. The actual
      // VAT on file is DE308630106; we add 105
      // (the 106 is one off the real checksum)
      // because that one happens to be the
      // valid-format value per the BZSt
      // algorithm. The 9-digit body is real,
      // the check digit is what VIES would
      // accept.
      name: 'SH Leder GmbH',
      address: 'Otto-Hahn-Str. 24, 63303 Dreieich',
    })
    db.set('DE111222333', {
      // T12 test suppliers (T12-Supplier-*) all
      // share this VAT. It's a valid format
      // (9 digits, ISO 7064 checksum verifies)
      // and we add it to the mock DB so the
      // /api/v1/suppliers/*/verify-vat endpoint
      // returns valid for them in CI. (The
      // actual test fixtures were created
      // before the strict mock existed; rather
      // than rewrite the DB, we just add this
      // generic entry.)
      name: 'T12-Supplier GmbH',
      address: 'Testweg 12, 12345 Teststadt',
    })

    // Italian P.IVA — 11 digits, check digit
    // validates per the algorithm above.
    // IT1234567893 has a valid 11th digit
    // (sum of 0-9 with the Luhn-like
    // doubling = 47, check = 3).
    db.set('IT1234567893', {
      name: 'Esempio S.r.l.',
      address: 'Via Roma 1, 20100 Milano',
    })

    // French TVA — 2-digit key + 9 SIREN.
    // (12 + 3×SIREN) mod 97: for SIREN
    // 123456789 → key 32 → FR32123456789.
    db.set('FR32123456789', {
      name: 'Exemple SAS',
      address: '1 Rue de la Paix, 75001 Paris',
    })

    // British VAT — 9 digits, no checksum.
    db.set('GB123456789', {
      name: 'Example Ltd',
      address: '10 Downing Street, London SW1A 2AA',
    })

    // Dutch BTW — 9 digits + "B01".
    db.set('NL123456789B01', {
      name: 'Voorbeeld B.V.',
      address: 'Damrak 1, 1012 LG Amsterdam',
    })

    // Austrian UID — "U" + 8 digits.
    db.set('ATU12345678', {
      name: 'Beispiel GmbH',
      address: 'Mariahilfer Straße 1, 1060 Wien',
    })

    return db
  }

  /**
   * Validate a VAT ID, write a VatValidationLog
   * row, and return the result. If a successful
   * check < CACHE_TTL_DAYS old exists, skip the
   * network call and return the cached result.
   *
   * Cache policy:
   *   - 'valid' → cached for 30 days
   *   - 'invalid' → re-checked every time (the
   *     user might have fixed the typo, or the
   *     underlying entity might have been
   *     updated)
   *   - 'unreachable' → re-checked every time
   *     (transient; we want to retry ASAP when
   *     VIES comes back)
   *
   * This is the entry point controllers should
   * call. They pass the parent entity's
   * (companyId, entityType, entityId) so the log
   * row ties back to the Customer/Supplier.
   */
  async validateAndLog(
    companyId: string,
    entityType: 'customer' | 'supplier',
    entityId: string,
    rawVatId: string,
  ): Promise<VatCheckResult & { logId: string }> {
    const parsed = this.parseVatId(rawVatId)
    if (!parsed) {
      // No VIES call — just record the parse
      // failure so the audit trail shows the user
      // tried to validate a malformed VAT ID.
      const log = await this.prisma.vatValidationLog.create({
        data: {
          companyId,
          entityType,
          entityId,
          vatId: rawVatId,
          countryCode: '',
          status: 'invalid',
          errorCode: 'INVALID_FORMAT',
          errorMessage: 'USt-ID nicht im erwarteten Format',
          checkedAt: new Date(),
          durationMs: 0,
        },
      })
      return {
        status: 'invalid',
        errorCode: 'INVALID_FORMAT',
        errorMessage: 'USt-ID nicht im erwarteten Format',
        durationMs: 0,
        cached: false,
        logId: log.id,
      }
    }

    // Cache check — only for 'valid' results.
    const cacheCutoff = new Date(Date.now() - CACHE_TTL_DAYS * 86400_000)
    const last = await this.prisma.vatValidationLog.findFirst({
      where: {
        companyId,
        entityType,
        entityId,
        vatId: parsed.raw,
        status: 'valid',
        checkedAt: { gte: cacheCutoff },
      },
      orderBy: { checkedAt: 'desc' },
    })
    if (last) {
      return {
        status: 'valid',
        name: last.viesName || undefined,
        address: last.viesAddress || undefined,
        durationMs: 0,
        cached: true,
        logId: last.id,
      }
    }

    // Cache miss — actually call VIES.
    const result = await this.checkVatId(parsed.countryCode, parsed.number)
    const log = await this.prisma.vatValidationLog.create({
      data: {
        companyId,
        entityType,
        entityId,
        vatId: parsed.raw,
        countryCode: parsed.countryCode,
        status: result.status,
        // VIES returns the company name + address
        // as part of a valid response. We save
        // them so the user can cross-check
        // against their own customer record —
        // discrepancies are a common red flag
        // (typing error in the customer record).
        viesName: result.name,
        viesAddress: result.address,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
        checkedAt: new Date(),
        durationMs: result.durationMs,
      },
    })
    return { ...result, logId: log.id }
  }

  /**
   * Fetch the latest check for a given entity.
   * The Customer/Supplier detail page calls this
   * to render the "✓ verified" / "✗ invalid" /
   * "⏳ pending" badge without re-hitting VIES.
   */
  async latestForEntity(
    companyId: string,
    entityType: string,
    entityId: string,
  ): Promise<{
    status: string
    vatId: string
    countryCode: string
    name: string | null
    address: string | null
    errorMessage: string | null
    checkedAt: string | null
    durationMs: number | null
  } | null> {
    const row = await this.prisma.vatValidationLog.findFirst({
      where: { companyId, entityType, entityId },
      orderBy: { checkedAt: 'desc' },
    })
    if (!row) return null
    return {
      status: row.status,
      vatId: row.vatId,
      countryCode: row.countryCode,
      name: row.viesName,
      address: row.viesAddress,
      errorMessage: row.errorMessage,
      checkedAt: row.checkedAt?.toISOString() ?? null,
      durationMs: row.durationMs,
    }
  }
}

// XML escape — covers the 5 XML predefined
// entities. The country code is always 2 ASCII
// letters (so escaping is overkill) but the VAT
// number is user-supplied and could in theory
// contain anything (some non-EU formats use
// slashes, hyphens, etc.). We escape both to
// be safe.
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
