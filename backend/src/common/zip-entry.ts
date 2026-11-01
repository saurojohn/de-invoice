/**
 * Tier 762 — a ZIP one entry at a time.
 *
 * `append` only queues: a loop over a year's documents held all of them in
 * memory until the archive had caught up, and the attachments are the larger
 * part of that. This waits until the entry has been written, so one document
 * is in memory at a time and a slow download slows the reading down.
 * `reader` is the response: when it closes, the wait must not outlive it.
 *
 * A PDF or a scan is compressed already: `store: true` keeps it as it is, and
 * spares a zlib stream per entry.
 */
export function appendAndWait(
  zip: any,
  data: Buffer | string,
  options: { name: string; store?: boolean },
  reader?: NodeJS.EventEmitter,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // The listeners go with the entry: one left on the reader would hold `data`.
    const off = () => {
      zip.off('entry', onEntry)
      zip.off('error', onError)
      reader?.off('close', onEntry)
    }
    const onEntry = () => { off(); resolve() }
    const onError = (e: Error) => { off(); reject(e) }
    zip.once('entry', onEntry)
    zip.once('error', onError)
    reader?.once('close', onEntry)
    zip.append(data, options)
  })
}
