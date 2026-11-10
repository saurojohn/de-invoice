import { test, expect } from "@playwright/test"

/**
 * Tier 826 — what the first-day drill left on the pages.
 *
 *  - The invoice list said „1 Dokumente · Summe …": t() fills `key_one` now
 *    when the count is 1.
 *  - Its bulk dunning showed „Mahnung senden ({count})" and „{count} Rechnungen
 *    ausgewählt" — the messages were used without their count.
 *  - The bank page's „Zuordnungen" table listed a suggestion as
 *    „Vorgeschlagen" with nothing to do about it; its row confirms or rejects
 *    it now, as the candidate card does. Its amounts read „€ 1.190,00".
 */

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("one invoice is „1 Dokument“, the bulk dunning counts, a suggested bank match is confirmed in its row", async ({ page, request }) => {
  test.setTimeout(240_000)
  const tag = `t826-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier826-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  expect((await request.put(`${API}/api/v1/companies/${companyId}?${q}`, {
    headers: H, data: { vatId: "DE123456789", address: { street: "Altstraße 1", city: "Berlin", postalCode: "10115", country: "DE" } },
  })).status()).toBe(200)
  const customer = await (await request.post(`${API}/api/v1/customers?${q}`, {
    headers: H, data: { name: `${tag} Kunde AG`, type: "business", address: { street: "Ring 2", postalCode: "80331", city: "München", country: "DE" } },
  })).json()
  const inv = await (await request.post(`${API}/api/v1/invoices?${q}`, {
    headers: H, data: { customerId: customer.id, issueDate: "2026-06-01", items: [{ description: "Taschen", quantity: 1, unit: "Stk", unitPrice: 1000, vatRate: 0.19 }] },
  })).json()
  expect((await request.put(`${API}/api/v1/invoices/${inv.id}/status?${q}`, { headers: H, data: { status: "sent" } })).status()).toBe(200)
  const number: string = (await (await request.get(`${API}/api/v1/invoices/${inv.id}?${q}`, { headers: H })).json()).invoiceNumber

  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  await page.addInitScript(({ userId, companyId }: { userId: string; companyId: string }) => {
    localStorage.setItem("userId", userId)
    localStorage.setItem("companyId", companyId)
    localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, savedAt: new Date().toISOString() }))
  }, { userId, companyId })

  // 1. the invoice list: one invoice, the singular; the bulk dunning with its count
  await page.goto("/dashboard/invoices")
  await expect(page.getByTestId("invoice-row")).toHaveCount(1, { timeout: 90_000 })
  await expect(page.getByTestId("invoices-sums")).toContainText("1 Dokument ·")
  await expect(page.getByTestId("invoices-sums")).not.toContainText("Dokumente")
  await page.getByLabel(`Rechnung ${number} auswählen`).check()
  const bulk = page.getByTestId("bulk-mahnung-button")
  await expect(bulk).toContainText("Mahnung senden (1)")
  await bulk.click()
  await expect(page.getByTestId("bulk-mahnung-level-picker")).toContainText("1 Rechnung ausgewählt.")
  await expect(page.getByTestId("bulk-mahnung-level-picker")).not.toContainText("{count}")

  // 2. the bank: a credit of 1 190,00 naming the invoice, suggested, not confirmed
  const mt940 = [
    ":1:F01BANKBICAXXX0000000000", ":20:ST826UI", ":25:DE89370400440532013000", ":28C:1/1",
    ":60F:C260601EUR100,00",
    `:61:2606050605C1190,00NTRFNONREF//${number}`, `${tag} Kunde AG`, `Rechnung ${number}`,
    ":62F:C260605EUR1290,00", "-",
  ].join("\n")
  const up = await request.post(`${API}/api/v1/bank-statements/import?${q}`, {
    headers: H,
    multipart: { file: { name: `${tag}.mt940`, mimeType: "text/plain", buffer: Buffer.from(mt940) }, companyId, userId },
  })
  expect(up.status(), "statement imported").toBe(201)
  const statementId: string = (await up.json()).statement?.id ?? (await up.json()).id
  const sug = await request.post(`${API}/api/v1/bank-statements/${statementId}/suggest?${q}`, { headers: H, data: {} })
  expect(sug.status(), "suggestions generated").toBe(201)

  await page.goto("/dashboard/bank-import")
  const statement = page.getByText(`${tag}.mt940`)
  await expect(statement).toBeVisible({ timeout: 90_000 })
  await page.waitForFunction(() => document.readyState === "complete")
  const confirmInRow = page.getByTestId("recon-row-confirm")
  await expect(async () => {
    await statement.click()
    await expect(confirmInRow).toBeVisible({ timeout: 5_000 })
  }).toPass({ timeout: 60_000 })
  await expect(page.getByText("€ 1.190,00")).toHaveCount(0)
  page.once("dialog", (d) => d.accept())
  await confirmInRow.click()
  await expect(page.getByTestId("recon-row-actions")).toHaveCount(0, { timeout: 30_000 })
  await expect.poll(async () => (await (await request.get(`${API}/api/v1/invoices/${inv.id}?${q}`, { headers: H })).json()).status, { timeout: 30_000 }).toBe("paid")
})
