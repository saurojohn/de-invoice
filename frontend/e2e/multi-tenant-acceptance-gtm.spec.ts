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

const COMPANY_A = 'ad257ec3-d319-479b-b870-3fe76e8f3111'
const USER_A = '8c6a9669-0069-4137-a842-a66fd1d178d6'
const API = 'http://localhost:3001'

const ADMIN_HEADERS_A = {
  'x-user-id': USER_A,
  'x-company-id': COMPANY_A,
}

const RUN_ID = `gtm-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const EMAIL = `acceptance-${RUN_ID}@example.com`
const COMPANY_NAME = `Acceptance ${RUN_ID}`

test.describe('GTM acceptance — multi-tenant isolation', () => {
  test('register creates company + admin user with UserCompany grant', async () => {
    const ctx = await playwrightRequest.newContext()
    const res = await ctx.post(`${API}/api/v1/auth/register`, {
      data: {
        email: EMAIL,
        password: 'Test1234!',
        companyName: COMPANY_NAME,
      },
    })
    expect(res.status()).toBe(201)
    const body = await res.json()
    expect(body.user.email).toBe(EMAIL)
    expect(body.user.role).toBe('admin')
    expect(body.company.name).toBe(COMPANY_NAME)
    // The grant row is the load-bearing
    // assertion — without it, the next
    // test (list invoices) would 401.
    expect(body.user.companyId).toBe(body.company.id)
    await ctx.dispose()
  })

  test('new admin can list their own company invoices (UserCompany grant auto-created)', async () => {
    // Look up the freshly created user via
    // the login response — we don't have
    // their id from the register call
    // above (each test runs in its own
    // scope; in this spec, the same
    // run-id is shared).
    const ctx = await playwrightRequest.newContext()
    const login = await ctx.post(`${API}/api/v1/auth/login`, {
      data: { email: EMAIL, password: 'Test1234!' },
    })
    const user = await login.json()
    const newUserId = user.id
    const newCompanyId = user.companyId
    const res = await ctx.get(
      `${API}/api/v1/invoices?companyId=${newCompanyId}`,
      {
        headers: {
          'x-user-id': newUserId,
          'x-company-id': newCompanyId,
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
    const login = await ctx.post(`${API}/api/v1/auth/login`, {
      data: { email: EMAIL, password: 'Test1234!' },
    })
    const user = await login.json()
    // Attempt to access SH Leder's
    // invoices using the new admin's
    // credentials. The header-auth guard
    // looks up UserCompany by (newUserId,
    // SH_Leder_id) — no row exists →
    // 401.
    const res = await ctx.get(
      `${API}/api/v1/invoices?companyId=${COMPANY_A}`,
      {
        headers: {
          'x-user-id': user.id,
          'x-company-id': COMPANY_A,
        },
      },
    )
    expect(res.status()).toBe(401)
    await ctx.dispose()
  })

  test('new admin can create a customer in their own company', async () => {
    const ctx = await playwrightRequest.newContext()
    const login = await ctx.post(`${API}/api/v1/auth/login`, {
      data: { email: EMAIL, password: 'Test1234!' },
    })
    const user = await login.json()
    const res = await ctx.post(
      `${API}/api/v1/customers?companyId=${user.companyId}`,
      {
        headers: {
          'x-user-id': user.id,
          'x-company-id': user.companyId,
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
    expect(body.companyId).toBe(user.companyId)
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
    // creator's session.
    const login = await ctx.post(`${API}/api/v1/auth/login`, {
      data: { email: EMAIL, password: 'Test1234!' },
    })
    const user = await login.json()
    const listRes = await ctx.get(
      `${API}/api/v1/customers?companyId=${user.companyId}`,
      {
        headers: {
          'x-user-id': user.id,
          'x-company-id': user.companyId,
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
    const res = await ctx.get(
      `${API}/api/v1/customers/${cust.id}?companyId=${COMPANY_A}`,
      {
        headers: ADMIN_HEADERS_A,
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
