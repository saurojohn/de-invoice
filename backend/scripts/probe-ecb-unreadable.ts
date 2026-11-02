#!/usr/bin/env ts-node
/**
 * Tier 776 — an ECB answer that is no rate table is not kept as „no rate".
 *
 * The rate of a settled day is kept for the life of the process. A 200 whose
 * body was no CSV (a maintenance page) parsed to null, and that null was kept:
 * the day had no rate until a restart. Asks twice for the same settled day, the
 * ECB answering first with an HTML page, then with a rate table. Prints one
 * JSON line: { first, second } — want first „unavailable" and second the rate.
 *
 * Usage: npx ts-node scripts/probe-ecb-unreadable.ts
 */
import { ExchangeRateService } from '../src/modules/exchange-rate/exchange-rate.service'

process.env.EXCHANGE_RATES_MOCK = ''
const answers = [
  '<!DOCTYPE html>\n<html><body>Wartungsarbeiten</body></html>\n',
  'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE\nEXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2025-03-14,1.0880\n',
]
globalThis.fetch = (async () => new Response(answers.shift() ?? '', { status: 200 })) as typeof fetch

async function outcome(svc: ExchangeRateService): Promise<string> {
  try {
    const r = await svc.ecbRateOn('USD', '2025-03-14')
    return r ? r.rate : 'none'
  } catch (e) {
    return (e as { status?: number }).status === 503 ? 'unavailable' : `error ${String(e).slice(0, 80)}`
  }
}

;(async () => {
  const svc = new ExchangeRateService(null as never, null as never)
  const first = await outcome(svc)
  const second = await outcome(svc)
  console.log(JSON.stringify({ first, second }))
})()
