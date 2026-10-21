/**
 * Tier 727 — the backups of an installation, as the app sees them.
 *
 * The owner, 21.10.2026: „数据要实现能自动备份数据，按要求多久备份一次“.
 *
 * What the law asks (GoBD Rz. 103 ff., § 146 Abs. 4 / § 147 AO): the books
 * and the documents are kept so that they cannot be lost — readable for 8
 * (Buchungsbelege) or 10 years (Bücher, Jahresabschlüsse) — and a backup is
 * part of that; no interval is written into the law. The interval follows
 * from what may be lost: an invoice issued and sent and then gone is a gap
 * in the numbering and a document the customer holds that the books do not.
 * So:
 *
 *   - the database every hour (the backup container, compose `backup`):
 *     every dump kept 48 hours, one a day for 30 days, one a week for
 *     12 weeks, one a month for 10 years;
 *   - the files (kept invoice copies, receipts, attachments — the storage
 *     volume) every hour, into a mirror of their own (`BACKUP_FILES_DIR`):
 *     new and changed files are copied, nothing is deleted there, and a file
 *     that changed keeps its earlier version under `versions/`;
 *   - every hour a check that both are fresh — a backup that stopped is
 *     reported (scheduler red, an error event, the notification channels);
 *   - off-site: the optional compose service `offsite-backup` (profile
 *     `offsite`) copies both to a Hetzner Storage Box (rclone).
 *
 * Before this tier the backup container dumped the database once a day and
 * nothing copied the files unless a cron job was set up on the host by hand
 * (scripts/backup-prod.sh); the admin page read the development directory
 * and showed nothing of either.
 */
import { Injectable, Logger } from '@nestjs/common'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export interface DbBackupStatus {
  configured: boolean
  dir: string | null
  latestAt: string | null
  latestFile: string | null
  latestSizeBytes: number
  ageHours: number | null
  counts: { hourly: number; daily: number; weekly: number; monthly: number }
  maxAgeHours: number
  ok: boolean
}

export interface FilesBackupStatus {
  configured: boolean
  dir: string | null
  lastRunAt: string | null
  ageHours: number | null
  files: number
  bytes: number
  copiedLastRun: number
  versions: number
  maxAgeHours: number
  ok: boolean
}

export interface MirrorResult {
  files: number
  copied: number
  versioned: number
  bytes: number
  durationMs: number
}

const TIERS = [
  ['hourly', 'last'],
  ['daily', 'daily'],
  ['weekly', 'weekly'],
  ['monthly', 'monthly'],
] as const

function hoursEnv(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

@Injectable()
export class ProductionBackupsService {
  private readonly logger = new Logger(ProductionBackupsService.name)

  /** the backup container's volume (read only for the app); unset: not this installation */
  get dbDir(): string | null {
    return process.env.BACKUP_DB_DIR?.trim() || null
  }

  /** where the app mirrors the files; unset: no file backup by the app */
  get filesDir(): string | null {
    return process.env.BACKUP_FILES_DIR?.trim() || null
  }

  /** what is mirrored: the storage volume (kept copies, receipts, attachments) */
  get storageDir(): string {
    // as storage.service.ts resolves it
    return process.env.STORAGE_PATH || path.join(os.homedir(), 'data', 'invoice-system')
  }

  dbStatus(now = new Date()): DbBackupStatus {
    const maxAgeHours = hoursEnv('BACKUP_DB_MAX_AGE_HOURS', 3)
    const dir = this.dbDir
    const counts = { hourly: 0, daily: 0, weekly: 0, monthly: 0 }
    if (!dir || !fs.existsSync(dir)) {
      return { configured: !!dir, dir, latestAt: null, latestFile: null, latestSizeBytes: 0, ageHours: null, counts, maxAgeHours, ok: false }
    }
    let latest: { file: string; mtime: Date; size: number } | null = null
    for (const [key, sub] of TIERS) {
      const d = path.join(dir, sub)
      if (!fs.existsSync(d)) continue
      for (const name of fs.readdirSync(d)) {
        // <db>-<stamp>.sql.gz; <db>-latest.sql.gz is a link to one of them
        if (!/\.sql\.gz$/.test(name) || /-latest\.sql\.gz$/.test(name)) continue
        counts[key] += 1
        const st = fs.statSync(path.join(d, name))
        if (st.size > 0 && (!latest || st.mtime > latest.mtime)) latest = { file: `${sub}/${name}`, mtime: st.mtime, size: st.size }
      }
    }
    const ageHours = latest ? (now.getTime() - latest.mtime.getTime()) / 3_600_000 : null
    return {
      configured: true,
      dir,
      latestAt: latest ? latest.mtime.toISOString() : null,
      latestFile: latest?.file ?? null,
      latestSizeBytes: latest?.size ?? 0,
      ageHours: ageHours == null ? null : Math.round(ageHours * 100) / 100,
      counts,
      maxAgeHours,
      ok: ageHours != null && ageHours <= maxAgeHours,
    }
  }

  filesStatus(now = new Date()): FilesBackupStatus {
    const maxAgeHours = hoursEnv('BACKUP_FILES_MAX_AGE_HOURS', 3)
    const dir = this.filesDir
    const empty = { lastRunAt: null, ageHours: null, files: 0, bytes: 0, copiedLastRun: 0, versions: 0 }
    if (!dir) return { configured: false, dir, ...empty, maxAgeHours, ok: false }
    let run: { at?: string; files?: number; bytes?: number; copied?: number; versions?: number } = {}
    try {
      run = JSON.parse(fs.readFileSync(path.join(dir, 'last-run.json'), 'utf8'))
    } catch {
      return { configured: true, dir, ...empty, maxAgeHours, ok: false }
    }
    const at = run.at ? new Date(run.at) : null
    const ageHours = at && !isNaN(at.getTime()) ? (now.getTime() - at.getTime()) / 3_600_000 : null
    return {
      configured: true,
      dir,
      lastRunAt: at ? at.toISOString() : null,
      ageHours: ageHours == null ? null : Math.round(ageHours * 100) / 100,
      files: run.files ?? 0,
      bytes: run.bytes ?? 0,
      copiedLastRun: run.copied ?? 0,
      versions: run.versions ?? 0,
      maxAgeHours,
      ok: ageHours != null && ageHours <= maxAgeHours,
    }
  }

  /**
   * Copy what is new or changed in the storage volume into the mirror.
   * Nothing is deleted from the mirror (a document deleted by mistake stays
   * restorable); a file that changed keeps its earlier version under
   * `versions/<path>.<timestamp>`. Each copy is written to a temporary name
   * and renamed, so a half-written file is never taken for a backup.
   */
  async mirrorFiles(now = new Date()): Promise<MirrorResult> {
    const dir = this.filesDir
    if (!dir) throw new Error('BACKUP_FILES_DIR ist nicht gesetzt — keine Dateisicherung in dieser Installation')
    const src = this.storageDir
    const t0 = Date.now()
    const mirror = path.join(dir, 'mirror')
    const versions = path.join(dir, 'versions')
    fs.mkdirSync(mirror, { recursive: true })
    const stamp = now.toISOString().replace(/[:.]/g, '-')
    let files = 0, copied = 0, versioned = 0, bytes = 0
    const walk = (rel: string) => {
      const abs = path.join(src, rel)
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const r = path.join(rel, e.name)
        if (e.isDirectory()) { walk(r); continue }
        if (!e.isFile()) continue
        const from = path.join(src, r)
        const to = path.join(mirror, r)
        const st = fs.statSync(from)
        files += 1
        bytes += st.size
        let prev: fs.Stats | null = null
        try { prev = fs.statSync(to) } catch { prev = null }
        if (prev && prev.size === st.size && Math.abs(prev.mtimeMs - st.mtimeMs) < 1000) continue
        fs.mkdirSync(path.dirname(to), { recursive: true })
        if (prev) {
          const old = path.join(versions, `${r}.${stamp}`)
          fs.mkdirSync(path.dirname(old), { recursive: true })
          fs.renameSync(to, old)
          versioned += 1
        }
        const tmp = `${to}.part-${process.pid}`
        fs.copyFileSync(from, tmp)
        fs.utimesSync(tmp, st.atime, st.mtime)
        fs.renameSync(tmp, to)
        copied += 1
      }
    }
    walk('')
    const allVersions = countFiles(versions)
    const result: MirrorResult = { files, copied, versioned, bytes, durationMs: Date.now() - t0 }
    const record = { at: now.toISOString(), files, bytes, copied, versioned, versions: allVersions, source: src }
    const tmp = path.join(dir, `last-run.json.part-${process.pid}`)
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2))
    fs.renameSync(tmp, path.join(dir, 'last-run.json'))
    this.logger.log(`files backup: ${files} files (${bytes} B), ${copied} copied, ${versioned} earlier versions kept`)
    return result
  }
}

function countFiles(dir: string): number {
  let n = 0
  const walk = (d: string) => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(d, e.name))
      else if (e.isFile()) n += 1
    }
  }
  walk(dir)
  return n
}
