#!/usr/bin/env ts-node
/**
 * Tier 405 — measure how long the backend keeps an idle keep-alive socket.
 *
 * Opens one TCP connection, sends a single HTTP/1.1 request with keep-alive,
 * reads the response, then goes quiet and reports when (if ever) the server
 * closes the socket. That number has to be LONGER than any client that pools
 * connections to us — nginx's upstream `keepalive` (60 s by default) in
 * production, Playwright's request context in CI. If the server closes first,
 * the client can reuse a socket at the exact moment it dies: nginx answers
 * 502 "upstream prematurely closed connection", Playwright sees ECONNRESET.
 *
 * Usage: npx ts-node scripts/probe-keepalive.ts [host] [port] [waitSeconds]
 * Prints one line: `closed-after-ms=<n>` or `still-open-after-ms=<n>`.
 */
import * as net from 'net'

const host = process.argv[2] || '127.0.0.1'
const port = Number(process.argv[3] || 3001)
const waitMs = Number(process.argv[4] || 10) * 1000

const sock = net.connect({ host, port })
let answeredAt: number | null = null
let buf = ''

sock.on('connect', () => {
  sock.write(
    `GET /api/v1/health HTTP/1.1\r\nHost: ${host}\r\nConnection: keep-alive\r\n\r\n`,
  )
})
sock.on('data', (d: Buffer) => {
  buf += d.toString()
  if (answeredAt === null && buf.includes('\r\n\r\n')) answeredAt = Date.now()
})
const finish = (label: string) => {
  const since = answeredAt === null ? -1 : Date.now() - answeredAt
  console.log(`${label}=${since}`)
  process.exit(0)
}
sock.on('end', () => finish('closed-after-ms'))
sock.on('close', () => finish('closed-after-ms'))
sock.on('error', (e: Error & { code?: string }) => {
  console.log(`error=${e.code || e.message}`)
  process.exit(1)
})
setTimeout(() => finish('still-open-after-ms'), waitMs)
