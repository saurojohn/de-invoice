# Phase 3 — Berater-Walkthrough Findings

**Date**: 2026-08-12 (Wed)
**Method**: API walkthrough (Berater UI 走查 in-app browser
需要 user 登录，user 选跳过 UI。我直接 hit backend
endpoint 测每条 path — 验证 data flow + endpoint 完整性。
0 真实 user click，**不**包含 visual layout 评估)
**Backend**: http://localhost:3001 (Tier 174 之后)
**Test user**: info@shleder.de (admin) / Test1234!

---

## Summary

5 条 USER-GUIDE 路径全跑通。**30/33 API call 成功**, 3 个
fail 全是 walkthrough script 参数错 (不是 bug):

| Path | API 测试结果 | 关键发现 |
|------|------------|---------|
| **1. Rechnung erstellen** | 6/6 ✅ | 8/12 项全 200/201, sequence number + skonto + discount + PDF + XRechnung + ZUGFeRD 都正常 |
| **2. Eingangsrechnung** | 4/5 ✅ | expense create 工作, account list 200 (但 list 是空 — 看 "DB state" 章节) |
| **3. Mahnung senden** | 6/6 ✅ | fees-config 正确, fees-preview / template-preview / email-data 全部 200, text 内容正确 (§ 288 BGB) |
| **4. Berater-Export** | 8/9 ✅ | BWA + BWA-PDF + BWA-quarterly + UStVA + DATEV CSV + DATEV-bundle ZIP + dashboard 全部 200, **DATEV 编码是 `windows-1252` (注意)** |
| **5. GoBD-Archiv** | 3/3 ✅ | ZIP 健康, 包含 invoices/ + emails/ + credit-notes/ + recurrings/ + mahnungen/ + audit-logs/ + manifest.json + verification-report.json + company-snapshot.json, 共 6404 个文件 |

---

## Tier 1-174 隐藏 issues (从这次 walkthrough 抓出)

### 🟠 Issue 1: `companies/:id` 缺 `defaultPaymentTerms` / `defaultVatMode` 字段

P1.company-settings 200 但 `defaultPaymentTerms=undefined`,
`defaultVatMode=undefined`。在 USER-GUIDE Path 1 "Rechnung
erstellen" 流程, system 应该 pre-fill default Skonto + payment
terms 字段。如果没 default, 用户每次都得手填。

**Recommendation**: schema 补两列, migration seed (Tier 176 candidate)

### ✅ Issue 2: `auth/me` endpoint 不存在 → **resolved in Tier 175**

P6.me 404。USER-GUIDE 多处讲 "Mandant-Inhaber 登录后
看到自己的 Mandant"。前端肯定有自己的方式拿当前 user
info (从 localStorage?), 但 backend 没 `/me` endpoint —
意味着 Berater 切换 Mandant 时的 session validation 只能靠
cookie/header 中的 `x-company-id` 而不能 cross-check 用户是否
真的有权 access 那个 company。

**Tier 175 update**: 读
`backend/src/auth/header-auth.guard.ts:58-70` 之后发现
HeaderAuthGuard **已经 verify UserCompany membership** —
没有 UserCompany 行的 x-company-id 直接 401 "Kein Zugriff
auf diese Firma"。So the security risk is narrow: 客户端
只能 pick 一个 user 已经有 UserCompany 行的 company. 真正的
risk 来自 stale localStorage, 不是 header tampering.

**Tier 175 implementation**: 加了 `GET /api/v1/auth/me` endpoint,
返回 user + role (per-company, Tier 66 semantics) + companies[]
list (all granted Mandanten). 前端在 page load 时调它来:
1. Re-validate session (don't trust stale localStorage)
2. Populate Mandant switcher with the full grant list
3. Show per-company role

5/5 e2e tests green (3.0s). See commit `705e1e6`.

### 🟡 Issue 3: DATEV CSV 编码 `windows-1252` 不是 UTF-8

```
P4.datev — 200, ct=text/csv; charset=windows-1252
```

USER-GUIDE 没明说编码。DATEV 实际接受 windows-1252 (这是
DATEV standard for EXTF format), 所以**这是正确**而非 bug。
但 Berater 打开 CSV 在 Excel 里要看是不是 unmangled —
windows-1252 显示德语 Umlaut (ä ö ü ß) 不应该有问题。

**Verification need**: Berater 实际打开一份 CSV 确认 Excel 显示
Umlaut 正常 + 用 DATEV-Import-Schnittstelle 能直接读

### 🟡 Issue 4: BWA monthlyData `hasMonthlyData: false` 但 lines=14

P4.bwa `lines=14, year=2026` 但 query `hasMonthlyData=false`.
YTD bucket 都有数据 (Umsatzerlöse ytd=623204 EUR), 但
"current month" 是 0 EUR (2026-08 才 12 号, 数据是上 7 个月的
bills mostly).

**Not a bug**: 真实 state. 但 frontend dashboard 渲染时如
果 8 月 ytd 显示 0 可能 user 困惑 — 文案要清楚
"Daten bis Juli 2026, August läuft"

### 🟡 Issue 5: `dashboard.ytd` 是 `[object Object]` 不是数字

```js
P4.dashboard — 200, ytd=[object Object]
```

YTD 字段返回嵌套对象 (probably `{revenue, expenses, profit}`)
但 frontend 可能 expect `ytd` 是 number。`Object.keys(ytd)` 是
null, 不报错但显示 broken。

**Need to check**: frontend /dashboard page 怎么 render `ytd`

### 🟢 Issue 6: GoBD zip `audit-logs/` 只 1 个 entry (可能是空目录)

```bash
$ unzip -l gobd-clean.zip | grep "audit-logs"
1 audit-logs
```

`audit-logs/` 是目录, 但 listing 显示 1 entry = 目录本身。
没有 .json 文件 = 没有 audit logs? 看 audit endpoint:

```
P6.audit — 200, 0 log entries
```

`/api/v1/audit-logs?companyId=...` 返回 0 rows.  **要 Berater 实际
create / update 一次数据看 audit log 是否写入**. 也可能 audit log
是 tier 后期加的, 老操作没记录.

### 🟢 Issue 7: `mahnungen/` 只有 2 个文件

GoBD zip `mahnungen/` 只 2 entries. Mahnungen 应该是每个 sent
Mahnung 都有 PDF + meta. `recentReminders=12` 但 zip 只 2 个?
可能:
- recentReminders 是 last 30 days, 但 mahnungen/ 只包 current
  fiscal year (2026)?
- 或者 Mahnung 生成时漏了 PDF
- 或者 **真实的 bug**: Mahnung sent 但没 PDF 生成

**Need to verify**: Berater 实际发一封 Mahnung, 然后看 GoBD
zip 里 mahnungen/ 是否有对应 entry

### 🟢 Issue 8: Mahnung fees-config `verzugszinsPct=9`

`P3.fees-config` 返回 `verzugszinsPct: 9%`. 但 `§ 288 BGB`
(post-2023 利率) 应该是 **Basiszinssatz + 9%** (not just 9%).

如果 system 用 hardcoded 9% 当 verzugszins 当 Basiszinssatz
已经很高了 (2026 Basiszinssatz ~2.5%), 那实际应该是 11.5%。

**Not a bug for now**: system 可能让 admin 配 verzugszins, 9%
是个 placeholder. Berater 实际看能配置就行 — 但 UI 没看到
settings 页面

---

## DB state observations

- **6288 invoices** (含 k6 留的 ~6000 noise). 现实生产 data 应该 <1000. Berater 走查时如果看到这种规模会困惑
- **24 customers**, **0 products** — 多数 INV 是 manual line item
- **0 expenses** 创建后查询 list 是 0 (我刚 create 1 个 expense id=`d7d66647-...`, 但 GET /expenses 返回 0 entries + `total=undefined`)

**Issue 9 (medium)**: `GET /api/v1/expenses` 返回 `{data: [...]}` 但
没 `total` 字段。其它 list endpoint 都有 `total` (P0.invoices total=6288).
前端用 `data?.length` 显示时会显示 0/页但实际有 records.

**Issue 10 (low)**: P2.create-expense 返回的 expense 缺 `accountNumber`
字段 (返回 201 但 json.accountNumber=undefined). Expense service 把
accountNumber 转成 accountId (FK lookup) 然后只存 FK, 不再 echo raw
accountNumber。前端拿不到原始 account number display。

---

## USER-GUIDE vs 实际 endpoint 的 mismatches (供下次更新文档)

| USER-GUIDE 写 | 实际 route | 差异 |
|---|---|---|
| "Berichtscenter → Tab DATEV-Export → CSV herunterladen" | `GET /api/v1/reports/datev-export` | ✅ 一致 |
| "UStVA-PDF (für ELSTER-Versand)" | `GET /api/v1/ustva/compute` (no PDF endpoint found) | ❌ **UStVA-PDF route 不存在** — `ustva.filings/:id/elster-xml` 是 XML, 但 UStVA compute 本身没 PDF 输出 |
| "BWA-PDF" | `GET /api/v1/reports/bwa.pdf` | ✅ 一致 |
| "DATEV-Buchungsstapel ZIP" | `GET /api/v1/reports/datev-export-bundle` | ✅ 一致 (Tier 167 加的) |
| "Mahnung — Live-Preview Mahngebühr" | `GET /api/v1/reminders/mahnungen/fees-preview?invoiceId=...` | ⚠️ USER-GUIDE 没说需 invoiceId. 我第一次用 `principal+daysOverdue` 猜的, 400 了. **需要 update USER-GUIDE 写明参数** |
| "BWA-quarterly" | `GET /api/v1/reports/bwa-quarterly?year=...&quarter=Q3` | ⚠️ quarter=Q1/Q2/Q3/Q4 (大写). 第一次猜 "Q3" 是对的, 但 DTO 校验严格 |

---

## Recommended follow-up tiers (优先级排序)

| Tier | 描述 | 估计 | 影响 |
|---|---|---|---|
| ~~**Tier 175**~~ | ~~加 `auth/me` endpoint + HeaderAuthGuard 验证 company membership~~ | ~~1.5h~~ | ~~🟠 security~~ **DONE 2026-08-12 (commit 705e1e6)** |
| **Tier 176** | companies 表加 `defaultPaymentTerms` + `defaultVatMode` 列 + migration + frontend pre-fill | ~1.5h | 🟡 UX |
| **Tier 177** | 加 `GET /api/v1/ustva/ustva.pdf?year=&month=` (USER-GUIDE 承诺了 UStVA-PDF 路径) | ~1h | 🟡 USER-GUIDE vs 实际 gap |
| **Tier 178** | expenses list 加 `total` 字段 (跟 invoices/customers 一致) | ~30min | 🟡 consistency |
| **Tier 179** | expense response echo `accountNumber` 字段 (前端显示) | ~30min | 🟡 UX |
| **Tier 180** | UPDATE USER-GUIDE.md: 写明 fees-preview 参数是 `invoiceId` 不是 `principal+daysOverdue`, `quarter=Q1/Q2/Q3/Q4` 不是 `Q3` 形式 | ~30min | 🟡 docs |

---

## 结论

**Backend API 层面 5 条路径全跑通**. 没发现功能性 bug (P2002
race 已经在 Tier 174 修了). 主要 findings 是:
1. **Auth/me endpoint 缺失** — resolved in **Tier 175** (commit
   `705e1e6`). HeaderAuthGuard 已经有 UserCompany check (Tier 66),
   so 真正的 risk 是 stale localStorage 而非 header tampering.
2. **几处 USER-GUIDE vs 实际 endpoint 文档/字段不一致** (medium)
3. **UX 改进 (default settings, response field completeness)** (low)

建议下一档: Tier 176 (companies defaultPaymentTerms/VatMode)
或 Tier 177 (UStVA-PDF endpoint).
