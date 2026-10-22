/**
 * Tier 728d — the template editor previews what is typed, before „Speichern“:
 * the settings go to POST /invoice-templates/preview and the PDF opens.
 * (What the PDF contains: backend spec 441.)
 */
import { test, expect } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("invoice templates: the editor previews an unsaved template", async ({ page, request }) => {
  const tag = `t728d-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier728d-e2e", companyName: `${tag} Werkstatt` },
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
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-22T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
  // the PDF opens in a new tab — recorded here (headless Chromium shows a blob PDF tab as „:“)
  await page.addInitScript(() => {
    const w = window as unknown as { open: (u?: string | URL) => null; __opened?: string }
    w.open = (u) => { w.__opened = String(u); return null }
  })
  await page.goto("/dashboard/invoice-templates")
  await page.getByRole("button", { name: "Neue Vorlage" }).click({ timeout: 60_000 })
  await page.getByPlaceholder("z. B. SH Leder Standard, B2B Reverse Charge").fill("Probe")
  await page.getByPlaceholder("Vielen Dank für Ihren Auftrag.").fill(`Danke ${tag}`)

  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/v1/invoice-templates/preview") && r.request().method() === "POST"),
    page.getByTestId("template-preview-draft").click(),
  ])
  expect(response.status()).toBe(200)
  expect(response.headers()["content-type"]).toContain("application/pdf")
  const sent = response.request().postDataJSON()
  expect(sent.name).toBe("Probe")
  expect(sent.configJson.footerText).toBe(`Danke ${tag}`)
  await expect.poll(() => page.evaluate(() => (window as unknown as { __opened?: string }).__opened || "")).toMatch(/^blob:/)
  // nothing was saved
  const list = await (await request.get(`${API}/api/v1/invoice-templates?companyId=${companyId}`, {
    headers: { "x-user-id": userId, "x-company-id": companyId },
  })).json()
  expect(Array.isArray(list) ? list.length : list.data?.length ?? 0).toBe(0)
})
