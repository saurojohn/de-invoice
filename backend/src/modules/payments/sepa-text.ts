/**
 * Tier 976 — what pain.001.001.09 (and pain.008) allow: an EndToEndId of at
 * most 35 characters (Max35Text) and a name of at most 70 (EPC rulebook).
 * The file carried `E2E-<uuid>` (40) and names in full; the bank refuses it
 * whole — while the bills were already marked paid on the execution day.
 */
export function sepaEndToEndId(id: string): string {
  return ('E2E' + String(id).replace(/-/g, '')).slice(0, 35)
}
export function sepaName(name: string | null | undefined): string {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 70)
}
