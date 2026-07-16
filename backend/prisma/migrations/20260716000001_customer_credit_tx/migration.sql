-- Tier 58: Customer credit balance (Kundenguthaben) + Auszahlung (refund)
-- ledger.
--
-- Real-world scenario: a B2B customer overpays an invoice by EUR 47,50
-- (or several Gutschriften stack up so the customer has positive
-- credit). That money is owed back to the customer, but until the
-- user explicitly issues an Auszahlung (refund) Voucher + bank
-- transfer, the credit just sits in the books.
--
-- This table is the immutable ledger of every credit movement:
--   - `overpayment`  : posted when a Payment.amount exceeds the
--                      invoice's remaining total. amount = overage.
--   - `gutschrift`   : when a Gutschrift (credit note) lands but
--                      the original invoice is already fully paid,
--                      the Gutschrift's amount flows to credit
--                      balance instead. amount = Gutschrift total.
--   - `payout`       : posted when the user issues an Auszahlung
--                      Voucher. amount = -payout (credit used).
--   - `apply`        : posted when credit is applied against a
--                      specific invoice (reducing that invoice's
--                      open balance). amount = -applied.
--   - `manual`       : Berater manual adjustment. amount can be
--                      either sign.
--
-- `amount` is signed: positive = credit added, negative = credit used.
-- The customer's `creditBalance` is the sum of all amounts (no caching
-- needed — table stays small, query is index-backed).
--
-- A `balance_after` snapshot column is included so the statement can
-- show a per-row running balance without re-summing the whole table
-- in JS (one pass over rows works in ascending order, using the prior
-- row's `balance_after` as the seed).
--
-- `referenceType` + `referenceId` link to the originating Invoice /
-- Voucher / Payment. NULL is fine for `manual` entries.
--
-- All PK/FK columns are `text` (not UUID) — matches the rest of the
-- schema where Prisma's `String @id @default(uuid())` serialises to
-- `text` because the baseline migration did not declare `@db.Uuid`.

CREATE TABLE "CustomerCreditTransaction" (
    "id"              TEXT         PRIMARY KEY,
    "companyId"       TEXT         NOT NULL,
    "customerId"      TEXT         NOT NULL,
    "amount"          DECIMAL(12,4) NOT NULL,
    "currency"        VARCHAR(3)   NOT NULL DEFAULT 'EUR',
    "type"            VARCHAR(32)  NOT NULL,
    "referenceType"   VARCHAR(32),
    "referenceId"     TEXT,
    "balanceAfter"    DECIMAL(12,4) NOT NULL,
    "description"     TEXT,
    "createdById"     TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerCreditTransaction_companyId_fkey"
        FOREIGN KEY ("companyId") REFERENCES "Company"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CustomerCreditTransaction_customerId_fkey"
        FOREIGN KEY ("customerId") REFERENCES "Customer"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CustomerCreditTransaction_createdById_fkey"
        FOREIGN KEY ("createdById") REFERENCES "User"("id")
        ON DELETE SET NULL ON UPDATE CASCADE
);

-- Tenant-scoping + per-customer lookups. The customer-detail page
-- hits this with `WHERE customerId = ? ORDER BY createdAt ASC` —
-- the composite index makes the query a single index range scan.
CREATE INDEX "CustomerCreditTransaction_companyId_customerId_idx"
    ON "CustomerCreditTransaction"("companyId", "customerId");
CREATE INDEX "CustomerCreditTransaction_customerId_createdAt_idx"
    ON "CustomerCreditTransaction"("customerId", "createdAt");

-- The `type` is queried for filtering ("show only payouts") and
-- the `referenceId` for "is there already a credit for this
-- invoice" lookups.
CREATE INDEX "CustomerCreditTransaction_type_idx"
    ON "CustomerCreditTransaction"("type");
CREATE INDEX "CustomerCreditTransaction_referenceId_idx"
    ON "CustomerCreditTransaction"("referenceId")
    WHERE "referenceId" IS NOT NULL;
