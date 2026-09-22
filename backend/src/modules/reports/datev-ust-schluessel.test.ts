// Tests for the DATEV Steuerschlüssel mapping. Pure function — no DB.
//
// Run: npx ts-node --transpile-only src/modules/reports/datev-ust-schluessel.test.ts
//
// Tier 423: the expected keys are DATEV's standard keys (2/3 USt, 8/9 VSt,
// 18/19 igE, 91/94 § 13b). The keys asserted before (1, 20, 21, 12–15) were
// invented and would have been read by DATEV as something else entirely.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { vatRateToUstSchluessel, outputUstSchluessel, UstSchluesselMode } from './datev-ust-schluessel'

const key = (rate: any, mode: UstSchluesselMode) => vatRateToUstSchluessel(rate, mode)?.key

describe('output VAT', () => {
  test('19 % → 3', () => assert.equal(key(0.19, 'output'), '3'))
  test('7 % → 2', () => assert.equal(key(0.07, 'output'), '2'))
  test('0 % → no key (the account decides)', () => assert.equal(key(0, 'output'), ''))
  test('null / undefined / NaN → null', () => {
    assert.equal(vatRateToUstSchluessel(null, 'output'), null)
    assert.equal(vatRateToUstSchluessel(undefined, 'output'), null)
    assert.equal(vatRateToUstSchluessel(NaN, 'output'), null)
  })
  test('16 % is not a current rate → null in output mode', () => assert.equal(vatRateToUstSchluessel(0.16, 'output'), null))
  test('a Decimal serialised as string still matches', () => assert.equal(key('0.19', 'output'), '3'))
  test('tolerance: 0.18999 and 0.19001 are 19 %, 0.18 is nothing', () => {
    assert.equal(key(0.18999, 'output'), '3')
    assert.equal(key(0.19001, 'output'), '3')
    assert.equal(vatRateToUstSchluessel(0.18, 'output'), null)
  })
})

describe('legacy 2020 rates', () => {
  test('16 % → 5', () => {
    const r = vatRateToUstSchluessel(0.16, 'legacy')
    assert.equal(r?.key, '5')
    assert.equal(r?.legacy, true)
  })
  test('19 % is not legacy', () => assert.equal(vatRateToUstSchluessel(0.19, 'legacy'), null))
})

describe('input VAT', () => {
  test('19 % → 9', () => assert.equal(key(0.19, 'input'), '9'))
  test('7 % → 8', () => assert.equal(key(0.07, 'input'), '8'))
  test('16 % → 7', () => assert.equal(key(0.16, 'input'), '7'))
  test('0 % → no key', () => assert.equal(key(0, 'input'), ''))
})

describe('innergemeinschaftlicher Erwerb', () => {
  test('19 % → 19', () => assert.equal(key(0.19, 'igE'), '19'))
  test('7 % → 18', () => assert.equal(key(0.07, 'igE'), '18'))
})

describe('§ 13b UStG', () => {
  test('19 % → 94', () => assert.equal(key(0.19, 'reverseCharge'), '94'))
  test('7 % → 91', () => assert.equal(key(0.07, 'reverseCharge'), '91'))
})

describe('outputUstSchluessel', () => {
  test('19 % → "3", 7 % → "2"', () => {
    assert.equal(outputUstSchluessel(0.19), '3')
    assert.equal(outputUstSchluessel(0.07), '2')
  })
  test('0, null and unknown rates → ""', () => {
    assert.equal(outputUstSchluessel(0), '')
    assert.equal(outputUstSchluessel(null), '')
    assert.equal(outputUstSchluessel(0.42), '')
  })
})
