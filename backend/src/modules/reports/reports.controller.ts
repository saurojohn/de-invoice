/**
 * Deprecated stub — all endpoints have been split into
 * 7 domain-specific controllers (Tier 173):
 *
 *   SalesReportController     — /sales, /vat, /customers, /aging
 *   DashboardController       — /dashboard, /dashboard-v2
 *   DatevExportController     — /datev-export*, /datev-preview
 *   CashflowPnlController    — /cashflow, /pnl
 *   BwaController             — /bwa, /bwa.pdf, /bwa-quarterly
 *   OssController             — /oss, /oss.csv
 *   CostCenterController      — /cost-center-*
 *
 * The original 2455-line reports.controller.ts was split
 * because no single file should hold 24 endpoints across
 * 7 domains (it had grown past the point where one
 * developer could read the whole thing). The split is
 * behavioural-equivalent: every URL path is preserved
 * and the response shapes are byte-identical.
 *
 * This file remains as a placeholder so any external
 * import (e.g. tests, docs) of `ReportsController` from
 * the old path doesn't fail at import time. It contains
 * a no-op class with NO route decorators — registering
 * it would not add any HTTP routes (those are all on
 * the 7 new controllers).
 *
 * If you find a real test that imports ReportsController
 * from here, update it to import the specific new
 * controller instead. This file is scheduled for
 * deletion in a future tier once all dependents are
 * migrated.
 */
export class ReportsController {
  // Intentionally empty. See the comment above.
}
