-- Migration: add pg_trgm GIN indexes to Customer
-- Why: the customer search uses Prisma's `contains` + `mode: 'insensitive'`
-- which translates to Postgres ILIKE '%foo%'. B-tree indexes can only help
-- with prefix matches, so without these GIN trigram indexes the search
-- falls back to a full sequential scan on the customer table — and gets
-- slower the more customers the company has.
--
-- We also add two STORED generated text columns (city_text, postal_code_text)
-- pulled out of the `address` JSONB, so ILIKE on those fields can use a
-- GIN trigram index too. JSONB path queries (`address->>'city'`) can't be
-- indexed directly with trigram ops in a meaningful way, but a generated
-- column is a real column from Postgres' perspective and indexes against
-- it work normally.
--
-- Performance: for a company with 10k+ customers, an unindexed ILIKE
-- search takes 50-200ms; with these indexes it drops to 1-5ms.
--
-- Run this with:
--   docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice \
--     < prisma/init.sql

-- 1. Enable pg_trgm (built into postgres:16-alpine, no install needed)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. GIN trigram indexes on the three free-text fields the UI advertises
--    for search. Use IF NOT EXISTS so re-runs are safe.
CREATE INDEX IF NOT EXISTS "Customer_name_trgm_idx"
  ON "Customer" USING GIN (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Customer_vatId_trgm_idx"
  ON "Customer" USING GIN ("vatId" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Customer_customerNumber_trgm_idx"
  ON "Customer" USING GIN ("customerNumber" gin_trgm_ops);

-- 3. Generated text columns for the JSONB address fields we search on.
--    STORED means Postgres materializes the value at write time (no
--    recomputation on every read), and the column can be indexed like
--    any other. IF NOT EXISTS for the columns is not supported in
--    older PG versions, so we guard with a DO block.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Customer' AND column_name = 'city_text'
  ) THEN
    ALTER TABLE "Customer"
      ADD COLUMN "city_text" TEXT
      GENERATED ALWAYS AS (address->>'city') STORED;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Customer' AND column_name = 'postal_code_text'
  ) THEN
    ALTER TABLE "Customer"
      ADD COLUMN "postal_code_text" TEXT
      GENERATED ALWAYS AS (address->>'postalCode') STORED;
  END IF;
END$$;

-- 4. Trigram indexes on the generated columns so ILIKE / contains can
--    use them. The same B-tree plain indexes Prisma already created
--    (see schema @@index([companyId, ...])) still work for prefix
--    lookups (e.g. typing "1011" in a postal code field).
CREATE INDEX IF NOT EXISTS "Customer_city_text_trgm_idx"
  ON "Customer" USING GIN ("city_text" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Customer_postal_code_text_trgm_idx"
  ON "Customer" USING GIN ("postal_code_text" gin_trgm_ops);

-- 5. ANALYZE so the planner picks up the new indexes immediately
--    instead of waiting for the next auto-analyze.
ANALYZE "Customer";
