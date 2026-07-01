-- Migration: Tier 28 — full-text search with snippet highlight
--
-- Why this migration:
--   The customer/product/invoice search currently uses
--   Prisma `contains: { q, mode: 'insensitive' }` which
--   translates to ILIKE %q%. We have pg_trgm GIN indexes
--   (see init.sql) which make that fast, BUT:
--
--     1. ILIKE has NO relevance ranking. "Müller GmbH" and
--        "Müll GmbH" both match the query "müll" but with
--        no way to surface the better hit first.
--     2. ILIKE has no snippet generation. We can't show
--        the user "Mü<mark>ll</mark>er GmbH — Otto-Hahn-Str."
--        as a hit preview — the UI is stuck with raw
--        full-row display.
--     3. ILIKE doesn't normalize diacritics. "Muller" must
--        be searched as "Muller" (not "Müller") unless
--        we wrap in unaccent() — which ILIKE can't do.
--
-- This migration adds:
--   - The `unaccent` extension (built-in to PG, just CREATE EXTENSION)
--   - IMMUTABLE wrappers for unaccent(), to_tsvector() (regconfig),
--     and array_to_string() — Postgres requires STORED generated
--     columns to use IMMUTABLE functions, and the built-in
--     versions of those three are STABLE.
--   - A STORED generated tsvector column per searchable model
--   - A GIN index on each tsvector column
--
-- The wrappers are documented in
--   https://www.postgresql.org/docs/current/textsearch-controls.html
-- and the immutable_array_to_string wrapper is the same pattern
-- we already use elsewhere in this codebase.
--
-- We use 'simple' config (no German stemming) because the existing
-- ILIKE behaviour was substring-based and users expect "Müller" to
-- match "Müller" literally, not "muhlen" via stemming. The
-- trade-off: typo tolerance is worse (we don't fuzzy-match), but
-- result relevance is predictable and matches user intent.
--
-- The ts_headline() function (used by the search service to render
-- snippets) respects StartSel/StopSel options — the search service
-- passes '<mark>' / '</mark>' so the frontend can render highlights
-- without a second pass.

-- 1. Enable unaccent (lives in the public schema).
CREATE EXTENSION IF NOT EXISTS unaccent;

-- 1b. IMMUTABLE wrappers. PG 16 requires IMMUTABLE for STORED
--     generated columns. The built-in unaccent(), to_tsvector(regconfig, text)
--     and array_to_string() are STABLE — the wrappers below hardcode
--     the regconfig / separator string so PG considers them immutable.
CREATE OR REPLACE FUNCTION immutable_unaccent(text)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  STRICT
AS $$
  SELECT unaccent('unaccent', $1)
$$;

CREATE OR REPLACE FUNCTION immutable_to_tsvector_simple(text)
  RETURNS tsvector
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  STRICT
AS $$
  SELECT to_tsvector('simple'::regconfig, $1)
$$;

CREATE OR REPLACE FUNCTION immutable_array_to_string(text[])
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  STRICT
AS $$
  SELECT array_to_string($1, ' ')
$$;

-- 2. Customer: search across name, vatId, customerNumber, plus the
--    already-extracted city_text / postal_code_text (from init.sql).
--    Tags array is included as a separate weighted column (set C)
--    so a hit on a tag outranks a hit on a postal code (tags are
--    user-curated and more meaningful).
--
--    The COALESCE(..., ''::tsvector) wrappers around each
--    setweight() call are critical: PG 16's generated-column
--    evaluator NULL-propagates empty tsvectors through the `||`
--    operator unless coalesced. Without the wrappers, a single
--    empty input (e.g. a Customer with no city_text) nukes the
--    whole column to NULL.
--
--    All inputs are wrapped in immutable_unaccent() so 'Müller'
--    and 'Muller' land on the same lexeme ('muller'), and a
--    search for 'muller:*' matches both spellings.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Customer' AND column_name = 'search_tsv'
  ) THEN
    ALTER TABLE "Customer"
      ADD COLUMN "search_tsv" tsvector
      GENERATED ALWAYS AS (
        coalesce(setweight(immutable_to_tsvector_simple(immutable_unaccent(name)), 'A'), ''::tsvector) ||
        coalesce(setweight(immutable_to_tsvector_simple(immutable_unaccent("customerNumber")), 'A'), ''::tsvector) ||
        coalesce(setweight(immutable_to_tsvector_simple(immutable_unaccent("vatId")), 'A'), ''::tsvector) ||
        coalesce(setweight(immutable_to_tsvector_simple(immutable_unaccent(city_text)), 'B'), ''::tsvector) ||
        coalesce(setweight(immutable_to_tsvector_simple(immutable_unaccent(postal_code_text)), 'B'), ''::tsvector) ||
        coalesce(setweight(immutable_to_tsvector_simple(immutable_unaccent(coalesce(immutable_array_to_string(tags), ''))), 'C'), ''::tsvector)
      ) STORED;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS "Customer_search_tsv_idx"
  ON "Customer" USING GIN ("search_tsv");

-- 3. Product: name + sku (A), description (B).
--    Category text is fetched via a subquery from the Category
--    relation — but STORED generated columns can't span relations.
--    We add a denormalised categoryName column populated by the
--    service on every Product write. The search_tsv column
--    references it as if it always exists (the default '' handles
--    rows that haven't been backfilled yet).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Product' AND column_name = 'categoryName'
  ) THEN
    ALTER TABLE "Product"
      ADD COLUMN "categoryName" TEXT NOT NULL DEFAULT '';
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Product' AND column_name = 'search_tsv'
  ) THEN
    ALTER TABLE "Product"
      ADD COLUMN "search_tsv" tsvector
      GENERATED ALWAYS AS (
        coalesce(setweight(immutable_to_tsvector_simple(immutable_unaccent(name)), 'A'), ''::tsvector) ||
        coalesce(setweight(immutable_to_tsvector_simple(immutable_unaccent(sku)), 'A'), ''::tsvector) ||
        coalesce(setweight(immutable_to_tsvector_simple(immutable_unaccent(description)), 'B'), ''::tsvector) ||
        coalesce(setweight(immutable_to_tsvector_simple(immutable_unaccent("categoryName")), 'B'), ''::tsvector)
      ) STORED;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS "Product_search_tsv_idx"
  ON "Product" USING GIN ("search_tsv");

-- 4. Invoice: invoiceNumber + customerName (A), notes (B).
--    customerName is denormalised on the Invoice row (mirrored at
--    write time from Customer.name). Existing rows may have it
--    empty — we backfill below from the joined Customer.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Invoice' AND column_name = 'customerName'
  ) THEN
    ALTER TABLE "Invoice"
      ADD COLUMN "customerName" TEXT NOT NULL DEFAULT '';
  END IF;
END$$;

-- Backfill: copy Customer.name into Invoice.customerName for
-- existing rows. Safe to run repeatedly (idempotent).
UPDATE "Invoice" i
  SET "customerName" = c.name
  FROM "Customer" c
  WHERE i."customerId" = c.id
    AND (i."customerName" IS NULL OR i."customerName" = '');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Invoice' AND column_name = 'search_tsv'
  ) THEN
    ALTER TABLE "Invoice"
      ADD COLUMN "search_tsv" tsvector
      GENERATED ALWAYS AS (
        coalesce(setweight(immutable_to_tsvector_simple(immutable_unaccent("invoiceNumber")), 'A'), ''::tsvector) ||
        coalesce(setweight(immutable_to_tsvector_simple(immutable_unaccent("customerName")), 'A'), ''::tsvector) ||
        coalesce(setweight(immutable_to_tsvector_simple(immutable_unaccent(notes)), 'B'), ''::tsvector)
      ) STORED;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS "Invoice_search_tsv_idx"
  ON "Invoice" USING GIN ("search_tsv");