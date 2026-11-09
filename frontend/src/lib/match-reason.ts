import { L } from "@/components/useI18n"

/**
 * Tier 818 — the reason a bank suggestion gives (bank-import.service.ts
 * `matchReason`, stored with the Zuordnung), in the page's language. The
 * backend writes it in English for the log and the specs: „amount 60 +
 * invoice# INV-2026-000001 in purpose + name match" stood in the German page
 * of the first-day drill. A part this does not know stays as it is.
 */
export function matchReasonText(reason: string | null | undefined): string {
  if (!reason) return ""
  return reason.split(" + ").map(part).join(" · ")
}

function part(p: string): string {
  let m: RegExpExecArray | null
  if ((m = /^amount (\d+)$/.exec(p))) {
    const score = Number(m[1])
    return score >= 60 ? L("Betrag stimmt") : score >= 35 ? L("Betrag bis auf Cent") : L("Betrag fast gleich")
  }
  if ((m = /^amount less (.+?) % Skonto( \(after its date\))?$/.exec(p))) {
    const late = m[2] ? " (" + L("nach der Skontofrist") + ")" : ""
    return L("Betrag abzüglich Skonto") + " " + m[1] + " %" + late
  }
  if ((m = /^one of (\d+) invoices named, together the amount$/.exec(p))) {
    return L("eine von mehreren genannten Rechnungen, zusammen der Betrag") + " (" + m[1] + ")"
  }
  if (p === "part payment") return L("Teilzahlung")
  if (p === "more than is open") return L("mehr als offen")
  if ((m = /^date ±(\d+)d$/.exec(p))) return L("Fälligkeit") + " ±" + m[1] + " " + L("Tage")
  if ((m = /^invoice# (.+) in purpose$/.exec(p))) return m[1] + " " + L("im Verwendungszweck")
  if (p === "name match") return L("Name passt")
  if ((m = /^purpose names (.+)$/.exec(p))) return L("Verwendungszweck nennt") + " " + m[1]
  if (p === "manual") return L("manuell")
  return p
}
