/**
 * Tier 604 — the Impressum shows the operator's own details.
 *
 * The page had a made-up provider („Musterstraße 1, 12345 Musterstadt“,
 * info@example.com, +49 (0) 000 000000). It now renders what the operator —
 * the installation's oldest company — entered in its company settings
 * (GET /companies/imprint, public), or says that this is still missing.
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("the Impressum is the operator's, without a session", async ({ page, request }) => {
  const res = await request.get(`${API}/api/v1/companies/imprint`)
  expect(res.status(), "the route is public").toBe(200)
  const imprint = await res.json()

  await page.goto("/impressum")
  await expect(page.getByTestId("impressum-heading")).toHaveText("Impressum", { timeout: 60_000 })
  await page.waitForLoadState("networkidle")
  const body = await page.locator("body").innerText()
  expect(body).not.toContain("info@example.com")
  expect(body).not.toContain("000 000000")
  expect(body).not.toContain("12345 Musterstadt")
  expect(body).toContain("§ 5 DDG")

  if (imprint.name) await expect(page.getByTestId("impressum-name")).toHaveText(imprint.name)
  if (imprint.street) await expect(page.getByTestId("impressum-address")).toContainText(imprint.street)
  if (imprint.email) await expect(page.getByTestId("impressum-email")).toHaveText(imprint.email)
  if (imprint.vatId) await expect(page.getByTestId("impressum-vat")).toHaveText(imprint.vatId)
  // complete → no notice; incomplete → the page says so instead of inventing something
  await expect(page.getByTestId("impressum-not-configured")).toHaveCount(imprint.configured ? 0 : 1)
})
