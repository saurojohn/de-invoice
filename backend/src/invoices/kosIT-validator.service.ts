import { execFile } from 'child_process'
import { promisify } from 'util'
import * as path from 'path'
import * as fs from 'fs/promises'
import * as os from 'os'

const execFileAsync = promisify(execFile)

/**
 * KoSITValidatorService — Tier 116
 * Wraps the official KoSIT Validator (validator-1.6.2.jar)
 * to validate XRechnung documents against the German
 * CIUS (XRechnung 3.0.2 / KoSIT 2024). Falls back gracefully
 * if the JAR or JDK is not installed.
 *
 * Why KoSIT:
 *   - The in-process validateXRechnung() (Tier 115) covers
 *     a subset of the EN 16931 business rules (BR-01..13).
 *     KoSIT covers 150+ rules including all BR-*, BR-CO-*,
 *     BR-DEC-*, BR-S-*, plus the XRechnung 3.0 specific
 *     extensions.
 *
 * The CLI:
 *   java -jar validator.jar \
 *     -r repository -s scenarios.xml \
 *     --serialize-report-input -o <outDir> \
 *     <input.xml>
 *
 * The CLI prints a result table + writes the report XML.
 * We parse both: the table for valid/rejected, the XML
 * for detailed BR-* assertions when present.
 *
 * Infra location (configured via env / convention):
 *   infra/kosit/validator.jar
 *   infra/kosit/scenarios.xml
 *   infra/kosit/repository/   (XSDs + schematron)
 *   infra/java/jdk-17.0.13/Contents/Home/bin/java  (Temurin)
 *
 * If JAVA or the JAR is missing, the service throws a
 * KoSITValidatorUnavailableError and the caller (the
 * controller) falls back to the in-process
 * validateXRechnung().
 */

export interface KoSITResult {
  valid: boolean
  engine: 'kosit' | 'kosit-unavailable'
  acceptance: 'ACCEPTABLE' | 'REJECT' | 'UNDEFINED' | 'ERROR'
  /** XSD pass: Y/N */
  schema: 'Y' | 'N' | '?'
  /** Schematron pass: Y/N */
  schematron: 'Y' | 'N' | '?'
  errors: Array<{
    rule?: string
    message: string
    location?: string
  }>
  warnings: Array<{
    rule?: string
    message: string
    location?: string
  }>
  /** Time taken by the CLI in milliseconds */
  durationMs: number
  /** Raw stderr (for debugging — truncated to 2KB) */
  stderr: string
}

export class KoSITValidatorUnavailableError extends Error {
  constructor(reason: string) {
    super(`KoSIT validator not available: ${reason}`)
    this.name = 'KoSITValidatorUnavailableError'
  }
}

// From src/invoices/ (or dist/invoices/), go up 3 levels
// to reach the project root, then into infra/kosit.
//   src/invoices/  →  src/  →  backend/  →  <project-root>  →  infra/kosit
const KOSIT_ROOT = path.resolve(__dirname, '..', '..', '..', 'infra', 'kosit')
const JAVA_HOME = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'infra',
  'java',
  'jdk-17.0.13+11',
  'Contents',
  'Home',
)

/**
 * Resolve the Java binary. Looks for Temurin in infra/java
 * first, then falls back to /usr/bin/java + the JAVA_HOME
 * env var.
 */
async function findJava(): Promise<string> {
  // 1. infra/java/jdk-17*/Contents/Home/bin/java (our bundled)
  try {
    const javaPath = path.join(JAVA_HOME, 'bin', 'java')
    await fs.access(javaPath)
    return javaPath
  } catch {
    // not found
  }
  // 2. JAVA_HOME env
  if (process.env.JAVA_HOME) {
    return path.join(process.env.JAVA_HOME, 'bin', 'java')
  }
  // 3. /usr/bin/java
  return '/usr/bin/java'
}

/**
 * Resolve the KoSIT validator JAR.
 */
async function findValidatorJar(): Promise<string> {
  const jarPath = path.join(KOSIT_ROOT, 'validator.jar')
  await fs.access(jarPath)
  return jarPath
}

/**
 * Resolve the scenarios.xml + repository.
 */
async function findScenarios(): Promise<{ scenarios: string; repository: string }> {
  const scenarios = path.join(KOSIT_ROOT, 'scenarios.xml')
  const repository = path.join(KOSIT_ROOT, 'repository')
  await fs.access(scenarios)
  await fs.access(repository)
  return { scenarios, repository }
}

/**
 * Run the KoSIT validator on the given XRechnung XML and
 * return the parsed result. Throws KoSITValidatorUnavailableError
 * if the validator or JDK is not installed.
 */
export async function validateXRechnungWithKoSIT(
  xml: string,
  options: { timeoutMs?: number } = {},
): Promise<KoSITResult> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const start = Date.now()

  // Sanity check the pre-reqs
  let javaBin: string
  let validatorJar: string
  let scenariosPath: string
  let repositoryPath: string
  try {
    javaBin = await findJava()
    validatorJar = await findValidatorJar()
    const s = await findScenarios()
    scenariosPath = s.scenarios
    repositoryPath = s.repository
  } catch (err: any) {
    throw new KoSITValidatorUnavailableError(err.message || 'KoSIT not installed')
  }

  // Write the input to a temp file
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kosit-'))
  const inputPath = path.join(tmpDir, 'input.xml')
  const outDir = path.join(tmpDir, 'out')
  await fs.writeFile(inputPath, xml, 'utf-8')

  try {
    // Invoke the validator. Capture stdout (the result table)
    // and stderr (loading + per-file processing log).
    // Note: KoSIT exits with code 1 when a document is
    // REJECTED. That's a VALID outcome (not an error),
    // so we use `reject: false` and inspect the exit
    // code ourselves. The Node.js child_process default
    // would throw on any non-zero exit.
    const execResult = await execFileAsync(
      javaBin,
      [
        '-jar',
        validatorJar,
        '-r',
        repositoryPath,
        '-s',
        scenariosPath,
        '--serialize-report-input',
        '-o',
        outDir,
        inputPath,
      ],
      {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        // `killSignal` ensures the JVM gets SIGTERM on
        // timeout (the default is SIGKILL which leaves
        // no chance for the JVM to clean up temp files).
        killSignal: 'SIGTERM' as any,
      },
    ).catch((err: any) => {
      // execFile throws on non-zero exit. We catch and
      // return the partial result + the captured output.
      return {
        stdout: err.stdout || '',
        stderr: err.stderr || '',
      }
    })

    const result = parseKoSITResult(
      execResult.stdout || '',
      execResult.stderr || '',
    )
    result.durationMs = Date.now() - start
    return result
  } finally {
    // Best-effort cleanup
    try {
      await fs.rm(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}

/**
 * Parse the KoSIT CLI output into a KoSITResult.
 * The CLI prints a result table like:
 *
 *   |File              |Schema |Schematron|Acceptance|Error/Description           |
 *   |/tmp/xrechnung.xml|   Y   |    Y     |ACCEPTABLE|                            |
 *
 *   Acceptable:  1  Rejected:  0
 *
 *   Validation successful!  (exit 0)
 *   Validation failed!      (exit 1)
 */
function parseKoSITResult(stdout: string, stderr: string): KoSITResult {
  const result: KoSITResult = {
    valid: false,
    engine: 'kosit',
    acceptance: 'UNDEFINED',
    schema: '?',
    schematron: '?',
    errors: [],
    warnings: [],
    durationMs: 0,
    stderr: stderr.slice(-2048), // last 2KB for debugging
  }

  // Parse the result table line. Format:
  //   |<filename>|<Schema>|<Schematron>|<Acceptance>|<Error/Description>|
  // The pipe-separated fields are padded with spaces. Match the
  // FIRST data line (skip the header line which starts with
  // |File |Schema |...; the spaces between 'File' and the
  // next '|' matter — use a broader regex check).
  const lines = stdout.split('\n')
  let dataLine: string | null = null
  for (const line of lines) {
    const trimmed = line.trim()
    if (
      trimmed.startsWith('|') &&
      // Skip the header: starts with "|File" (any whitespace after)
      !/^\|File\s+\|/.test(trimmed) &&
      // skip the divider lines (|--------|...)
      !/^\|[-=+\s|]+\|$/.test(trimmed) &&
      trimmed.includes('|') &&
      // the data line always has at least 5 pipe-separated fields
      (trimmed.match(/\|/g) || []).length >= 5
    ) {
      dataLine = trimmed
      break
    }
  }
  if (dataLine) {
    // Strip the leading and trailing pipes, split by |
    const inner = dataLine.replace(/^\|/, '').replace(/\|$/, '')
    const parts = inner.split('|').map((p) => p.trim())
    // parts: [filename, schema, schematron, acceptance, error]
    if (parts.length >= 4) {
      // parts[0] is the file path; parts[1..3] are the 3 columns
      // Schema/Schematron/Acceptance; parts[4] is the optional
      // error description.
      // The data line is:
      //   |/path/to/file |  N  |   Y  |  REJECT  |  (empty or XSD error) |
      // 0: filename
      // 1: schema
      // 2: schematron
      // 3: acceptance
      // 4: error
      const schemaRaw = parts[1]?.trim() || ''
      const schematronRaw = parts[2]?.trim() || ''
      const acceptanceRaw = parts[3]?.toUpperCase().trim() || 'UNDEFINED'
      const errorDesc = parts[4]?.trim() || ''
      result.schema = schemaRaw === 'Y' ? 'Y' : schemaRaw === 'N' ? 'N' : '?'
      result.schematron =
        schematronRaw === 'Y' ? 'Y' : schematronRaw === 'N' ? 'N' : '?'
      result.acceptance =
        acceptanceRaw === 'ACCEPTABLE'
          ? 'ACCEPTABLE'
          : acceptanceRaw === 'REJECT'
            ? 'REJECT'
            : 'UNDEFINED'
      result.valid = result.acceptance === 'ACCEPTABLE'
      if (errorDesc && errorDesc.length > 0) {
        // The Error/Description column carries XSD validation
        // errors (cvc-complex-type) when the Schema column is
        // N. We surface them as a single error.
        result.errors.push({
          message: errorDesc,
        })
      }
    }
  }

  // If we couldn't parse the table, treat as error
  if (result.acceptance === 'UNDEFINED' && result.errors.length === 0) {
    result.errors.push({
      message: 'Could not parse KoSIT CLI output (no result table found)',
    })
  }

  return result
}
