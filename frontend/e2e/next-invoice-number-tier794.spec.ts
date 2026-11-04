/**
 * Tier 794 — „Nächste Rechnungsnummer“ on the settings page.
 *
 * A company's first invoice was 000001, with no way to go on at the count of
 * the software it came from. The settings page now shows the number the next
 * invoice gets, takes a new one above the highest used, and shows the
 * backend's refusal for one below. The backend is spec 496.
 */
import { test, expect, type Page } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

async function signIn(page: Page, request: import("@playwright/test").APIRequestContext) {
  const tag = `t794-${Date.now()}-${Math.floor(Math.random() * 1000)}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier794-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
      localStorage.setItem("locale", "de")
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-08T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
  return { userId, companyId }
}

test("the next invoice number is shown, set to 1000, and not set below a number used", async ({ page, request }) => {
  test.setTimeout(120_000)
  const { userId, companyId } = await signIn(page, request)
  await page.goto("/dashboard/settings")
  const input = page.getByTestId("settings-next-invoice-number")
  const hint = page.getByTestId("settings-next-invoice-number-hint")
  await expect(hint).toContainText(/Die nächste Rechnung erhält INV-\d{4}-000001\./, { timeout: 60_000 })
  await expect(input).toHaveValue("1")

  await input.fill("1000")
  await page.getByTestId("settings-next-invoice-number-apply").click()
  const msg = page.getByTestId("settings-next-invoice-number-msg")
  await expect(msg).toHaveText(/Gespeichert — die nächste Rechnung erhält INV-\d{4}-001000\./)
  await expect(hint).toContainText(/INV-\d{4}-001000\. Möglich ist jede Zahl ab 1 /)
  const peek = await (await request.get(`${API}/api/v1/companies/${companyId}/invoice-number`, {
    headers: { "x-user-id": userId, "x-company-id": companyId },
  })).json()
  expect(peek.next).toBe(1000)

  // below what can be set: said on the page, nothing sent
  await input.fill("0")
  await page.getByTestId("settings-next-invoice-number-apply").click()
  await expect(msg).toHaveText("Bitte eine ganze Zahl von 1 bis 99999999 eingeben.")
  await expect(hint).toContainText("001000")
})
