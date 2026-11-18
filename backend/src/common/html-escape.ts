/**
 * Tier 866 — text a person typed, put into the HTML part of an e-mail.
 *
 * The team invitation wrote the company's name into its HTML as it was. A
 * name is whatever the company's administrator typed — „<a href=…>Jetzt
 * bestätigen</a>“ became a link in a mail the installation sends to any
 * address. Everything typed goes through this before it is part of HTML.
 */
export function escapeHtml(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
