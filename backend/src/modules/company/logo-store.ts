import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * Tier 560 — a company's logo lives with the other uploaded files.
 *
 * It was written to `frontend/public/images/` next to the source tree, where
 * the Next.js dev server happens to serve it. In the compose deployment that
 * path is `/frontend/public/images` inside the BACKEND container: not a
 * volume, so every logo was gone after the next `docker compose up` (and the
 * invoice PDFs lost it), and not the frontend container's public directory,
 * so the settings page and the invoice preview never showed it at all.
 *
 * Now: `<STORAGE_PATH>/_logos/` (the `storage` volume), served by
 * GET /companies/logo/:name. Files from before are still found in the old
 * directory.
 */
const LOGO_NAME = /^logo-[0-9a-f]{8}-\d{10,}\.(png|jpe?g|gif|webp)$/i
const ANY_IMAGE = /\.(png|jpe?g|gif|webp)$/i

function storageRoot(): string {
  // the same rule as StorageService.getDefaultLocalPath
  return process.env.STORAGE_PATH || path.join(os.homedir(), 'data', 'invoice-system')
}

export function logoDir(): string {
  return path.join(storageRoot(), '_logos')
}

/** Where logos were kept before Tier 560 (backend/src/modules/company → project root). */
export function legacyLogoDir(): string {
  return path.resolve(__dirname, '..', '..', '..', '..', 'frontend', 'public', 'images')
}

export function isUploadedLogoName(name: string): boolean {
  return LOGO_NAME.test(name)
}

/** The file behind `Company.logoPath`, or null. Only the base name counts (Tier 544). */
export function findLogo(logoPath: string | null | undefined): string | null {
  const name = path.basename(String(logoPath || '').replace(/\\/g, '/'))
  if (!name || name === '.' || name === '..' || !ANY_IMAGE.test(name)) return null
  for (const dir of [logoDir(), legacyLogoDir()]) {
    const candidate = path.join(dir, name)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/** Best effort: remove a company's previous logo wherever it is. */
export function removeLogoFile(logoPath: string | null | undefined): void {
  const name = path.basename(String(logoPath || '').replace(/\\/g, '/'))
  if (!isUploadedLogoName(name)) return // only files this module wrote
  for (const dir of [logoDir(), legacyLogoDir()]) {
    try {
      const p = path.join(dir, name)
      if (fs.existsSync(p)) fs.unlinkSync(p)
    } catch {
      // a stray file is better than a failed upload
    }
  }
}
