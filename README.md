# de-invoice — Deutsches Rechnungs- & Buchhaltungssystem
# de-invoice — German Invoice & Accounting System
# de-invoice — 德国发票与会计管理系统

> GoBD-konforme Rechnungs-, Buchhaltungs- und Bankensoftware für kleine
> und mittelständische Unternehmen im DACH-Raum. Inklusive XRechnung,
> ZUGFeRD/Factur-X, DATEV-Export, UStVA, FinTS-Banking und OCR-Vorbereitung.

**Tier 105 — UStJA (Umsatzsteuerjahreserklärung, § 18 Abs. 3 UStG) + always-on annual VAT return**:
- 131 backend e2e tests + 286 Playwright UI tests (all green)
- UStJA aggregates 12 monthly UStVAs into the BMF Vordruck 2024 Kz 20-23
  (Bemessungsgrundlagen 19%/7%) + Kz 41-44 (igL, Ausfuhren, sonstige) +
  Kz 36 (Reverse Charge § 13b) + Kz 66 (Summe USt) + Kz 67 (Summe Vorsteuer) +
  Kz 68 (Verbleibender Betrag = 66-67) + Kz 39 (Sondervorauszahlung = 1/11
  der Jan-UStVA, § 47 Abs. 1 UStDV) + Kz 69 (Restzahlung = 68-39, fällig bis
  31.07. des Folgejahres) + Kz 81 (Differenzbetrag)
- Delegates per-month computation to existing UstvaService.compute()
- Anlage S / V / KAP / G / N / R / Kind + UStJA for Berater-Packager —
  10-way conditional shift (plus KSt 1, plus UStJA always-on)
- 5th feature-flag toggle (anlageKind) — force-include in Berater package
- E-Bilanz (XBRL) v2 — 52 BMF GCD 6.7 positions
- 404/500 error pages + mobile responsive + deploy readiness
- 2384 i18n keys × 3 locales (DE/EN/ZH), 100% consistent

---

## ⚡ Quickstart (5 Minuten)

```bash
# 1. Repo klonen + Node 22 prüfen
node --version   # muss >= 22 sein

# 2. Dependencies installieren
cd backend && npm install && cd ..
cd frontend && npm install && cd ..

# 3. Datenbank starten + App hochfahren
./start.sh       # bringt Postgres + Backend (3001) + Frontend (3000) hoch

# 4. Im Browser öffnen
open http://localhost:3000
# Login: info@shleder.de / Test1234!
```

Die App ist sofort einsatzbereit mit Testdaten (SH Leder GmbH).

### E2E-Tests (131 Backend + 286 Playwright UI, ~9 Min)

```bash
# Backend hochfahren
cd backend && npm install && npx ts-node src/main.ts &

# Alle 130 Backend-Tests
cd backend && for f in e2e/[0-9]*.sh; do bash "$f"; done

# 286 Playwright UI-Tests (Frontend muss auf 3100 laufen)
cd frontend && npm install && npx playwright install chromium
cd frontend && npx playwright test
```

### Produktion (Docker)

```bash
cp .env.example .env                                       # JWT_SECRET etc. setzen
docker compose -f docker-compose.prod.yml up -d --build    # Postgres + Backend + Frontend
```

Required env vars (see DEPLOY.md §2.1):
- `POSTGRES_PASSWORD` — postgres role password
- `JWT_SECRET` — backend JWT signing secret (`openssl rand -hex 32`)
- `NEXT_PUBLIC_API_URL` — **build-time** URL the browser uses to reach the backend
  (e.g. `https://api.example.com`). Requires `docker compose build frontend`
  BEFORE `up` if changed.

Siehe [DEPLOY.md](DEPLOY.md) für die vollständige Produktionsanleitung
und [RUNBOOK.md](RUNBOOK.md) für Operator-Notfälle (Restore, Rotate,
Troubleshoot).

---

## 🏗️ Architektur

```
                  ┌───────────────────────┐
                  │   Browser (Chrome /   │
                  │   Firefox / Safari)   │
                  └──────────┬────────────┘
                             │  HTTPS (via Cloudflare/reverse proxy)
                  ┌──────────▼────────────┐
                  │   Next.js Frontend    │
                  │   (port 3000)         │     React 19 + Next 16
                  │   - SSR pages         │     standalone output
                  │   - API proxy         │     i18n (DE/EN/ZH)
                  └──────────┬────────────┘
                             │  HTTP (internal docker network)
                  ┌──────────▼────────────┐
                  │   NestJS Backend      │
                  │   (port 3001)        │     30+ modules
                  │   - REST API          │     throttler (600/60s)
                  │   - Cron jobs         │     self-hosted Sentry
                  │   - PDF gen (PDFKit)  │     bcrypt + 2FA
                  └──────────┬────────────┘
                             │  Prisma 5
                  ┌──────────▼────────────┐
                  │   PostgreSQL 16       │
                  │   (port 5432)         │     ~50 models
                  │   - GoBD audit trail  │     2FA recovery (SHA-256)
                  │   - Backups (daily)   │     EUR-cents numeric(12,4)
                  └───────────────────────┘
```

### Tech-Stack

| Layer | Technology | Notes |
| --- | --- | --- |
| Frontend | Next.js 16 (standalone), React 19, Tailwind | `output: "standalone"` für minimal image size |
| Backend | NestJS 11, TypeScript 5, ts-node | Multi-stage Dockerfile, health endpoints |
| ORM | Prisma 5 (binary engine) | `engineType: "binary"` — avoids libssl 1.1 in slim images |
| Database | PostgreSQL 16 | 50+ models, ~80 indexes |
| PDF | PDFKit (server-side) | GoBD: 1 page, no fills, thin lines |
| E-Invoice | Custom builders | XRechnung (UBL 2.1) + ZUGFeRD 2.1 (PDF/A-3 + XML) |
| Auth | bcrypt + 2FA (TOTP) | Per-route `@Require(action)` |
| Banking | FinTS 3.0 (mock + real) | HKCSE/HKCCS, 2-step TAN |
| Mail | SMTP (nodemailer) | Falls back to "no-smtp" mode in dev |
| Storage | Local FS (`~/data/invoice-system`) | S3/MinIO compatible |
| Backup | `pg_dump` + tar | Daily rotation, 7d/4w/monthly anchors |
| Monitoring | `/metrics` (Prometheus) | 3 gauges + 2 counters + 1 histogram, no deps |
| CI | GitHub Actions | typecheck × 2 + e2e (131 backend + 286 Playwright UI) on every PR |

### 131 E2E-Tests Backend + 286 Playwright UI (417 tests, ~9 Min)

| # | Feature | Tests |
| --- | --- | --- |
| 1-6 | Cashbook (Kassenbuch), Z-Bericht, Storno | 50+ assertions |
| 7-11 | DATEV (per-company, storno, config) | 30+ |
| 8, 36-37 | Bank import (MT940, FinTS read, FinTS write) | 50+ |
| 12-14 | Expenses, voucher templates | 30+ |
| 15 | Dashboard KPIs (perf-optimized, 8ms warm) | 17 |
| 16-19 | Dark mode, email, receipts, bulk import | 40+ |
| 20-21 | VIES VAT validation, self-hosted Sentry | 30+ |
| 22-23 | Reminder cron, logo upload | 25+ |
| 24 | 2FA TOTP | 15+ |
| 25-30 | DATEV Tier 5 + exchange rates + attachments | 80+ |
| 31-32 | FinTS mock + smart match | 40+ |
| 33-34 | Custom invoice templates (PDF applied) | 40+ |
| 35 | Recurring invoice wizard | 16 |
| 36 | Banking reconciliation panel | 17 |
| 37 | SEPA transfer (HKCSE/HKCCS) | 21 |
| 38 | Health endpoints | 12 |
| 39 | SSRF guard on FinTS endpointUrl | 11 |
| 40 | Buchungsjournal PDF (GoBD, X-Journal-* headers) | 14 |
| 41 | Prisma migrate fresh-DB round-trip | 21 |
| 42 | Backup fire-drill (sentinel insert→backup→restore) | 9 |
| 43 | `/metrics` Prometheus endpoint contract | 39 |
| 44-50 | (cost-center, skonto, credit notes, statement, credit-balance, PDF-signing, age analysis) | 100+ |
| 51-65 | (TOTP, OCR, customer portal, dashboard, cost-center-CRUD, cost-suggest, voucher-correct, cost-suggest-prefix, voucher-autopersist, installment-plan, skonto-window, credit-note-PDF, Mahnung-skonto, statement-v2) | 250+ |
| 66-79 | (mandant-switcher, audit-trail, global-search, datev-preview, readonly, PDF-signing-cert, 2FA, cashflow, P&L, Anlage-EUR, GoBD-archive, EU-OSS, Berater-exchange, Anlage-S) | 200+ |
| 80-90 | (Bilanz, G+V, Anlagenverzeichnis, Anhang, Berater-Packager, BWA, AfA-Buchung, E-Bilanz-VORSCHAU, AfA-monatlich, AfA-Storno) | 250+ |
| 91 | Auto-AfA month-end scheduler (cron) | 18 |
| 92 | Anlage V (Vermietung und Verpachtung, § 21 EStG) | 18 |
| 93 | BWA extensions (granular Sonstige + Steuern + Zinserträge) | 24 |
| 94 | Frontend Settings UI for feature flags (autoBookAfa + anlageV) | 13 |
| 95 | BWA im Berater-Packager | 11 |
| 97 | E-Bilanz (XBRL) v2 — 52 BMF GCD 6.7 positions, 17 sub-sections | 50+ |
| 98 | Anlage KAP (Kapitalerträge, § 20 EStG) | 60+ |
| 99a | 404/500 error pages (DE/EN/ZH) | 4 |
| 99b | Mobile responsive (iPhone 12 audit) | 7 |
| 99c | Production deploy readiness (compose lint) | 12 |
| 99d | Security headers regression (helmet + CORS) | 12 |
| 100 | Anlage G (Gewerbebetrieb, § 15 EStG) | 50+ |
| 101 | Anlage N (Arbeitnehmereinkünfte, § 3 EStG) | 40+ |
| 102 | KSt 1 (Körperschaftsteuererklärung, § 1 KStG) | 30+ |
| 103 | Anlage R (Einkünfte aus Renten und Bezügen, § 22 EStG) | 40+ |
| 104 | Anlage Kind (Kinderfreibetrag + Kindergeld, § 32/33/33a EStG) | 50+ |
| 105 | UStJA (Umsatzsteuerjahreserklärung, § 18 Abs. 3 UStG) | 50+ |
| UI | Playwright suite (73 spec files, 286 tests) | 286 |

---

## 🌐 Sprache / Language / 语言

| Deutsch (Standard) | English | 中文 |
|---|---|---|
| [↓ Deutsche Dokumentation](#deutsch) | [↓ English documentation](#english) | [↓ 中文文档](#中文) |

---

<a id="deutsch"></a>

## 🇩🇪 Deutsch

Eine Webanwendung für kleine und mittelständische Unternehmen in Deutschland
zur **GoBD-konformen** Erstellung, Versendung und Verbuchung von Rechnungen
sowie zur Erfüllung der Anforderungen an **XRechnung** und
**ZUGFeRD/Factur-X**. Entwickelt für SH Leder GmbH (und vergleichbare
B2B-Anwendungsfälle im DACH-Raum).

### Funktionen

#### Rechnungserstellung (Kern)
- Rechnungstypen: Standardrechnung (INV), Gutschrift (CN), Proforma (PI) und
  Quittung (RCV)
- Mehrzeilige Positionen mit deutschen USt-Sätzen (0 %, 7 %, 19 %)
- Rabatte, Zahlungsziele (Sofort fällig / 14 / 30 / 60 Tage), Bankverbindung
  auf dem PDF
- Fortlaufende Rechnungsnummern pro Unternehmen
- Nummernformat: `RE-2026-000001`, `GS-2026-000001` usw.
- Statusworkflow: Entwurf → versendet → bezahlt / überfällig / storniert
- GoBD-konformes 1-Seiten-PDF (keine Farbflächen, dünne schwarze Linien,
  deutsches Zahlen-/Datumsformat `€ 1.234,56` / `dd.mm.yyyy`)

#### Compliance & E-Invoicing
- **XRechnung** (XML, UBL 2.1) — Pflicht im öffentlichen B2G-Bereich
- **ZUGFeRD 2.1 / Factur-X 2.1** — hybrides PDF mit eingebettetem XML für B2B
- **UStVA** (Umsatzsteuervoranmeldung) mit allen Kennzahlen
  (Zeilen 20–23 Umsätze, 26–29 steuerfrei, 36 Reverse Charge,
  50–66 Vorsteuer, 81 Differenzbetrag)
- Ausgabenverwaltung mit Zuordnung zu UStVA-Zeilen
- Audit-Log

#### Kunden- und Produktverwaltung
- Kunden-Stammdaten mit USt-ID, freiem Ländertext, deutscher Adressformat
- CSV-Import/Export (RFC 4180 + UTF-8-BOM für Excel)
- Pro Kunde: Datum der letzten Rechnung + Anzahl Rechnungen (effizientes
  groupBy)
- Produktkatalog mit Artikelnummer (SKU), Grundpreis, USt-Satz, Einheit
- Artikel-Positionen automatisch aus Produktwahl übernehmen

#### Mehrbenutzer & Zugriffskontrolle
- 3 Rollen: `admin` (Vollzugriff), `accountant` (Rechnungen/Buchhaltung),
  `viewer` (read-only)
- Benutzer-Einladung per E-Mail (bcrypt-gehashter Token, 1 h Gültigkeit)
- Passwort-Reset (constant-time bcrypt, generische Antworten, keine
  Benutzer-Enumeration)
- Login-Throttler (Anti-Brute-Force), IP-basierte Sperre nach Fehlversuchen
- Alle sensiblen Routen geschützt durch `@Auth()` + `@Require(action)`

#### Produktivität
- Sammel-Download: bis zu 100 Rechnungen als ZIP (PDF oder ZUGFeRD,
  eindeutige Dateinamen, Manifest)
- Sammel-E-Mail-Versand
- CSV-Export nach Zeitraum (18 Spalten, Excel-kompatibel)
- ZIP-Export nach Zeitraum
- Mehrfachauswahl in der Rechnungsliste mit Sammelaktions-Toolbar
- Mahn-Workflow mit Mehrfachversand
- Zahlungsverfolgung mit Auto-Statuswechsel (bezahlt, sobald Summe
  Gesamtsumme deckt)
- **Mehrsprachige Oberfläche: Deutsch, Englisch, Chinesisch** (1 500+ Schlüssel)
- Mehrwährungsfähig (Standard: EUR)

#### Speicher
- Pro Unternehmen lokaler Speicherordner
  (`{Jahr}/{Monat}/{Typ}/{companyId}`)
- Gesundheitsprüfung (erreichbar/beschreibbar/Speicherplatz)
- Dateiliste mit Download/Löschen
- Logo-Upload (Bilddatei pro Unternehmen)

### Schnellstart (Entwicklung)

#### Voraussetzungen
- Node.js 22 LTS
- PostgreSQL 16
- npm 10+

#### 1. Datenbank
```bash
docker run -d --name de-invoice-postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=de_invoice \
  -p 5432:5432 postgres:16
```

#### 2. Backend
```bash
cd backend
cp .env.example .env       # DATABASE_URL, JWT_SECRET, SMTP_* anpassen
npm install
npx prisma db push
npx prisma generate
npx ts-node src/main.ts   # → http://localhost:3001
```

#### 3. Frontend
```bash
cd frontend
npm install
npm run dev               # → http://localhost:3000
```

Ersten Benutzer im Browser unter <http://localhost:3000> registrieren
(legt automatisch ein Unternehmen an und vergibt die Admin-Rolle), dann
loslegen.

### API-Konventionen

Alle Dashboard-Routen benötigen diese zwei Header:
```
x-user-id:    <uuid>
x-company-id: <uuid>
```
Der Frontend-Helper `@/lib/api` fügt sie automatisch aus `localStorage` ein —
niemals direktes `fetch()` für API-Aufrufe verwenden.

### Entwicklerhinweise
Siehe **`backend/AGENTS.md`** für projektspezifische Stolperfallen
(PDF-Layout-Invarianten, Throttler-Pitfall, Frontend-Auth-Header).

### CI/CD
Jeder `push` auf `main` (und jeder PR) durchläuft
**`.github/workflows/ci.yml`**:
1. **Backend typecheck** — `tsc --noEmit` auf dem NestJS-Server
2. **Frontend typecheck** — `tsc --noEmit` auf dem Next.js-Client
3. **E2E** — PostgreSQL als Service, `prisma db push`,
   Backend starten, alle 43 e2e-Tests durchlaufen
   (`for f in backend/e2e/[0-9]*.sh; do bash "$f"; done`),
   Playwright UI-Tests (`cd frontend && npx playwright test`)

Fehlgeschlagene CI blockiert Merges (Branch-Protection aktivieren).

### Backup
Siehe **`DEPLOY.md`** für die Produktions-Anleitung.
Kurzfassung:
- **`scripts/backup.sh`** — `pg_dump` + `tar` der Belege,
  Rotation: 7 Tage / 4 Wochen / Monatsanker
- **`scripts/restore.sh`** — Wiederherstellung mit Bestätigung
- **`scripts/com.de-invoice.backup.plist`** — macOS launchd
  (täglich 03:17 Uhr, `~/Library/LaunchAgents/` ablegen + laden)

### Lizenz
Proprietär — für den internen Gebrauch von SH Leder GmbH.

---

<a id="english"></a>

## 🇬🇧 English

A web application for German small/medium businesses to issue, send, and
account invoices in full compliance with **GoBD**, **XRechnung**, and
**ZUGFeRD/Factur-X** standards. Built for SH Leder GmbH (and any similar
B2B invoicing use-case in the DACH region).

### Features

#### Core invoicing
- Standard invoice (INV), credit note (CN), proforma (PI), and receipt (RCV)
- Multi-line items with German VAT rates (0%, 7%, 19%)
- Discounts, payment terms (Net 0/14/30/60), bank info on PDF
- Auto-generated sequential invoice numbers per company
- Number formats: `INV-2026-000001`, `CN-2026-000001`, etc.
- Status workflow: draft → sent → paid / overdue / cancelled
- GoBD-compliant 1-page PDF (no colored fills, thin black lines, German
  number/date format `€ 1.234,56` / `dd.mm.yyyy`)

#### Compliance & e-invoicing
- **XRechnung** (XML, UBL 2.1) — required for federal B2G invoicing
- **ZUGFeRD 2.1 / Factur-X 2.1** — hybrid PDF + embedded XML for B2B
- UStVA (Umsatzsteuervoranmeldung) declaration with full Kennzahlen
  (lines 20-23 sales, 26-29 exempt, 36 reverse charge, 50-66 input tax,
  81 Differenzbetrag)
- Expense tracking with UStVA line assignment
- Audit log

#### Customer & product management
- Customer CRUD with VAT ID, free-text country, German address format
- CSV import/export (RFC 4180 + UTF-8 BOM for Excel)
- Per-customer last-invoice date + total invoice count (efficient groupBy)
- Product catalog with SKU, base price, VAT rate, unit
- Auto-fill invoice items from product selection

#### Multi-user & access control
- 3 roles: `admin` (full access), `accountant` (invoicing/bookkeeping),
  `viewer` (read-only)
- User invitation via email (bcrypt-hashed token, 1h expiry)
- Password reset flow (constant-time bcrypt, generic responses, no user
  enumeration)
- Login throttler (anti-brute-force), per-IP failed-attempt lockout
- All sensitive routes guarded by `@Auth()` + `@Require(action)` decorators

#### Productivity
- Bulk invoice download — up to 100 invoices bundled as ZIP
  (PDF or ZUGFeRD format, deduplicated filenames, manifest)
- Bulk invoice email sending
- Date-range CSV export (18 columns, Excel compatible)
- Date-range ZIP export
- Multi-select invoice list with bulk-action toolbar
- Reminder / dunning workflow with multi-send
- Payment tracking with auto-status transition (paid when sum covers total)
- **Trilingual UI: German, English, Chinese** (1,500+ keys)
- Multi-currency ready (defaults to EUR)

#### Storage
- Per-company local storage folder (`{year}/{month}/{type}/{companyId}`)
- Health check (reachable/writable/free space)
- File list with download/delete
- Logo upload (image per company)

### Quick Start (Development)

#### Prerequisites
- Node.js 22 LTS
- PostgreSQL 16
- npm 10+

#### 1. Database
```bash
docker run -d --name de-invoice-postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=de_invoice \
  -p 5432:5432 postgres:16
```

#### 2. Backend
```bash
cd backend
cp .env.example .env       # adjust DATABASE_URL, JWT_SECRET, SMTP_*
npm install
npx prisma db push
npx prisma generate
npx ts-node src/main.ts   # → http://localhost:3001
```

#### 3. Frontend
```bash
cd frontend
npm install
npm run dev               # → http://localhost:3000
```

Open <http://localhost:3000>, register the first user (which auto-creates a
company and assigns you admin role), and start invoicing.

### API Conventions

All dashboard routes require these two headers:
```
x-user-id:    <uuid>
x-company-id: <uuid>
```
The frontend helper `@/lib/api` injects them automatically from
`localStorage` — never use raw `fetch()` for API calls.

### Development Notes
See **`backend/AGENTS.md`** for project-specific gotchas
(PDF layout invariants, throttler pitfall, frontend auth headers).

### License
Proprietary — built for SH Leder GmbH internal use.

---

<a id="中文"></a>

## 🇨🇳 中文

为德国中小企业打造的发票与会计管理系统,完全符合 **GoBD**、**XRechnung** 和
**ZUGFeRD/Factur-X** 标准。为 SH Leder GmbH 开发(同样适用于德语区 B2B
开票场景)。

### 功能特性

#### 核心开票
- 发票类型:普通发票 (INV)、贷项凭证 (CN)、形式发票 (PI)、收据 (RCV)
- 多行项目,支持德国增值税税率(0%、7%、19%)
- 支持折扣、付款条件(立即/14/30/60天)、PDF 上展示银行信息
- 每个公司独立的连续发票编号
- 编号格式:`RE-2026-000001`、`GS-2026-000001` 等
- 状态流转:草稿 → 已发送 → 已付款 / 逾期 / 已作废
- GoBD 合规的单页 PDF(无彩色填充、黑色细线、
  德式数字/日期格式 `€ 1.234,56` / `dd.mm.yyyy`)

#### 合规与电子发票
- **XRechnung**(XML, UBL 2.1)— 联邦 B2G 必选
- **ZUGFeRD 2.1 / Factur-X 2.1** — B2B 混合 PDF + 嵌入 XML
- **UStVA**(增值税预申报)含完整 Kennzahlen
  (20–23 行销售额、26–29 行免税、36 行反向征收、
  50–66 行进项税、81 行差额)
- 费用管理,可对应到 UStVA 行
- 审计日志

#### 客户与产品管理
- 客户增删改查,含增值税 ID、自由国家文本、德式地址格式
- CSV 导入/导出(RFC 4180 + UTF-8 BOM,Excel 兼容)
- 每客户最近开票日期 + 累计开票数量(高效 groupBy)
- 产品目录含 SKU、基础价、税率、单位
- 选择产品后自动填充发票项目

#### 多用户与权限控制
- 3 种角色:`admin`(完全权限)、`accountant`(开票/记账)、
  `viewer`(只读)
- 邮件邀请用户(bcrypt 哈希 token,1 小时过期)
- 密码重置(恒定时间 bcrypt、通用响应、避免用户枚举)
- 登录限流(防暴力破解),按 IP 失败次数锁定
- 所有敏感路由通过 `@Auth()` + `@Require(action)` 装饰器保护

#### 效率工具
- 批量下载:最多 100 张发票打包为 ZIP
  (PDF 或 ZUGFeRD,文件名去重,带清单)
- 批量邮件发送
- 按时间区间 CSV 导出(18 列,Excel 兼容)
- 按时间区间 ZIP 导出
- 发票列表多选 + 批量操作工具栏
- 催收/逾期提醒工作流,支持多次发送
- 付款跟踪,自动状态切换(收款金额覆盖总额后自动置为已付)
- **三语界面:德语 / 英语 / 中文**(1500+ 翻译键)
- 多币种就绪(默认 EUR)

#### 存储
- 每个公司独立的本地存储目录(`{年}/{月}/{类型}/{公司ID}`)
- 健康检查(可达 / 可写 / 剩余空间)
- 文件列表(下载 / 删除)
- Logo 上传(每个公司一张图)

### 快速开始(开发环境)

#### 环境要求
- Node.js 22 LTS
- PostgreSQL 16
- npm 10+

#### 1. 数据库
```bash
docker run -d --name de-invoice-postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=de_invoice \
  -p 5432:5432 postgres:16
```

#### 2. 后端
```bash
cd backend
cp .env.example .env       # 修改 DATABASE_URL, JWT_SECRET, SMTP_*
npm install
npx prisma db push
npx prisma generate
npx ts-node src/main.ts   # → http://localhost:3001
```

#### 3. 前端
```bash
cd frontend
npm install
npm run dev               # → http://localhost:3000
```

浏览器打开 <http://localhost:3000>,注册第一个用户(自动创建公司并授予
admin 角色),即可开始开票。

### API 约定

所有 Dashboard 路由需要以下两个请求头:
```
x-user-id:    <uuid>
x-company-id: <uuid>
```
前端辅助函数 `@/lib/api` 会从 `localStorage` 自动注入 — 切勿直接使用
`fetch()` 调 API。

### 开发提示
项目特有的"坑"请参考 **`backend/AGENTS.md`**
(PDF 布局约束、限流器陷阱、前端鉴权头)。

### 许可证
专有软件 — 仅供 SH Leder GmbH 内部使用。

---

## Tech Stack / 技术栈

| Layer / 层 | Technology / 技术 |
|------------|-------------------|
| Frontend / 前端 | Next.js 16, React 19, TypeScript, Tailwind CSS |
| Backend / 后端 | Node.js 22 LTS, NestJS 10, TypeScript |
| Database / 数据库 | PostgreSQL 16 (Prisma ORM 5) |
| PDF | PDFKit (1-page ink-saving layout) |
| E-Invoice / 电子发票 | Custom XRechnung (UBL 2.1) + ZUGFeRD 2.1 / Factur-X 2.1 generators |
| Email / 邮件 | Nodemailer (SMTP), per-company config |
| Storage / 存储 | Local filesystem (S3/MinIO planned) |
| Auth / 鉴权 | Custom header-based shim + RBAC roles |
| Security headers / 安全头 | Helmet 7.x (HSTS, X-Frame-Options, X-Content-Type-Options) |
| i18n / 国际化 | Flat JSON keys, 3 locales (DE/EN/ZH), 2384 keys × 3 = 7152 translations |
| E2E tests / 端到端测试 | 131 backend bash scripts + 286 Playwright UI tests (73 spec files) |

## Repository Layout / 仓库结构

```
de-invoice/
├── backend/                      # NestJS API
│   ├── prisma/schema.prisma      # DB schema (Company, User, Customer, Invoice, ...)
│   ├── src/
│   │   ├── auth/                 # HeaderAuthGuard, RolesGuard, decorators
│   │   ├── modules/              # customer, invoice, product, accounting, ...
│   │   ├── invoices/             # PDF + XRechnung + ZUGFeRD generators
│   │   └── prisma/               # PrismaService
│   ├── AGENTS.md                 # Project memory (PDF rules, throttler pitfall, etc.)
│   └── package.json
├── frontend/                     # Next.js dashboard
│   ├── messages/{de,en,zh}.json  # i18n message catalogs
│   ├── src/
│   │   ├── app/dashboard/        # pages: invoices, customers, products, accounting, ...
│   │   ├── components/           # shared UI: ExportCSVButton, RevenueChart, ...
│   │   └── lib/api.ts            # apiFetch / apiGet / apiPost / apiPut / apiDelete
│   └── package.json
└── README.md                     # this file / 本文件 / diese Datei
```
