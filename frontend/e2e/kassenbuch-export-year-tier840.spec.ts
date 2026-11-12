/**
 * Tier 840 — the Kassenbuch export of a chosen year, beginning with the Übertrag.
 *
 * Measured before: the export button always took the current calendar year, so
 * in January last year's Kassenbuch (for the Jahresabschluss) could not be
 * exported from the page; and a year after the book's first entry began with
 * its first entry, the cash carried in only inside that row's Bestand. Now a
 * year is chosen next to the button, and the export's first row is the
 * Übertrag (backend spec 534).
 */
import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

const API = process.env.E2E_API_URL || "http://localhost:3001"
test("last year's Kassenbuch can be exported, and this year's begins with the Übertrag", async ({ page, request }) => {
  const tag = `t840-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier840-e2e", companyName: `${tag} Laden` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const q = `companyId=${companyId}`
  const thisYear = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric" }).format(new Date()))
  const lastYear = thisYear - 1
  for (const data of [
    { businessDate: `${lastYear}-12-01`, type: "eroeffnung", description: "Anfangsbestand", amount: 500 },
    { businessDate: `${lastYear}-12-15`, type: "einnahme", description: "Tageslosung Dezember", amount: 119, vatRate: 0.19 },
    { businessDate: `${thisYear}-01-01`, type: "einnahme", description: "Tageslosung Januar", amount: 238, vatRate: 0.19 },
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
  const year = page.getByTestId("cashbook-export-year")
  await expect(year).toBeVisible({ timeout: 90_000 })
  await page.waitForFunction(() => document.readyState === "complete")
  await page.waitForTimeout(500)

  const rowsOf = async () => {
    const [file] = await Promise.all([page.waitForEvent("download", { timeout: 30_000 }), page.getByTestId("cashbook-export").click()])
    expect(file.suggestedFilename()).toMatch(/^Kassenbuch_\d{4}-01-01_\d{4}-12-31\.csv$/)
    const raw = readFileSync((await file.path())!, "utf8")
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
    return { name: file.suggestedFilename(), rows: text.split("\r\n").slice(1).map((r) => r.split(";")) }
  }

  await expect(year).toHaveValue(String(thisYear))
  await year.selectOption(String(lastYear))
  const last = await rowsOf()
  expect(last.name).toBe(`Kassenbuch_${lastYear}-01-01_${lastYear}-12-31.csv`)
  expect(last.rows.map((r) => [r[1], r[2], r[9]])).toEqual([
    ["Eröffnung", "Anfangsbestand", "500,00"],
    ["Einnahme", "Tageslosung Dezember", "619,00"],
  ])

  await year.selectOption(String(thisYear))
  const cur = await rowsOf()
  expect(cur.rows.map((r) => [r[0], r[1], r[2], r[9]])).toEqual([
    [`${thisYear}-01-01`, "Übertrag", `Kassenbestand vor dem 01.01.${thisYear}`, "619,00"],
    [`${thisYear}-01-01`, "Einnahme", "Tageslosung Januar", "857,00"],
  ])
})
