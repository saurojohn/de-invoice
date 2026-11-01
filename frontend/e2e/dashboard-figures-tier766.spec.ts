/**
 * Tier 766 — the dashboard's tiles are the company's.
 *
 * The page fetched the newest 500 invoices and added them up in the browser:
 * from the 501st invoice on, what is overdue, open and paid was that of the
 * newest 500. Overdue invoices are old, so the tile said „0“ for a company that
 * has them.
 */
import { test, expect } from "@playwright/test"
import { execSync } from "child_process"
import { PG_CONTAINER } from "./fixtures/test-env"

const API = process.env.E2E_API_URL || "http://localhost:3001"

test("overdue invoices older than the newest 500 are counted", async ({ page, request }) => {
  test.setTimeout(120_000)
  const tag = `t766-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier766-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const sql = `
    insert into "Customer"(id,"companyId",type,name,address,"updatedAt") values ('${tag}-c','${companyId}','business','Kunde ${tag}','{"country":"DE"}',now());
    insert into "Invoice"(id,"companyId","customerId","invoiceNumber",type,status,"issueDate","dueDate",subtotal,"totalVat",total,currency,"customerName","createdAt","updatedAt")
      select '${tag}-o'||n,'${companyId}','${tag}-c','OLD-${tag}-'||n,'INV','overdue','2025-01-10','2025-02-10',100,19,119,'EUR','Kunde ${tag}','2025-01-10',now() from generate_series(1,3) n;
    insert into "Invoice"(id,"companyId","customerId","invoiceNumber",type,status,"issueDate","dueDate",subtotal,"totalVat",total,currency,"customerName","updatedAt")
      select '${tag}-n'||n,'${companyId}','${tag}-c','NEW-${tag}-'||n,'INV','paid','2026-06-01','2026-06-30',100,19,119,'EUR','Kunde ${tag}',now() from generate_series(1,520) n;`
  execSync(`docker exec -i ${PG_CONTAINER} psql -q -U de_invoice -d de_invoice -v ON_ERROR_STOP=1`, { input: sql })

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
  await page.goto("/dashboard")
  const tile = page.getByTestId("dashboard-kpi-overdue")
  await expect(page.getByTestId("dashboard-kpi-overdue-count")).toHaveText("3", { timeout: 60_000 })
  await expect(tile).toContainText("357,00 € offen")
})

test("the expense list asks once, and says when it shows only the newest", async ({ page, request }) => {
  test.setTimeout(120_000)
  const tag = `t766e-${Date.now()}`
  const reg = await (await request.post(`${API}/api/v1/auth/register`, {
    data: { email: `${tag}@example.test`, password: "Tier766-e2e", companyName: `${tag} GmbH` },
  })).json()
  const userId: string = reg.user.id
  const companyId: string = reg.user.companyId || reg.company.id
  const sql = `
    insert into "Expense"(id,"companyId","invoiceNumber",description,"invoiceDate","netAmount","vatRate","vatAmount","grossAmount","updatedAt")
      select '${tag}-'||n,'${companyId}','ER-'||n,'Ausgabe '||n,date '2026-06-01'-n,100,0.19,19,119,now() from generate_series(1,505) n;
    insert into "Attachment"(id,"companyId","entityType","entityId","originalName","mimeType",size,"storagePath","contentHash")
      values ('${tag}-a1','${companyId}','expense','${tag}-1','beleg.pdf','application/pdf',10,'x/${tag}.pdf','0'),
             ('${tag}-a2','${companyId}','expense','${tag}-1','beleg2.pdf','application/pdf',10,'x/${tag}2.pdf','0');`
  execSync(`docker exec -i ${PG_CONTAINER} psql -q -U de_invoice -d de_invoice -v ON_ERROR_STOP=1`, { input: sql })
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
  const asked: string[] = []
  page.on("request", (r) => { if (r.url().includes("/api/v1/attachments")) asked.push(r.url()) })
  await page.goto("/dashboard/expenses")
  await expect(page.getByTestId(`expense-open-${tag}-1`)).toContainText("2", { timeout: 60_000 })
  await expect(page.getByTestId(`expense-open-${tag}-2`)).toContainText("0")
  await expect(page.getByTestId("expenses-capped")).toContainText("Die neuesten 500 von 505")
  expect(asked).toEqual([])
})
