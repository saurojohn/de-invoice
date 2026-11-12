/**
 * Tier 838 — the Tagesabschluss books the counted difference.
 *
 * Measured before: a count below the book was only noted on the close; the
 * Kassenbuch kept the book's figure, so the next exact count showed the same
 * difference again, and no report saw the Fehlbetrag. Now the dialog says the
 * difference will be booked, the close books it as a line of its own, and that
 * line has no Storno button (it goes with the close; backend spec 532).
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"
test("a Fehlbetrag counted at the close is booked in the Kassenbuch", async ({ page, request }) => {
  const tag = `t838-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier838-e2e", companyName: `${tag} Laden` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date())
  for (const data of [
    { businessDate: today, type: "eroeffnung", description: "Anfangsbestand", amount: 500 },
    { businessDate: today, type: "einnahme", description: "Tageslosung", amount: 119, vatRate: 0.19 },
  ]) {
    expect((await request.post(`${API}/api/v1/cashbook/entries?${q}`, { headers: H, data })).status()).toBe(201)
  }

  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(
    ({ userId, companyId }: { userId: string; companyId: string }) => {
      localStorage.setItem("userId", userId)
      localStorage.setItem("companyId", companyId)
    },
    { userId, companyId },
  )
  await page.goto("/dashboard/cashbook")
  const open = page.getByTestId("cashbook-zbericht-open")
  await expect(open).toBeVisible({ timeout: 90_000 })
  await page.waitForFunction(() => document.readyState === "complete")
  await page.waitForTimeout(500)
  await expect(async () => {
    await open.click()
    await expect(page.getByTestId("zbericht-count")).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 30_000 })

  // 619 € in the book, 617 € in the till
  await page.getByTestId("zbericht-count").fill("617")
  await expect(page.getByTestId("zbericht-differenz-booked")).toContainText("Fehlbetrag wird mit dem Abschluss im Kassenbuch gebucht")
  await page.getByTestId("zbericht-note").fill("Wechselgeld falsch herausgegeben")
  const closed = page.waitForResponse(
    (r) => r.url().includes("/api/v1/cashbook/close-day") && r.request().method() === "POST",
    { timeout: 60_000 },
  )
  await page.getByTestId("zbericht-save").click()
  expect((await closed).status()).toBe(201)

  const row = page.locator('[data-testid="cashbook-row"][data-kind="kassendifferenz"]')
  await expect(row).toBeVisible({ timeout: 30_000 })
  await expect(row).toContainText("Kassenfehlbetrag lt. Kassensturz")
  await expect(row).toContainText("2,00")
  await expect(row.getByTestId("cashbook-storno")).toHaveCount(0)
  // an ordinary line keeps its Storno button
  await expect(page.locator('[data-testid="cashbook-row"]', { hasText: "Tageslosung" }).getByTestId("cashbook-storno")).toHaveCount(1)

  const bal = await (await request.get(`${API}/api/v1/cashbook/balance?${q}`, { headers: H })).json()
  expect(bal.balance).toBe(617)
})
