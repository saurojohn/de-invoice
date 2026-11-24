/**
 * A customer entered as a private person — a consumer for § 288 Abs. 1 / § 286 BGB
 * (reminder.service.ts) and no recipient of § 13b UStG (mandatory-details.ts, Tier 978).
 */
export function isConsumer(type: string | null | undefined): boolean {
  return ['individual', 'private', 'consumer', 'privat'].includes(String(type ?? '').toLowerCase())
}
