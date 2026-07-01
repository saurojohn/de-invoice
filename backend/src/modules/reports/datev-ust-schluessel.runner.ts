// Run with: npx ts-node --transpile-only src/modules/reports/datev-ust-schluessel.runner.ts
//
// node:test with describe/it doesn't surface errors
// well in the CJS-compiled form, so we run node:test
// programmatically with the spec reporter.

import { run } from 'node:test'
import { spec as Spec } from 'node:test/reporters'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const testFile = path.join(__dirname, 'datev-ust-schluessel.test.ts')

const reporter = new Spec({})
reporter.pipe(process.stdout)
run({ files: [testFile] }).pipe(reporter)
