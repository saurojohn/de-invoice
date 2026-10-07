/**
 * Tier 574 — a scanned receipt: nothing is created before it is confirmed,
 * and the scan is kept.
 *
 * Measured before: picking a scan created the supplier at once (cancelling
 * the preview left it behind, and a name corrected in the preview had no
 * effect on it), and the picture itself was read and thrown away — the
 * expense had no Beleg.
 */
import { test, expect } from "@playwright/test"
import { createHash } from "crypto"

const API = process.env.E2E_API_URL || "http://localhost:3001"
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=", "base64")

test("a scan creates its supplier only on confirmation and stays with the expense", async ({ page, request }) => {
  const tag = `t574-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier574-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const H = { "x-user-id": userId, "x-company-id": companyId }
  const suppliers = async () => (await (await request.get(`${API}/api/v1/suppliers?companyId=${companyId}`, { headers: H })).json()) as { name: string }[]

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
  await page.goto("/dashboard/expenses")
  await expect(page.getByTestId("expense-ocr-upload-button")).toBeVisible({ timeout: 60_000 })
  await page.waitForLoadState("networkidle")
  const pick = () => page.getByTestId("expense-ocr-file-input").setInputFiles({ name: "beleg.png", mimeType: "image/png", buffer: PNG })

  // looked at and cancelled: nothing was created
  await pick()
  await expect(page.getByTestId("ocr-preview")).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId("ocr-field-supplier")).toHaveValue("Musterfirma GmbH")
  expect(await suppliers(), "no supplier before the confirmation").toHaveLength(0)
  await page.getByTestId("ocr-preview").getByRole("button", { name: /Abbrechen|Cancel|取消/ }).click()
  await expect(page.getByTestId("ocr-modal")).toBeHidden()
  expect(await suppliers(), "no supplier after cancelling").toHaveLength(0)

  // confirmed, with the supplier's name corrected
  await pick()
  await expect(page.getByTestId("ocr-preview")).toBeVisible({ timeout: 30_000 })
  await page.getByTestId("ocr-field-supplier").fill("Musterfirma Korrigiert GmbH")
  await page.getByTestId("ocr-confirm-button").click()
  await expect(page.getByTestId("ocr-modal")).toBeHidden({ timeout: 30_000 })
  await expect(page.getByTestId("expense-row").filter({ hasText: "RG-2026-0042" })).toHaveCount(1, { timeout: 30_000 })

  const made = await suppliers()
  expect(made.map((s) => s.name), "one supplier, under the corrected name").toEqual(["Musterfirma Korrigiert GmbH"])
  const expenses = (await (await request.get(`${API}/api/v1/expenses?companyId=${companyId}`, { headers: H })).json()).data
  expect(expenses).toHaveLength(1)
  const files = await (await request.get(`${API}/api/v1/attachments?companyId=${companyId}&entityType=expense&entityId=${expenses[0].id}`, { headers: H })).json()
  expect(files, "the scan is the expense's Beleg").toHaveLength(1)
  expect(files[0].mimeType).toBe("image/png")
  expect(files[0].contentHash).toBe(createHash("sha256").update(PNG).digest("hex"))
})
