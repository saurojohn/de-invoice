import { test, expect } from "@playwright/test"

/**
 * Tier 818 — the first-day drill: the company details are typed in at the
 * top of the settings page; its only button that saves them is at the very
 * end, below a dozen cards, several with a „Speichern" of their own that
 * saves only that card. The nearest one (the dunning card's) said
 * „gespeichert" and the details were lost. While they are unsaved, a bar at
 * the bottom of the window says so and saves them.
 */

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("unsaved company details are announced and saved from the bar", async ({ page, request }) => {
  const tag = `t818-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier818-e2e", companyName: `${tag} GmbH` },
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
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, savedAt: new Date().toISOString() }))
    },
    { userId, companyId },
  )
  await page.goto("/dashboard/settings")
  const taxNumber = page.getByLabel("Steuernummer", { exact: true })
  await expect(taxNumber).toBeVisible({ timeout: 90_000 })
  const bar = page.getByTestId("settings-unsaved")
  await expect(bar, "nothing changed yet").toHaveCount(0)

  await taxNumber.fill("93815/08152")
  await expect(bar).toBeVisible()
  await expect(bar).toBeInViewport()

  // the dunning card's own button saves the dunning card — the details stay unsaved
  await page.getByRole("button", { name: "Speichern", exact: true }).first().click()
  await expect(page.getByText("Mahnungs-Einstellungen gespeichert")).toBeVisible()
  await expect(bar).toBeVisible()

  await page.getByTestId("settings-unsaved-save").click()
  await expect(bar).toHaveCount(0)
  const stored = await (await request.get(`${API}/api/v1/companies/${companyId}`, {
    headers: { "x-user-id": userId, "x-company-id": companyId },
  })).json()
  expect(stored.taxId).toBe("93815/08152")
  await page.reload()
  await expect(taxNumber).toHaveValue("93815/08152", { timeout: 90_000 })
  await expect(bar, "after a reload nothing is unsaved").toHaveCount(0)
})

test("„70173 Stuttgart“ typed into the postcode is split into postcode and city", async ({ page, request }) => {
  const tag = `t818b-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier818-e2e", companyName: `${tag} GmbH` },
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
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, savedAt: new Date().toISOString() }))
    },
    { userId, companyId },
  )
  await page.goto("/dashboard/settings")
  const plz = page.getByTestId("settings-postal-code")
  await expect(plz).toBeVisible({ timeout: 90_000 })
  await plz.fill("70173 Stuttgart")
  await plz.blur()
  await expect(plz).toHaveValue("70173")
  await expect(page.getByLabel("Stadt")).toHaveValue("Stuttgart")
  // a city already there is not overwritten
  await plz.fill("70174 Esslingen")
  await plz.blur()
  await expect(plz).toHaveValue("70174 Esslingen")
  await expect(page.getByLabel("Stadt")).toHaveValue("Stuttgart")
})
