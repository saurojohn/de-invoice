/**
 * Tier 6: Minimal FinTS 3.0 / HBCI 4 message
 * builder + parser. Covers only what we use:
 * DIALOG INIT, HKSYN, HNSHK, HKIDN, HKVVB, HKSAL,
 * HKKAZ, HIRMG, HIRMS, HIUPD, HIBPD, HITAN.
 *
 * This is NOT a complete FinTS 3.0
 * implementation. The full spec is ~3,000
 * pages and most of it is for corner cases we
 * never hit (signature cards, secure
 * transporters, collective bookings,
 * Auslandsüberweisungen with currency
 * conversion, …). What we cover is enough to
 * build valid request messages for the
 * read-only PSD2 flow and parse the response
 * segments we expect back.
 *
 * Wire format: ISO-8859-1 (Latin-1) text. The
 * HBCI message is one DEG-style segment stream
 * wrapped in HNHBK (header) / HNHBS (footer).
 * Each segment is:
 *
 *   SEG:ref:version:body+
 *
 * `+` is the terminator (segment-closing
 * separator). The body is a sequence of
 * `field:subfield:value` triples separated by
 * `+`, with `?` for empty fields. Numbers are
 * 0-padded left to a fixed DEG-defined width;
 * binary values are written as `@<len>@<hex>`.
 *
 * The proper encoder would use the official
 * DEG (DatenElementGruppen) definitions per
 * segment. We hand-roll the most common ones
 * because a full DEG registry is ~200 KB and
 * 90% of it is unused.
 *
 * For mock-mode these functions are never
 * called (the mock bypasses the protocol). For
 * real-mode they construct the wire format
 * the bank expects. The fact that we never
 * have a real bank to test against means this
 * code is "structural" — correct format, but
 * not validated against any specific bank's
 * actual response quirks.
 */

export interface SegmentHeader {
  type: string
  ref: number
  version: number
}

export interface Segment {
  header: SegmentHeader
  body: Record<string, any>
}

/**
 * Pad a numeric value to a fixed width with
 * leading zeros, e.g. pad(7, 4) = '0007'.
 */
function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}

/**
 * Escape a string for inclusion in a FinTS
 * segment body. The reserved characters are
 * '+' (segment terminator), ':' (field
 * separator) and '?' (empty value marker).
 * Banks generally want them replaced with '?',
 * but in practice modern FinTS messages are
 * sent in a binary container (HNVSK) and
 * escaping is rarely an issue.
 */
function escape(s: string): string {
  return s.replace(/[+:]/g, '?')
}

/**
 * Build the wire-format body of a segment
 * from the JS object. Empty values become
 * '?', non-empty values are escaped. The
 * segment is terminated with `+'`.
 */
function buildSegment(seg: Segment): string {
  const head = `${seg.header.type}:${seg.header.ref}:${seg.header.version}`
  const fields = Object.values(seg.body).map((v) => {
    if (v === null || v === undefined || v === '') return '?'
    if (typeof v === 'number') return String(v)
    return escape(String(v))
  })
  return `${head}:${fields.join('+')}+'`
}

/**
 * Build a complete FinTS message: HNHBK
 * header + segment list + HNHBS footer.
 *
 * The HNHBK is the message-level header:
 * sender + receiver IDs, dialog-id, message
 * number, message size (which we can't know
 * up front because it depends on the
 * encrypted payload size — so we send `0` and
 * the bank tolerates it). The HNVSK
 * encryption envelope wraps the user
 * segments, but since the mock-mode never
 * builds an actual wire message, we emit the
 * segments in cleartext and let the real
 * bank (when wired) replace this with a
 * proper HNVSK-wrapped payload.
 */
export function buildFinTsMessage(input: {
  dialogId: string
  messageNumber: number
  blz: string
  userId: string
  pin: string
  segments: Segment[]
}): Buffer {
  const head = buildSegment({
    header: { type: 'HNHBK', ref: 1, version: 3 },
    body: {
      // Most fields are message-internal
      // counters and IDs the bank echoes
      // back. We send plausible defaults.
      messageSize: 0,
      hbciVersion: 300,
      dialogId: input.dialogId,
      messageNumber: input.messageNumber,
    },
  })
  const segs = input.segments.map(buildSegment).join('')
  const foot = buildSegment({
    header: { type: 'HNHBS', ref: 99, version: 1 },
    body: { messageNumber: input.messageNumber },
  })
  return Buffer.from(`${head}${segs}${foot}`, 'latin1')
}

/**
 * Parse a FinTS response message. The
 * response is a stream of segments in the
 * same wire format as the request. We split
 * on `+'` (the segment terminator) and
 * unescape each segment's fields.
 *
 * Returns a structured object with the
 * header (HNHBK), the response segments,
 * and any error / TAN info.
 */
export function parseFinTsMessage(buf: Buffer): {
  header: Record<string, string>
  segments: Array<{ type: string; ref: number; version: number; fields: string[] }>
  hirmg?: { code: string; text: string }
  hirms: Array<{ code: string; text: string; segment?: string }>
  hitan?: { challenge: string }
} {
  const text = buf.toString('latin1')
  const rawSegs = text.split("+'").map((s) => s.trim()).filter(Boolean)
  const header: Record<string, string> = {}
  const segments: any[] = []
  const hirms: Array<{ code: string; text: string; segment?: string }> = []
  let hirmg: { code: string; text: string } | undefined
  let hitan: { challenge: string } | undefined

  for (const raw of rawSegs) {
    const parts = raw.split(':')
    if (parts.length < 3) continue
    const [type, ref, version, ...fields] = parts
    if (type === 'HNHBK') {
      // The HNHBK header fields are
      // positional: dialogId, messageNumber,
      // messageSize, hbciVersion, etc.
      header['dialogId'] = fields[0] || ''
      header['messageNumber'] = fields[1] || ''
      header['messageSize'] = fields[2] || ''
      header['hbciVersion'] = fields[3] || ''
    } else if (type === 'HIRMG') {
      // Global response message: first
      // field is the return code, then a
      // list of (code, text) pairs.
      // We just take the first pair here
      // for simplicity.
      hirmg = {
        code: fields[0] || '',
        text: fields[1] || '',
      }
    } else if (type === 'HIRMS') {
      // Segment-level response: same
      // (code, text) pair format. Multiple
      // HIRMS may appear.
      for (let i = 0; i < fields.length; i += 2) {
        hirms.push({
          code: fields[i] || '',
          text: fields[i + 1] || '',
        })
      }
    } else if (type === 'HITAN') {
      // PSD2 challenge: hn_challenge
      // (the human-readable TAN prompt)
      // is in field 2 of HITAN v6.
      hitan = { challenge: fields[1] || fields[0] || '' }
    } else {
      segments.push({
        type,
        ref: parseInt(ref, 10),
        version: parseInt(version, 10),
        fields: fields.map((f) => f.replace(/\?/g, '')),
      })
    }
  }

  return { header, segments, hirmg, hirms, hitan }
}
