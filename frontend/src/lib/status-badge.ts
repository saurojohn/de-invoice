/**
 * Tier 718 — the colours of an invoice's status badge, light and dark.
 *
 * Draft and cancelled were a grey-800 box on the grey-800 table in dark mode,
 * the others light boxes on the dark page. One table for the invoice list and
 * the invoice page.
 */
const TONE = {
  gray: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-100",
  muted: "bg-gray-100 text-gray-500 dark:bg-gray-700/60 dark:text-gray-300",
  blue: "bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-200",
  green: "bg-green-100 text-green-700 dark:bg-green-900/60 dark:text-green-200",
  red: "bg-red-100 text-red-700 dark:bg-red-900/60 dark:text-red-200",
}

const BY_STATUS: Record<string, string> = {
  draft: TONE.gray,
  sent: TONE.blue,
  paid: TONE.green,
  overdue: TONE.red,
  cancelled: TONE.muted,
  offered: TONE.blue,
  accepted: TONE.green,
  declined: TONE.red,
  delivered: TONE.green,
  confirmed: TONE.green,
}

export function statusBadgeClass(status: string): string {
  return BY_STATUS[status] || TONE.gray
}
