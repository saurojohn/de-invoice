#!/usr/bin/env node
/* global require, process, fetch, FormData, Blob, AbortSignal, console */
// Tier 756 — the receipt scanner of a running backend, through its own API.
//
//   node scripts/ci-ocr-check.js 201   a German receipt is read
//   node scripts/ci-ocr-check.js 503   no language data: the answer says so at once
//
// Run inside the production image (.github/workflows/docker-build.yml). The
// scanner used to fetch its language data from a CDN at the first scan after a
// start; with the CDN out of reach the scan hung, as did every later one.
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas')

const API = `http://localhost:${process.env.PORT || 3001}/api/v1`
const ORIGIN = String(process.env.FRONTEND_URL || '').split(',')[0]
const expected = Number(process.argv[2] || 201)
const LIMIT_MS = 30_000

function receipt() {
  GlobalFonts.registerFromPath('/app/assets/fonts/LiberationMono-Bold.ttf', 'Receipt')
  const canvas = createCanvas(1240, 700)
  const g = canvas.getContext('2d')
  g.fillStyle = '#fff'
  g.fillRect(0, 0, 1240, 700)
  g.fillStyle = '#000'
  g.font = '40px Receipt'
  const lines = ['Bäckerei Müller GmbH', '', 'Rechnung Nr. 2026-1047', 'Datum: 14.10.2026', '', 'MwSt 19%        19,00 EUR', 'Gesamtbetrag   119,00 EUR']
  lines.forEach((line, i) => g.fillText(line, 80, 90 + i * 80))
  return canvas.toBuffer('image/png')
}

async function main() {
  const email = `ocr-${Date.now()}@example.test`
  const reg = await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ email, password: 'Ocr-check-1', companyName: `${email} GmbH` }),
  })
  if (reg.status !== 201) throw new Error(`register: ${reg.status} ${await reg.text()}`)
  const body = await reg.json()
  const companyId = body.user.companyId || body.company.id
  const cookie = reg.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')

  const form = new FormData()
  form.append('file', new Blob([receipt()], { type: 'image/png' }), 'beleg.png')
  const started = Date.now()
  const res = await fetch(`${API}/ocr/scan?companyId=${companyId}`, {
    method: 'POST',
    headers: { cookie, 'x-company-id': companyId, origin: ORIGIN },
    body: form,
    signal: AbortSignal.timeout(LIMIT_MS),
  })
  const text = await res.text()
  console.log(`scan: ${res.status} in ${Date.now() - started} ms`)
  if (res.status !== expected) throw new Error(`expected ${expected}: ${text.slice(0, 300)}`)
  if (expected === 201) {
    const read = JSON.parse(text)
    if (read.grossAmount !== 119 || !/Bäckerei/.test(read.rawText)) throw new Error(`not read: ${text.slice(0, 300)}`)
  } else if (!/Belegerkennung/.test(text)) {
    throw new Error(`no word about the scanner: ${text.slice(0, 300)}`)
  }
}

main().catch((e) => {
  console.error(String(e))
  process.exit(1)
})
