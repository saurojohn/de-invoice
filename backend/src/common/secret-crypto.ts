import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'

/**
 * Tier 630 — a secret a company hands over (its SMTP password) is not kept
 * in the database as it was typed.
 *
 * AES-256-GCM under the installation's key — the same `FINTS_PIN_ENC_KEY`
 * that protects the FinTS PINs (one key to set and to keep; it is never
 * rotated, see infra/prod/SECURITY.md). A sealed value is the string
 *   enc:v1:<iv>:<tag>:<ciphertext>      (each base64)
 * so it fits the column the plain value had, and a value from before this
 * tier — or from an installation without the key — is read as it is.
 */
const PREFIX = 'enc:v1:'

const key = (): Buffer | null => {
  const env = process.env.FINTS_PIN_ENC_KEY
  return env ? createHash('sha256').update(env).digest() : null
}

export const secretEncryptionAvailable = (): boolean => key() !== null
export const isSealed = (stored: string | null | undefined): boolean => typeof stored === 'string' && stored.startsWith(PREFIX)

/** seals a secret — or returns it as it is when the installation has no key */
export function sealSecret(plain: string): string {
  const k = key()
  if (!k || !plain || isSealed(plain)) return plain
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', k, iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return `${PREFIX}${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ct.toString('base64')}`
}

/**
 * opens a stored secret. A plain value is returned as it is. A sealed one
 * that cannot be opened — no key, another key, a damaged value — gives null:
 * the caller has no password then, and says so.
 */
export function openSecret(stored: string | null | undefined): string | null {
  if (!stored) return stored ?? null
  if (!isSealed(stored)) return stored
  const k = key()
  const [iv, tag, ct] = stored.slice(PREFIX.length).split(':')
  if (!k || !iv || !tag || !ct) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}
