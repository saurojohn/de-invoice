/**
 * Tier 453 — the settings page's stored-file "Download" button.
 *
 * Measured before: the button navigated to the backend URL without the auth
 * headers — the backend answered 401 and the browser saved an error page
 * (left open since Tier 385). Now it fetches the file with the headers and
 * saves it.
 */
import { test, expect } from "@playwright/test"
import { readFileSync } from "fs"

const API = "http://localhost:3001"

test("a stored file is downloaded with its content", async ({ page, request }) => {
  const tag = `t453-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier453-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const content = `%PDF-1.4\n% ${tag}\n%%EOF\n`
  const up = await (await request.post(`${API}/api/v1/storage/upload?companyId=${companyId}`, {
    headers: H,
    multipart: { file: { name: `${tag}.pdf`, mimeType: "application/pdf", buffer: Buffer.from(content) } },
  })).json()
  const filename: string = up.file.filename

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
  await page.goto("/dashboard/settings")
  const button = page.getByTestId(`storage-download-${filename}`)
  await expect(button).toBeVisible({ timeout: 90_000 })
  await page.waitForFunction(() => document.readyState === "complete")
  await page.waitForTimeout(500)

  const fetched = page.waitForResponse((r) => r.url().includes("/api/v1/storage/files/"), { timeout: 60_000 })
  const download = page.waitForEvent("download", { timeout: 60_000 })
  await button.click()
  expect((await fetched).status(), "fetched with the auth headers (was 401)").toBe(200)
  const file = await download
  expect(file.suggestedFilename()).toBe(`${tag}.pdf`)
  const saved = await file.path()
  expect(readFileSync(saved!, "utf-8")).toBe(content)
})
