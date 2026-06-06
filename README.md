# de-invoice — German Invoice & Accounting System

A web application for German small/medium businesses to issue, send, and
account invoices in full compliance with **GoBD**, **XRechnung**, and
**ZUGFeRD/Factur-X** standards. Built for SH Leder GmbH (and any similar
B2B invoicing use-case in the DACH region).

## Tech Stack

| Layer       | Technology                                         |
|-------------|----------------------------------------------------|
| Frontend    | Next.js 16, React 19, TypeScript, Tailwind CSS     |
| Backend     | Node.js 22 LTS, NestJS 10, TypeScript              |
| Database    | PostgreSQL 16 (via Prisma ORM 5)                   |
| PDF         | PDFKit (1-page ink-saving layout)                  |
| E-Invoice   | Custom XRechnung (UBL 2.1) + ZUGFeRD 2.1 / Factur-X 2.1 generators |
| Email       | Nodemailer (SMTP), per-company config              |
| Storage     | Local filesystem (S3/MinIO planned)                |
| Auth        | Custom header-based shim + RBAC roles             |

## Features

### Core invoicing
- Standard invoice (INV), credit note (CN), proforma (PI), and receipt (RCV) types
- Multi-line items with German VAT rates (0%, 7%, 19%)
- Discounts, payment terms (Net 0/14/30/60), bank info on PDF
- Auto-generated sequential invoice numbers per company
- Invoice number formats: `INV-2026-000001`, `CN-2026-000001`, etc.
- Status workflow: draft → sent → paid / overdue / cancelled
- GoBD-compliant 1-page PDF (no colored fills, thin black lines, German
  number/date format `€ 1.234,56` / `dd.mm.yyyy`)

### Compliance & e-invoicing
- **XRechnung** (XML, UBL 2.1) — required for federal B2G invoicing
- **ZUGFeRD 2.1 / Factur-X 2.1** — hybrid PDF + embedded XML for B2B
- UStVA (Umsatzsteuervoranmeldung) declaration with full Kennzahlen
  (lines 20-23 sales, 26-29 exempt, 36 reverse charge, 50-66 input tax,
  81 Differenzbetrag)
- Expense tracking with UStVA line assignment
- Audit log

### Customer & product management
- Customer CRUD with VAT ID, free-text country, German address format
- CSV import/export for customers (RFC 4180 + UTF-8 BOM for Excel)
- Per-customer last-invoice date + total invoice count (efficient groupBy)
- Product catalog with SKU, base price, VAT rate, unit
- Auto-fill invoice items from product selection

### Multi-user & access control
- 3 roles: `admin` (full access), `accountant` (invoicing/bookkeeping),
  `viewer` (read-only)
- User invitation via email (bcrypt-hashed token, 1h expiry)
- Password reset flow (constant-time bcrypt, generic responses, no user
  enumeration)
- Login throttler (anti-brute-force), per-IP failed-attempt lockout
- All sensitive routes guarded by `@Auth()` + `@Require(action)` decorators

### Productivity
- Bulk invoice download — select up to 100 invoices and bundle as ZIP
  (PDF or ZUGFeRD format, deduplicated filenames, manifest)
- Bulk invoice email sending
- Date-range CSV export (18 columns, German Excel compatible)
- Date-range ZIP export
- Multi-select invoice list with bulk-action toolbar
- Reminder / dunning workflow with multi-send
- Payment tracking with auto-status transition (paid when sum covers total)
- German/English/Chinese UI translations (1,500+ keys)
- Multi-currency ready (defaults to EUR)

### Storage
- Per-company local storage folder (`{year}/{month}/{type}/{companyId}`)
- Health check (reachable/writable/free space)
- File list with download/delete
- Logo upload (image upload per company)

## Repository Layout

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
└── README.md                     # this file
```

## Quick Start (Development)

### Prerequisites
- Node.js 22 LTS
- PostgreSQL 16
- npm 10+

### 1. Database

```bash
docker run -d --name de-invoice-postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=de_invoice \
  -p 5432:5432 postgres:16
```

### 2. Backend

```bash
cd backend
cp .env.example .env       # adjust DATABASE_URL, JWT_SECRET, SMTP_*
npm install
npx prisma db push
npx prisma generate
npx ts-node src/main.ts   # → http://localhost:3001
```

### 3. Frontend

```bash
cd frontend
npm install
npm run dev               # → http://localhost:3000
```

Open <http://localhost:3000>, register the first user (which auto-creates a
company and assigns you admin role), and start invoicing.

## API Conventions

All dashboard routes require these two headers:

```
x-user-id:    <uuid>
x-company-id: <uuid>
```

The frontend helper `@/lib/api` injects them automatically from
`localStorage` — never use raw `fetch()` for API calls.

Pagination response shape:
```ts
{ data: T[], total: number, page: number, pageSize: number, totalPages: number }
```

Frontend always defends with `Array.isArray(d) ? d : (d.data || [])` to
handle both shapes (auth errors return `{ statusCode, message }` without
`.data`).

## Development Notes

See **`backend/AGENTS.md`** for project-specific gotchas:
- PDF layout invariants (1 page, ink-saving, German number format)
- Throttler pitfall (multi-bucket config caps all routes, not just the named one)
- Frontend auth headers (every dashboard call must include `x-user-id` +
  `x-company-id`)

## License

Proprietary — built for SH Leder GmbH internal use.
