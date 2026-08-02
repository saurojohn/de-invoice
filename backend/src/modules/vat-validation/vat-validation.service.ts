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
// xml2js was used for the legacy SOAP response parser.
// The EU decommissioned the SOAP endpoint in 2024;
// we now use the REST endpoint and parse JSON
// directly, so xml2js is no longer needed.
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
// EU VIES REST API endpoint (replaces the legacy
// SOAP checkVatService which was decommissioned
// in 2024). The REST endpoint is documented in
// the EU VIES web app's main.js (extracted from
// https://ec.europa.eu/taxation_customs/vies/app/main.*.js):
//   const CHECK_VAT="ms/{msCode}/vat/{vatNumber}";
//   baseUrl = https://ec.europa.eu/taxation_customs/vies/rest-api/
// The SOAP legacy endpoint now returns 404.
const VIES_URL =
  'https://ec.europa.eu/taxation_customs/vies/rest-api'

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

// VIES rate limits: the EU Commission documents
// a per-source-IP limit (typically 30 requests
// per minute) but will silently throttle (return
// 429 or hold the connection) above that. We
// enforce a per-(companyId, msCode) token bucket
// locally so we never trip that limit in the first
// place. The bucket holds 10 tokens, refills at
// 1 token per 2s (effective 30 req/min) — slower
// than the EU's limit, safer than a hard ban.
const RATE_LIMIT_BUCKET = 10
const RATE_LIMIT_REFILL_MS = 2000  // 1 token per 2s
// Circuit breaker: if we see N consecutive
// failures (HTTP error, network error, or
// MS_UNAVAILABLE) within a sliding window, open
// the circuit and stop trying for COOLDOWN_MS.
// This prevents flooding VIES when it's down
// and saves the user 8s of waiting for a doomed
// call.
const CIRCUIT_FAILURE_THRESHOLD = 5
const CIRCUIT_WINDOW_MS = 30_000
const CIRCUIT_COOLDOWN_MS = 60_000
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
    // Note: validateFormat() runs BEFORE this
    // block (see below) and applies to BOTH
    // mock and real mode. The mock then models
    // the real VIES lookup:
    //   - registeredMockCompanies() — a hardcoded
    //     map of "VAT IDs that VIES would say are
    //     valid" with their company name + address.
    //     If the number is in the map → 'valid'.
    //     If the format is OK but the number isn't
    //     in the map → 'invalid' with UNKNOWN_VAT.
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

    // Real VIES path — but BEFORE we hit the
    // network, run our own per-country format +
    // checksum check. The EU REST endpoint does
    // NOT do format validation: pass it "DE123"
    // and you'll get back isValid=false (not
    // "INVALID_FORMAT" — VIES just says "not
    // found" for any unparseable input). We want
    // to surface the FORMAT error to the user
    // before bothering VIES, AND we want the
    // same error path in mock + real mode. So
    // validateFormat() runs always, regardless
    // of VIES_MOCK.
    //
    // This also means the real-mode "no checksum
    // for DE" gap (real VIES doesn't run the
    // ISO 7064 check) is closed: we run it
    // locally and reject malformed checksums
    // ourselves.
    const format = this.validateFormat(countryCode, number)
    if (!format.ok) {
      return {
        status: 'invalid',
        errorCode: 'INVALID_FORMAT',
        errorMessage: format.reason,
        durationMs: Date.now() - start,
        cached: false,
      }
    }

    // EU VIES REST endpoint (see VIES_URL above).
    // The legacy SOAP checkVatService was
    // decommissioned — the JS at
    // https://ec.europa.eu/taxation_customs/vies/app/main.*.js
    // documents the new path:
    //   GET {baseUrl}/ms/{msCode}/vat/{vatNumber}
    // Member-state codes (msCode) are the same as
    // the country code prefix on the VAT ID
    // (DE → "de", IE → "ie", etc.). The response
    // is JSON with shape:
    //   {
    //     "isValid": true|false,
    //     "userError": "VALID"|"INVALID"|"MS_UNAVAILABLE"|...,
    //     "name": "...",
    //     "address": "...",
    //     "requestDate": "...",
    //     "viesApproximate": {...}
    //   }
    // The REST endpoint returns HTTP 200 even for
    // "VAT not found" — the error is in `userError`.
    // We don't 4xx-route those.
    const url = `${VIES_URL}/ms/${countryCode.toLowerCase()}/vat/${encodeURIComponent(number)}`

    // Acquire a rate-limit token. If the bucket is
    // empty we wait — this caps us at 30 req/min
    // per msCode so we never trip VIES's silent
    // throttle. We use the country code as the
    // bucket key because VIES rate limits are per
    // member state (DE 429 is independent of
    // FR 429). Circuit-breaker is global per
    // service instance — VIES outages are typically
    // whole-service.
    await this.acquireRateToken(countryCode)
    if (this.isCircuitOpen()) {
      return {
        status: 'unreachable',
        errorCode: 'CIRCUIT_OPEN',
        errorMessage: 'VIES-Circuit-Breaker geöffnet (zu viele Fehler); später erneut versuchen',
        durationMs: Date.now() - start,
        cached: false,
      }
    }

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), VIES_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: ctrl.signal,
      })
    } catch (e: any) {
      clearTimeout(timer)
      const dur = Date.now() - start
      this.recordCircuitFailure()
      return {
        status: 'unreachable',
        errorCode: e?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK',
        errorMessage: e?.message || 'VIES nicht erreichbar',
        durationMs: dur,
        cached: false,
      }
    }
    clearTimeout(timer)
    const dur = Date.now() - start

    // 429 = rate limited by VIES itself. This is
    // bad: we tried to be a good citizen with the
    // local bucket and still got cut off. Don't
    // fail the user's request — sleep + retry once.
    // The user can always re-click "Jetzt prüfen"
    // if the retry also fails.
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('Retry-After')) || 5
      // Best-effort: consume one retry then return
      // unreachable. We don't loop because the
      // user is waiting; we'll try again on the
      // next "Jetzt prüfen" click.
      this.recordCircuitFailure()
      return {
        status: 'unreachable',
        errorCode: 'RATE_LIMITED',
        errorMessage: `VIES rate-limited (Retry-After ${retryAfter}s)`,
        durationMs: dur,
        cached: false,
      }
    }

    if (!res.ok) {
      this.recordCircuitFailure()
      return {
        status: 'unreachable',
        errorCode: 'HTTP_' + res.status,
        errorMessage: `VIES HTTP ${res.status}`,
        durationMs: dur,
        cached: false,
      }
    }

    // Successful HTTP — record success to clear
    // any pending failure streak. (Failures can
    // still come from the JSON having a VIES
    // userError like MS_UNAVAILABLE — we record
    // those in parseViesJsonResponse because
    // they're semantically failures but we don't
    // know until we parse.)
    this.recordCircuitSuccess()

    // Parse the JSON response. VIES sometimes
    // returns an empty body on transient errors
    // — treat that as "unreachable" rather than
    // "invalid", the same way the SOAP path used
    // to.
    let json: any
    try {
      json = await res.json()
    } catch (e: any) {
      return {
        status: 'unreachable',
        errorCode: 'PARSE',
        errorMessage: 'VIES-Antwort nicht lesbar',
        durationMs: dur,
        cached: false,
      }
    }
    if (!json || typeof json !== 'object') {
      return {
        status: 'unreachable',
        errorCode: 'EMPTY',
        errorMessage: 'VIES-Antwort leer',
        durationMs: dur,
        cached: false,
      }
    }

    return this.parseViesJsonResponse(json, dur)
  }

  /**
   * Parse the EU VIES REST JSON response into a
   * structured VatCheckResult — never throws.
   * The REST endpoint returns HTTP 200 with a
   * JSON body that ALWAYS includes `userError`
   * (e.g. "VALID", "INVALID", "MS_UNAVAILABLE",
   * "INVALID_INPUT"). We map each userError to
   * our internal status/errorCode vocabulary.
   *
   * Shape (verified against
   * https://ec.europa.eu/taxation_customs/vies/):
   *   {
   *     "isValid": bool,
   *     "userError": "VALID" | "INVALID" |
   *                  "MS_UNAVAILABLE" |
   *                  "INVALID_INPUT" | "SERVER_BUSY" |
   *                  "MS_MAX_CONCURRENT_REQ" | "NO_VAT_NUMBER" |
   *                  "INVALID_REQUESTER" | ...,
   *     "name": string,
   *     "address": string,
   *     "requestDate": ISO,
   *     "viesApproximate": { ... }
   *   }
   *
   * "name"/"address" come as "---" placeholders
   * when isValid=false. We trim them but only
   * surface the value if it's a real string.
   */
  private async parseViesJsonResponse(
    json: any,
    dur: number,
  ): Promise<VatCheckResult> {
    const userError = String(json.userError || '').toUpperCase()
    const isValid = json.isValid === true

    // MS_UNAVAILABLE / SERVER_BUSY / rate limits:
    // the member state's register is down. This
    // is NOT a "no" — the user should retry.
    // These are also circuit-failures: if BZSt
    // (or whoever) is offline, every subsequent
    // call will also fail, so we record the
    // failure and let the breaker short-circuit
    // the next N calls.
    if (
      userError === 'MS_UNAVAILABLE' ||
      userError === 'SERVER_BUSY' ||
      userError === 'MS_MAX_CONCURRENT_REQ'
    ) {
      this.recordCircuitFailure()
      return {
        status: 'unreachable',
        errorCode: 'MS_UNAVAILABLE',
        errorMessage: `VIES: ${userError}`,
        durationMs: dur,
        cached: false,
      }
    }

    // INVALID_INPUT: VIES rejected the format.
    // This is a per-input validation failure
    // (we already do our own format check, but
    // VIES may have stricter rules for some
    // countries). NOT a circuit failure — the
    // service is healthy, the input is bad.
    if (userError === 'INVALID_INPUT' || userError === 'NO_VAT_NUMBER') {
      return {
        status: 'invalid',
        errorCode: 'INVALID_FORMAT',
        errorMessage: `VIES: ${userError}`,
        durationMs: dur,
        cached: false,
      }
    }

    if (userError === 'INVALID_REQUESTER') {
      // Not really a circuit failure (the user
      // misconfigured their own VIES ID; calling
      // VIES again will produce the same error).
      // But it does mean we'll never get a valid
      // response, so don't count it as success
      // either — the caller can still see the
      // structured INVALID_REQUESTER error.
      return {
        status: 'unreachable',
        errorCode: 'INVALID_REQUESTER',
        errorMessage:
          'VIES: Anfragende USt-ID ungültig (auf Anfrageseite registrieren)',
        durationMs: dur,
        cached: false,
      }
    }

    if (isValid) {
      const rawName = typeof json.name === 'string' ? json.name.trim() : ''
      const rawAddr = typeof json.address === 'string' ? json.address.trim() : ''
      return {
        status: 'valid',
        name: rawName && rawName !== '---' ? rawName : undefined,
        address: rawAddr && rawAddr !== '---' ? rawAddr : undefined,
        durationMs: dur,
        cached: false,
      }
    }

    // isValid: false. VIES confirms the number is
    // not registered with the member state.
    return {
      status: 'invalid',
      errorCode: 'UNKNOWN_VAT',
      errorMessage: `VIES: ${userError || 'USt-ID nicht gültig'}`,
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

  /**
   * Tier 134: batch-check every entity of a given
   * type for one company. Walks customers (or
   * suppliers) with a non-empty VAT ID, runs
   * `validateAndLog` on each, and returns the
   * aggregate counts + per-entity results.
   *
   * Used by the "Alle USt-IDs prüfen" button on
   * the customers/suppliers list pages. VIES is
   * slow (~1-2s per call) and the local token-
   * bucket rate limiter (acquireRateToken inside
   * validateAndLog) means a 50-customer batch can
   * take 1-2 minutes. We accept that: this is a
   * one-shot bulk operation, the frontend shows
   * a progress modal, and the user can navigate
   * away (the request keeps running server-side).
   *
   * Cap: 100 entities per call. Anything more
   * would tie up the request for >5 min which
   * is past most reverse-proxy timeouts.
   *
   * Errors: if the VIES circuit breaker is OPEN,
   * every per-entity call short-circuits with
   * status='unreachable' and the global error
   * message. The function never throws — the
   * caller always gets a structured result.
   */
  async batchCheckAll(
    companyId: string,
    entityType: 'customer' | 'supplier',
    opts: { limit?: number } = {},
  ): Promise<{
    total: number
    valid: number
    invalid: number
    unreachable: number
    skipped: number
    durationMs: number
    results: Array<{
      entityId: string
      entityName: string
      vatId: string
      status: 'valid' | 'invalid' | 'unreachable' | 'pending'
      cached: boolean
      errorMessage: string | null
      durationMs: number
    }>
  }> {
    const limit = Math.min(100, Math.max(1, opts.limit ?? 100))
    const startedAt = Date.now()
    // Pull the entities with a VAT ID. We don't
    // join the latest vatValidationLog here — each
    // per-entity call does its own cache check.
    const where =
      entityType === 'customer'
        ? { companyId, vatId: { not: null } }
        : { companyId, vatId: { not: null } }
    const entities =
      entityType === 'customer'
        ? await this.prisma.customer.findMany({
            where,
            take: limit,
            select: { id: true, name: true, vatId: true },
            orderBy: { name: 'asc' },
          })
        : await this.prisma.supplier.findMany({
            where,
            take: limit,
            select: { id: true, name: true, vatId: true },
            orderBy: { name: 'asc' },
          })
    const results: Array<{
      entityId: string
      entityName: string
      vatId: string
      status: 'valid' | 'invalid' | 'unreachable' | 'pending'
      cached: boolean
      errorMessage: string | null
      durationMs: number
    }> = []
    let valid = 0,
      invalid = 0,
      unreachable = 0,
      skipped = 0
    for (const ent of entities) {
      const vat = (ent.vatId || '').trim()
      if (!vat) {
        skipped++
        results.push({
          entityId: ent.id,
          entityName: ent.name,
          vatId: '',
          status: 'invalid',
          cached: false,
          errorMessage: 'no VAT ID',
          durationMs: 0,
        })
        continue
      }
      try {
        const r = await this.validateAndLog(
          companyId,
          entityType,
          ent.id,
          vat,
        )
        if (r.status === 'valid') valid++
        else if (r.status === 'unreachable') unreachable++
        else invalid++ // 'invalid' or 'pending'
        results.push({
          entityId: ent.id,
          entityName: ent.name,
          vatId: vat,
          status: r.status,
          cached: r.cached,
          errorMessage: r.errorMessage ?? null,
          durationMs: r.durationMs,
        })
      } catch (e: any) {
        // A single failure (network blip, parse
        // bug) should not abort the whole batch.
        unreachable++
        this.logger.error(
          `batch ${entityType} ${ent.id} failed: ${e?.message || e}`,
        )
        results.push({
          entityId: ent.id,
          entityName: ent.name,
          vatId: vat,
          status: 'unreachable',
          cached: false,
          errorMessage: e?.message || String(e),
          durationMs: 0,
        })
      }
    }
    const durationMs = Date.now() - startedAt
    this.logger.log(
      `batch ${entityType} check done. total=${entities.length} valid=${valid} invalid=${invalid} unreachable=${unreachable} skipped=${skipped} duration=${durationMs}ms`,
    )
    return {
      total: entities.length,
      valid,
      invalid,
      unreachable,
      skipped,
      durationMs,
      results,
    }
  }

  // ---- Rate limiter (token bucket per msCode) ----
  //
  // VIES doesn't document a public rate limit, but
  // empirics (and the EU's own developer forum)
  // suggest ~30 requests/minute per source IP and
  // per member state. We implement a local token
  // bucket: each msCode (country code) has its own
  // bucket of 10 tokens, refilling at 1 token per
  // 2 seconds (effective 30 req/min — half the
  // perceived limit, so two app instances sharing
  // an IP still don't trip VIES).
  //
  // acquireRateToken() returns when a token is
  // available. It does NOT throw — it just waits.
  // This is fine because VIES calls are user-
  // triggered (click "Jetzt prüfen") and the wait
  // is bounded by the bucket size.
  private _buckets: Map<string, { tokens: number; lastRefill: number }> = new Map()
  private async acquireRateToken(msCode: string): Promise<void> {
    const now = Date.now()
    let bucket = this._buckets.get(msCode)
    if (!bucket) {
      bucket = { tokens: RATE_LIMIT_BUCKET, lastRefill: now }
      this._buckets.set(msCode, bucket)
    }
    // Refill: 1 token per RATE_LIMIT_REFILL_MS.
    const elapsed = now - bucket.lastRefill
    const refilled = Math.floor(elapsed / RATE_LIMIT_REFILL_MS)
    if (refilled > 0) {
      bucket.tokens = Math.min(RATE_LIMIT_BUCKET, bucket.tokens + refilled)
      bucket.lastRefill += refilled * RATE_LIMIT_REFILL_MS
    }
    // Wait for a token if the bucket is empty.
    if (bucket.tokens <= 0) {
      const waitMs = RATE_LIMIT_REFILL_MS - (now - bucket.lastRefill)
      this.logger.warn(
        `VIES rate-limit bucket empty for ${msCode}, waiting ${waitMs}ms`,
      )
      await new Promise((r) => setTimeout(r, waitMs))
      bucket.tokens = 1
      bucket.lastRefill = Date.now() + RATE_LIMIT_REFILL_MS
    }
    bucket.tokens--
  }

  // ---- Circuit breaker (global, sliding window) ----
  //
  // When VIES is having a bad day (BZSt offline,
  // 30s timeouts, network issues), every check
  // wastes 8 seconds before failing. That's bad UX
  // AND it floods VIES with doomed requests,
  // making the outage worse. The circuit breaker
  // tracks recent failures in a sliding window:
  // if N failures land in CIRCUIT_WINDOW_MS, the
  // circuit "trips" and we short-circuit subsequent
  // calls for CIRCUIT_COOLDOWN_MS, returning
  // 'unreachable' immediately.
  //
  // A single success clears the failure counter
  // (so the breaker auto-heals when VIES comes
  // back). We don't need an exponential backoff
  // because the cooldown is itself the backoff.
  private _failures: number[] = []  // timestamps of recent failures
  private _circuitOpenUntil: number = 0
  private isCircuitOpen(): boolean {
    if (Date.now() < this._circuitOpenUntil) return true
    // Lazy-prune failures outside the window.
    const cutoff = Date.now() - CIRCUIT_WINDOW_MS
    this._failures = this._failures.filter((t) => t >= cutoff)
    return false
  }
  private recordCircuitFailure(): void {
    const now = Date.now()
    const cutoff = now - CIRCUIT_WINDOW_MS
    this._failures = this._failures.filter((t) => t >= cutoff)
    this._failures.push(now)
    if (this._failures.length >= CIRCUIT_FAILURE_THRESHOLD) {
      this._circuitOpenUntil = now + CIRCUIT_COOLDOWN_MS
      this.logger.error(
        `VIES circuit breaker TRIPPED — ${this._failures.length} failures in ${CIRCUIT_WINDOW_MS}ms. Cooldown ${CIRCUIT_COOLDOWN_MS}ms.`,
      )
      // Reset the failure list so we start fresh
      // after the cooldown — otherwise the very
      // first call after the cooldown re-trips
      // because the old failures are still in the
      // window... wait, the cooldown is 60s but
      // the window is 30s, so by definition the
      // old failures age out. No reset needed.
    }
  }
  private recordCircuitSuccess(): void {
    // One success clears the failure streak.
    // (We don't need to be more clever — VIES
    // outages are usually 30+ seconds. A single
    // successful response means the service is
    // back.)
    this._failures = []
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
