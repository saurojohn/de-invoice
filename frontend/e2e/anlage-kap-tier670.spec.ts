/**
 * Tier 670 — Anlage KAP: the allowance of the year, the spouses' joint one,
 * and what the form says of itself.
 *
 * Before: 1 000 € for every year with nothing to choose "together" with; a
 * customer's payment whose purpose named „Verzugszinsen“ was interest
 * income; the page was "für Privatinvestoren" and did not say that a
 * business account's interest is business income (§ 20 Abs. 8 EStG).
 */
import { test, expect, type Page, type APIRequestContext } from "@playwright/test"

const API = process.env.E2E_API_URL || "http://localhost:3001"
// the form opens on last year
const Y = new Date().getFullYear() - 1
const yy = String(Y).slice(2)

async function company(page: Page, request: APIRequestContext) {
  const tag = `t670-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier670-e2e", companyName: `${tag} Einzelunternehmen` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  await page.context().clearCookies()
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
  return { tag, userId, companyId, H: { "x-user-id": userId, "x-company-id": companyId } }
}

test("1 500 € of interest: 500 € taxable alone, nothing together — and the customer's payment is no interest", async ({ page, request }) => {
  test.setTimeout(240_000)
  const { tag, userId, companyId, H } = await company(page, request)
  const mt940 = [
    ":1:F01BANKBICAXXX0000000000", ":20:ST670UI", ":25:DE89370400440532013000", ":28C:1/1",
    `:60F:C${yy}0101EUR1000,00`,
    `:61:${yy}07010701C1190,00NTRFNONREF`, ":86:166?00GUTSCHRIFT?20Rechnung 12 inkl. Verzugszinsen?32Kunde GmbH",
    `:61:${yy}12301230C1500,00NTRFNONREF`, `:86:805?00ABSCHLUSS?20Habenzinsen ${Y}?32Musterbank`,
    `:62F:C${yy}1230EUR3690,00`, "-",
  ].join("\n")
  const up = await request.post(`${API}/api/v1/bank-statements/import?companyId=${companyId}`, {
    headers: H,
    multipart: {
      file: { name: `${tag}.mt940`, mimeType: "text/plain", buffer: Buffer.from(mt940) },
      companyId, userId,
    },
  })
  expect(up.status(), "statement imported").toBe(201)
  const purposes = ((await up.json()).transactions as Array<{ purpose: string | null }>).map((t) => t.purpose || "").join(" | ")
  expect(purposes, "fixture: both purposes arrived").toContain("Habenzinsen")
  expect(purposes).toContain("Verzugszinsen")

  await page.goto("/dashboard/accounting")
  const table = page.getByTestId("anlage-kap-einnahmen-table")
  await expect(table).toBeVisible({ timeout: 120_000 })
  const section = page.locator('[data-form-section="anlageKAP"]')
  // what the form is for
  await expect(section).toContainText("Erträge eines betrieblichen Kontos sind Betriebseinnahmen (§ 20 Abs. 8 EStG)")
  await expect(section).not.toContainText("Privatinvestoren")
  // the interest, not the customer's payment (was 2 690 €)
  await expect(table.locator("tr", { hasText: "7100" })).toContainText("1.500,00")
  await expect(section).toContainText("1.000 EUR, bei Zusammenveranlagung 2.000 EUR")
  const taxable = page.getByTestId("anlage-kap-zu-versteuern")
  await expect(taxable).toContainText("500,00")
  const info = page.getByTestId("anlage-kap-abgeltung-info")
  await expect(info).toContainText("wenn die Bank nichts einbehalten hat")
  await expect(info).toContainText("125,00")
  await expect(page.getByTestId("anlage-kap-disclaimer")).toContainText("Steuerbescheinigung der Bank")

  // together: the joint allowance covers it
  const together = page.getByTestId("anlage-kap-zusammen")
  await expect(together).not.toBeChecked()
  const saved = page.waitForResponse((r) => r.url().includes("/accounting/anlage-kap/settings") && r.request().method() === "PUT" && r.ok())
  await together.check()
  await saved
  await expect(taxable).toContainText("0,00")
  await expect(page.getByTestId("anlage-kap-abzuege-table").locator("tr", { hasText: "7300" })).toContainText("1.500,00")
  await page.reload()
  await expect(page.getByTestId("anlage-kap-einnahmen-table")).toBeVisible({ timeout: 120_000 })
  await expect(page.getByTestId("anlage-kap-zusammen")).toBeChecked()
})
