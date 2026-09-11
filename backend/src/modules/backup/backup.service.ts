/**
 * BackupService — Tier 120 admin backup management.
 *
 * Thin wrapper around the existing `scripts/backup.sh`
 * shell script (Tier 14). The script handles the actual
 * pg_dump + tar + rotation work; this service exposes
 * the result as a REST API so the admin UI can:
 *
 *   1. LIST existing backup stage directories under
 *      $BACKUP_ROOT (size, age, has-db, has-attachments).
 *   2. TRIGGER a manual backup (runs the script, awaits
 *      completion, returns the new stage dir).
 *   3. VERIFY a backup (docker exec pg_restore --list)
 *      — proves the file is a valid pg_dump.
 *   4. DELETE a backup (operator wants to free disk).
 *
 * Why a service (not a CLI call from the controller)?
 *   - Single source of truth for BACKUP_ROOT resolution
 *     (env var override, default path, e2e test path).
 *   - The same `runBackup()` is used by the auto-backup
 *     scheduler and the manual-trigger endpoint — no
 *     duplicate child_process.spawn() logic.
 *   - Health colour calculation lives here, next to the
 *     data model — no split between "what" and "how".
 *
 * Why a service (not direct DB)?
 *   - Backups are on disk, not in the database. The
 *     DB is the thing being backed up; a backup-record
 *     table would itself need to be in the DB.
 *   - The cron-health table already records every run
 *     (success/fail/duration) — that IS the audit trail.
 *     The on-disk files are the payload.
 */
import { Injectable, Logger } from '@nestjs/common'
import { execFile } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs'
import * as path from 'path'

const execFileAsync = promisify(execFile)

export interface BackupInfo {
  /** YYYY-MM-DD-HHMMSS, mirrors the stage dir name */
  id: string
  /** Absolute path to the stage dir */
  dir: string
  /** When the dir was last touched (rotation could
   *  rewrite mtime, so this is the file timestamp) */
  createdAt: Date
  /** Combined size of db.sql.gz + attachments.tar.gz */
  sizeBytes: number
  /** Absolute path to db.sql.gz, or null if missing */
  dbFile: string | null
  /** Size in bytes of the db file (0 if missing) */
  dbSizeBytes: number
  /** Absolute path to attachments.tar.gz, or null */
  attachmentsFile: string | null
  /** Size in bytes of the attachment file (0 if missing) */
  attachmentsSizeBytes: number
  /** db.sql.gz exists. The attachment archive is
   *  optional (skipped if no $ATTACHMENT_PATH dir),
   *  so "complete" really means "has the DB part". */
  isComplete: boolean
  /** Hours since createdAt. Used by the colour rule. */
  ageHours: number
}

export interface BackupRunResult {
  success: boolean
  /** Stage dir ID, or 'failed' on error */
  id: string
  sizeBytes: number
  durationMs: number
  /** Last 200 lines of script stdout/stderr. */
  log: string
}

export interface BackupVerifyResult {
  valid: boolean
  /** Number of TABLE entries pg_restore --list saw */
  tableCount: number
  error?: string
}

@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name)

  /** Resolved at construction. Override via env in tests. */
  private readonly backupRoot: string
  private readonly scriptPath: string
  private readonly dockerContainer: string

  constructor() {
    // Default mirrors scripts/backup.sh. The script
    // itself uses the same default, so when we spawn
    // it we only need to override BACKUP_ROOT (and we
    // do that via the `env` option of execFile).
    this.backupRoot =
      process.env.BACKUP_ROOT ||
      path.join(
        process.env.HOME || '/tmp',
        'data',
        'backups',
        'de-invoice',
      )
    // Resolve from this file (backend/src/modules/backup/)
    // up to the repo root, then into scripts/backup.sh.
    //   backup.service.ts
    //   ../ → modules/
    //   ../../ → backend/src/
    //   ../../../ → backend/
    //   ../../../../ → repo root
    this.scriptPath = path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'scripts',
      'backup.sh',
    )
    this.dockerContainer = process.env.BACKUP_DOCKER_CONTAINER || 'de-invoice-postgres'
  }

  /**
   * List all backup stage dirs under $BACKUP_ROOT,
   * sorted newest-first.
   *
   * "Stage dir" = the `backup-YYYY-MM-DD-HHMMSS/`
   * subdirectory the script creates per run. Each
   * contains the db.sql.gz + attachments.tar.gz
   * for that single backup, so the two are always
   * restored together (this matters for GoBD: a
   * partial restore without attachments is a Beleg
   * integrity violation).
   */
  async list(): Promise<BackupInfo[]> {
    if (!fs.existsSync(this.backupRoot)) {
      return []
    }
    const entries = fs.readdirSync(this.backupRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^backup-\d{4}-\d{2}-\d{2}/.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse()

    const result: BackupInfo[] = []
    for (const name of entries) {
      const dir = path.join(this.backupRoot, name)
      const id = name.replace(/^backup-/, '')
      const dbFile = path.join(dir, 'db.sql.gz')
      const attFile = path.join(dir, 'attachments.tar.gz')
      const dbExists = fs.existsSync(dbFile)
      const attExists = fs.existsSync(attFile)
      const dbSize = dbExists ? fs.statSync(dbFile).size : 0
      const attSize = attExists ? fs.statSync(attFile).size : 0
      // mtime of the dir itself is unreliable (rotation
      // and chmod change it). Use the db file mtime if
      // present, else the dir mtime.
      const refPath = dbExists ? dbFile : dir
      const stat = fs.statSync(refPath)
      result.push({
        id,
        dir,
        createdAt: stat.mtime,
        sizeBytes: dbSize + attSize,
        dbFile: dbExists ? dbFile : null,
        dbSizeBytes: dbSize,
        attachmentsFile: attExists ? attFile : null,
        attachmentsSizeBytes: attSize,
        isComplete: dbExists,
        ageHours: (Date.now() - stat.mtime.getTime()) / 3_600_000,
      })
    }
    return result
  }

  /**
   * Spawn `scripts/backup.sh` and wait for it to finish.
   * The script writes everything to $BACKUP_ROOT and
   * exits 0 on success / 1 on partial failure.
   *
   * We pass BACKUP_ROOT via env so the e2e test can
   * use a temp dir without polluting the user's real
   * backups. Everything else (DB connection, S3,
   * rotation) uses the script's own defaults.
   *
   * The script can take 30s-5min depending on DB size
   * and S3 upload. We give it a 10-minute timeout —
   * the controller layer doesn't need its own timeout
   * because the HTTP server's keep-alive handles
   * long-lived POSTs fine.
   */
  async runBackup(): Promise<BackupRunResult> {
    const t0 = Date.now()
    const beforeDirs = new Set(
      (await this.list()).map((b) => b.id),
    )
    try {
      const { stdout, stderr } = await execFileAsync(
        'bash',
        [this.scriptPath],
        {
          env: { ...process.env, BACKUP_ROOT: this.backupRoot },
          timeout: 600_000, // 10 min
          maxBuffer: 10 * 1024 * 1024,
        },
      )
      const durationMs = Date.now() - t0
      // The new stage dir = one whose ID wasn't in
      // the before set. Sort the after-list by mtime
      // and pick the top.
      const after = await this.list()
      const created = after.find((b) => !beforeDirs.has(b.id))
      return {
        success: true,
        id: created?.id ?? after[0]?.id ?? 'unknown',
        sizeBytes: created?.sizeBytes ?? 0,
        durationMs,
        log: tail((stdout + '\n' + stderr), 200),
      }
    } catch (e: any) {
      const durationMs = Date.now() - t0
      this.logger.error(`Backup run failed: ${e?.message}`)
      return {
        success: false,
        id: 'failed',
        sizeBytes: 0,
        durationMs,
        log: tail(
          (e?.stdout || '') + '\n' + (e?.stderr || '') + '\n' + (e?.message || ''),
          200,
        ),
      }
    }
  }

  /**
   * Verify a backup by:
   *   1. Reading the first 5 bytes (sanity: must be
   *      "PGDMP" — the pg_dump custom-format magic).
   *   2. If a docker container is running, docker cp
   *      the file in and run `pg_restore --list` to
   *      enumerate the tables. This proves the file
   *      is a syntactically valid pg_dump that the
   *      same Postgres version can read.
   *
   * Why docker cp + exec instead of just `pg_restore
   * --list` on the host? Because the de-invoice-postgres
   * container is the only Postgres with the right
   * version + locale + extension set; a host pg_restore
   * (if any) would be a different minor version and
   * could refuse the dump.
   */
  async verify(id: string): Promise<BackupVerifyResult> {
    const dir = path.join(this.backupRoot, `backup-${id}`)
    const dbFile = path.join(dir, 'db.sql.gz')
    if (!fs.existsSync(dbFile)) {
      return { valid: false, tableCount: 0, error: 'db.sql.gz not found' }
    }

    // Step 1: magic bytes
    const fd = fs.openSync(dbFile, 'r')
    try {
      const buf = Buffer.alloc(5)
      fs.readSync(fd, buf, 0, 5, 0)
      if (buf.toString('ascii') !== 'PGDMP') {
        return {
          valid: false,
          tableCount: 0,
          error: 'file does not start with PGDMP magic — not a pg_dump custom-format file',
        }
      }
    } finally {
      fs.closeSync(fd)
    }

    // Step 2: pg_restore --list inside the container
    const containerPath = `/tmp/verify-${id}.sql.gz`
    try {
      // Copy the file in. We use the absolute host path
      // (dbFile) which must be reachable by the docker
      // daemon — true for any path on the host filesystem.
      await execFileAsync('docker', [
        'cp',
        dbFile,
        `${this.dockerContainer}:${containerPath}`,
      ])
      try {
        const { stdout } = await execFileAsync(
          'docker',
          ['exec', this.dockerContainer, 'pg_restore', '--list', containerPath],
          { timeout: 60_000, maxBuffer: 5 * 1024 * 1024 },
        )
        // Each TOC entry line has the form:
        //   `<toc_id>; <oid> <namespace> TABLE <owner> ...`
        // e.g. `230; 1259 24727 TABLE public Account de_invoice`
        // So the TABLE keyword is preceded by exactly two
        // numbers (the OID and the namespace OID) after
        // the semicolon. Matching `\d+;\s*\d+\s+\d+\s+TABLE`
        // (three whitespace-separated numbers around a
        // semicolon) is the right heuristic — non-TABLE
        // entries (FUNCTION, INDEX, CONSTRAINT, COMMENT,
        // EXTENSION) all have different keywords in that
        // position. The `;`-anchored start also rules out
        // false matches from the free-form comment header
        // ("TOC Entries: 421").
        const matches = stdout.match(/\d+;\s*\d+\s+\d+\s+TABLE\b/g) || []
        return { valid: true, tableCount: matches.length }
      } finally {
        // Always clean up the staged file in the
        // container, even if pg_restore crashed.
        await execFileAsync('docker', [
          'exec',
          this.dockerContainer,
          'rm',
          '-f',
          containerPath,
        ]).catch(() => {
          /* best-effort */
        })
      }
    } catch (e: any) {
      return {
        valid: false,
        tableCount: 0,
        error: e?.message || String(e),
      }
    }
  }

  /**
   * Delete a backup stage dir. Recursive.
   * The auto-backup cron will simply re-create a new
   * one at the next tick; this is for the operator who
   * wants to free disk immediately (e.g. before
   * shipping the old volume to cold storage).
   */
  async delete(id: string): Promise<{ deleted: boolean; error?: string }> {
    const dir = path.join(this.backupRoot, `backup-${id}`)
    if (!fs.existsSync(dir)) {
      return { deleted: false, error: `backup ${id} not found` }
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      return { deleted: true }
    } catch (e: any) {
      return { deleted: false, error: e?.message }
    }
  }

  /**
   * Tier 195 — restore-drill. Picks the most-recent
   * backup, restores it into a throwaway database
   * `de_invoice_restore_drill`, counts the resulting
   * tables, then drops the database. The operator's
   * production `de_invoice` DB is never touched.
   *
   * This is the only way to be sure a backup actually
   * works end-to-end. pg_restore --list only checks
   * the TOC header; a real restore catches row
   * corruption, missing extensions, FK constraint
   * problems introduced by a schema change, etc.
   *
   * 200 → ok=true with a non-zero tableCount
   * 500 → ok=false with the error message (the
   *        throwaway DB is still dropped before we
   *        return, so we don't leak it).
   *
   * Idempotency: re-running while a previous drill
   * is in flight will fail at the CREATE DATABASE
   * step (database already exists). We DROP if
   * exists at the start to make the endpoint
   * re-runnable in practice.
   */
  async restoreDrill(): Promise<{
    ok: boolean
    dbName: string
    tableCount: number
    durationMs: number
    error?: string
  }> {
    const started = Date.now()
    const dbName = 'de_invoice_restore_drill'
    // Tier 359: drill the newest backup that actually contains the database.
    // This used to take all[0] unconditionally, so once dumps started failing
    // (a run that leaves a directory without db.sql.gz — see healthColor) the
    // drill answered "db.sql.gz not found" about the broken entry instead of
    // exercising the last backup that could really be restored, which is the
    // question the drill exists to answer.
    const all = await this.list()
    if (all.length === 0) {
      return {
        ok: false,
        dbName,
        tableCount: 0,
        durationMs: 0,
        error: 'no backups available to drill',
      }
    }
    const newest = all.find((b) => b.isComplete)
    if (!newest) {
      return {
        ok: false,
        dbName,
        tableCount: 0,
        durationMs: 0,
        error: `none of the ${all.length} backups contains db.sql.gz`,
      }
    }
    const dbFile = path.join(this.backupRoot, `backup-${newest.id}`, 'db.sql.gz')
    if (!fs.existsSync(dbFile)) {
      return {
        ok: false,
        dbName,
        tableCount: 0,
        durationMs: 0,
        error: `db.sql.gz not found in backup-${newest.id}`,
      }
    }
    // Stage the file in the postgres container.
    const containerPath = `/tmp/restore-drill-${newest.id}.sql.gz`
    try {
      await execFileAsync('docker', [
        'cp',
        dbFile,
        `${this.dockerContainer}:${containerPath}`,
      ])
      // Drop if exists (idempotent), then create
      // the throwaway database. The de_invoice
      // user needs CREATEDB privilege — production
      // setup grants it. We use the same
      // de_invoice user as a safety so we don't
      // accidentally touch the postgres superuser.
      await execFileAsync('docker', [
        'exec',
        this.dockerContainer,
        'psql',
        '-U',
        'de_invoice',
        '-d',
        'postgres',
        '-c',
        `DROP DATABASE IF EXISTS ${dbName};`,
      ])
      await execFileAsync('docker', [
        'exec',
        this.dockerContainer,
        'createdb',
        '-U',
        'de_invoice',
        dbName,
      ])
      // Run pg_restore into the throwaway DB.
      // The exit code is non-zero on warnings
      // (e.g. "errors ignored on restore" when
      // some rows violate a constraint) so we
      // don't fail on those — we just check the
      // resulting table count.
      await execFileAsync(
        'docker',
        [
          'exec',
          this.dockerContainer,
          'pg_restore',
          '-U',
          'de_invoice',
          '-d',
          dbName,
          '--no-owner',
          '--single-transaction',
          containerPath,
        ],
        { timeout: 5 * 60_000, maxBuffer: 50 * 1024 * 1024 },
      ).catch(() => {
        /* ignore — table count is the truth */
      })
      // Count the tables. A healthy restore
      // should land all schema tables.
      const { stdout: countOut } = await execFileAsync('docker', [
        'exec',
        this.dockerContainer,
        'psql',
        '-U',
        'de_invoice',
        '-d',
        dbName,
        '-tA',
        '-c',
        "SELECT count(*) FROM pg_tables WHERE schemaname = 'public';",
      ])
      const tableCount = Number(countOut.trim())
      return {
        ok: tableCount > 0,
        dbName,
        tableCount,
        durationMs: Date.now() - started,
      }
    } catch (e: any) {
      return {
        ok: false,
        dbName,
        tableCount: 0,
        durationMs: Date.now() - started,
        error: e?.message || String(e),
      }
    } finally {
      // Always drop the throwaway DB and clean up
      // the staged file, even on error. The
      // operator's prod DB is never touched.
      await execFileAsync('docker', [
        'exec',
        this.dockerContainer,
        'psql',
        '-U',
        'de_invoice',
        '-d',
        'postgres',
        '-c',
        `DROP DATABASE IF EXISTS ${dbName};`,
      ]).catch(() => {
        /* best-effort */
      })
      await execFileAsync('docker', [
        'exec',
        this.dockerContainer,
        'rm',
        '-f',
        containerPath,
      ]).catch(() => {
        /* best-effort */
      })
    }
  }

  /**
   * Best-effort health colour for the "last backup" card:
   *   - grey  no backup has ever been taken
   *   - red   last backup has no database dump (db.sql.gz missing)
   *   - red   last backup is older than 2 days (likely stuck)
   *   - amber last backup is 1-2 days old (warning)
   *   - green last backup is < 1 day old
   *
   * Why not 24h? A daily cron at 04:00 means the
   * gap between runs is up to 24h. Anything between
   * 24h and 48h is "the cron ran but the script
   * failed silently" territory. 48h+ is "the whole
   * pipeline is broken" territory.
   *
   * Tier 359 added the db.sql.gz rule. Age alone could not see the most
   * important failure: scripts/backup.sh still creates the stage directory
   * (and archives attachments) when pg_dump fails, so a fresh, complete-
   * looking entry with no database scored green. On one developer machine
   * that ran for five consecutive nights (2026-09-06..10) while the page
   * stayed green.
   */
  static healthColor(
    newest: BackupInfo | null,
  ): 'green' | 'amber' | 'red' | 'grey' {
    if (!newest) return 'grey'
    if (!newest.isComplete) return 'red'
    if (newest.ageHours > 48) return 'red'
    if (newest.ageHours > 24) return 'amber'
    return 'green'
  }
}

/**
 * Return the last N lines of a string. Used for the
 * log preview in the UI — the full script output can
 * be ~1000 lines, but the user only needs the tail
 * to see what went wrong.
 */
function tail(s: string, lines: number): string {
  const arr = s.split('\n')
  return arr.slice(Math.max(0, arr.length - lines)).join('\n')
}
