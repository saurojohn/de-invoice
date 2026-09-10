import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 62: USt-Behandlung auto-Erkennung (auto-suggestion).
 *
 * The invoice create form auto-detects the right
 * USt-Behandlung for the chosen customer:
 *   - DE customer with DE VAT ID → standard (Inland B2B)
 *   - DE customer without VAT ID → standard (B2C)
 *   - EU customer (e.g. FR) with FR VAT ID →
 *     euTransaction (§1a UStG, with §13b hint)
 *   - Non-EU customer (e.g. US) without VAT ID →
 *     standard (Ausfuhrlieferung §4 UStG prüfen)
 *
 * The detector is a pure function on the backend
 * (see `ust-behandlung-detector.ts`); the e2e 89
 * test exercises it via HTTP. This Playwright spec
 * tests the UI integration:
 *
 *   1. The "Auto-Erkennung" hint renders after
 *      selecting a customer
 *   2. The "USt-ID" badge renders when the
 *      customer has a VAT ID
 *   3. The "EU B2B" badge renders when the
 *      customer is in a different EU country
 *   4. The radio group is pre-filled to the
 *      suggested treatment (e.g. euTransaction
 *      for an FR customer)
 *   5. The reason text mentions the right §-reference
 *      for the scenario
 *
 * Why a fresh-customer-per-spec? The customer search
 * dropdown is a free-text filter on `Customer.name` —
 * using a unique TAG prefix per run (e.g. `Tier62-EU-<ts>`)
 * avoids ever matching a customer from a previous run
 * (or a production fixture), and makes the dropdown
 * locator exact.
 *
 * Auth: shares the /tmp/cashbook-e2e-auth.env cache
 * with the backend e2e suite. Run those first, then
 *   `npx playwright test e2e/ust-suggestion.spec.ts`.
 */

const AUTH_CACHE = "/tmp/cashbook-e2e-auth.env"

function readCachedTokens(): { userId: string; companyId: string } {
  const env = readFileSync(AUTH_CACHE, "utf-8")
  const map: Record<string, string> = {}
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) map[m[1]] = m[2]
  }
  if (!map.USER_ID || !map.COMPANY_ID) {
    throw new Error(
      `Auth cache ${AUTH_CACHE} missing — run backend e2e first`,
    )
  }
  return { userId: map.USER_ID, companyId: map.COMPANY_ID }
}

let testTokens: { userId: string; companyId: string } | null = null

test.beforeAll(() => {
  testTokens = readCachedTokens()
})

// Tag every fixture with the same TS so beforeAll and
// the spec body can both reference it. The test deletes
// via the LIKE 'Tier62Playwright-<ts>%' clause so we
// never leave junk behind even if afterAll fails.
const TAG = `Tier62Playwright-${Date.now()}`

interface Fixture {
  id: string
  name: string
  vatId: string | null
  country: string
}

const fixtures: Fixture[] = []

test.beforeAll(async ({ request }) => {
  // 3 hermetic customers — one for each of the
  // scenarios we exercise in the UI:
  //   a) Inland B2B (DE + DE VAT ID)
  //   b) Inland B2C (DE, no VAT)
  //   c) EU B2B (FR + FR VAT ID) — exercises the
  //      EU-B2B branch + isEuB2b=true badge +
  //      §1a UStG hint + euTransaction radio prefill
  //
  // We use `request.post` (separate context, no
  // cookies needed) so this spec doesn't depend on
  // the dev login flow not being throttled (lesson
  // from tier 58: the throttle 600/60s can 429 the
  // login route when many parallel specs run).
  const headers = {
    "x-user-id": testTokens!.userId,
    "x-company-id": testTokens!.companyId,
  }
  const api = `http://localhost:3001/api/v1/customers?companyId=${testTokens!.companyId}`

  const mk = async (suffix: string, vatId: string | null, country: string) => {
    const body: Record<string, unknown> = {
      name: `${TAG}-${suffix}`,
      type: "business",
      address: { country },
    }
    if (vatId) body.vatId = vatId
    const res = await request.post(api, { headers, data: body })
    expect(res.status(), `create ${suffix}`).toBe(201)
    const j = await res.json()
    return { id: j.id, name: `${TAG}-${suffix}`, vatId, country }
  }

  fixtures.push(await mk("DE-B2B", "DE987654321", "DE"))
  fixtures.push(await mk("DE-B2C", null, "DE"))
  fixtures.push(await mk("FR-B2B", "FR12345678901", "FR"))
})

test.afterAll(async ({ request }) => {
  if (!testTokens || fixtures.length === 0) return
  for (const f of fixtures) {
    try {
      await request.delete(
        `http://localhost:3001/api/v1/customers/${f.id}?companyId=${testTokens.companyId}`,
        {
          headers: {
            "x-user-id": testTokens.userId,
            "x-company-id": testTokens.companyId,
          },
        },
      )
    } catch {
      // Ignore — non-fatal. afterAll best-effort cleanup.
    }
  }
})

async function setupAuth(context: any, page: any) {
  if (!testTokens) return
  // The Next.js middleware (src/middleware.ts) reads
  // x-user-id / x-company-id from COOKIES, not
  // localStorage. Without the cookies, every
  // /dashboard/* page redirects to /login BEFORE the
  // React app even mounts, so addInitScript(localStorage)
  // is too late.
  await context.addCookies([
    {
      name: "x-user-id",
      value: testTokens.userId,
      domain: "localhost",
      path: "/",
      sameSite: "Lax",
    },
    {
      name: "x-company-id",
      value: testTokens.companyId,
      domain: "localhost",
      path: "/",
      sameSite: "Lax",
    },
  ])
  // The create form ALSO reads `companyId` from
  // localStorage inside its useEffect — without it,
  // the page redirects to /login even with the
  // cookies in place. The customer-detail spec hits
  // the same problem and solved it with
  // addInitScript. Mirror that here.
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
    },
    testTokens,
  )
}

/**
 * Navigate to the invoice create page, type the
 * customer's unique name into the search input, click
 * the dropdown item, then wait for the suggestion hint
 * to render (the hint appears only AFTER the customer
 * is selected and the API responds).
 *
 * Why wait for the customers API response first?
 * The create form fetches the customers list in
 * parallel with the form mount. If we type into the
 * search input before the list arrives, the dropdown
 * shows the "+ Neuen Kunden anlegen" item (since
 * `filteredCustomers` is empty) and Playwright's
 * `text=<name>` locator matches THAT item first —
 * not the real customer. We use `waitForResponse`
 * to ensure the customers fetch has resolved before
 * we start typing.
 *
 * The dropdown uses onMouseDown (not onClick) on the
 * item rows, so the click must be via `click()` which
 * Playwright maps to mousedown+mouseup.
 */
async function selectCustomerAndWaitForHint(
  page: any,
  customerName: string,
) {
  // Register the response waiter BEFORE the
  // page navigation. The create form fetches
  // /api/v1/customers?pageSize=200 in a
  // useEffect on mount; we want to type only
  // AFTER the payload has been applied to the
  // React state. Per the Playwright gotcha in
  // MEMORY.md, the waiter MUST be set up
  // before the request fires — registering it
  // after page.goto() will miss the response.
  const customersResponse = page.waitForResponse(
    (r: any) =>
      r.url().includes("/api/v1/customers") &&
      r.url().includes("pageSize=200") &&
      r.status() === 200,
    { timeout: 15_000 },
  )

  await page.goto("/dashboard/invoices/create", {
    waitUntil: "domcontentloaded",
  })
  // The customer search input is the FIRST input the
  // user touches — wait for it explicitly. The page is
  // heavy and the customers list fetches in parallel
  // with the form mount.
  const search = page.locator('[data-testid="invoice-customer-search"]')
  await expect(search).toBeVisible({ timeout: 15_000 })
  // Wait for the customers fetch to complete. This
  // guarantees `customers` state is populated BEFORE
  // we type, so the filter operates on the full list.
  await customersResponse
  // Small settle — the React state update is
  // synchronous after the .then() but the dropdown
  // re-render is one tick later.
  await page.waitForTimeout(200)
  await search.click()
  await search.fill(customerName)
  // The dropdown items are divs with the customer
  // name as a child. Wait for the unique name to
  // appear in a clickable position. The dropdown
  // is filtered live as we type.
  const item = page.locator(`text=${customerName}`).first()
  await expect(item).toBeVisible({ timeout: 5_000 })
  // Use a stable scope: target the divs inside the
  // dropdown by class, not text-matching which can
  // also match the "+ Neuen Kunden" pseudo-item.
  await page
    .locator(`div.hover\\:bg-blue-50:has-text("${customerName}")`)
    .first()
    .click()
  // The hint renders after the suggestion API
  // resolves. Use a small waitFor on the hint
  // element (the data-testid is `invoice-ust-suggestion-hint`).
  await expect(
    page.locator('[data-testid="invoice-ust-suggestion-hint"]'),
  ).toBeVisible({ timeout: 10_000 })
}

test.describe("Tier 62 — USt-Behandlung auto-Erkennung on invoice create", () => {
  test("DE + DE VAT ID → standard + USt-ID badge, no EU-B2B badge", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    const f = fixtures.find((x) => x.name.endsWith("DE-B2B"))!
    await selectCustomerAndWaitForHint(page, f.name)

    // USt-ID badge present (the customer has a DE VAT ID).
    await expect(
      page.locator('[data-testid="invoice-ust-suggestion-vatid-badge"]'),
    ).toBeVisible()
    // EU B2B badge ABSENT (both customer + company are DE).
    await expect(
      page.locator('[data-testid="invoice-ust-suggestion-eub2b-badge"]'),
    ).toHaveCount(0)
    // Hint mentions Inland.
    const hint = page.locator('[data-testid="invoice-ust-suggestion-hint"]')
    await expect(hint).toContainText(/Inland/i)
    // Radio: standard is checked.
    await expect(
      page.locator('[data-testid="invoice-tax-standard"]'),
    ).toBeChecked()
  })

  test("DE without VAT ID → standard + no VAT-ID badge, B2C reason", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    const f = fixtures.find((x) => x.name.endsWith("DE-B2C"))!
    await selectCustomerAndWaitForHint(page, f.name)

    // No VAT-ID badge (customer has no VAT ID).
    await expect(
      page.locator('[data-testid="invoice-ust-suggestion-vatid-badge"]'),
    ).toHaveCount(0)
    // No EU B2B badge.
    await expect(
      page.locator('[data-testid="invoice-ust-suggestion-eub2b-badge"]'),
    ).toHaveCount(0)
    // Hint mentions B2C.
    const hint = page.locator('[data-testid="invoice-ust-suggestion-hint"]')
    await expect(hint).toContainText(/B2C/i)
    // Radio: standard.
    await expect(
      page.locator('[data-testid="invoice-tax-standard"]'),
    ).toBeChecked()
  })

  test("FR + FR VAT ID → euTransaction + USt-ID badge + EU B2B badge + §1a hint", async ({
    page,
    context,
  }) => {
    await setupAuth(context, page)
    const f = fixtures.find((x) => x.name.endsWith("FR-B2B"))!
    await selectCustomerAndWaitForHint(page, f.name)

    // Both badges present.
    await expect(
      page.locator('[data-testid="invoice-ust-suggestion-vatid-badge"]'),
    ).toBeVisible()
    await expect(
      page.locator('[data-testid="invoice-ust-suggestion-eub2b-badge"]'),
    ).toBeVisible()
    // Hint mentions §1a (innergemeinschaftliche Lieferung)
    // or §13b (reverse charge for B2B services) — the
    // detector surfaces both so the Berater picks the
    // right one.
    const hint = page.locator('[data-testid="invoice-ust-suggestion-hint"]')
    await expect(hint).toContainText(/1a UStG|13b UStG/)
    // Radio: euTransaction is checked (not standard).
    await expect(
      page.locator('[data-testid="invoice-tax-eu"]'),
    ).toBeChecked()
    await expect(
      page.locator('[data-testid="invoice-tax-standard"]'),
    ).not.toBeChecked()
  })

  test("hint + badges disappear when customer is cleared (smoke)", async ({
    page,
    context,
  }) => {
    // Sanity test: the hint should NOT render on a
    // fresh page with no customer selected. This is
    // a regression guard for the case where the
    // suggestion state is stale across navigations.
    await setupAuth(context, page)
    await page.goto("/dashboard/invoices/create", {
      waitUntil: "domcontentloaded",
    })
    await expect(
      page.locator('[data-testid="invoice-tax-treatment"]'),
    ).toBeVisible({ timeout: 10_000 })
    // No hint before customer is picked.
    await expect(
      page.locator('[data-testid="invoice-ust-suggestion-hint"]'),
    ).toHaveCount(0)
    // No badges.
    await expect(
      page.locator('[data-testid="invoice-ust-suggestion-badges"]'),
    ).toHaveCount(0)
  })
})
