/**
 * Quick smoke test — 10s, low concurrency, just to verify
 * the script runs without errors before launching the full
 * 5-minute Tier 172 load test.
 */
import http from 'k6/http'
import { check, sleep } from 'k6'

const BASE = __ENV.BASE || 'http://localhost:3001'

export const options = {
  vus: 2,
  duration: '5s',
  thresholds: {
    http_req_failed: ['rate<0.05'],
  },
}

export default function () {
  // Health
  const h = http.get(`${BASE}/api/v1/health`)
  check(h, { 'health 200': r => r.status === 200 })

  // Login
  const lr = http.post(
    `${BASE}/api/v1/auth/login`,
    JSON.stringify({ email: 'info@shleder.de', password: 'Test1234!' }),
    { headers: { 'Content-Type': 'application/json' } },
  )
  const ok = check(lr, { 'login 200': r => r.status === 200 })
  if (!ok) return
  const auth = {
    'Content-Type': 'application/json',
    'x-user-id': lr.json().id,
    'x-company-id': lr.json().companyId,
    'x-user-role': lr.json().role,
  }

  // Invoice list
  const l = http.get(
    `${BASE}/api/v1/invoices?companyId=ad257ec3-d319-479b-b870-3fe76e8f3111&page=1&pageSize=10`,
    { headers: auth },
  )
  check(l, { 'list 200': r => r.status === 200 })

  sleep(1)
}
