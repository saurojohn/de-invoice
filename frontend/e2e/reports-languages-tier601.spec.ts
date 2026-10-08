/**
 * Tier 601 — the reports page speaks the chosen language.
 *
 * /dashboard/reports was German in every language: 116 texts without a
 * translation key (seen in the page walk, Tier 589).
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("the reports page in German, Chinese and English", async ({ page, request }) => {
  const tag = `t601-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier601-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  await page.context().addCookies([
    { name: "x-user-id", value: userId, domain: "localhost", path: "/" },
    { name: "x-company-id", value: companyId, domain: "localhost", path: "/" },
  ])
  const open = async (locale: string) => {
    await page.addInitScript(
      ({ userId, companyId, locale }: { userId: string; companyId: string; locale: string }) => {
        localStorage.setItem("userId", userId)
        localStorage.setItem("companyId", companyId)
        localStorage.setItem("locale", locale)
        localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-08T00:00:00.000Z" }))
      },
      { userId, companyId, locale },
    )
    await page.goto("/dashboard/reports")
    await page.waitForLoadState("networkidle")
    return (await page.locator("body").innerText()).replace(/\s+/g, " ")
  }
  const de = await open("de")
  for (const s of ["Berichtscenter", "Umsatzbericht", "Kundenbericht", "Gesamtumsatz", "Umsatz nach Monat", "Von Datum"]) expect(de, `German: ${s}`).toContain(s)
  const zh = await open("zh")
  for (const s of ["报表中心", "营业额报表", "客户报表", "营业额合计", "按月营业额", "起始日期"]) expect(zh, `Chinese: ${s}`).toContain(s)
  for (const s of ["Berichtscenter", "Umsatzbericht", "Kundenbericht", "Gesamtumsatz", "Von Datum", "Zurück"]) expect(zh, `Chinese page still says ${s}`).not.toContain(s)
  const en = await open("en")
  for (const s of ["Reports", "Revenue by month", "Total revenue", "Customers"]) expect(en, `English: ${s}`).toContain(s)
  for (const s of ["Berichtscenter", "Umsatzbericht", "Gesamtumsatz", "Zurück"]) expect(en, `English page still says ${s}`).not.toContain(s)
  for (const text of [de, zh, en]) expect(text).not.toMatch(/reports\.[a-zA-Z0-9]+/)
})
