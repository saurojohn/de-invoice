/**
 * Tier 703: a customer no longer asks for a portal link with an e-mail
 * address (POST /customer-portal/request-session answers 403); the company
 * sends it — `admin/create-session`, the customer page's „Portal-Login
 * senden“. The specs that need a portal session take it the company's way;
 * the link the admin gets back carries the token (no reading of the backend
 * log any more).
 */
import { request } from '@playwright/test'
import { getTestEnv } from './test-env'

export async function portalTokenFor(api: string, customerId: string): Promise<{ status: number; token: string }> {
  const { userId, companyId } = getTestEnv()
  const ctx = await request.newContext()
  const res = await ctx.post(`${api}/api/v1/customer-portal/admin/create-session?companyId=${companyId}`, {
    headers: { 'x-user-id': userId, 'x-company-id': companyId, 'content-type': 'application/json' },
    data: { customerId },
  })
  let token = ''
  try {
    const data = await res.json()
    token = String(data?.url ?? '').match(/token=([0-9a-f]{64})/)?.[1] ?? ''
  } catch {
    // not JSON — the status says why
  }
  await ctx.dispose()
  return { status: res.status(), token }
}
