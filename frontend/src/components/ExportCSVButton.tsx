"use client"

import { Button } from "@/components/ui/button"

export interface CsvColumn<T> {
  header: string
  // Return the value as a string. The exporter will handle escaping.
  accessor: (row: T) => string | number | null | undefined
}

interface ExportCSVButtonProps<T> {
  data: T[]
  columns: CsvColumn<T>[]
  filename: string
  label?: string
}

/**
 * Generic CSV export button.
 * Generates a UTF-8 CSV (with BOM for Excel compatibility) and triggers
 * a browser download. Escapes quotes/commas/newlines per RFC 4180.
 */
export function ExportCSVButton<T>({
  data,
  columns,
  filename,
  label,
}: ExportCSVButtonProps<T>) {
  const handleClick = () => {
    if (!data || data.length === 0) return

    const escape = (v: unknown) => {
      if (v === null || v === undefined) return ""
      const s = String(v)
      // RFC 4180: fields with quotes, commas, or newlines must be quoted;
      // embedded quotes are doubled.
      if (/[",\n\r]/.test(s)) {
        return `"${s.replace(/"/g, '""')}"`
      }
      return s
    }

    const header = columns.map((c) => escape(c.header)).join(";")
    const rows = data.map((row) =>
      columns.map((c) => escape(c.accessor(row))).join(";")
    )

    // Use semicolon as separator — common in German Excel installs that
    // use comma as decimal separator. The BOM at the start lets Excel
    // auto-detect UTF-8.
    const csv = "\uFEFF" + [header, ...rows].join("\n")
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${filename}_${new Date().toISOString().split("T")[0]}.csv`
    document.body.appendChild(a)
    a.click()
    window.URL.revokeObjectURL(url)
    document.body.removeChild(a)
  }

  return (
    <Button variant="outline" size="sm" onClick={handleClick} disabled={!data || data.length === 0}>
      {label ?? "CSV"}
    </Button>
  )
}
