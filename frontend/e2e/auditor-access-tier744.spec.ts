/**
 * Tier 744 — a tax auditor's access, from the admin's invitation to the
 * auditor's dashboard. (The rules: backend spec 464.)
 */
import { test, expect, type Page } from "@playwright/test"
import * as fs from "fs"

const API = process.env.E2E_API_URL || "http://localhost:3001"
const LOG = "/tmp/backend.log"
const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)

async function as(page: Page, userId: string, companyId: string) {
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
      localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, savedAt: "2026-10-30T00:00:00.000Z" }))
    },
    { userId, companyId },
  )
}

test("the admin invites an auditor with a last day; the auditor is told what the access is", async ({ page, request }) => {
  test.skip(!fs.existsSync(LOG), `no backend log at ${LOG}`)
  const tag = `t744-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier744-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id

  await as(page, userId, companyId)
  await page.goto("/dashboard/settings/users")
  await page.getByRole("button", { name: /Benutzer einladen|Einladen/ }).first().click({ timeout: 90_000 })
  await page.locator('input[type="email"]').fill(`${tag}-pruefer@example.test`)
  await page.locator("select").first().selectOption("auditor")
  await expect(page.getByTestId("invite-auditor-hint")).toContainText("§ 147 Abs. 6 AO")

  const send = page.getByRole("button", { name: /Einladung senden|senden/i }).first()
  await send.click()
  await expect(page.getByText("Enddatum", { exact: false })).toBeVisible({ timeout: 30_000 })

  const inviteLinks = () => fs.readFileSync(LOG, "utf8").match(/register\?invite=[A-Za-z0-9_-]+/g) || []
  const before = inviteLinks().length
  await page.getByTestId("invite-access-until").fill(iso(30))
  await send.click()
  await expect.poll(() => inviteLinks().length, { timeout: 30_000 }).toBeGreaterThan(before)
  const token = inviteLinks().at(-1)!.split("=")[1]
  const accepted = await (await request.post(`${API}/api/v1/invitations/accept`, { data: { token, password: "Tier744-pruef1" } })).json()
  expect(accepted.role).toBe("auditor")

  await page.reload()
  const until = page.getByTestId(`user-access-until-${accepted.userId}`)
  await expect(until).toHaveValue(iso(30), { timeout: 90_000 })
  await until.fill(iso(45))
  await until.blur()
  await expect(page.getByText("Rolle aktualisiert")).toBeVisible({ timeout: 30_000 })

  await as(page, accepted.userId, companyId)
  await page.goto("/dashboard")
  const notice = page.getByTestId("auditor-access-notice")
  await expect(notice).toBeVisible({ timeout: 90_000 })
  await expect(notice).toContainText("nur lesen")
  await expect(notice).toContainText(new Date(`${iso(45)}T00:00:00Z`).toLocaleDateString("de-DE", { timeZone: "UTC" }))

  await notice.getByRole("link").click()
  await expect(page).toHaveURL(/\/dashboard\/audit/, { timeout: 60_000 })
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 60_000 })
})
