import { test, expect } from "@playwright/test"

/**
 * Tier 827 — the app asks with a dialog of its own, not the browser's
 * `confirm()`: that one offered „Diese Seite daran hindern, weitere
 * Dialogfelder zu erstellen", and once ticked every later question answered
 * „no" at once — „Löschen" did nothing. Escape, „Abbrechen" and a click
 * beside the box keep things as they are; „OK" goes ahead; the browser shows
 * no dialog of its own.
 */

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("deleting a product asks in the app's own dialog", async ({ page, request }) => {
  test.setTimeout(180_000)
  const tag = `t827-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier827-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  expect((await request.post(`${API}/api/v1/products?companyId=${companyId}`, {
    headers: H, data: { sku: "T827", name: "Gürteltasche", unit: "Stk", basePrice: 49, vatRate: 19 },
  })).status()).toBe(201)
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(({ userId, companyId }: { userId: string; companyId: string }) => {
    localStorage.setItem("userId", userId)
    localStorage.setItem("companyId", companyId)
    localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, savedAt: new Date().toISOString() }))
  }, { userId, companyId })
  const native: string[] = []
  page.on("dialog", (d) => { native.push(d.message()); void d.dismiss() })

  await page.goto("/dashboard/products")
  const row = page.getByTestId("product-row").filter({ hasText: "Gürteltasche" })
  await expect(row).toBeVisible({ timeout: 90_000 })
  const del = row.getByTitle("Löschen")
  const dialog = page.getByTestId("confirm-dialog")

  // Escape: nothing happens
  await del.click()
  await expect(dialog).toBeVisible()
  await expect(page.getByTestId("confirm-dialog-message")).toHaveText("Löschen — Gürteltasche?")
  await expect(page.getByTestId("confirm-dialog-ok")).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
  await expect(row).toBeVisible()

  // „Abbrechen": nothing happens; the button that asked has the focus again
  await del.click()
  await page.getByTestId("confirm-dialog-cancel").click()
  await expect(dialog).toHaveCount(0)
  await expect(del).toBeFocused()
  await expect(row).toBeVisible()

  // beside the box: nothing happens
  await del.click()
  await page.getByTestId("confirm-dialog-backdrop").click({ position: { x: 5, y: 5 } })
  await expect(dialog).toHaveCount(0)
  await expect(row).toBeVisible()

  // „OK": deleted
  await del.click()
  await page.getByTestId("confirm-dialog-ok").click()
  await expect(row).toHaveCount(0, { timeout: 30_000 })
  const left = await (await request.get(`${API}/api/v1/products?companyId=${companyId}`, { headers: H })).json()
  expect((Array.isArray(left) ? left : left.items || left.data || []).some((p: { sku: string }) => p.sku === "T827")).toBe(false)
  expect(native, "the browser showed no dialog of its own").toEqual([])
})
