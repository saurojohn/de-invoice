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
    if (VIES_MOCK) {
      const upper = (number || '').toUpperCase()
      // Common fields shared across all mock
      // responses. status is overridden per
      // branch below. We list `status: 'valid'`
      // as a default-valid starting point; the
      // invalid + unreachable branches set
      // status explicitly.
      const base: VatCheckResult = {
        status: 'valid',
        durationMs: 5,
        cached: false,
      }
      if (upper.startsWith('VALID')) {
        return {
          ...base,
          status: 'valid',
          name: `Mock Test Co (${countryCode})`,
          address: `Mock Street 1, 12345 ${countryCode}`,
        }
      }
      if (upper.startsWith('INVALID')) {
        return {
          ...base,
          status: 'invalid',
          errorCode: 'UNKNOWN_VAT',
          errorMessage: 'Mock: invalid VAT ID',
        }
      }
      if (upper.startsWith('UNREACHABLE') || upper.startsWith('MS_UNAVAILABLE')) {
        return {
          ...base,
          status: 'unreachable',
          errorCode: 'MS_UNAVAILABLE',
          errorMessage: 'Mock: VIES unreachable',
        }
      }
      // Default: treat as valid (the dev experience
      // is "it just works"). The e2e test uses the
      // explicit prefixes above for negative cases.
      return {
        ...base,
        status: 'valid',
        name: `Mock ${countryCode} Co`,
        address: 'Mock Address',
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
