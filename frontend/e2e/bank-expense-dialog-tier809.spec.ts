import { test, expect } from "@playwright/test"

/**
 * Tier 809 — „Als Aufwand buchen" asks for the account, the VAT rate and the
 * category (was a prompt() for the account alone) and records an expense the
 * reports read; a debit booked the old way (a voucher only) offers „In die
 * Ausgaben übernehmen". A fresh company, so nothing is left on the shared one.
 * The old-way voucher cannot be made through the API any more, so its
 * statement row is given here (page.route) and the rebooking POST is caught;
 * spec 510 checks the backend.
 */

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("a debit booked as an expense with its Vorsteuer; an old booking offers to be taken into the expenses", async ({ page, request }) => {
  const tag = `t809-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier809-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`

  const mt940 = [
    ":1:F01BANKBICAXXX0000000000", ":20:ST809UI", ":25:DE89370400440532013000", ":28C:1/1",
    ":60F:C260601EUR1000,00",
    ":61:2606020602D119,00NTRFNONREF", ":86:177?00SEPA-UEBERWEISUNG?20Bueromaterial Juni?32Papier Schulz",
    ":61:2606030603D50,00NTRFNONREF", ":86:177?00SEPA-UEBERWEISUNG?20Strom Mai?32Stadtwerke",
    ":62F:C260603EUR831,00", "-",
  ].join("\n")
  const up = await request.post(`${API}/api/v1/bank-statements/import?${q}`, {
    headers: H,
    multipart: { file: { name: `${tag}.mt940`, mimeType: "text/plain", buffer: Buffer.from(mt940) }, companyId, userId },
  })
  expect(up.status(), "statement imported").toBe(201)
  const upBody = await up.json()
  const statementId: string = upBody.id
  const paper = upBody.transactions.find((t: any) => Number(t.amount) === -119)
  const power = upBody.transactions.find((t: any) => Number(t.amount) === -50)

  // the second debit shown as booked the old way: a voucher on an expense account, no expense
  await page.route(`**/api/v1/bank-statements/${statementId}?*`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback()
    // the real statement, read with the test's own client (route.fetch's answer was disposed mid-read)
    const json = await (await request.get(`${API}/api/v1/bank-statements/${statementId}?${q}`, { headers: H })).json()
    for (const t of json.transactions || []) {
      if (t.id === power.id) {
        t.voucher = { id: "v-old", voucherNumber: "BK-ALT-1", date: "2026-06-03", referenceType: "BankTransaction", lines: [{ account: { type: "expense" } }] }
      }
    }
    await route.fulfill({ json })
  })
  const rebooks: any[] = []
  await page.route(`**/transactions/${power.id}/rebook-as-expense?*`, async (route) => {
    rebooks.push(route.request().postDataJSON())
    await route.fulfill({ json: { transactionId: power.id, voucherId: "v-new" } })
  })

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
  await page.goto("/dashboard/bank-import")
  const statement = page.getByText(`${tag}.mt940`)
  await expect(statement).toBeVisible({ timeout: 90_000 })
  await page.waitForFunction(() => document.readyState === "complete")
  const button = page.getByTestId(`book-expense-${paper.id}`)
  await expect(async () => {
    await statement.click()
    await expect(button).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 30_000 })

  // the old booking: marked, and offered to be taken into the expenses
  await expect(page.getByTestId(`booked-without-expense-${power.id}`)).toBeVisible()

  // 1. the dialog, not a prompt()
  await button.click()
  const dialog = page.getByTestId("book-expense-dialog")
  await expect(dialog).toBeVisible()
  await expect(page.getByTestId("book-expense-account")).toHaveValue("4900")
  await page.getByTestId("book-expense-rate").selectOption("0.19")
  await expect(page.getByTestId("book-expense-vat")).toContainText("19,00")
  await page.getByTestId("book-expense-category").fill("Bürobedarf")
  const booked = page.waitForResponse(
    (r) => r.url().includes(`/transactions/${paper.id}/book-expense`) && r.request().method() === "POST",
    { timeout: 60_000 },
  )
  await page.getByTestId("book-expense-submit").click()
  const res = await booked
  expect(res.status()).toBe(201)
  expect(JSON.parse(res.request().postData() || "{}")).toEqual({
    expenseAccountNumber: "4900", description: "Bueromaterial Juni", vatRate: 0.19, category: "Bürobedarf",
  })
  const expenseId: string = (await res.json()).createdExpenseId
  await expect(dialog).toHaveCount(0)
  await expect(button).toHaveCount(0, { timeout: 30_000 })

  const expenses = await (await request.get(`${API}/api/v1/ustva/expenses?${q}`, { headers: H })).json()
  const list = Array.isArray(expenses) ? expenses : expenses.data ?? []
  const e = list.find((x: any) => x.id === expenseId)
  expect([Number(e.netAmount), Number(e.vatAmount), e.category, e.accountNumber]).toEqual([100, 19, "Bürobedarf", "4900"])

  // 2. the old booking taken into the expenses: the rate kept unless chosen
  await page.getByTestId(`rebook-expense-${power.id}`).click()
  await expect(dialog).toBeVisible()
  await expect(page.getByTestId("book-expense-account")).toHaveCount(0)
  await expect(page.getByTestId("book-expense-rate")).toHaveValue("keep")
  await page.getByTestId("book-expense-category").fill("Strom")
  await page.getByTestId("book-expense-submit").click()
  await expect.poll(() => rebooks.length, { timeout: 30_000 }).toBe(1)
  expect(rebooks[0]).toEqual({ category: "Strom" })
  await expect(dialog).toHaveCount(0, { timeout: 30_000 })
  // the page reloads the statement after the rebooking: let that answer finish
  await page.unrouteAll({ behavior: "wait" })
})
