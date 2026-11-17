#!/usr/bin/env node
// Tier 858 — the production dependencies have no known high or critical hole.
//
// Security audit (18.11.2026), item 4: nothing looked at the dependencies'
// advisories. Measured that day with `npm audit --omit=dev`: the frontend ran
// Next.js 15.5.27 — a critical advisory, remote code execution through the
// image optimizer with SVG files, fixed in 15.5.29 — and the backend multer
// and body-parser (denial of service) and node-forge (signature check), all
// high, all with a fix.
//
// Usage: node scripts/ci-npm-audit.mjs backend frontend
//
// For each directory: `npm audit --omit=dev --package-lock-only --json` (the
// lock file is enough, no install). Fails on every high or critical advisory
// of a production dependency, except one listed in scripts/npm-audit-allow.json
// with its reason and a date it is looked at again — after that date it fails
// again. Moderate and low ones are listed, they do not fail the run.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const allow = JSON.parse(readFileSync(process.env.AUDIT_ALLOW || join(here, 'npm-audit-allow.json'), 'utf8')).allow ?? []
const today = process.env.AUDIT_TODAY || new Date().toISOString().slice(0, 10)
const dirs = process.argv.slice(2)
if (!dirs.length) { console.error('usage: ci-npm-audit.mjs <dir>…'); process.exit(2) }

let failed = 0
for (const dir of dirs) {
  let out
  try {
    out = execFileSync('npm', ['audit', '--omit=dev', '--package-lock-only', '--json'], { cwd: resolve(root, dir), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 })
  } catch (e) {
    out = e.stdout // npm audit exits 1 when it finds anything
  }
  let report
  try { report = JSON.parse(out) } catch { console.error(`${dir}: npm audit gave no report`); failed++; continue }
  if (report.error) { console.error(`${dir}: npm audit failed: ${report.error.summary || JSON.stringify(report.error)}`); failed++; continue }
  // the advisories themselves (an entry's `via` holds them, or the name of the package it comes through)
  const seen = new Map()
  for (const [pkg, v] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of v.via) {
      if (typeof via !== 'object') continue
      const id = (via.url || '').split('/').pop() || String(via.source)
      if (!seen.has(id)) seen.set(id, { id, pkg: via.name || pkg, severity: via.severity, title: via.title, range: via.range, url: via.url })
    }
  }
  const list = [...seen.values()].sort((a, b) => a.pkg.localeCompare(b.pkg))
  if (!list.length) console.log(`${dir}: no known advisory in the production dependencies`)
  for (const a of list) {
    const serious = a.severity === 'high' || a.severity === 'critical'
    const ok = allow.find((x) => x.id === a.id && x.package === a.pkg)
    let verdict
    if (!serious) verdict = 'listed'
    else if (ok && ok.until >= today) verdict = `allowed until ${ok.until}: ${ok.reason}`
    else { verdict = ok ? `FAIL (the exception ended on ${ok.until})` : 'FAIL'; failed++ }
    console.log(`${dir}: ${a.severity.padEnd(8)} ${a.pkg} ${a.range} — ${a.title} ${a.url} → ${verdict}`)
  }
}
if (failed) {
  console.error(`\n${failed} high or critical advisory/advisories without an exception. Update the dependency (npm update / npm install <pkg>@<fixed>), or — only when it cannot be reached in this program — add it to scripts/npm-audit-allow.json with the reason and a date.`)
  process.exit(1)
}
