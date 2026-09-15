import { BadRequestException } from '@nestjs/common'
import { isIP } from 'net'
import { lookup } from 'dns/promises'

/**
 * Tier 391 — one SSRF guard for every place that takes a URL from the client
 * and later fetches it (webhook delivery, FinTS endpoint). Two ad-hoc checks
 * existed before (webhook.service.ts, fints.controller.ts); each had gaps.
 * Measured against the webhook guard, all accepted (201): http://0.0.0.0/,
 * http://[::1]/, http://[::ffff:127.0.0.1]/, http://127.0.0.1.nip.io/ (a DNS
 * name that resolves to 127.0.0.1) and http://metadata.google.internal/.
 *
 * The guard has two layers:
 *   - assertPublicHttpUrl(): synchronous, on the client's value — protocol and,
 *     when the host is an IP literal, the address range. Immediate 400.
 *   - assertHostResolvesPublic(): resolves the hostname (DNS) and checks every
 *     returned address, run just before the fetch so a name that resolved
 *     public at create time but private at delivery time (rebinding) is still
 *     caught. Callers must also disable redirect following (a public host can
 *     otherwise 302 into the internal network).
 */

/** Turn an address into its bytes: 4 for IPv4, 16 for IPv6, or null. */
function addrBytes(addr: string): number[] | null {
  const fam = isIP(addr)
  if (fam === 4) return addr.split('.').map((o) => parseInt(o, 10))
  if (fam === 6) {
    let s = addr
    // An IPv4-mapped / -compatible tail (::ffff:127.0.0.1) — expand it to hex.
    const v4 = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/)
    if (v4) {
      const o = v4[1].split('.').map((n) => parseInt(n, 10))
      s = s.slice(0, v4.index) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16)
    }
    const halves = s.split('::')
    const head = halves[0] ? halves[0].split(':') : []
    const tail = halves.length > 1 && halves[1] ? halves[1].split(':') : []
    const missing = 8 - head.length - tail.length
    const groups = [...head, ...Array(Math.max(0, missing)).fill('0'), ...tail]
    if (groups.length !== 8) return null
    const bytes: number[] = []
    for (const g of groups) {
      const v = parseInt(g || '0', 16)
      bytes.push((v >> 8) & 0xff, v & 0xff)
    }
    return bytes
  }
  return null
}

/**
 * True for loopback, private, link-local (incl. cloud metadata 169.254.169.254),
 * CGNAT, and unspecified addresses in both families, and their IPv4-mapped IPv6
 * forms. Not a literal IP → false (a hostname; resolve it first).
 */
export function isPrivateAddress(addr: string): boolean {
  const b = addrBytes(addr)
  if (!b) return false
  if (b.length === 16) {
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) → judge as IPv4.
    const mapped = b.slice(0, 10).every((x) => x === 0) && (b[10] === 0xff && b[11] === 0xff || b[10] === 0 && b[11] === 0)
    if (mapped) return isPrivateV4(b.slice(12))
    if (b.every((x) => x === 0)) return true // ::
    if (b[0] === 0 && b[1] === 0 && b.slice(2, 15).every((x) => x === 0) && b[15] === 1) return true // ::1
    if ((b[0] & 0xfe) === 0xfc) return true // fc00::/7 unique-local
    if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true // fe80::/10 link-local
    return false
  }
  return isPrivateV4(b)
}

function isPrivateV4(o: number[]): boolean {
  const [a, b] = o
  if (a === 0) return true // 0.0.0.0/8 (incl. 0.0.0.0 = "this host")
  if (a === 10) return true
  if (a === 127) return true // loopback
  if (a === 169 && b === 254) return true // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  return false
}

/**
 * Protocol + IP-literal range check on the raw value. Throws BadRequestException.
 * Node's URL parser already normalizes decimal / octal / hex IPv4
 * (http://2130706433 → 127.0.0.1), so those reach isPrivateAddress as dotted quads.
 */
export function assertPublicHttpUrl(
  raw: string,
  opts: { requireHttps?: boolean; label?: string } = {},
): URL {
  const label = opts.label ?? 'URL'
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new BadRequestException(`${label} ist keine gültige URL`)
  }
  const allowed = opts.requireHttps ? ['https:'] : ['http:', 'https:']
  if (!allowed.includes(url.protocol)) {
    throw new BadRequestException(
      opts.requireHttps ? `${label} muss HTTPS sein` : `${label} muss http(s) sein`,
    )
  }
  // Credentials in the URL (http://user:pass@host) are a common bypass/confusion vector.
  if (url.username || url.password) {
    throw new BadRequestException(`${label} darf keine Zugangsdaten enthalten`)
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  // Reserved private-use TLDs: localhost, mDNS .local, and ICANN's .internal —
  // these never name a public host, so reject them statically without DNS.
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new BadRequestException(`${label} darf nicht auf einen internen Host zeigen`)
  }
  if (isIP(host) && isPrivateAddress(host)) {
    throw new BadRequestException(
      `${label} darf nicht auf eine lokale/private Adresse zeigen`,
    )
  }
  return url
}

/**
 * Resolve the hostname and reject if any resolved address is private. For an IP
 * literal, re-checks the literal. Throws BadRequestException. Call this right
 * before fetching, and fetch with redirects disabled.
 */
export async function assertHostResolvesPublic(
  hostname: string,
  label = 'URL',
  opts: { allowUnresolved?: boolean } = {},
): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new BadRequestException(`${label} darf nicht auf eine lokale/private Adresse zeigen`)
    }
    return
  }
  let addrs: { address: string }[]
  try {
    addrs = await lookup(host, { all: true })
  } catch {
    // Create time (allowUnresolved): a transient / prod-only name is left to the
    // delivery-time check rather than blocking a legitimate webhook. Delivery
    // time: a name that will not resolve cannot be delivered to anyway.
    if (opts.allowUnresolved) return
    throw new BadRequestException(`${label}: Host konnte nicht aufgelöst werden`)
  }
  if (addrs.some((a) => isPrivateAddress(a.address)) || (!opts.allowUnresolved && addrs.length === 0)) {
    throw new BadRequestException(`${label} darf nicht auf eine lokale/private Adresse zeigen`)
  }
}
