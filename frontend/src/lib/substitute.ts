/**
 * Template variable substitution.
 *
 * Replaces {key} placeholders in a string with values
 * from a vars object. Missing keys are replaced with an
 * empty string (NOT "undefined" or "[object Object]") so
 * the email body never shows a raw key or broken text.
 *
 * Example:
 *   substitute("Hi {name}, your code is {code}", {
 *     name: "Anna",
 *     // 'code' missing
 *   }) → "Hi Anna, your code is "
 *
 * Used by the email template preview in the invoice
 * detail page (frontend) and is the same algorithm the
 * backend uses (see mail/templates/invoice-email.template.ts).
 * Keeping the two in sync is enforced by the e2e test
 * which compares the rendered output for an identical
 * invoice + locale combination.
 */
export function substitute(
  template: string,
  vars: Record<string, string | number | null | undefined>,
): string {
  return template.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const v = vars[key]
    if (v === undefined || v === null) return ""
    return String(v)
  })
}
