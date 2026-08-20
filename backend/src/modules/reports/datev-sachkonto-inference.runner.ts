// @ts-nocheck -- ESM-only syntax (`import.meta.url`) + node:test
// run-options overload that the CJS @types doesn't expose.
// The runtime is `--transpile-only` (see header) so syntax-
// only checks are intentionally bypassed. Tier 235: this
// file was already failing tsc; rather than tsc-exclude it,
// we accept the nocheck and document why.
//
// Run with: npx ts-node --transpile-only src/modules/reports/datev-sachkonto-inference.runner.ts
//
// The .test.ts file uses node:test + describe/it.
// We can't easily re-export from there into the
// CJS-compiled test runner, so this script runs
// node:test programmatically after ts-node has
// transformed the source.

import { run } from 'node:test'
import { spec as Spec } from 'node:test/reporters'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const testFile = path.join(__dirname, 'datev-sachkonto-inference.test.ts')

const reporter = new Spec({})
reporter.pipe(process.stdout)
run({ files: [testFile] }).pipe(reporter)