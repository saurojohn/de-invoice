#!/usr/bin/env ts-node
// Tier 196: re-hash the entire audit-log chain in
// `seq` order so the chain is "clean" again.
// (Tier 367: was createdAt order — see the IMPORTANT
// note below and src/prisma/audit-log.extension.ts.)
//
// Why this exists: the audit-hash-chain-tier196
// Playwright spec asserts
//   GET /api/v1/audit-logs/verify → { ok: true, brokenAt: null }
// The chain is intentionally broken by other tests
// (e.g. the "tamper detection" tests in the same
// suite write a fake row that breaks the chain).
// Before the spec suite runs, we re-hash the entire
// chain so the "clean chain" assertion is valid.
//
// IMPORTANT: the production verify walks the chain
// per-companyId (each company has its own chain
// rooted at previousHash = ''). So we have to
// re-hash per-companyId, sorted by `seq` — not
// the global row order. Re-hashing the global
// order would compute a hash that depends on rows
// from OTHER companies, which the per-company
// verify would then reject as "previous_hash_mismatch".
//
// Tier 367: the sort key is `seq`, not createdAt. createdAt is rounded to
// whole seconds by the writer and the id tiebreak is a random UUID, so
// re-hashing in (createdAt, id) order produced a chain in an order the live
// writer would never extend — the next real write chained to a different
// predecessor and the walk broke again. Note this tool is no longer what makes
// the chain verify: e2e/170 asserts a freshly seeded database verifies with no
// re-hash at all. It stays for repairing a chain that really is corrupted.
//
// Usage:
//   cd backend && npx ts-node scripts/audit-rehash.ts

import { PrismaClient } from '@prisma/client'
import { createHash } from 'crypto'

const prisma = new PrismaClient()

// Tier 366: matches stableStringifyV2 in audit-log.extension.ts — anything
// with toJSON() (Date, Prisma.Decimal) is hashed as the value jsonb stores.
function stableStringify(v: any): string {
  if (v == null) return ''
  if (typeof v === 'bigint') return JSON.stringify(v.toString())
  if (typeof v !== 'object') return JSON.stringify(v)
  if (typeof (v as any).toNumber === 'function') {
    return JSON.stringify((v as any).toNumber())
  }
  if (typeof (v as any).toJSON === 'function') {
    return stableStringify((v as any).toJSON())
  }
  if (Array.isArray(v)) {
    return '[' + v.map(stableStringify).join(',') + ']'
  }
  // Tier 367: skip `undefined`-valued keys — Prisma drops them when writing
  // the jsonb payload, so hashing them made the write and verify paths
  // disagree. `null` is kept (jsonb stores it). Must stay identical to
  // stableStringifyV2 in src/prisma/audit-log.extension.ts.
  const keys = Object.keys(v)
    .filter((k) => v[k] !== undefined)
    .sort()
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + stableStringify(v[k]))
      .join(',') +
    '}'
  )
}

function computeHash(row: any, previousHash: string): string {
  const payload = [
    row.action,
    row.entityType ?? '',
    row.entityId ?? '',
    row.userId ?? '',
    row.companyId ?? '',
    stableStringify(row.oldData),
    stableStringify(row.newData),
    previousHash,
    row.createdAt.toISOString(),
  ].join('|')
  return createHash('sha256').update(payload).digest('hex')
}

async function main() {
  // Get the list of distinct companyIds that have
  // audit rows. Rows with companyId = null are
  // processed separately (their previousHash
  // walks in isolation).
  const companies = await prisma.auditLog.findMany({
    distinct: ['companyId'],
    select: { companyId: true },
  })
  let totalUpdated = 0
  let totalRows = 0
  for (const { companyId } of companies) {
    const rows = await prisma.auditLog.findMany({
      where: { companyId },
      // Tier 367: the same order the writer and verifyChain use. Re-hashing in
      // any other order would hand back a chain the live writer cannot extend.
      orderBy: { seq: 'asc' },
    })
    let prevHash = ''
    let updated = 0
    for (const row of rows) {
      const expected = computeHash(row, prevHash)
      if (row.hash !== expected || row.previousHash !== prevHash) {
        await prisma.auditLog.update({
          where: { id: row.id },
          data: {
            hash: expected,
            previousHash: prevHash,
            hashAlgorithm: 'SHA-256-V2',
          },
        })
        updated++
      }
      prevHash = expected
    }
    totalUpdated += updated
    totalRows += rows.length
    if (rows.length > 0) {
      console.log(
        `  company ${companyId}: ${rows.length} rows, ${updated} updated`,
      )
    }
  }
  console.log(
    `audit-rehash: processed ${totalRows} rows, updated ${totalUpdated}`,
  )
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
