"use client";

/**
 * VatCheckPanel — small UI block for "USt-ID prüfen"
 * inside a Customer/Supplier detail modal. Shows:
 *   • a colored status badge (none / valid / invalid / unreachable / pending)
 *   • a "Jetzt prüfen" button
 *   • the VIES-returned name + address (when valid)
 *   • a "Letzte Prüfungen" history list (collapsible)
 *
 * Why this is a component and not inline JSX:
 *   The exact same panel is used on BOTH the customer
 *   and supplier detail modals. Both call the same
 *   backend shape, render the same status colors, and
 *   show the same history. Duplicating ~120 lines in
 *   two pages would drift. Centralized here so a fix
 *   to e.g. the error message rendering only happens
 *   once.
 *
 * The component is intentionally NOT "smart" — the
 * parent owns the entity id + companyId and passes
 * them in. The panel just orchestrates the three
 * HTTP calls (verify / latest / history) and
 * renders the result. The parent doesn't have to
 * re-implement the loading + error states.
 */

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api";
import { Button } from "@/components/ui/button";

type VatStatus = "valid" | "invalid" | "unreachable" | "pending";

interface VatLatest {
  status: VatStatus;
  vatId: string;
  countryCode: string;
  name: string | null;
  address: string | null;
  errorMessage: string | null;
  checkedAt: string;
  durationMs: number;
}

interface VatHistoryEntry {
  id: string;
  vatId: string;
  status: VatStatus;
  countryCode: string;
  viesName: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  checkedAt: string;
  durationMs: number;
  createdAt: string;
}

interface VatCheckResponse {
  status: VatStatus;
  durationMs: number;
  cached: boolean;
  name: string | null;
  address: string | null;
  vatId?: string;
  countryCode?: string;
  errorMessage?: string | null;
  logId: string;
}

interface VatCheckPanelProps {
  companyId: string;
  entityType: "customer" | "supplier";
  entityId: string;
  vatId: string | null | undefined;
  /**
   * German labels map. The panel is intentionally
   * non-i18n-coupled: the parent (customer / supplier
   * page) has access to `t()` and the i18n bundles.
   * Passing in just the keys it needs keeps this
   * component decoupled from `useI18n`.
   */
  labels: {
    title: string;
    check: string;
    checking: string;
    noVat: string;
    statusNone: string;
    statusValid: string;
    statusInvalid: string;
    statusUnreachable: string;
    statusPending: string;
    cached: string;
    fresh: string;
    history: string;
    noHistory: string;
    errorPrefix: string;
    checkedAt: string;
    duration: string;
  };
}

/**
 * The status color is a project convention:
 *   valid     → green   (badge-checked)
 *   invalid   → red     (badge-destructive)
 *   unreachable → yellow (badge-warning — VIES
 *                  is offline, NOT a typo; user
 *                  should retry, not edit)
 *   pending   → gray
 *   none      → muted gray
 */
function statusColor(s: VatStatus | "none"): string {
  switch (s) {
    case "valid":
      return "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-200 dark:border-emerald-800";
    case "invalid":
      return "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/40 dark:text-red-200 dark:border-red-800";
    case "unreachable":
      return "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/40 dark:text-amber-200 dark:border-amber-800";
    case "pending":
      return "bg-gray-100 text-gray-700 border-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:border-gray-600";
    default:
      return "bg-gray-50 text-gray-500 border-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-700";
  }
}

function formatCheckedAt(iso: string): string {
  // The same date format we use in invoices: dd.mm.yyyy hh:mm.
  // We don't import formatDateDE because it lives in a
  // utility file the panel doesn't need to depend on.
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function VatCheckPanel({
  companyId,
  entityType,
  entityId,
  vatId,
  labels,
}: VatCheckPanelProps) {
  const [latest, setLatest] = useState<VatLatest | null>(null);
  const [history, setHistory] = useState<VatHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const base = `/api/v1/${entityType}s/${entityId}`;
  const apiPath = `${base}?companyId=${companyId}`;

  const loadLatest = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await apiGet(`${base}/vat-history?companyId=${companyId}&limit=10`);
      const data = r as { latest: VatLatest | null; history: VatHistoryEntry[] };
      setLatest(data.latest);
      setHistory(data.history || []);
    } catch (e: any) {
      // Don't surface the network error loudly on first
      // load — just show "no check yet". Most users open
      // a customer once before any check exists.
      setLatest(null);
      setHistory([]);
    } finally {
      setLoading(false);
    }
  }, [base, companyId]);

  useEffect(() => {
    if (!vatId) {
      setLatest(null);
      setHistory([]);
      return;
    }
    loadLatest();
  }, [vatId, loadLatest]);

  async function handleCheck() {
    if (!vatId) return;
    setChecking(true);
    setError(null);
    try {
      const r = (await apiPost(`${base}/verify-vat`, {})) as VatCheckResponse;
      // After the check, re-fetch latest+history so the
      // UI shows the new row in the history list and the
      // latest pointer updates to the just-finished check.
      await loadLatest();
      // If the response was "invalid" or "unreachable",
      // surface the error message inline (not via toast).
      // We don't fail the whole flow because the user
      // explicitly asked for the check.
      if (r.status === "invalid" && r.errorMessage) {
        setError(r.errorMessage);
      } else if (r.status === "unreachable" && r.errorMessage) {
        setError(r.errorMessage);
      }
    } catch (e: any) {
      setError(e?.message || "Prüfung fehlgeschlagen");
    } finally {
      setChecking(false);
    }
  }

  if (!vatId || !vatId.trim()) {
    return (
      <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 p-3 text-sm text-gray-500 dark:text-gray-400">
        <div className="font-medium text-gray-700 dark:text-gray-300 mb-1">{labels.title}</div>
        {labels.noVat}
      </div>
    );
  }

  const status: VatStatus | "none" = latest?.status ?? "none";
  const statusLabel: string = (() => {
    switch (status) {
      case "valid":
        return labels.statusValid;
      case "invalid":
        return labels.statusInvalid;
      case "unreachable":
        return labels.statusUnreachable;
      case "pending":
        return labels.statusPending;
      default:
        return labels.statusNone;
    }
  })();

  return (
    <div className="rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/50 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="font-medium text-sm text-gray-700 dark:text-gray-300">{labels.title}</div>
        <span
          data-testid="vat-status-badge"
          className={`text-xs px-2 py-0.5 rounded-full border ${statusColor(status)}`}
        >
          {loading ? "…" : statusLabel}
        </span>
      </div>

      <div className="text-xs text-gray-600 dark:text-gray-400 font-mono break-all">
        {vatId}
      </div>

      {latest && latest.status === "valid" && (latest.name || latest.address) && (
        <div className="text-xs text-gray-600 dark:text-gray-400 space-y-0.5">
          {latest.name && <div>{latest.name}</div>}
          {latest.address && <div>{latest.address}</div>}
        </div>
      )}

      {latest && (
        <div className="text-[11px] text-gray-500 dark:text-gray-500">
          {labels.checkedAt} {formatCheckedAt(latest.checkedAt)} ·{" "}
          {labels.duration} {latest.durationMs} ms
        </div>
      )}

      {error && (
        <div className="text-xs text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded p-2">
          {labels.errorPrefix}: {error}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleCheck}
          disabled={checking}
          data-testid="vat-check-button"
        >
          {checking ? labels.checking : labels.check}
        </Button>
        {history.length > 0 && (
          <button
            type="button"
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
            onClick={() => setShowHistory((v) => !v)}
          >
            {labels.history} ({history.length}) {showHistory ? "▲" : "▼"}
          </button>
        )}
      </div>

      {showHistory && history.length > 0 && (
        <div className="border-t border-gray-200 dark:border-gray-700 pt-2 mt-2 space-y-1 max-h-40 overflow-y-auto">
          {history.map((h) => (
            <div
              key={h.id}
              className="text-[11px] flex items-center justify-between gap-2"
            >
              <span className="text-gray-500 dark:text-gray-400 font-mono">
                {formatCheckedAt(h.checkedAt)}
              </span>
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded border ${statusColor(h.status)}`}
              >
                {h.status}
              </span>
              {h.viesName && (
                <span className="text-gray-600 dark:text-gray-300 truncate flex-1" title={h.viesName}>
                  {h.viesName}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
