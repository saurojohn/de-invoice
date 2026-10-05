/**
 * Tier 532 — no NUL character reaches the database.
 *
 * PostgreSQL cannot store U+0000 in text ("invalid byte sequence for encoding
 * UTF8: 0x00"). Measured: `"name": "a\u0000b"` in any JSON body, or `%00` in
 * any search parameter, was a 500. No form produces one; a request that
 * carries it is refused as a whole (400) rather than repaired.
 */
function hasNul(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') return value.includes('\u0000')
  if (value === null || typeof value !== 'object' || depth > 12) return false
  if (Array.isArray(value)) return value.some((v) => hasNul(v, depth + 1))
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k.includes('\u0000') || hasNul(v, depth + 1)) return true
  }
  return false
}

export function noNulMiddleware(
  req: { url?: string; originalUrl?: string; body?: unknown },
  res: { status: (n: number) => { json: (b: unknown) => void } },
  next: () => void,
): void {
  const url = String(req.originalUrl ?? req.url ?? '')
  if (/%00/i.test(url) || url.includes('\u0000') || hasNul(req.body)) {
    res.status(400).json({ statusCode: 400, error: 'Bad Request', message: 'Die Anfrage enthält ein ungültiges Zeichen (NUL).' })
    return
  }
  next()
}
