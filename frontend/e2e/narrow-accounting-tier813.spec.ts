import { test, expect } from "@playwright/test"

/**
 * Tier 813 — the accounting page fits a 350 px phone: no sideways scrolling
 * of the page itself (a wide table scrolls inside its own box). HANDOFF §9
 * had it 12 px too wide: the card title „Umsatzsteuerjahreserklärung (UStJA)"
 * at 24 px is one word wider than the screen; card titles break long words
 * now. A fresh company, the page with its cards loaded.
 */

const API = process.env.E2E_API_URL || "http://localhost:3001"

for (const path of ["/dashboard/accounting", "/dashboard/bank-import"]) {
  test(`${path} is no wider than a 350 px screen`, async ({ page, request }) => {
    test.setTimeout(120_000)
    const tag = `t813w-${Date.now()}-${Math.floor(Math.random() * 1000)}`
    const reg = await (await request.post(`${API}/api/v1/auth/register`, {
      data: { email: `${tag}@example.test`, password: "Tier813-e2e", companyName: `${tag} GmbH` },
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
        localStorage.setItem("cookie-consent", JSON.stringify({ necessary: true, analytics: false, marketing: false, savedAt: "2026-10-08T00:00:00.000Z" }))
      },
      { userId, companyId },
    )
    await page.setViewportSize({ width: 350, height: 800 })
    await page.goto(path)
    await page.waitForLoadState("networkidle", { timeout: 90_000 })
    await page.waitForTimeout(1500)
    const wide = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth
      // inside a box that scrolls (or clips) sideways itself: not the page's width
      const inScrollBox = (el: HTMLElement | null) => {
        for (let p = el; p && p !== document.body; p = p.parentElement) {
          const ox = getComputedStyle(p).overflowX
          if (ox === "auto" || ox === "scroll" || ox === "hidden" || ox === "clip") return true
        }
        return false
      }
      const out: string[] = []
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.right <= vw + 0.5 || inScrollBox(el.parentElement)) continue
        out.push(`${el.tagName.toLowerCase()}${el.getAttribute("data-testid") ? `[${el.getAttribute("data-testid")}]` : ""}.${(el.className || "").toString().slice(0, 60)} → ${Math.round(r.right)}`)
      }
      // a word wider than its box spills out as text, past every element's box
      const first: string[] = []
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      const range = document.createRange()
      let n: Node | null
      while ((n = walker.nextNode())) {
        if (!n.textContent?.trim()) continue
        range.selectNodeContents(n)
        const r = range.getBoundingClientRect()
        if (r.width > 0 && r.right > vw + 0.5 && !inScrollBox(n.parentElement)) first.push(`text in ${(n.parentElement?.tagName || "").toLowerCase()}.${(n.parentElement?.className || "").toString().slice(0, 80)} right=${Math.round(r.right)} text=${n.textContent.slice(0, 60)}`)
      }
      return { scroll: document.documentElement.scrollWidth, vw, out: out.slice(0, 8), text: first.slice(0, 8) }
    })
    expect(wide.out, `elements past the right edge (${wide.vw}px)`).toEqual([])
    expect(wide.text, `text past the right edge (${wide.vw}px) — was „Umsatzsteuerjahreserklärung (UStJA)", 362 px`).toEqual([])
    expect(wide.scroll).toBeLessThanOrEqual(wide.vw)
  })
}
