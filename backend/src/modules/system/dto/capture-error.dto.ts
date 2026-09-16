import { IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator'

/**
 * Tier 392 — body of the PUBLIC POST /system/errors (frontend crash capture).
 *
 * The handler took `any`. Measured unauthenticated against the running backend:
 *   - 5 posts with random `fingerprint` → 5 ErrorEvent rows, each firing an
 *     operator notification (pushErrorNotification runs on every new row);
 *   - `context: { pad: "A".repeat(2_000_000) }` → stored verbatim (2 000 011
 *     chars); the JSON body limit is 10 MB, so ~10 MB per row;
 *   - posting the fingerprint of an existing group rewrote that group's message
 *     and stack: "Echter Fehler: Zahlung fehlgeschlagen" became "Alles in
 *     Ordnung, bitte ignorieren" (occurrences 1 → 2).
 *
 * The fingerprint is no longer taken from the client at all — the service
 * computes it from source + message + first stack frame, which is what the
 * frontend's own hash approximated. The field stays here so an already-loaded
 * browser tab that still sends it does not get a 400 from
 * `forbidNonWhitelisted`; the value is ignored.
 */
export class CaptureErrorDto {
  // Optional on purpose: a body without a message keeps answering 200
  // {ok:true} (the handler drops it) so a broken client does not see a noisy
  // 400 in devtools — the behaviour e2e 21 test 14 pins.
  @IsOptional() @IsString() @MaxLength(4000)
  message?: string

  @IsOptional() @IsString() @MaxLength(8192)
  stack?: string

  @IsOptional() @IsString() @MaxLength(2048)
  url?: string

  // The stored union (ErrorKind). Any string was accepted and stored before.
  @IsOptional() @IsIn(['unhandled', 'boundary', 'manual', 'api'])
  kind?: 'unhandled' | 'boundary' | 'manual' | 'api'

  @IsOptional() @IsString() @MaxLength(200)
  component?: string

  @IsOptional() @IsString() @MaxLength(500)
  browser?: string

  @IsOptional() @IsIn(['error', 'warn', 'info', 'fatal'])
  level?: string

  /** Free-form, but bounded when stored — see CONTEXT_MAX_CHARS. */
  @IsOptional() @IsObject()
  context?: Record<string, unknown>

  /** Accepted for old clients, ignored — the server computes the fingerprint. */
  @IsOptional() @IsString() @MaxLength(128)
  fingerprint?: string

  /**
   * Accepted, ignored: the handler has always stored source="frontend" for this
   * route. Declared so callers that send it (Playwright tier205) are not
   * refused by forbidNonWhitelisted.
   */
  @IsOptional() @IsString() @MaxLength(50)
  source?: string
}

/** A crash context is diagnostic breadcrumbs, not a payload channel. */
export const CONTEXT_MAX_CHARS = 4000

/**
 * Keep the context only when it serialises small; otherwise store a marker so
 * the operator sees that something was dropped rather than silently losing it.
 */
export function boundContext(
  context: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!context) return undefined
  let json: string
  try {
    json = JSON.stringify(context)
  } catch {
    return { truncated: true, reason: 'context not serialisable' }
  }
  if (json.length <= CONTEXT_MAX_CHARS) return context
  return { truncated: true, bytes: json.length, preview: json.slice(0, 500) }
}
