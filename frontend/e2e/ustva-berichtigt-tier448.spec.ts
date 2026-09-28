/**
 * Tier 448 — submitting a UStVA period twice from the page.
 *
 * Measured before: the second "An Finanzamt übermitteln" silently overwrote
 * the submitted filing (a draft save did too). Now the backend answers 409 and
 * the page asks whether to submit a corrected return (berichtigte
 * Voranmeldung); only then is it sent, with `berichtigt: true`.
 */
import { test, expect } from "@playwright/test"

const API = "http://localhost:3001"

test("a second submission becomes a corrected return, after asking", async ({ page, request }) => {
  const tag = `t448-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier448-e2e", companyName: `${tag} GmbH` },
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
    },
    { userId, companyId },
  )
  await page.goto("/dashboard/accounting/ustva")
  const submit = page.getByTestId("ustva-submit")
  await expect(submit).toBeVisible({ timeout: 90_000 })
  await page.waitForFunction(() => document.readyState === "complete")
  await page.waitForTimeout(500)

  const filingPost = () =>
    page.waitForResponse(
      (r) => r.url().includes("/api/v1/ustva/filings") && r.request().method() === "POST",
      { timeout: 60_000 },
    )

  const first = filingPost()
  await submit.click()
  expect((await first).status(), "first submission").toBe(201)

  const dialogs: string[] = []
  page.on("dialog", async (d) => {
    dialogs.push(d.message())
    await d.accept()
  })
  const refused = filingPost()
  await submit.click()
  expect((await refused).status(), "second submission is refused first").toBe(409)
  const corrected = filingPost()
  const res = await corrected
  expect(res.status(), "…and sent again as a corrected return once confirmed").toBe(201)
  expect(JSON.parse(res.request().postData() || "{}").berichtigt).toBe(true)
  expect((await res.json()).notes).toContain("Berichtigte Voranmeldung")
  expect(dialogs.join("\n")).toMatch(/berichtigte Voranmeldung/)
})
