#!/bin/bash
# Tier 863 — a webhook connects only to the address that was checked
#
# Security audit (18.11.2026), item 12. Before a delivery the host name was
# resolved and every address checked (no loopback, private, link-local or
# cloud-metadata address) — then `fetch` resolved the name a second time to
# connect. A name under an attacker's control with a TTL of 0 answers a
# public address to the first question and 127.0.0.1 to the second (DNS
# rebinding): the check passed, the POST went inside the server's network,
# and its answer was stored and shown in the deliveries drawer.
#
# Now the connection's own lookup is checked (common/ssrf-guard.ts
# publicOnlyLookup / postToPublicUrl). Measured here with a resolver that
# answers like such a name, against a server listening on 127.0.0.1.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"
SRC="$SCRIPT_DIR/../src"

OUT=$(cd "$SCRIPT_DIR/.." && ./node_modules/.bin/ts-node -T -e "
import * as http from 'http'
import { publicOnlyLookup, postToPublicUrl, assertHostResolvesPublic } from './src/common/ssrf-guard'
const server = http.createServer((req, res) => { hits++; res.end('inside') })
let hits = 0
// answers like an attacker's name: public to the first question, 127.0.0.1 to every later one
let asked = 0
const rebinding = (_h: string, o: any, cb: any) => { asked++; const a = asked === 1 ? '93.184.216.34' : '127.0.0.1'; o.all ? cb(null, [{ address: a, family: 4 }]) : cb(null, a, 4) }
server.listen(0, '127.0.0.1', async () => {
  const port = (server.address() as any).port
  const url = 'http://rebind.example.test:' + port + '/hook'
  const lines: string[] = []
  // 1. the old way: a check, then a connection with a lookup of its own
  asked = 0
  const first = await new Promise<string>((r) => rebinding('rebind.example.test', { all: true }, (_e: any, a: any) => r(a[0].address)))
  lines.push('check saw ' + first)
  await new Promise<void>((r) => { const q = http.request(url, { method: 'POST', lookup: rebinding as any }, (res) => { res.resume(); res.on('end', () => r()) }); q.on('error', () => r()); q.end('{}') })
  lines.push('old: inside hits=' + hits)
  // 2. now: the connection's lookup is the one checked
  hits = 0; asked = 1
  try {
    await postToPublicUrl(url, { headers: {}, body: '{}', timeoutMs: 3000, lookup: publicOnlyLookup(rebinding as any) })
    lines.push('new: delivered')
  } catch (e: any) { lines.push('new: refused ' + (e.code || '') + ' hits=' + hits) }
  // 3. a public answer passes through unchanged
  const pub = await new Promise<string>((r) => publicOnlyLookup(((_h: string, _o: any, cb: any) => cb(null, [{ address: '93.184.216.34', family: 4 }])) as any)('x', {}, (e: any, a: any) => r(e ? 'error' : a)))
  lines.push('public: ' + pub)
  // 4. a 302 is answered as it is, not followed; the answer is capped
  const red = http.createServer((_q, res) => { res.writeHead(302, { location: 'http://127.0.0.1:1/' }); res.end('x'.repeat(500000)) })
  red.listen(0, '127.0.0.1', async () => {
    const p2 = (red.address() as any).port
    const ok = (_h: string, o: any, cb: any) => o.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)
    const r = await postToPublicUrl('http://red.example.test:' + p2 + '/', { headers: {}, body: '{}', timeoutMs: 3000, lookup: ok as any })
    lines.push('redirect: ' + r.statusCode + ' body=' + r.body.length)
    red.close(); server.close()
    console.log(lines.join('\n'))
  })
})
" 2>&1)
assert_eq "the old way: the check saw a public address…" "$(sed -n 1p <<<"$OUT")" "check saw 93.184.216.34"
assert_eq "…and the connection went to 127.0.0.1" "$(sed -n 2p <<<"$OUT")" "old: inside hits=1"
assert_eq "now: the connection's own lookup is checked — refused, nothing reached" "$(sed -n 3p <<<"$OUT")" "new: refused EPRIVATEADDR hits=0"
assert_eq "a public address passes through" "$(sed -n 4p <<<"$OUT")" "public: 93.184.216.34"
assert_eq "a redirect is answered as it is (not followed); the answer is capped at 256 KiB" "$(sed -n 5p <<<"$OUT")" "redirect: 302 body=262144"

note "=== the delivery uses it ==="
BODY=$(awk '/private async postJson\(/,/^  }$/' "$SRC/modules/webhook/webhook.service.ts")
assert_eq "postJson posts through postToPublicUrl, not fetch" \
  "$(grep -c 'postToPublicUrl(url' <<<"$BODY")/$(grep -c 'fetch(' <<<"$BODY")" "1/0"
summary
