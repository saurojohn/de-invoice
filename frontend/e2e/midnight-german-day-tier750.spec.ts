/**
 * Tier 750 — half an hour after midnight in Germany, where UTC is still on
 * yesterday.
 *
 * 23:30 UTC on 31.10. is 00:30 on 01.11. here. The customer statement proposed
 * September (the month before UTC's October), a scanned receipt without a date
 * was dated the 31st, and the first instalment fell a day early. Time stamps of
 * that hour were shown on the UTC day; the credit ledger printed UTC at any
 * hour, one or two behind the clock on the wall.
 * (The backend's side: spec 469.)
 */
import { test, expect, type Page } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"
const AFTER_MIDNIGHT = new Date("2026-10-31T23:30:00.000Z")
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=", "base64")

async function as(page: Page, userId: string, companyId: string) {
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
      localStorage.setItem("locale", "de")
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, savedAt: "2026-10-29T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
}

test("00:30 on the 1st: the forms and the time stamps are on the German day", async ({ page, request }) => {
  test.setTimeout(240_000)
  const tag = `t750-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier750-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const customer = await (await request.post(`${API}/api/v1/customers?companyId=${companyId}`, {
    headers: H,
    data: { name: `${tag} Kunde`, type: "business", address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" } },
  })).json()
  await as(page, userId, companyId)
  await page.clock.setFixedTime(AFTER_MIDNIGHT)

  // the customer statement proposes the month that has just ended
  await page.goto(`/dashboard/customers/${customer.id}/statement`)
  await expect.soft(page.getByTestId("statement-from-input")).toHaveValue("2026-10-01", { timeout: 90_000 })
  await expect.soft(page.getByTestId("statement-to-input")).toHaveValue("2026-10-31")

  // the credit ledger: the moment, on the German day and the German clock
  await page.route("**/credit-ledger**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "t750", type: "manual", amount: 10, currency: "EUR", balanceAfter: 10, referenceType: null, referenceId: null,
          description: "Korrektur", createdById: null, createdAt: "2026-10-30T23:18:00.000Z",
        },
      ]),
    }),
  )
  await page.goto(`/dashboard/customers/${customer.id}/credit`)
  await expect.soft(page.getByTestId("credit-ledger-row")).toContainText("31.10.2026 00:18", { timeout: 90_000 })

  // a receipt without a date: today
  await page.route("**/api/v1/ocr/scan**", (route) =>
    route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ supplierName: `${tag} Laden`, grossAmount: 11.9 }) }),
  )
  await page.goto("/dashboard/expenses")
  await expect(page.getByTestId("expense-ocr-upload-button")).toBeVisible({ timeout: 90_000 })
  await page.waitForFunction(() => document.readyState === "complete")
  await page.getByTestId("expense-ocr-file-input").setInputFiles({ name: "beleg.png", mimeType: "image/png", buffer: PNG })
  await expect.soft(page.getByTestId("ocr-field-date")).toHaveValue("2026-11-01", { timeout: 30_000 })
})
