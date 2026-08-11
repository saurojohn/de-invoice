import http from 'k6/http'
import { check, sleep } from 'k6'

const BASE = 'http://localhost:3001'

export const options = {
  vus: 1,
  iterations: 3,
}

export default function () {
  const h = http.get(`${BASE}/api/v1/health`)
  console.log('health status:', h.status, 'body:', h.body ? h.body.slice(0, 100) : 'no body')

  const lr = http.post(
    `${BASE}/api/v1/auth/login`,
    JSON.stringify({ email: 'info@shleder.de', password: 'Test1234!' }),
    { headers: { 'Content-Type': 'application/json' } },
  )
  console.log('login status:', lr.status, 'body:', lr.body ? lr.body.slice(0, 200) : 'no body')
  sleep(1)
}
