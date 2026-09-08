/**
 * ExchangeRateService — ECB daily reference rates,
 * pulled + cached per company.
 *
 * Why this exists
 * ---------------
 * The DATEV-Beleg-Paket includes a "Kurs" column
 * (CSV column 17) for every non-EUR transaction.
 * Until Tier 5d the value was always 1,0000, which
 * the Berater had to overwrite on import. This
 * service fetches the official ECB daily reference
 * rates and feeds the right Kurs into the export.
 *
 * Source
 * ------
 * European Central Bank Statistical Data Warehouse:
 *   https://data-api.ecb.europa.eu/service/data/EXR/D.<CCY>.EUR.SP00.A
 *
 * Returns CSV with one row per currency per day.
 * Rates are expressed as "<CCY> per 1 EUR" — exactly
 * what DATEV column 17 wants. We persist the
 * raw string to keep the original precision (4-5
 * significant digits) without a JS Number round-trip.
 *
 * Schedule
 * --------
 * The cron @ 02:00 Europe/Berlin runs every day.
 * ECB publishes the new rate around 15:00 CET on
 * working days, so by 02:00 the next morning the
 * previous day's rate is settled. We fetch even
 * on weekends (the API returns the last
 * working-day's rate).
 *
 * Failure handling
 * ----------------
 * Network errors / 5xx are caught and logged; the
 * previously cached rates stay in place. A manual
 * refresh via the controller can retry.
 *
 * Per-company storage
 * -------------------
 * Rates live in `Company.settings.datev.exchangeRates`
 * — same shape as the other DATEV config. The
 * `fetchedAt` timestamp drives the staleness UI
 * ("Kurse von 2026-06-19, 17:00 — heute aktualisieren").
 */

import {
  Injectable,
  Logger,
  BadRequestException,
} from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PrismaService } from '../../prisma/prisma.service'
// Tier 119: the daily @Cron body is wrapped with
// the shared CronHealthService so the admin
// dashboard can surface the last run + last error.
import { CronHealthService } from '../admin/cron-health.service'

// The 7 currencies we care about. ECB has 30+ but
// supporting all of them adds noise — the typical
// German Mittelstand invoices in CHF, USD, GBP,
// and occasionally CNY. Add more on demand.
const SUPPORTED_CURRENCIES = ['USD', 'CHF', 'GBP', 'CNY', 'JPY', 'PLN', 'CZK']

// The ECB SDMX API endpoint for daily EUR-based
// reference rates. The `+`-separated list after
// `D.` requests multiple currencies in one call.
// `SP00.A` = Spot rate, Average, A-type. ECB has
// the same endpoint return XML/JSON/CSV — we use
// CSV for easy parse. The `lastNObservations=1`
// query parameter limits the response to the
// most recent date. We omit it here so we get the
// full historical stream — useful if the service
// is asked for a specific date later.
const ECB_URL =
  'https://data-api.ecb.europa.eu/service/data/EXR/D.' +
  SUPPORTED_CURRENCIES.join('+') +
  '.EUR.SP00.A?format=csvdata'

export interface ExchangeRateSnapshot {
  /** ISO date the rate was published, e.g. "2026-06-19" */
  date: string
  /** ISO timestamp the snapshot was fetched */
  fetchedAt: string
  /** Always "EUR" — the base currency for these rates */
  base: string
  /**
   * Map of currency code → rate as a string.
   * String (not number) preserves the 4-5 digit
   * precision without a JS Number round-trip.
   * Example: { "USD": "1.1467", "GBP": "0.86653" }
   */
  rates: Record<string, string>
}

interface CsvRow {
  CURRENCY: string
  TIME_PERIOD: string
  OBS_VALUE: string
}

@Injectable()
export class ExchangeRateService {
  private readonly logger = new Logger(ExchangeRateService.name)

  // Tier 119: the daily ECB refresh @Cron wraps
  // itself with `this.health.wrap(...)` so the
  // admin dashboard can show "exchange-rate-
  // refresh last ran N hours ago, last error: …".
  constructor(
    private prisma: PrismaService,
    private health: CronHealthService,
  ) {}

  /**
   * Fetch + parse the ECB CSV. Returns the most
   * recent date's rate map plus its date + fetched
   * timestamp. Throws on network/parse failure
   * (the caller decides whether to log+swallow or
   * surface).
   */
  async fetchEcbRates(): Promise<ExchangeRateSnapshot> {
    // Tier 334: CI runners have no outbound network
    // access to data-api.ecb.europa.eu, so the real
    // fetch hangs/fails and the e2e 30-exchange-rates
    // spec's `POST /exchange-rates/refresh` step fails
    // with HTTP 500. We honor an EXCHANGE_RATES_MOCK=1
    // env var that returns a known-good snapshot. The
    // same pattern is used by the VIES mock
    // (VIES_MOCK=1 → returns fixture VAT validation).
    if (process.env.EXCHANGE_RATES_MOCK === '1') {
      return {
        date: '2026-06-19',
        base: 'EUR',
        rates: { CHF: '0.9248', USD: '1.0850', GBP: '0.8520' },
        fetchedAt: new Date().toISOString(),
      }
    }
    const res = await fetch(ECB_URL, {
      // 10s — ECB responds in <1s normally; we
      // cap at 10s so a hung connection doesn't
      // pin a worker for minutes.
      signal: AbortSignal.timeout(10_000),
      headers: { 'User-Agent': 'de-invoice/1.0 (ECB rate sync)' },
    })
    if (!res.ok) {
      throw new BadRequestException(
        `ECB API responded ${res.status} ${res.statusText}`,
      )
    }
    const csv = await res.text()
    const parsed = this.parseEcbCsv(csv)
    return {
      ...parsed,
      fetchedAt: new Date().toISOString(),
    }
  }

  /**
   * Parse the ECB CSV into a (date, rates) tuple.
   * The CSV has 30+ columns; we only read
   * CURRENCY (col 3), TIME_PERIOD (col 7), and
   * OBS_VALUE (col 8). The API sorts rows
   * alphabetically by currency, then
   * chronologically by date, so the LAST row per
   * currency is the most recent observation.
   *
   * We pick the most recent TIME_PERIOD that has
   * values for ALL the currencies we care about.
   * If a currency is missing for that date (e.g.
   * a recent ECB fix removed GBP from the daily
   * feed), the missing currency is dropped from
   * the snapshot — the DATEV export falls back to
   * "1,0000" for that one row, the rest of the
   * map is unaffected.
   */
  parseEcbCsv(csv: string): { date: string; base: string; rates: Record<string, string> } {
    const lines = csv.split('\n').filter((l) => l.length > 0)
    if (lines.length < 2) {
      throw new BadRequestException('ECB CSV appears empty or single-line')
    }
    // Parse the header to find the column indexes
    // dynamically. ECB adds/removes columns over
    // the years — hardcoding col 7 would break
    // silently.
    const header = this.parseCsvLine(lines[0])
    const idxCurrency = header.indexOf('CURRENCY')
    const idxTime = header.indexOf('TIME_PERIOD')
    const idxValue = header.indexOf('OBS_VALUE')
    if (idxCurrency < 0 || idxTime < 0 || idxValue < 0) {
      throw new BadRequestException(
        `ECB CSV missing expected columns (currency/time/value) — got: ${header.slice(0, 12).join(',')}`,
      )
    }
    // Group rows by date, keeping the most recent
    // date that has at least one row per currency.
    // We don't require ALL currencies to be
    // present — we take the latest date that has
    // SOME rows, then filter out missing currencies
    // downstream.
    const byDate: Record<string, Record<string, string>> = {}
    for (let i = 1; i < lines.length; i++) {
      const cells = this.parseCsvLine(lines[i])
      if (cells.length <= idxValue) continue
      const currency = cells[idxCurrency]
      const time = cells[idxTime]
      const value = cells[idxValue]
      if (!currency || !time || !value) continue
      if (!byDate[time]) byDate[time] = {}
      // The CSV has one row per (date, currency).
      // If a duplicate slips in, the last one wins.
      byDate[time][currency] = value
    }
    // Pick the most recent date.
    const dates = Object.keys(byDate).sort()
    if (dates.length === 0) {
      throw new BadRequestException('ECB CSV had no usable rows')
    }
    const latestDate = dates[dates.length - 1]
    return {
      date: latestDate,
      base: 'EUR',
      rates: byDate[latestDate],
    }
  }

  /**
   * Tiny CSV parser. ECB's CSV is well-formed (no
   * embedded newlines, no escaped quotes) so a
   * naive split-on-comma works. We do it by hand
   * instead of pulling in a CSV lib — this is
   * called once per cron tick.
   */
  private parseCsvLine(line: string): string[] {
    return line.split(',')
  }

  /**
   * Cron: refresh rates for every company at 02:00
   * Europe/Berlin. ECB publishes the new daily
   * rate around 15:00 CET on working days, so by
   * 02:00 Berlin the rate is settled.
   *
   * We don't fail the cron on errors — one bad
   * fetch leaves the previous rate in place.
   * The next cron will retry.
   */
  @Cron('0 2 * * *', { timeZone: 'Europe/Berlin' })
  async refreshAllCompanies() {
    this.logger.log('ECB rate refresh: starting')
    // Tier 119: wrap with CronHealthService so the
    // admin dashboard surfaces "exchange-rate-
    // refresh last ran N hours ago". The wrap
    // re-throws on failure so the next cron retries
    // the fetch. We use the existing exchangeRate
    // service's own getRate() helper indirectly —
    // the service itself is the cron source so we
    // just `this.health.wrap()` here.
    return this.health.wrap('exchange-rate-refresh', async () => {
      let snapshot: ExchangeRateSnapshot
      try {
        snapshot = await this.fetchEcbRates()
      } catch (e: any) {
        this.logger.error(`ECB rate refresh: fetch failed — ${e?.message}`)
        throw e
      }
      this.logger.log(
        `ECB rate refresh: ${Object.keys(snapshot.rates).length} rates for ${snapshot.date}`,
      )
      const companies = await this.prisma.company.findMany({
        select: { id: true, settings: true },
      })
      let ok = 0
      let fail = 0
      for (const c of companies) {
        try {
          await this.saveRatesForCompany(c.id, snapshot)
          ok++
        } catch (e: any) {
          this.logger.warn(
            `ECB rate refresh: company ${c.id} save failed — ${e?.message}`,
          )
          fail++
        }
      }
      this.logger.log(`ECB rate refresh: ${ok} ok, ${fail} fail`)
      return `${Object.keys(snapshot.rates).length} rates, ${ok} ok, ${fail} fail`
    })
  }

  /**
   * Persist the snapshot to
   * Company.settings.datev.exchangeRates. We
   * preserve any non-rate keys already in
   * `datev` (the Berater-Nr / Mandanten-Nr /
   * openingBalances stay intact).
   */

  /**
   * Persist the snapshot to
   * Company.settings.datev.exchangeRates. We
   * preserve any non-rate keys already in
   * `datev` (the Berater-Nr / Mandanten-Nr /
   * openingBalances stay intact).
   */
  async saveRatesForCompany(
    companyId: string,
    snapshot: ExchangeRateSnapshot,
  ): Promise<void> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { settings: true },
    })
    const settings: any = company?.settings || {}
    const datev: any = settings.datev || {}
    const next = { ...settings, datev: { ...datev, exchangeRates: snapshot } }
    await this.prisma.company.update({
      where: { id: companyId },
      data: { settings: next },
    })
  }

  /**
   * Read the cached rates for a company. Returns
   * the snapshot as-is (no transformation). The
   * `null` return means "no snapshot yet" — the
   * datev-export endpoint treats this as "use
   * 1,0000 for everything".
   */
  async getRatesForCompany(
    companyId: string,
  ): Promise<ExchangeRateSnapshot | null> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { settings: true },
    })
    const datev: any = (company as any)?.settings?.datev
    if (!datev?.exchangeRates) return null
    return datev.exchangeRates as ExchangeRateSnapshot
  }

  /**
   * Resolve the exchange rate for a specific
   * currency code. The lookup order is:
   *   1. Per-invoice override (passed as 2nd arg)
   *   2. Company cached snapshot
   *   3. Fallback "1,0000"
   *
   * Called by the datev export for every non-EUR
   * line. EUR is short-circuited in the caller
   * (no need to look up a rate for the home
   * currency).
   */
  async getRate(
    companyId: string,
    currency: string,
    override?: string,
  ): Promise<string> {
    if (override && /^\d+\.\d{1,8}$/.test(override)) {
      return override
    }
    const snapshot = await this.getRatesForCompany(companyId)
    if (snapshot?.rates?.[currency]) {
      return snapshot.rates[currency]
    }
    return '1.0000'
  }
}
