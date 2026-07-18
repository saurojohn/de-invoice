import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"
import { execSync } from "child_process"

/**
 * Tier 66: MandantSwitcher UI.
 *
 * The dashboard header now has a "Mandant wechseln"
 * dropdown (visible only when the user has 2+
 * UserCompany grants). This spec covers the
 * end-to-end user flow:
 *
 *   1. With only SH Leder (1 grant) the dropdown
 *      does NOT render — instead a small "single-
 *      Mandant" label is shown.
 *   2. After granting the test user a second
 *      Company, the dropdown appears with both
 *      Mandanten. The active one is marked with a
 *      checkmark and rendered first.
 *   3. Clicking a different Mandant issues
 *      POST /api/v1/users/me/switch-company, then
 *      reloads the page. After the reload, the
 *      previously-clicked Mandant is now the
 *      active one.
 *
 * Backend e2e 93 covers the API contract. This
 * Playwright spec covers the UI affordances:
 * data-testid stability, dropdown open/close,
 * click → POST → reload → state-flip.
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

const TAG = `Tier66-Playwright-${Date.now()}`
const SECOND_COMPANY_ID = `${TAG}-c2`

test.afterAll(async () => {
  if (!testTokens) return
  // Best-effort cleanup of the second company + grant.
  try {
    execSync(
      `docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL
DELETE FROM "UserCompany" WHERE "companyId" = '${SECOND_COMPANY_ID}';
DELETE FROM "Company" WHERE id = '${SECOND_COMPANY_ID}';
SQL`,
      { stdio: "ignore" },
    )
  } catch {
    // best-effort
  }
})

async function injectAuth(page: any) {
  if (!testTokens) return
  // Set localStorage on the FIRST navigation only.
  // After the user clicks a Mandant and the page
  // reloads, the localStorage must keep the new
  // companyId — so we don't re-inject if userId
  // is already present.
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      if (!localStorage.getItem("userId")) {
        localStorage.setItem("userId", userId)
        localStorage.setItem("companyId", companyId)
      }
    },
    testTokens,
  )
  await page.context().addCookies([
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
}

function ensureSecondMandantGrant() {
  if (!testTokens) return
  // The second Mandant must exist before each test
  // that needs it. Use ON CONFLICT to be idempotent.
  execSync(
    `docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL
INSERT INTO "Company" (id, name, "legalName", address, "defaultPaymentDays", "createdAt", "updatedAt")
VALUES ('${SECOND_COMPANY_ID}', '${TAG} Mandant', 'Tier66 Test GmbH', '{}'::jsonb, 30, NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO "UserCompany" ("userId", "companyId", role, "grantedAt")
VALUES ('${testTokens.userId}', '${SECOND_COMPANY_ID}', 'accountant', NOW())
ON CONFLICT DO NOTHING;
SQL`,
    { stdio: "ignore" },
  )
}

test.describe("MandantSwitcher", () => {
  test("single-Mandant user sees label, not dropdown", async ({ page }) => {
    // Before granting a second company, the test user
    // has only SH Leder. The dropdown should NOT render.
    // Make sure no stale second Mandant exists from a
    // prior run.
    execSync(
      `docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice <<SQL
DELETE FROM "UserCompany" WHERE "companyId" = '${SECOND_COMPANY_ID}';
DELETE FROM "Company" WHERE id = '${SECOND_COMPANY_ID}';
SQL`,
      { stdio: "ignore" },
    )

    await injectAuth(page)
    await page.goto("/dashboard")
    // Wait for the dashboard to finish loading.
    await expect(page.getByTestId("mandant-switcher-single")).toBeVisible({
      timeout: 30_000,
    })
    // The dropdown variant is absent.
    await expect(page.getByTestId("mandant-switcher")).toHaveCount(0)
  })

  test("multi-Mandant dropdown renders, lists both", async ({ page }) => {
    if (!testTokens) throw new Error("tokens not loaded")
    ensureSecondMandantGrant()

    await injectAuth(page)
    await page.goto("/dashboard")
    const switcher = page.getByTestId("mandant-switcher")
    await expect(switcher).toBeVisible({ timeout: 30_000 })

    // The single-Mandant label is now absent.
    await expect(page.getByTestId("mandant-switcher-single")).toHaveCount(0)

    // Open the dropdown.
    await page.getByTestId("mandant-switcher-button").click()
    const dropdown = page.getByTestId("mandant-switcher-dropdown")
    await expect(dropdown).toBeVisible({ timeout: 5_000 })

    // Both options render.
    const options = page.getByTestId("mandant-switcher-option")
    await expect(options).toHaveCount(2, { timeout: 5_000 })

    // The second Mandant option is present.
    await expect(
      page.locator(
        `[data-testid="mandant-switcher-option"][data-mandant-id="${SECOND_COMPANY_ID}"]`,
      ),
    ).toBeVisible()

    // Close the dropdown.
    await page.keyboard.press("Escape")
  })

  test("clicking a Mandant issues POST + reloads page with new active", async ({
    page,
  }) => {
    if (!testTokens) throw new Error("tokens not loaded")
    ensureSecondMandantGrant()

    await injectAuth(page)
    await page.goto("/dashboard")
    await expect(page.getByTestId("mandant-switcher")).toBeVisible({
      timeout: 30_000,
    })

    // Open the dropdown and intercept the POST.
    const switchPost = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/users/me/switch-company") &&
        r.request().method() === "POST",
    )
    await page.getByTestId("mandant-switcher-button").click()
    await expect(page.getByTestId("mandant-switcher-dropdown")).toBeVisible()

    // Click the second Mandant.
    const secondOption = page.locator(
      `[data-testid="mandant-switcher-option"][data-mandant-id="${SECOND_COMPANY_ID}"]`,
    )
    await expect(secondOption).toBeVisible({ timeout: 5_000 })
    await secondOption.click()

    // The POST returns 201 Created.
    const resp = await switchPost
    expect(resp.status(), "POST switch-company").toBe(201)

    // The page reloads. After reload, the dropdown
    // shows the second company as active.
    await page.waitForLoadState("domcontentloaded")
    await page.waitForTimeout(2_000)
    const lsState = await page.evaluate(() => ({
      userId: localStorage.getItem("userId"),
      companyId: localStorage.getItem("companyId"),
    }))
    expect(lsState.companyId, "localStorage companyId after reload").toBe(
      SECOND_COMPANY_ID,
    )

    await expect(page.getByTestId("mandant-switcher")).toBeVisible({
      timeout: 30_000,
    })
    await page.getByTestId("mandant-switcher-button").click()
    const dropdown = page.getByTestId("mandant-switcher-dropdown")
    await expect(dropdown).toBeVisible({ timeout: 5_000 })
    const activeOption = page.locator(
      `[data-testid="mandant-switcher-option"][data-mandant-id="${SECOND_COMPANY_ID}"]`,
    )
    await expect(activeOption).toHaveClass(/font-medium|active/, {
      timeout: 5_000,
    })

    // Switch back to SH Leder via the API so subsequent
    // tests see the default Mandant.
    await page.evaluate(
      async ({ userId, companyId }: { userId: string; companyId: string }) => {
        const r = await fetch(
          "http://localhost:3001/api/v1/users/me/switch-company",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-user-id": userId,
              "x-company-id": companyId,
            },
            body: JSON.stringify({ companyId }),
          },
        )
        if (!r.ok) throw new Error(`reset switch failed: ${r.status}`)
      },
      { userId: testTokens.userId, companyId: testTokens.companyId },
    )
  })
})
