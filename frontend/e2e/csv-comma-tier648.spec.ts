/**
 * Tier 648 — a CSV the browser writes has a comma in its numbers, and a name
 * with a semicolon stays in its cell.
 *
 * The product list wrote "19.99" (the API's string), and the export button
 * quoted a cell for a comma, not for the semicolon that separates the cells:
 * a product called "Tasche; groß" pushed every cell after it one to the right.
 */
import { test, expect } from "@playwright/test"
import { readFileSync } from "node:fs"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("the product list as a CSV: a comma in the price, a semicolon inside quotes", async ({ page, request }) => {
  test.setTimeout(180_000)
  const tag = `t648-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier648-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  expect((await request.post(`${API}/api/v1/products?companyId=${companyId}`, {
    headers: H, data: { sku: "T-1", name: "Tasche; groß", unit: "Stk", basePrice: 19.99, vatRate: 19 },
  })).status()).toBe(201)
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
  await page.goto("/dashboard/products")
  await expect(page.getByTestId("product-row").first()).toBeVisible({ timeout: 60_000 })
  const [file] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: /CSV/ }).first().click(),
  ])
  const raw = readFileSync((await file.path())!, "utf8")
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  const [header, row] = text.split("\n")
  expect(header).toBe("Artikelnummer;Name;Typ;Kategorie;Einheit;Grundpreis;MwSt-Satz;Beschreibung")
  // eight cells, the name one of them
  expect(row.startsWith('T-1;"Tasche; groß";')).toBe(true)
  expect(row).toContain(";19,99;")
  expect(row).not.toMatch(/\d\.\d/)
})
