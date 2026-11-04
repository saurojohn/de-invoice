/**
 * Tier 796 — the tag chips of the customer list are the tags of all the
 * company's customers, not of the 50 on the page shown.
 *
 * A company with 55 customers, the last of them by name (on the second page)
 * the only one tagged "Seite-Zwei": its chip is offered on the first page,
 * and picking it lists that customer. The backend is spec 498.
 */
import { test, expect, type Page } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

async function signIn(page: Page, request: import("@playwright/test").APIRequestContext) {
  const tag = `t796-${Date.now()}-${Math.floor(Math.random() * 1000)}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier796-e2e", companyName: `${tag} GmbH` },
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

test("a tag only a customer on the second page has is offered, and picking it lists that customer", async ({ page, request }) => {
  test.setTimeout(180_000)
  const { userId, companyId } = await signIn(page, request)
  const headers = { "x-user-id": userId, "x-company-id": companyId }
  for (let n = 1; n <= 55; n++) {
    const res = await request.post(`${API}/api/v1/customers?companyId=${companyId}`, {
      headers,
      data: {
        name: `Kunde ${String(n).padStart(2, "0")}`,
        type: "business",
        address: { street: "Ring 1", postalCode: "50667", city: "Köln", country: "DE" },
        ...(n === 55 ? { tags: ["Seite-Zwei"] } : n <= 3 ? { tags: ["VIP"] } : {}),
      },
    })
    expect(res.status()).toBe(201)
  }

  await page.goto("/dashboard/customers")
  await expect(page.getByTestId("customer-tag-suggestions")).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText("Kunde 01").first()).toBeVisible()
  await expect(page.getByText("Kunde 55")).toHaveCount(0)
  const chip = page.getByTestId("customer-tag-chip-Seite-Zwei")
  await expect(chip).toBeVisible()
  await expect(chip).toContainText("1")
  await expect(page.getByTestId("customer-tag-chip-VIP")).toContainText("3")

  await chip.click()
  await expect(page.getByTestId("customer-tag-active-Seite-Zwei")).toBeVisible()
  await expect(page.getByText("Kunde 55").first()).toBeVisible()
  await expect(page.getByText("Kunde 01")).toHaveCount(0)
})
