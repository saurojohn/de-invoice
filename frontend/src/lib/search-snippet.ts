/**
 * Tier 867 — a search snippet is text with <mark> around the matches, and
 * nothing else, whatever the server sends.
 *
 * The snippets are rendered as HTML (dangerouslySetInnerHTML) for the marks.
 * The backend escapes the text first (search.service.ts markTermsInText), but
 * its fallback for a product matched only by its description sent the raw
 * name: a product called `<b onmouseover=…>` ran its script in the search box
 * of everyone in the company. Here every tag but <mark> becomes text again.
 */
export function safeSnippet(html: string | null | undefined): string {
  return String(html ?? "")
    .split(/(<\/?mark>)/)
    .map((part) => (part === "<mark>" || part === "</mark>" ? part : part.replace(/</g, "&lt;").replace(/>/g, "&gt;")))
    .join("")
}
