# German Invoice System — Backend

## UStVA (Umsatzsteuervoranmeldung) — implemented 2026-06-04
- `backend/src/modules/reports/ustva.service.ts` — computes UStVA per period
  - Outputs: salesByRate (lines 20-23), igL (41), export (43), otherExempt (44), reverseCharge (36),
    vorsteuer (19/7/igE/§13b), umsatzsteuer, vorsteuerSum, differenzbetrag (line 81)
  - DB tables: `Expense` (input invoices with `isIntraEU`/`isReverseCharge` flags) and `UStvaFiling` (drafts/submissions)
  - **Compound unique key gotcha**: `@@unique([companyId, year, quarter, month])` with nullable quarter/month
    causes Prisma `upsert` to require the `quarter` field even when null. Workaround: use
    `findFirst({ where: { companyId, year, quarter, month } })` then `create` or `update` by id.
  - Forgot-password token: randomBytes(32).toString('hex'), bcrypt-hashed in `passwordResetToken`, expires 1h.
- Frontend UStVA page: `frontend/src/app/dashboard/accounting/ustva/page.tsx` — period picker, summary cards,
  sales/exempt/input-tax tables, expense entry form, filing save/submit, history, CSV export.

## Password Reset Flow — implemented 2026-06-04
- `POST /api/v1/auth/forgot-password` (3/hour per IP) — generates 32-byte token, bcrypt-hashed in DB, sends
  email via existing `MailService`. Returns generic 200 message always (no user enumeration).
  In dev (no SMTP), logs `[DEV-RESET-LINK]` to backend stdout.
- `POST /api/v1/auth/reset-password` (10/min per IP) — verifies token (constant-time bcrypt.compare),
  enforces password strength (8+ chars, letter+digit), updates hash, invalidates token, audit-logs success.
- Frontend: `/forgot-password` (enter email) → email → `/reset-password?token=...` (set new password) → `/login`
- `test@example.com` test user: password was reset to `NewSecret123` during testing and left as-is.
  To restore, run the forgot-password flow from the UI or seed manually.

## PDF Generation Rules (PDFKit)

When working with `backend/src/invoices/invoice-pdf.service.ts`:

### German number/currency format (MANDATORY)
- Currency: `€ 1.234,56` (NOT `€1,234.56`) — use non-breaking space `\u00A0` after €
- Numbers: `1.234,56` (dot for thousands, comma for decimal)
- Dates: `dd.mm.yyyy` (e.g. `01.06.2026`)
- Use helpers: `formatCurrency()` and `formatNumber()` (do NOT call `toFixed(2)` directly)

### Layout conventions
- Description column: left-aligned
- Quantity / price / tax / amount columns in items table: **center-aligned**
- Totals area (Zwischensumme, Gesamtbetrag): right-aligned (financial convention)
- Header text in totals: left side, amount: right side anchored to right margin

### Ink-saving design
- **No fills** — no colored backgrounds anywhere (saves toner)
- Use thin black lines (0.3pt) for table row separators
- Use a slightly thicker line (0.8-1.0pt) only for table header bottom and totals divider
- Gesamtbetrag box: outline only (no fill), 1.0pt border
- Footer text: pure black `#000000` (not gray)

### PDFKit gotchas
- **`lineBreak: false` is REQUIRED** on all single-line `text()` calls. Default is `true` which causes text to wrap to next line if it exceeds the right margin → pushes subsequent elements to a second blank page
- Always anchor `text()` with explicit x,y AND set `lineBreak: false` to prevent overflow
- Test with `file /tmp/test.pdf` to verify single-page output

### Page count invariant
- A standard invoice MUST be 1 page. If `file` reports 2 pages, one of the
  `text()` calls is wrapping — find it by adding `lineBreak: false` until
  page count drops to 1.

## Frontend → Backend auth (HeaderAuthGuard) — implemented 2026-06-05
- **Every** protected backend route requires `x-user-id` and `x-company-id`
  headers. Without them, the backend returns `403 "Unzureichende Berechtigung"`
  with body `{statusCode: 403, message: "Unzureichende Berechtigung: <action>"}`.
- **NEVER use raw `fetch(\`http://localhost:3001/api/v1/...\`)` in the frontend.**
  Always go through `frontend/src/lib/api.ts` (`apiGet` / `apiPost` / `apiPut`
  / `apiDelete`) which auto-injects the headers from localStorage.
- Failure mode when using raw fetch: the JSON body is `{statusCode, message}`,
  no `.data` field, so `data.data || []` returns `[]` and lists appear empty
  with no error message. This was the "saved but not displayed" bug —
  backend was fine, frontend was unauthenticated.
- The login flow stores `userId` and `companyId` in localStorage (see
  `frontend/src/app/login/page.tsx`). `apiFetch()` reads both.
- For the dashboard refetch after a create/update, always force `page=1` and
  clear the search filter — otherwise the new row can be hidden by stale
  pagination state.

## NestJS Throttler — DO NOT add a second named bucket — discovered 2026-06-06
- The ThrottlerModule evaluates **every configured bucket** on every request,
  not just the routes it applies to. Adding a `name: 'auth', limit: 5, ttl: 60s`
  bucket to `ThrottlerModule.forRoot([...])` also caps EVERY other route
  (customers, invoices, products, ...) at 5 req/min/IP — which makes the
  dashboard unusable once the user clicks around a bit.
- For per-route tighter limits (e.g. login anti-brute-force), use the
  `@Throttle({ default: { limit, ttl } })` decorator on the specific
  controller method. The login routes in `auth.controller.ts` already do this.
- Keep `ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 100 }])`
  and add route-level @Throttle() overrides for the rest.
- Symptom of this bug: a logged-in user gets random 429 "ThrottlerException:
  Too Many Requests" on normal navigation, and the list pages show empty
  because frontend treats 429 like a generic error.

## HeaderAuthGuard — DENY by default, NEVER return true on failure — discovered 2026-06-06
- The guard at `backend/src/auth/header-auth.guard.ts` MUST be DENY-default.
  Every failure path (no header / unknown user / cross-tenant / inactive /
  DB exception) must throw `UnauthorizedException`. A `return true` on
  any failure path is a CRITICAL security bug — it lets an attacker
  with a single valid `x-user-id` UUID dump the entire company, or
  read cross-tenant data.
- The original implementation had 5 `return true` paths that should
  have been `return false` (or throws). It allowed `GET /customers`
  with ONLY `x-user-id` (no `x-company-id`) to return 200, exposing
  the full customer list. Fixed in commit 5765821.
- When modifying or copy-pasting this guard, keep the symmetry:
  every `if` that finds a problem throws — no early `return true` on
  failure. The "happy path" is the only `return true`.
