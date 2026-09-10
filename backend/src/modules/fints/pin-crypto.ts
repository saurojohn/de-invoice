/**
 * Tier 22: AES-256-GCM helpers for at-rest
 * encryption of sensitive fields (currently
 * just the FinTS PIN).
 *
 * Why AES-256-GCM rather than bcrypt/scrypt?
 *   - PIN needs to be reversible (banks use it
 *     for HMAC in the FinTS dialog). Hashing
 *     breaks the protocol.
 *   - GCM gives us authenticated encryption:
 *     any bit-flip in ciphertext fails the tag
 *     check, so we know the value is intact.
 *   - 256-bit key from FINTS_PIN_ENC_KEY env
 *     variable, hex-encoded. Missing key means
 *     real-mode is unavailable (the service
 *     throws at startup of the FintsReal path,
 *     NOT at boot — graceful degradation).
 *
 * Key handling:
 *   - 64 hex chars (32 bytes) → SHA-256 → 32-byte key
 *   - That's deterministic: same env value → same key
 *     across restarts, which is what we want (otherwise
 *     we'd need to re-encrypt every PIN on every deploy).
 *   - The env value never leaves the server process.
 *
 * Output shape:
 *   - iv:    12 random bytes, base64
 *   - tag:   16 bytes, base64
 *   - ciphertext: variable, base64
 *   All three are stored separately in the DB so we
 *   can swap encryption schemes without touching
 *   other tables.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto'

const ALGO = 'aes-256-gcm'
const IV_LEN = 12 // GCM standard

/**
 * Derive the 32-byte AES key from the env var.
 * Throws if the env var is missing — callers
 * must guard before calling.
 */
function deriveKey(envValue: string): Buffer {
  return createHash('sha256').update(envValue).digest()
}

function getKey(): Buffer {
  const env = process.env.FINTS_PIN_ENC_KEY
  if (!env) {
    throw new Error(
      'FINTS_PIN_ENC_KEY is not set — at-rest FinTS PIN encryption is unavailable. ' +
        'Set it to a 64-char hex string (or any 32+ char string) in backend/.env.',
    )
  }
  return deriveKey(env)
}

/**
 * Encrypt a plaintext PIN.
 * Returns { iv, tag, ciphertext } as base64 strings.
 */
export function encryptPin(plaintext: string): {
  iv: string
  tag: string
  ciphertext: string
} {
  const key = getKey()
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALGO, key, iv)
  const ct = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ct.toString('base64'),
  }
}

/**
 * Decrypt a stored PIN. Throws on tag mismatch
 * (which would indicate tampering or a wrong key).
 */
export function decryptPin(p: {
  iv: string
  tag: string
  ciphertext: string
}): string {
  const key = getKey()
  const decipher = createDecipheriv(
    ALGO,
    key,
    Buffer.from(p.iv, 'base64'),
  )
  decipher.setAuthTag(Buffer.from(p.tag, 'base64'))
  const pt = Buffer.concat([
    decipher.update(Buffer.from(p.ciphertext, 'base64')),
    decipher.final(),
  ])
  return pt.toString('utf8')
}

/**
 * True if the env var is set. Cheap check for
 * the "should we offer real-mode?" gate.
 */
export function pinEncryptionAvailable(): boolean {
  return !!process.env.FINTS_PIN_ENC_KEY
}