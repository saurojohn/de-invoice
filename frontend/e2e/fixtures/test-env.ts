/**
 * Tier 250: shared test-env helper.
 *
 * Reads the admin userId + companyId from the
 * auth cache file (`/tmp/cashbook-e2e-auth.env`)
 * that ci-seed.sh writes. Replaces the hardcoded
 * dryrun UUIDs that were sprinkled across 48+
 * Playwright specs.
 *
 * Why this exists:
 *   - The 48 specs were originally written
 *     against the dryrun stack, hardcoding
 *     USER_ID=8c6a9669-... and
 *     COMPANY_ID=ad257ec3-... (the dryrun
 *     admin + company). When the same specs
 *     run in CI or against a fresh dev DB,
 *     the FK constraint on Customer.companyId
 *     rejects the INSERT — and tests that
 *     depend on a seed row fail with
 *     "0ms test, FK violation".
 *   - This helper reads the auth cache
 *     (written by ci-seed.sh, also by
 *     backend/e2e/_lib.sh `login()`) and
 *     returns the correct userId/companyId
 *     for the current run. Specs that need
 *     a customer or invoice row use this
 *     helper's IDs in their seed SQL.
 *
 * Usage:
 *
 *   import { getTestEnv } from './fixtures/test-env'
 *
 *   const { userId, companyId } = getTestEnv()
 *   await page.context().addCookies([
 *     { name: 'x-user-id', value: userId, ... },
 *     ...
 *   ])
 *
 * The cache is read once per call (synchronous
 * read of a small file, < 1ms). The function
 * throws if the cache is missing — that's the
 * intended behavior: tests should fail fast
 * if the env wasn't set up, not silently use
 * stale IDs.
 */

import { readFileSync, existsSync } from "fs"

const AUTH_CACHE = "/tmp/cashbook-e2e-auth.env"

/**
 * Name of the Postgres container the e2e specs shell into with
 * `docker exec`.
 *
 * Tier 353: 28 spec files hardcoded "de-invoice-postgres" across 54 call
 * sites, which meant a spec could only ever run against that one
 * container. Locally that container has been dead since 2026-09-06 (see
 * HANDOFF), so any spec touching psql failed in `beforeAll` for purely
 * environmental reasons and could not be verified before pushing — that
 * blocked local verification three separate times in Tiers 350-352.
 *
 * `ci-seed.sh` already took PG_CONTAINER from the environment; this makes
 * the Playwright side agree with it. Default is unchanged, so CI and any
 * existing local setup behave exactly as before.
 */
export const PG_CONTAINER = process.env.PG_CONTAINER || 'de-invoice-postgres'

export interface TestEnv {
  userId: string
  companyId: string
}

export function getTestEnv(): TestEnv {
  if (!existsSync(AUTH_CACHE)) {
    throw new Error(
      `Auth cache ${AUTH_CACHE} not found. ` +
        `Run backend/e2e/ci-seed.sh (or backend/e2e/run-all.sh) ` +
        `to populate it before running Playwright.`,
    )
  }
  const env = readFileSync(AUTH_CACHE, "utf-8")
  const map: Record<string, string> = {}
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) map[m[1]] = m[2]
  }
  if (!map.USER_ID || !map.COMPANY_ID) {
    throw new Error(
      `Auth cache ${AUTH_CACHE} missing USER_ID or COMPANY_ID. ` +
        `Run ci-seed.sh to re-create.`,
    )
  }
  return { userId: map.USER_ID, companyId: map.COMPANY_ID }
}
