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
 *     every dump kept 24 hours, one a day for 30 days, one a week for
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
import { promises as fsp } from 'fs'
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
  /** Tier 727b: what the dumps take on disk — a hard-linked dump counted once */
  totalBytes: number
  disk: DiskSpace | null
  maxAgeHours: number
  ok: boolean
}

/** Tier 727b: the disk the backups are on */
export interface DiskSpace {
  totalBytes: number
  freeBytes: number
  freePercent: number
  /** below BACKUP_MIN_FREE_GB (default 2) or BACKUP_MIN_FREE_PERCENT (default 10) */
  low: boolean
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
  /** Tier 727b: the mirror and the earlier versions on disk */
  mirrorBytes: number
  versionsBytes: number
  disk: DiskSpace | null
  maxAgeHours: number
  ok: boolean
}

export interface MirrorResult {
  files: number
  copied: number
  versioned: number
  bytes: number
  /** Tier 731e: files that could not be read or copied this run (gone, no access) */
  skipped: number
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
      return { configured: !!dir, dir, latestAt: null, latestFile: null, latestSizeBytes: 0, ageHours: null, counts, totalBytes: 0, disk: null, maxAgeHours, ok: false }
    }
    let latest: { file: string; mtime: Date; size: number } | null = null
    const seen = new Set<string>()
    let totalBytes = 0
    for (const [key, sub] of TIERS) {
      const d = path.join(dir, sub)
      if (!fs.existsSync(d)) continue
      for (const name of fs.readdirSync(d)) {
        // <db>-<stamp>.sql.gz; <db>-latest.sql.gz is a link to one of them
        if (!/\.sql\.gz$/.test(name) || /-latest\.sql\.gz$/.test(name)) continue
        counts[key] += 1
        const st = fs.statSync(path.join(d, name))
        const inode = `${st.dev}:${st.ino}`
        if (!seen.has(inode)) { seen.add(inode); totalBytes += st.size }
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
      totalBytes,
      disk: diskSpace(dir),
      maxAgeHours,
      ok: ageHours != null && ageHours <= maxAgeHours,
    }
  }

  filesStatus(now = new Date()): FilesBackupStatus {
    const maxAgeHours = hoursEnv('BACKUP_FILES_MAX_AGE_HOURS', 3)
    const dir = this.filesDir
    const empty = { lastRunAt: null, ageHours: null, files: 0, bytes: 0, copiedLastRun: 0, versions: 0, mirrorBytes: 0, versionsBytes: 0 }
    if (!dir) return { configured: false, dir, ...empty, disk: null, maxAgeHours, ok: false }
    let run: { at?: string; files?: number; bytes?: number; copied?: number; versions?: number; mirrorBytes?: number; versionsBytes?: number } = {}
    try {
      run = JSON.parse(fs.readFileSync(path.join(dir, 'last-run.json'), 'utf8'))
    } catch {
      return { configured: true, dir, ...empty, disk: diskSpace(dir), maxAgeHours, ok: false }
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
      mirrorBytes: run.mirrorBytes ?? 0,
      versionsBytes: run.versionsBytes ?? 0,
      disk: diskSpace(dir),
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
    await fsp.mkdir(mirror, { recursive: true })
    const stamp = now.toISOString().replace(/[:.]/g, '-')
    let files = 0, copied = 0, versioned = 0, bytes = 0, skipped = 0
    // Tier 731e: asynchronous — the synchronous walk held every request of
    // every company while it copied — and file by file: a file that went
    // away between listing and copying (a temporary upload, a replaced logo)
    // ended the whole run, and the next freshness check called the file
    // backup stale.
    const walk = async (rel: string): Promise<void> => {
      let entries: fs.Dirent[]
      try {
        entries = await fsp.readdir(path.join(src, rel), { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const r = path.join(rel, e.name)
        if (e.isDirectory()) { await walk(r); continue }
        if (!e.isFile()) continue
        const from = path.join(src, r)
        const to = path.join(mirror, r)
        try {
          const st = await fsp.stat(from)
          files += 1
          bytes += st.size
          const prev = await fsp.stat(to).catch(() => null)
          if (prev && prev.size === st.size && Math.abs(prev.mtimeMs - st.mtimeMs) < 1000) continue
          await fsp.mkdir(path.dirname(to), { recursive: true })
          if (prev) {
            const old = path.join(versions, `${r}.${stamp}`)
            await fsp.mkdir(path.dirname(old), { recursive: true })
            await fsp.rename(to, old)
            versioned += 1
          }
          const tmp = `${to}.part-${process.pid}`
          await fsp.copyFile(from, tmp)
          await fsp.utimes(tmp, st.atime, st.mtime)
          await fsp.rename(tmp, to)
          copied += 1
        } catch (err) {
          skipped += 1
          this.logger.warn(`files backup: ${r} übersprungen (${(err as { code?: string }).code ?? (err as Error).message})`)
        }
      }
    }
    await walk('')
    const v = await sizeOf(versions)
    const m = await sizeOf(mirror)
    const result: MirrorResult = { files, copied, versioned, bytes, skipped, durationMs: Date.now() - t0 }
    const record = { at: now.toISOString(), files, bytes, copied, versioned, skipped, versions: v.files, versionsBytes: v.bytes, mirrorBytes: m.bytes, source: src }
    const tmp = path.join(dir, `last-run.json.part-${process.pid}`)
    await fsp.writeFile(tmp, JSON.stringify(record, null, 2))
    await fsp.rename(tmp, path.join(dir, 'last-run.json'))
    this.logger.log(`files backup: ${files} files (${bytes} B), ${copied} copied, ${versioned} earlier versions kept${skipped ? `, ${skipped} skipped` : ''}`)
    return result
  }
}

async function sizeOf(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0, bytes = 0
  const walk = async (d: string): Promise<void> => {
    let entries: fs.Dirent[]
    try { entries = await fsp.readdir(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.isFile()) {
        const st = await fsp.stat(p).catch(() => null)
        if (st) { files += 1; bytes += st.size }
      }
    }
  }
  await walk(dir)
  return { files, bytes }
}

/** Tier 727b: free space of the disk `dir` is on; null where it cannot be read */
export function diskSpace(dir: string): DiskSpace | null {
  try {
    const st = fs.statfsSync(dir)
    const totalBytes = st.blocks * st.bsize
    const freeBytes = st.bavail * st.bsize
    const freePercent = totalBytes > 0 ? Math.round((freeBytes / totalBytes) * 1000) / 10 : 0
    const minGb = hoursEnv('BACKUP_MIN_FREE_GB', 2)
    const minPct = hoursEnv('BACKUP_MIN_FREE_PERCENT', 10)
    return { totalBytes, freeBytes, freePercent, low: freeBytes < minGb * 1024 ** 3 || freePercent < minPct }
  } catch {
    return null
  }
}
