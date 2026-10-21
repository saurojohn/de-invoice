"use client"
/**
 * Tier 724 — the payment term (Zahlungsziel) as a choice of days.
 *
 * Three pages had their own list (0 / 7 / 14 / 30 / 60, the settings also
 * 90). A term outside it — 21 days from an import, 45 days agreed with a
 * customer — showed as „Sofort fällig“ while the invoice was due in 21 days.
 * Common terms, and the current one whatever it is.
 */
import { useI18n } from "@/components/useI18n"

const COMMON = [0, 7, 10, 14, 21, 30, 45, 60, 90]

export function PaymentTermSelect({
  value,
  onChange,
  className = "w-full h-10 border rounded-md px-3",
  testId,
  id,
}: {
  value: number | null | undefined
  onChange: (days: number) => void
  className?: string
  testId?: string
  id?: string
}) {
  const { t } = useI18n()
  const current = Number(value ?? 0)
  const days = COMMON.includes(current) ? COMMON : [...COMMON, current].sort((a, b) => a - b)
  return (
    <select
      id={id}
      className={className}
      value={current}
      onChange={(e) => onChange(Number(e.target.value))}
      data-testid={testId}
    >
      {days.map((d) => (
        <option key={d} value={d}>
          {d === 0 ? t("paymentTerm.immediate") : t("paymentTerm.daysN", { days: d })}
        </option>
      ))}
    </select>
  )
}
