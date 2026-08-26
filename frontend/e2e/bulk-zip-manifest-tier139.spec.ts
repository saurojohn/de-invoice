/**
 * Playwright spec — Tier 139 enhanced bulk-download
 * ZIP manifest.
 *
 * Verifies:
 *   1. The bulk-download endpoint still returns a
 *      valid ZIP (Content-Type=application/zip,
 *      first 4 bytes = "PK\x03\x04") for the
 *      2-invoice batch.
 *   2. The ZIP contains the _manifest.txt entry
 *      (we check the central directory listing
 *      for the filename — deflate-compressed body
 *      isn't readable without a real ZIP lib).
 *
 * The actual manifest content (invoice number,
 * date, customer) is smoke-tested with `unzip -p`
 * + `grep` in the deploy runbook, not here. The
 * spec is a regression guard: if a future change
 * breaks the ZIP generation entirely, this test
 * catches it. If the manifest content silently
 * degrades to UUIDs again, the smoke test catches
 * that.
 */
import { test, expect, request as playwrightRequest } from '@playwright/test'
import { getTestEnv } from './fixtures/test-env'

const USER_ID = getTestEnv().userId
const COMPANY_ID = getTestEnv().companyId
const API = 'http://localhost:3001'
// Three real invoices from the dev DB. The
// hardcoded UUIDs match the rows seeded by
// ci-seed.sh + dynamic sequence runs (the
// invoice numbers are stable across runs
// because the sequence is shared + the row
// upserts preserve the same id).
//
// If a future migration changes the seed
// invoice IDs, run `psql ... -c "SELECT id,
// \"invoiceNumber\" FROM \"Invoice\" WHERE
// \"invoiceNumber\" IN ('INV-TEST-001',
// 'INV-2026-000203', 'INV-2026-000205');"`
// to find the current ids.
const INVOICE_IDS = [
  '11deeb35-7147-4bdc-86d9-a302b4f80f3e', // INV-TEST-001
  '2ae06f86-4310-4fa1-b7b7-53ffa90d0a2c', // INV-2026-000203
  '5cd98db2-4b9b-4b6f-a65d-19d5958521f7', // INV-2026-000205
]

test.describe('Tier 139 — Bulk ZIP enriched manifest', () => {
  test('returns a valid ZIP with the _manifest.txt entry', async () => {
    const ctx = await playwrightRequest.newContext()
    const res = await ctx.post(
      `${API}/api/v1/invoices/bulk-download?companyId=${COMPANY_ID}`,
      {
        headers: {
          'x-user-id': USER_ID,
          'x-company-id': COMPANY_ID,
          'Content-Type': 'application/json',
        },
        data: { invoiceIds: INVOICE_IDS, format: 'pdf' },
      },
    )
    expect([200, 201]).toContain(res.status())
    expect(res.headers()['content-type']).toContain('application/zip')
    const body = await res.body()
    expect(body.length).toBeGreaterThan(1000)
    // ZIP magic: "PK\x03\x04"
    expect(body[0]).toBe(0x50) // P
    expect(body[1]).toBe(0x4b) // K
    expect(body[2]).toBe(0x03)
    expect(body[3]).toBe(0x04)
    // _manifest.txt filename must appear in the
    // central directory (last 2KB of the file is
    // a safe grep range for the standard ZIP CD).
    const tail = body.subarray(Math.max(0, body.length - 4096))
    expect(tail.toString('utf-8')).toContain('_manifest.txt')
    // The 2 invoice filenames should also be there
    expect(tail.toString('utf-8')).toContain('INV-2026-000203')
    expect(tail.toString('utf-8')).toContain('INV-2026-000205')
    await ctx.dispose()
  })
})
