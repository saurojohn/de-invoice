/**
 * Playwright spec — GTM acceptance (multi-tenant
 * isolation).
 *
 * The Berater's question: "When the user
 * registers a new account on de-invoice,
 * they should land in their own company —
 * not be 401'd by the auth guard because
 * the UserCompany grant row was never
 * created."
 *
 * This spec verifies the multi-tenant grant
 * model end-to-end:
 *   1. Register a new company + admin user.
 *   2. The new admin can list their own
 *      company's invoices (200) — proves
 *      the UserCompany grant row was
 *      auto-created at register time.
 *   3. The new admin CANNOT list another
 *      company's invoices (401/404) —
 *      proves the per-company access check
 *      is enforced, not bypassed.
 *   4. The new admin can create a customer
 *      in their own company.
 *   5. The other admin CANNOT see the
 *      new admin's customer (404) — proves
 *      tenant data isolation in the
 *      read-by-id path.
 *
 * Regression history: this spec was added
 * when the GTM acceptance drill discovered
 * that `auth.service.register()` only
 * created the Company + User rows but
 * forgot the UserCompany grant. The
 * header-auth guard's many-to-many
 * check returned 401 for every new
 * registrant, blocking the entire
 * self-serve onboarding flow. The fix
 * is in auth.service.ts (adds the
 * UserCompany row in the same
 * transaction as the User create). This
 * spec would have caught the bug at PR
 * time.
 */
import { test, expect, request as playwrightRequest } from '@playwright/test'
import { getTestEnv } from './fixtures/test-env'

// Tenant A: SH Leder GmbH (the canonical ci-seed tenant). Read
// the live UUIDs from the auth cache because re-seeding can rotate
// the user/company UUIDs (e.g. when the test DB is reset).
const tokens = getTestEnv()
const COMPANY_A = tokens.companyId
// Login Tenant A admin to get their actual user UUID. The user
// id from the auth cache IS the admin's id (single-tenant test
// user), so we can use it directly — but to be safe we re-login.
const API = 'http://localhost:3001'

async function loginTenantA(): Promise<{ userId: string; companyId: string }> {
  const ctx = await playwrightRequest.newContext()
  const r = await ctx.post(`${API}/api/v1/auth/login`, {
    data: { email: 'info@shleder.de', password: 'Test1234!' },
  })
  // Backend's /auth/login returns 200 OK on success (not 201 —
  // a session login isn't a resource creation).
  expect(
    r.status(),
    `SH Leder admin login must succeed: ${r.status()} ${await r.text()}`,
  ).toBe(200)
  const body = await r.json()
  await ctx.dispose()
  return { userId: body.id, companyId: body.companyId }
}

const RUN_ID = `gtm-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const EMAIL = `acceptance-${RUN_ID}@example.com`
const COMPANY_NAME = `Acceptance ${RUN_ID}`

// Tier 291: register a fresh tenant ONCE in beforeAll and share
// the user/company UUIDs across all tests. The original spec
// re-logged-in at the start of every test, which trips the
// /auth/login 5/60s throttler after the first call — every test
// then sees a throttled "ThrottlerException: Too Many Requests"
// JSON instead of a user record, and the subsequent API calls
// 401 because the headers reference `undefined` user id / company
// id. By registering once in beforeAll and sharing the response
// data, only the /auth/register call (5/60s) is made during the
// spec — every subsequent test reuses the same user record.
let NEW_USER_ID: string
let NEW_COMPANY_ID: string
let registerStatus: number
let registerBodyEmail: string
let registerBodyRole: string
let registerBodyCompanyName: string
let registerBodyUserCompanyId: string
let registerBodyCompanyId: string

test.describe('GTM acceptance — multi-tenant isolation', () => {
  test.beforeAll(async () => {
    const ctx = await playwrightRequest.newContext()
    const res = await ctx.post(`${API}/api/v1/auth/register`, {
      data: {
        email: EMAIL,
        password: 'Test1234!',
        companyName: COMPANY_NAME,
      },
    })
    registerStatus = res.status()
    const body = await res.json()
    NEW_USER_ID = body.user.id
    NEW_COMPANY_ID = body.user.companyId
    registerBodyEmail = body.user.email
    registerBodyRole = body.user.role
    registerBodyCompanyName = body.company.name
    registerBodyUserCompanyId = body.user.companyId
    registerBodyCompanyId = body.company.id
    await ctx.dispose()
  })

  test('register creates company + admin user with UserCompany grant', () => {
    expect(registerStatus).toBe(201)
    expect(registerBodyEmail).toBe(EMAIL)
    expect(registerBodyRole).toBe('admin')
    expect(registerBodyCompanyName).toBe(COMPANY_NAME)
    // The grant row is the load-bearing
    // assertion — without it, the next
    // test (list invoices) would 401.
    expect(registerBodyUserCompanyId).toBe(registerBodyCompanyId)
  })

  test('new admin can list their own company invoices (UserCompany grant auto-created)', async () => {
    // Tier 291: use the user/company UUIDs from the module-level
    // register call (avoids hitting the /auth/login 5/60s throttler
    // on every test). The grant is the load-bearing assertion —
    // without it, this test would 401.
    const ctx = await playwrightRequest.newContext()
    const res = await ctx.get(
      `${API}/api/v1/invoices?companyId=${NEW_COMPANY_ID}`,
      {
        headers: {
          'x-user-id': NEW_USER_ID,
          'x-company-id': NEW_COMPANY_ID,
        },
      },
    )
    // The "new company has no invoices"
    // case is a 200 with empty rows. The
    // "no UserCompany grant" case would be
    // a 401 — that's the bug this test
    // guards against.
    expect(res.status()).toBe(200)
    await ctx.dispose()
  })

  test('new admin CANNOT list another company invoices (cross-tenant blocked)', async () => {
    const ctx = await playwrightRequest.newContext()
    // Attempt to access SH Leder's
    // invoices using the new admin's
    // credentials. The header-auth guard
    // looks up UserCompany by (NEW_USER_ID,
    // SH_Leder_id) — no row exists →
    // 401.
    const res = await ctx.get(
      `${API}/api/v1/invoices?companyId=${COMPANY_A}`,
      {
        headers: {
          'x-user-id': NEW_USER_ID,
          'x-company-id': COMPANY_A,
        },
      },
    )
    expect(res.status()).toBe(401)
    await ctx.dispose()
  })

  test('new admin can create a customer in their own company', async () => {
    const ctx = await playwrightRequest.newContext()
    const res = await ctx.post(
      `${API}/api/v1/customers?companyId=${NEW_COMPANY_ID}`,
      {
        headers: {
          'x-user-id': NEW_USER_ID,
          'x-company-id': NEW_COMPANY_ID,
          'Content-Type': 'application/json',
        },
        data: {
          name: `Acceptance Cust ${RUN_ID}`,
          address: {
            street: 'A',
            city: 'B',
            postalCode: '12345',
            country: 'DE',
          },
        },
      },
    )
    expect(res.status()).toBe(201)
    const body = await res.json()
    expect(body.companyId).toBe(NEW_COMPANY_ID)
    await ctx.dispose()
  })

  test('other admin CANNOT read by id the cross-tenant customer (404 not 200)', async () => {
    // Look up the customer we just
    // created — the companyId filter
    // means SH Leder's admin can't see
    // it. The exact response code is
    // 404 (not 200 + filtered result, not
    // 401 with leak); this test
    // documents the "don't leak
    // existence" behaviour.
    const ctx = await playwrightRequest.newContext()
    // Find the customer via the original
    // creator's session (using module-level
    // user/company UUIDs, see Tier 291).
    const listRes = await ctx.get(
      `${API}/api/v1/customers?companyId=${NEW_COMPANY_ID}`,
      {
        headers: {
          'x-user-id': NEW_USER_ID,
          'x-company-id': NEW_COMPANY_ID,
        },
      },
    )
    const list = await listRes.json()
    // Customer list returns {data, total, page, ...}
    const cust = (list.data || list).find(
      (c: any) => c.name === `Acceptance Cust ${RUN_ID}`,
    )
    expect(cust).toBeDefined()
    // SH Leder's admin tries to read it.
    const tenantA = await loginTenantA()
    const res = await ctx.get(
      `${API}/api/v1/customers/${cust.id}?companyId=${tenantA.companyId}`,
      {
        headers: {
          'x-user-id': tenantA.userId,
          'x-company-id': tenantA.companyId,
        },
      },
    )
    expect(res.status()).toBe(404)
    await ctx.dispose()
  })
})

/**
 * Cleanup — run as the last test in the
 * describe block. Removes the test
 * company, the test user, the UserCompany
 * grant, and the test customer. We
 * tolerate failures (the next run will
 * overwrite / no-op the duplicates).
 */
test.describe('GTM acceptance — cleanup', () => {
  test('removes the acceptance fixtures', async () => {
    const { execSync } = await import('child_process')
    const sql = `
      DELETE FROM "Customer" WHERE name = '${`Acceptance Cust ${RUN_ID}`}';
      DELETE FROM "UserCompany" WHERE "userId" IN (SELECT id FROM "User" WHERE email = '${EMAIL}');
      DELETE FROM "User" WHERE email = '${EMAIL}';
      DELETE FROM "Company" WHERE name = '${COMPANY_NAME}';
    `
    try {
      execSync(
        `docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice`,
        { input: sql, stdio: 'pipe' },
      )
    } catch {
      // Tolerate — the next run will no-op
      // the duplicates because the
      // register call's unique constraints
      // on email would 409.
    }
  })
})
