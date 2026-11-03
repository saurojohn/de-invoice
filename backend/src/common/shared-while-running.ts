/**
 * Tier 788 — one computation for identical requests that arrive while it runs.
 *
 * The accounting page asks for the Bilanz, the Anhang, the E-Bilanz and the
 * UStJA at once; each of them computes the year's twelve monthly UStVA, so a
 * company's same twelve months were computed 48 times in parallel (5,6 s for
 * the page at 50 000 invoices). A request that finds the same computation
 * running takes its result instead of starting another.
 *
 * Only while nothing was written since it began: every write through Prisma
 * counts (`noteWrite`, prisma.service.ts), and a computation that started
 * before a write is not joined after it. So a shared result never misses a
 * write that finished before the joining request asked. In-process only — one
 * backend process is what this installation runs.
 */
let writeSeq = 0
const running = new Map<string, { seq: number; promise: Promise<unknown> }>()

export function noteWrite(): void {
  writeSeq++
}

export function shareWhileRunning<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const hit = running.get(key)
  if (hit && hit.seq === writeSeq) return hit.promise as Promise<T>
  const promise = compute().finally(() => {
    if (running.get(key)?.promise === promise) running.delete(key)
  })
  running.set(key, { seq: writeSeq, promise })
  return promise
}
