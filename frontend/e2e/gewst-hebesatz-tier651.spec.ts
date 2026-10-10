/**
 * Tier 651 — the Hebesatz of the municipality is entered in the Gewerbesteuer
 * section.
 *
 * Before: the section explained that the Hebesatz was adjusted "via
 * Company.settings.hebesatz" — a field no page wrote. Every trade tax was
 * computed at 400 %.
 */
import { test, expect, type Page, type APIRequestContext } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

async function open(page: Page, request: APIRequestContext) {
  const tag = `t651-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier651-e2e", companyName: "Tier651 Handel GmbH" },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  await page.context().clearCookies()
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
  await page.goto("/dashboard/accounting")
  return { userId, companyId }
}

test("the Hebesatz is entered, kept, and used by the other forms", async ({ page, request }) => {
  test.setTimeout(180_000)
  const { userId, companyId } = await open(page, request)
  const headers = { "x-user-id": userId, "x-company-id": companyId }
  const field = page.getByTestId("gewst-hebesatz")
  await expect(field).toBeVisible({ timeout: 90_000 })
  await expect(field).toHaveValue("400")
  await expect(page.getByLabel("Hebesatz der Gemeinde")).toBeVisible()
  await expect(page.getByText("Er steht im Gewerbesteuerbescheid.")).toBeVisible()
  // the section explains itself without the program's own vocabulary
  await expect(page.getByText(/Company\.settings|Standalone-Trade|\bv1:/)).toHaveCount(0)

  await field.fill("470")
  await page.getByTestId("gewst-save-vorauszahlungen").click()
  await expect(page.getByText("Hebesatz und Vorauszahlungen gespeichert.")).toBeVisible({ timeout: 30_000 })
  const year = new Date().getFullYear() - 1
  const g = await (await request.get(`${API}/api/v1/accounting/anlage-g?year=${year}&companyId=${companyId}`, { headers })).json()
  expect(g.totals.hebesatz).toBe(470)

  await page.reload()
  await expect(page.getByTestId("gewst-hebesatz")).toHaveValue("470", { timeout: 90_000 })

  // below what § 16 Abs. 4 GewStG allows: said in words, nothing saved
  await page.getByTestId("gewst-hebesatz").fill("150")
  await page.getByTestId("gewst-save-vorauszahlungen").click()
  await expect(page.getByText("Der Hebesatz ist eine ganze Zahl zwischen 200 und 1000.")).toBeVisible({ timeout: 30_000 })
  const after = await (await request.get(`${API}/api/v1/accounting/gewst?year=${year}&companyId=${companyId}`, { headers })).json()
  expect(after.hebesatz).toBe(470)
})
