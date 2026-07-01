// Tests for the DATEV USt-Schlüssel mapping. Pure
// function — no DB required.
//
// Run: npx ts-node --transpile-only src/modules/reports/datev-ust-schluessel.test.ts

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  vatRateToUstSchluessel,
  outputUstSchluessel,
  UstSchluesselMode,
} from './datev-ust-schluessel'

describe('DATEV USt-Schlüssel — output VAT (default)', () => {
  test('0.19 → key 1 (19% Regelsatz)', () => {
    const r = vatRateToUstSchluessel(0.19, 'output')
    assert.equal(r?.key, '1')
    assert.equal(r?.name, '19% USt (Regelsatz)')
    assert.equal(r?.legacy, undefined)
  })

  test('0.07 → key 2 (7% ermäßigt)', () => {
    const r = vatRateToUstSchluessel(0.07, 'output')
    assert.equal(r?.key, '2')
    assert.equal(r?.name, '7% USt (ermäßigt)')
  })

  test('0 → key 0 (steuerfrei §19 UStG)', () => {
    const r = vatRateToUstSchluessel(0, 'output')
    assert.equal(r?.key, '0')
  })

  test('0.0 (float) → key 0', () => {
    const r = vatRateToUstSchluessel(0.0, 'output')
    assert.equal(r?.key, '0')
  })

  test('null → null (no key for missing rate)', () => {
    assert.equal(vatRateToUstSchluessel(null, 'output'), null)
  })

  test('undefined → null', () => {
    assert.equal(vatRateToUstSchluessel(undefined, 'output'), null)
  })

  test('NaN → null', () => {
    assert.equal(vatRateToUstSchluessel(NaN, 'output'), null)
  })

  test('unknown rate 0.16 → null in output mode (use legacy mode)', () => {
    // 16% is LEGACY (COVID 2020). The 'output' mode
    // is the 2024+ set, so 16% doesn't match. The
    // caller must use 'legacy' mode for old imports.
    assert.equal(vatRateToUstSchluessel(0.16, 'output'), null)
  })

  test('rate is a string "0.19" → still matches (Prisma Decimal serialised as string)', () => {
    // Prisma serialises Decimal as string when you
    // .map() without converting. Our function calls
    // Number() internally so this should still work.
    const r = vatRateToUstSchluessel('0.19' as any, 'output')
    assert.equal(r?.key, '1')
  })
})

describe('DATEV USt-Schlüssel — legacy rates (5%, 16%)', () => {
  test('0.05 → key 8 (LEGACY 2020-2023)', () => {
    const r = vatRateToUstSchluessel(0.05, 'legacy')
    assert.equal(r?.key, '8')
    assert.equal(r?.legacy, true)
  })

  test('0.16 → key 9 (LEGACY 2020 COVID)', () => {
    const r = vatRateToUstSchluessel(0.16, 'legacy')
    assert.equal(r?.key, '9')
    assert.equal(r?.legacy, true)
  })

  test('legacy mode: 0.19 (current) → null', () => {
    // 19% is NOT a legacy rate — it's the current
    // Regelsatz. legacy mode should not match it.
    assert.equal(vatRateToUstSchluessel(0.19, 'legacy'), null)
  })
})

describe('DATEV USt-Schlüssel — Innergemeinschaftlicher Erwerb (IgE)', () => {
  test('0.19 → key 14 (19% IgE §1a)', () => {
    const r = vatRateToUstSchluessel(0.19, 'igE')
    assert.equal(r?.key, '14')
    assert.match(r!.name, /IgE/)
  })

  test('0.07 → key 15 (7% IgE §1a)', () => {
    const r = vatRateToUstSchluessel(0.07, 'igE')
    assert.equal(r?.key, '15')
  })

  test('0.19 should NOT pick 16 Neufahrzeug automatically (caller decides)', () => {
    // Neufahrzeug requires a separate flag; rate alone
    // is identical to 19% IgE. We must not auto-pick
    // it — that would silently mis-classify every
    // 19% IgE booking as Neufahrzeug, which is a
    // different UStVA-Kennzahl.
    const r = vatRateToUstSchluessel(0.19, 'igE')
    assert.notEqual(r?.key, '16')
  })
})

describe('DATEV USt-Schlüssel — Reverse-Charge (§13b UStG)', () => {
  test('0.19 → key 12', () => {
    const r = vatRateToUstSchluessel(0.19, 'reverseCharge')
    assert.equal(r?.key, '12')
    assert.match(r!.name, /Reverse-Charge/)
  })

  test('0.07 → key 13', () => {
    const r = vatRateToUstSchluessel(0.07, 'reverseCharge')
    assert.equal(r?.key, '13')
  })
})

describe('DATEV USt-Schlüssel — input VAT (Vorsteuer)', () => {
  test('0.19 → key 20', () => {
    const r = vatRateToUstSchluessel(0.19, 'input')
    assert.equal(r?.key, '20')
  })

  test('0.07 → key 21', () => {
    const r = vatRateToUstSchluessel(0.07, 'input')
    assert.equal(r?.key, '21')
  })

  test('0 → key 0 (steuerfrei)', () => {
    const r = vatRateToUstSchluessel(0, 'input')
    assert.equal(r?.key, '0')
  })
})

describe('outputUstSchluessel shim', () => {
  test('0.19 → "1"', () => {
    assert.equal(outputUstSchluessel(0.19), '1')
  })
  test('0.07 → "2"', () => {
    assert.equal(outputUstSchluessel(0.07), '2')
  })
  test('0 → "0"', () => {
    assert.equal(outputUstSchluessel(0), '0')
  })
  test('null → "" (empty cell in the export)', () => {
    assert.equal(outputUstSchluessel(null), '')
  })
  test('unknown rate 0.42 → "" (Berater fills in manually)', () => {
    assert.equal(outputUstSchluessel(0.42), '')
  })
})

describe('Tolerance test — 0.18999 vs 0.19001', () => {
  // Prisma Decimal conversion can produce tiny
  // rounding errors like 0.18999... The tolerance
  // window (0.001) must catch those.
  test('0.18999 → still 19% (key 1)', () => {
    const r = vatRateToUstSchluessel(0.18999, 'output')
    assert.equal(r?.key, '1')
  })
  test('0.19001 → still 19% (key 1)', () => {
    const r = vatRateToUstSchluessel(0.19001, 'output')
    assert.equal(r?.key, '1')
  })
  test('0.18 → no match (NOT a DATEV rate — would be a bug in the source)', () => {
    assert.equal(vatRateToUstSchluessel(0.18, 'output'), null)
  })
})

// Smoke test: walk every mode and rate pair, verify
// we never return undefined for a recognised rate
// and never return a key for an unknown rate.
describe('DATEV USt-Schlüssel — exhaustive sanity', () => {
  const modes: UstSchluesselMode[] = [
    'output', 'input', 'igE', 'reverseCharge', 'legacy',
  ]
  const knownRates: Record<UstSchluesselMode, number[]> = {
    output:        [0, 0.07, 0.19],
    input:         [0, 0.07, 0.19],
    igE:           [0.07, 0.19],
    reverseCharge: [0.07, 0.19],
    legacy:        [0.05, 0.16],
  }
  for (const mode of modes) {
    for (const rate of knownRates[mode]) {
      test(`${mode} mode + ${rate} → returns a key`, () => {
        const r = vatRateToUstSchluessel(rate, mode)
        assert.ok(r, `${mode} mode at ${rate} should match`)
        assert.ok(/^\d{1,2}$/.test(r!.key),
          `key ${r!.key} should be 1-2 digits`)
      })
    }
  }
})
