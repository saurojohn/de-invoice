-- ─────────────────────────────────────────────────────────────────
-- de-invoice prod init.sql (run by postgres entrypoint on first start)
--
-- This file runs ONCE when the postgres data directory is empty
-- (i.e. the very first time the container starts, or after a
-- `docker volume rm deinvoicenet_pgdata`). After that it's
-- ignored — subsequent schema changes go through `prisma migrate
-- deploy` (run from the backend container's entrypoint, or as
-- a separate compose service).
--
-- We don't pre-create extensions here because the app doesn't
-- use any DB-specific extensions (no citext, no uuid-ossp —
-- Prisma generates UUIDs in app code via `crypto.randomUUID`).
-- If we ever add citext for case-insensitive email lookups,
-- uncomment the line below.
-- ─────────────────────────────────────────────────────────────────

-- CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- The schema (tables + indexes + FKs) is created by Prisma's
-- first migration when you run `npx prisma migrate deploy`.
-- This file just makes sure the database is in UTF-8 mode
-- and the locale matches what the backend expects.
-- Both are set by `POSTGRES_INITDB_ARGS=--encoding=UTF8`
-- in docker-compose, so this file is essentially a no-op
-- today. Kept for future extension / role grants.
SELECT 'de-invoice init.sql loaded' AS status;