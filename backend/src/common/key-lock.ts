import { AsyncLocalStorage } from 'node:async_hooks'
import { ConflictException } from '@nestjs/common'

/**
 * Tier 534 — one request at a time per booked thing.
 *
 * The services read, decide and write in separate statements. Measured with
 * the same request sent six times at once: an invoice issued six times took
 * its stock five times over (10 → −5); one bank credit of 119 € matched to
 * two invoices in parallel paid both (238 €); six credit notes for one
 * invoice answered 500 five times (the voucher number collided).
 *
 * `withKeyLock(key, fn)` runs `fn` alone for its key (`invoice:<id>`,
 * `banktxn:<id>`, `customer:<id>`, `voucher:<companyId>`). It is re-entrant
 * within one request (issuing an invoice records a payment on the same
 * invoice), and waits at most `WAIT_MS` — then 409, so that two requests
 * taking two keys in opposite order end in an answer instead of hanging.
 *
 * In-process: the backend runs as one instance (infra/prod/docker-compose).
 * More than one instance would need the lock in the database
 * (pg_advisory_xact_lock, as the audit chain does).
 */
const held = new AsyncLocalStorage<Set<string>>()
const tails = new Map<string, Promise<void>>()
const WAIT_MS = 30_000

export async function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const mine = held.getStore()
  if (mine?.has(key)) return fn()

  const before = tails.get(key) ?? Promise.resolve()
  let release!: () => void
  const done = new Promise<void>((resolve) => (release = resolve))
  const tail = before.then(() => done)
  tails.set(key, tail)

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), WAIT_MS)
  })
  const turn = await Promise.race([before.then(() => 'go' as const), timeout])
  if (timer) clearTimeout(timer)
  if (turn === 'timeout') {
    // Give the place in the queue back: the next waiter follows `before`.
    before.then(release)
    throw new ConflictException(
      'Dieser Vorgang wird gerade von einer anderen Anfrage bearbeitet — bitte gleich noch einmal versuchen.',
    )
  }
  try {
    return await held.run(new Set([...(mine ?? []), key]), fn)
  } finally {
    release()
    if (tails.get(key) === tail) tails.delete(key)
  }
}
