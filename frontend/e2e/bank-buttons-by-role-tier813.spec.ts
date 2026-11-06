import { test, expect, type Page, type APIRequestContext } from "@playwright/test"

/**
 * Tier 813 — the bank page offers what the role may do. Booking a tax
 * payment is `ustva.submit` (admin), booking a debit or matching a credit is
 * `invoice.create` / `accounting.update` (accountant). An accountant was
 * offered the tax button and a viewer every booking button; the click ended
 * in „Ihre Rolle reicht nicht aus". The role comes from GET /auth/me and is
 * answered by the test, as in gobd-viewer-tier789 (a real viewer needs an
 * invitation whose token only travels by e-mail); the backend refuses either way.
 */

const API = process.env.E2E_API_URL || "http://localhost:3001"

async function setup(page: Page, request: APIRequestContext) {
  const tag = `t813-${Date.now()}-${Math.floor(Math.random() * 1000)}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier813-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const mt940 = [
    ":1:F01BANKBICAXXX0000000000", ":20:ST813UI", ":25:DE89370400440532013000", ":28C:1/1",
    ":60F:C260601EUR1000,00",
    ":61:2606020602D300,00NTRFNONREF", ":86:177?00SEPA-UEBERWEISUNG?20Sondervorauszahlung 2027?32Finanzamt Koeln-Altstadt",
    ":61:2606030603D50,00NTRFNONREF", ":86:177?00SEPA-UEBERWEISUNG?20Sonstiges?32Irgendwer",
    ":62F:C260603EUR650,00", "-",
  ].join("\n")
  const up = await request.post(`${API}/api/v1/bank-statements/import?companyId=${companyId}`, {
    headers: { "x-user-id": userId, "x-company-id": companyId },
    multipart: { file: { name: `${tag}.mt940`, mimeType: "text/plain", buffer: Buffer.from(mt940) }, companyId, userId },
  })
  expect(up.status(), "statement imported").toBe(201)
  const txns = (await up.json()).transactions
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
  return {
    tag,
    tax: txns.find((t: any) => Number(t.amount) === -300),
    other: txns.find((t: any) => Number(t.amount) === -50),
  }
}
const asRole = (page: Page, role: string) =>
  page.route(/\/api\/v1\/auth\/me(\?|$)/, async (route) => {
    const res = await route.fetch()
    await route.fulfill({ response: res, json: { ...(await res.json()), role } })
  })
async function openStatement(page: Page, tag: string, ready: string) {
  await page.goto("/dashboard/bank-import")
  const statement = page.getByText(`${tag}.mt940`)
  await expect(statement).toBeVisible({ timeout: 90_000 })
  await page.waitForFunction(() => document.readyState === "complete")
  await expect(async () => {
    await statement.click()
    await expect(page.getByTestId(ready)).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 30_000 })
}

test("an accountant books the debit, the tax payment is left to an administrator", async ({ page, request }) => {
  const { tag, tax, other } = await setup(page, request)
  await asRole(page, "accountant")
  await openStatement(page, tag, `tax-payment-admin-${tax.id}`)
  await expect(page.getByTestId(`tax-payment-admin-${tax.id}`)).toContainText("Sondervorauszahlung 2027")
  await expect(page.getByTestId(`book-tax-${tax.id}`)).toHaveCount(0)
  await expect(page.getByTestId(`book-expense-${other.id}`)).toBeVisible()
  await page.unrouteAll({ behavior: "wait" })
})

test("a viewer is offered no booking", async ({ page, request }) => {
  const { tag, tax, other } = await setup(page, request)
  await asRole(page, "viewer")
  await openStatement(page, tag, `tax-payment-admin-${tax.id}`)
  await expect(page.getByTestId(`book-expense-${other.id}`)).toHaveCount(0)
  await expect(page.getByTestId(`book-expense-${tax.id}`)).toHaveCount(0)
  await expect(page.getByTestId(`book-tax-${tax.id}`)).toHaveCount(0)
  await page.unrouteAll({ behavior: "wait" })
})

test("an administrator is offered both", async ({ page, request }) => {
  const { tag, tax, other } = await setup(page, request)
  await openStatement(page, tag, `book-tax-${tax.id}`)
  await expect(page.getByTestId(`book-expense-${other.id}`)).toBeVisible()
  await expect(page.getByTestId(`tax-payment-admin-${tax.id}`)).toHaveCount(0)
})
