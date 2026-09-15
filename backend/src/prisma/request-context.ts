import { AsyncLocalStorage } from 'async_hooks'

/**
 * Who made a change and from where — read by the audit-log extension.
 *
 * Tier 384: this was a process global set by a main.ts middleware and cleared
 * on response finish. Node serves requests concurrently, so every request that
 * arrived while another one was awaiting the database replaced the global, and
 * every response that finished cleared it for the ones still running. Measured
 * with two tenants each sending 40 concurrent customer updates: of company A's
 * audit rows, 8 carried company B and B's user and 19 had no company; B's
 * `GET /audit-logs` listed those 8 rows — A's customer data, attributed to B.
 * AsyncLocalStorage keeps one context per request through its awaits.
 *
 * Background jobs and CLI scripts run outside any request: the context is
 * absent and the audit row has no user, as before.
 */
export interface RequestContext {
  userId: string | null
  companyId: string | null
  ipAddress: string | null
  userAgent: string | null
}

const storage = new AsyncLocalStorage<RequestContext>()

export const runWithRequestContext = <T>(
  ctx: { userId?: string | null; companyId?: string | null; ipAddress?: string | null; userAgent?: string | null },
  fn: () => T,
): T =>
  storage.run(
    {
      userId: ctx.userId ?? null,
      companyId: ctx.companyId ?? null,
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
    },
    fn,
  )

export const getRequestContext = (): RequestContext | undefined => storage.getStore()
