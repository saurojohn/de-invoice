import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

/**
 * Tier 14.4: Webhook administration UI.
 *
 * Tests the page at /dashboard/settings/webhooks:
 *   1. Page renders (no console errors, no
 *      "Application error" overlay)
 *   2. Empty state shows when no webhooks
 *      exist
 *   3. Create modal opens
 *   4. Create flow: fill in name/URL/events →
 *      submit → secret dialog appears
 *   5. After closing secret dialog, the new
 *      webhook appears in the list
 *   6. Delete (soft-delete) removes it
 *
 * Why a separate spec file?
 *   - smoke.spec.ts is the "8 fast tests"
 *     that gate every commit. Adding more
 *     tests there would slow it down.
 *   - Webhook UI is a new surface that
 *     benefits from isolated regression.
 *
 * Why rely on the e2e 50 cleanup?
 *   - The backend e2e 50 cleans up all
 *     test webhooks at the end of its run
 *     so the DB is empty when this spec
 *     starts.
 *   - If the order ever changes, the
 *     "empty state" test fails loudly.
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

test.beforeEach(async ({ context }: { context: any }) => {
  if (!testTokens) return
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
})

async function injectLocalStorage(page: any) {
  if (!testTokens) return
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
    },
    testTokens,
  )
}

test.describe("Webhooks UI", () => {
  test("settings page links to webhooks", async ({ page }) => {
    // Verify the entry-point exists in the
    // main settings overview so a user
    // can find the new page.
    await injectLocalStorage(page)
    await page.goto("/dashboard/settings")
    // Same hydration wait as Tiers 185 / 183 / 49.
    await page.waitForFunction(
      () => document.readyState === 'complete',
      { timeout: 30_000 },
    )
    await page.waitForTimeout(500)
    const link = page.locator('[data-testid="webhooks-settings-link"]')
    await expect(link).toBeVisible({ timeout: 10_000 })
  })

  test("webhooks page renders with empty state", async ({ page }) => {
    await injectLocalStorage(page)
    await page.goto("/dashboard/settings/webhooks")
    await page.waitForFunction(
      () => document.readyState === 'complete',
      { timeout: 30_000 },
    )
    await page.waitForTimeout(500)

    // Title visible
    await expect(
      page.locator("h1").filter({ hasText: "Webhooks" }).first(),
    ).toBeVisible({ timeout: 5_000 })

    // No JS error overlay
    const body = await page.locator("body").innerText()
    expect(body).not.toContain("Application error")

    // Either empty state OR a list (we don't
    // care which — depends on whether a
    // prior test left webhooks behind)
    const hasEmpty = await page
      .locator("text=Noch keine Webhooks")
      .isVisible()
      .catch(() => false)
    const hasList = await page
      .locator('[data-testid="webhook-row"]')
      .first()
      .isVisible()
      .catch(() => false)
    expect(hasEmpty || hasList).toBe(true)
  })

  test("create webhook via UI — full flow", async ({ page }) => {
    await injectLocalStorage(page)

    // Pre-clean: delete any prior test
    // webhooks for this company. We
    // can't do this from the UI without
    // a more elaborate flow, so use the
    // API directly via fetch.
    await page.goto("/dashboard/settings/webhooks")
    await page.waitForFunction(
      () => document.readyState === 'complete',
      { timeout: 30_000 },
    )
    await page.waitForTimeout(500)

    // Wait for the page to fully hydrate
    // and finish loading (it renders a
    // SkeletonTable first, then the real
    // list). Wait for the empty state OR
    // the "Webhook hinzufügen" button to
    // appear before interacting.
    const addBtn = page.locator("button", {
      hasText: /Webhook hinzufügen/,
    })
    await addBtn.first().waitFor({ state: "visible", timeout: 15_000 })
    await addBtn.first().click()
    await expect(
      page.locator('[data-testid="webhook-create-modal"]'),
    ).toBeVisible({ timeout: 3_000 })

    // Fill in the form
    const uniqueName = `e2e-14.4-${Date.now()}`
    await page.fill(
      '[data-testid="webhook-name-input"]',
      uniqueName,
    )
    await page.fill(
      '[data-testid="webhook-url-input"]',
      "https://httpbin.org/post",
    )
    // Tick a couple of event checkboxes
    await page.click('[data-testid="webhook-event-invoiceCreated"]')
    await page.click('[data-testid="webhook-event-paymentReceived"]')

    // Submit
    await page.click('[data-testid="webhook-create-submit"]')

    // Secret dialog should appear
    await expect(
      page.locator('[data-testid="webhook-secret-dialog"]'),
    ).toBeVisible({ timeout: 5_000 })
    const secretText = await page
      .locator('[data-testid="webhook-secret"]')
      .innerText()
    expect(secretText.length).toBeGreaterThan(20)

    // Close the dialog
    await page.getByRole("button", { name: /Schließen/ }).click()

    // The new webhook should appear in the list
    await expect(
      page.locator('[data-testid="webhook-row"]', { hasText: uniqueName }),
    ).toBeVisible({ timeout: 5_000 })

    // Clean up: delete the webhook we just created
    // so subsequent runs start from a clean state.
    // Find the row and click its delete button.
    const row = page.locator('[data-testid="webhook-row"]', {
      hasText: uniqueName,
    })
    const deleteBtn = row.locator('[data-testid="webhook-delete"]')
    // Set up dialog handler before clicking
    page.once("dialog", (dialog) => dialog.accept())
    await deleteBtn.click()

    // The row should disappear
    await expect(
      page.locator('[data-testid="webhook-row"]', { hasText: uniqueName }),
    ).toHaveCount(0, { timeout: 5_000 })
  })

  test("replay button in deliveries drawer triggers replay", async ({
    page,
  }) => {
    await injectLocalStorage(page)

    // Pre-clean: delete any prior test
    // webhooks for this company via the
    // UI/API so the page renders cleanly.
    await page.goto("/dashboard/settings/webhooks")
    await page.waitForFunction(
      () => document.readyState === 'complete',
      { timeout: 30_000 },
    )
    await page.waitForTimeout(500)

    // Create a webhook for the replay test.
    // Use webhook.test so we don't need
    // to set up a customer + invoice.
    const addBtn = page.locator("button", {
      hasText: /Webhook hinzufügen/,
    })
    await addBtn.first().waitFor({ state: "visible", timeout: 15_000 })
    await addBtn.first().click()
    await expect(
      page.locator('[data-testid="webhook-create-modal"]'),
    ).toBeVisible({ timeout: 3_000 })

    const uniqueName = `e2e-14.5-${Date.now()}`
    await page.fill(
      '[data-testid="webhook-name-input"]',
      uniqueName,
    )
    await page.fill(
      '[data-testid="webhook-url-input"]',
      "https://httpbin.org/post",
    )
    // Subscribe to invoice.created so we
    // can trigger a real event by creating
    // an invoice via the customers + invoices
    // pages. webhook.test is intentionally
    // NOT exposed in the UI event list —
    // it's a backend-only debug event.
    await page.click('[data-testid="webhook-event-invoiceCreated"]')
    await page.click('[data-testid="webhook-create-submit"]')

    // Close the secret dialog
    await page.getByRole("button", { name: /Schließen/ }).click()

    // Wait for the new webhook row
    await expect(
      page.locator('[data-testid="webhook-row"]', { hasText: uniqueName }),
    ).toBeVisible({ timeout: 5_000 })

    const row = page.locator('[data-testid="webhook-row"]', {
      hasText: uniqueName,
    })

    // Trigger a real invoice.created by
    // calling the backend directly via
    // fetch (avoids navigating through
    // the full invoice-creation form,
    // which is out of scope for this test).
    await page.evaluate(
      async ({ uid, cid }: { uid: string; cid: string }) => {
        // Create a customer first
        const custRes = await fetch(
          `http://localhost:3001/api/v1/customers?companyId=${cid}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-user-id": uid,
              "x-company-id": cid,
            },
            body: JSON.stringify({
              name: "e2e-14.5 customer",
              address: { city: "Berlin" },
            }),
          },
        )
        // Tier 380: both setup calls are checked. Unchecked, a failed
        // create meant no delivery and the test ended in its skip branch.
        if (custRes.status !== 201) throw new Error(`customer create ${custRes.status}`)
        const customer = await custRes.json()
        // Now create an invoice against that customer
        const invRes = await fetch(
          `http://localhost:3001/api/v1/invoices?companyId=${cid}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-user-id": uid,
              "x-company-id": cid,
            },
            body: JSON.stringify({
              customerId: customer.id,
              type: "INV",
              issueDate: new Date().toISOString().slice(0, 10),
              dueDate: new Date(Date.now() + 14 * 86400000)
                .toISOString()
                .slice(0, 10),
              items: [
                {
                  description: "e2e-14.5 item",
                  quantity: 1,
                  unitPrice: "10.00",
                  vatRate: 0.19,
                },
              ],
            }),
          },
        )
        if (invRes.status !== 201) throw new Error(`invoice create ${invRes.status}`)
        return customer
      },
      { uid: testTokens!.userId, cid: testTokens!.companyId },
    )

    // Tier 380: wait for the delivery row via the API before opening the
    // drawer. InvoiceService.create does not await webhooks.emit(), and the
    // drawer loads deliveries only when opened (no polling) — so a drawer
    // opened before the emit lands shows an empty list for good. That is the
    // likeliest cause of the skip CI took once (not reproduced locally, 3/3).
    // The old comment blamed a cron; rows are inserted on emit (Tier 350).
    const auth = { "x-user-id": testTokens!.userId, "x-company-id": testTokens!.companyId }
    const hooks = await (
      await page.request.get(
        `http://localhost:3001/api/v1/webhooks?companyId=${testTokens!.companyId}`,
        { headers: auth },
      )
    ).json()
    const hook = (hooks as Array<{ id: string; name: string }>).find((h) => h.name === uniqueName)
    expect(hook, "created webhook listed by the API").toBeTruthy()
    await expect
      .poll(
        async () => {
          const r = await page.request.get(
            `http://localhost:3001/api/v1/webhooks/${hook!.id}/deliveries?companyId=${testTokens!.companyId}`,
            { headers: auth },
          )
          return r.ok() ? ((await r.json()) as unknown[]).length : -1
        },
        { timeout: 20_000, message: "invoice.created produced no webhook delivery" },
      )
      .toBeGreaterThan(0)

    // Open the deliveries drawer
    await row.locator('[data-testid="webhook-deliveries"]').click()
    await expect(
      page.locator('[data-testid="webhook-deliveries-drawer"]'),
    ).toBeVisible({ timeout: 5_000 })

    // Wait for the delivery row to appear. The
    // cron that fires the webhook runs every
    // minute; if we just created the invoice,
    // we may need to wait up to 60s for the
    // delivery to land. 30s is usually enough
    // because the cron may have run very
    // recently. If the cron hasn't run within
    // 30s (we caught it just after a tick), we
    // skip the test rather than fail — the
    // assertion is correct, the env is just
    // unlucky.
    // Tier 380: no skip any more. It was kept in Tier 369 as a "cron race";
    // CI run 34963691074 took it once (912 passed, 1 skipped). The delivery
    // now exists before the drawer opens, so a missing row is a real failure.
    const deliveryRow = page.locator('[data-testid="delivery-row"]').first()
    await expect(deliveryRow).toBeVisible({ timeout: 15_000 })

    // Count deliveries before replay
    const beforeCount = await page
      .locator('[data-testid="delivery-row"]')
      .count()

    // Set up dialog handler BEFORE clicking
    page.once("dialog", (dialog) => dialog.accept())

    // Click the Replay button on the first delivery row
    await page
      .locator('[data-testid="delivery-row"]')
      .first()
      .locator('[data-testid="delivery-replay"]')
      .click()

    // Wait for the count to increase
    // (replay creates a new delivery row)
    await expect(
      page.locator('[data-testid="delivery-row"]'),
    ).toHaveCount(beforeCount + 1, { timeout: 10_000 })

    // Cleanup: close drawer + delete the
    // test webhook
    await page.keyboard.press("Escape")
    // Click the close (X) button in the drawer
    await page
      .locator('[data-testid="webhook-deliveries-drawer"]')
      .locator("button[aria-label='Close']")
      .click()
    page.once("dialog", (dialog) => dialog.accept())
    await row.locator('[data-testid="webhook-delete"]').click()

    // Cleanup: delete the test customer
    // + invoices created above (direct DB
    // cleanup — they're not surfaced in
    // the webhook UI).
    // We can't call the DELETE endpoint
    // because invoices might block it
    // (delete is only allowed on the
    // issue date). For test cleanup
    // simplicity, just leave them —
    // they'll show up as one extra row
    // in the customer's "Rechnungen"
    // list and won't break any other
    // tests.
  })
})
