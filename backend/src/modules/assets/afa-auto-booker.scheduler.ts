/**
 * Tier 91: Auto-AfA month-end scheduler.
 *
 * Runs on the 1st of each month at 00:05
 * Europe/Berlin and automatically books
 * the AfA for the previous month for every
 * company that has the Anlagenverzeichnis
 * enabled.
 *
 * The flow per company:
 *   1. Read `Company.settings.autoBookAfa` —
 *      if explicitly false, skip (opt-out).
 *   2. Call `AssetsService.bookAfaMonthly(
 *      companyId, previousYear)` — the
 *      existing tier 89 monthly booking
 *      endpoint. Its mutex check refuses if
 *      an annual booking already exists, and
 *      its dedup is idempotent on
 *      (relatedAssetId, afaYear, afaMonth)
 *      so re-running is a no-op.
 *   3. Write an AuditLog entry with
 *      action='assets.afa.auto_booked'
 *      carrying the year + count + the
 *      skippedCompanies list.
 *
 * v1 simplifications:
 *   - The cron runs at the start of the
 *     new month, not the end of the old
 *     month (a 5-minute grace period is
 *     fine for an auto-booking flow).
 *   - The booking is the full 12-month
 *     monthly mode (tier 89) — not a
 *     per-month row insertion. The dedup
 *     makes the second-and-later runs free
 *     (no DB writes for already-booked
 *     months).
 *   - Per-company opt-out is via the
 *     `settings.autoBookAfa` JSON field
 *     (not a schema column). Defaults to
 *     ON (true) for new companies.
 *
 * Errors in one company must NOT block
 * other companies. We try/catch per-
 * company and log the error so a single
 * broken company doesn't silently kill
 * the whole monthly cron.
 */
import { Injectable, Logger } from "@nestjs/common"
import { Cron } from "@nestjs/schedule"
import { PrismaService } from "../../prisma/prisma.service"
import { AssetsService } from "./assets.service"
import { AuditService } from "../audit/audit.service"
// Tier 119: record every cron tick to the shared
// CronHealthService for the admin dashboard.
import { CronHealthService } from "../admin/cron-health.service"

@Injectable()
export class AfaAutoBookerScheduler {
  private readonly logger = new Logger(AfaAutoBookerScheduler.name)

  constructor(
    private prisma: PrismaService,
    private assets: AssetsService,
    private health: CronHealthService,
    // Tier 368: signs the auto-book audit rows (were unsigned direct inserts).
    private audit: AuditService,
  ) {}

  /**
   * Cron entry point: 00:05 on the 1st of
   * each month, Europe/Berlin timezone.
   *
   * 00:05 (not :00) avoids the midnight
   * stampede — many crons fire at :00
   * and we don't want to compete with
   * them for the DB connection pool.
   */
  @Cron("5 0 1 * *", {
    name: "afa-auto-booker",
    timeZone: "Europe/Berlin",
  })
  async runAfaAutoBooker() {
    return this.health.wrap("afa-auto-booker", async () => {
    const now = new Date()
    // "Previous month" in Berlin
    // timezone — important because the
    // cron schedule is in Berlin time.
    // On Aug 1 at 00:05 Berlin, the
    // previous month is July (not June).
    const berlinDate = new Date(
      now.toLocaleString("en-US", { timeZone: "Europe/Berlin" }),
    )
    const prevMonth = berlinDate.getMonth() // 0-11 (0=Jan)
    const prevYear =
      prevMonth === 0
        ? berlinDate.getFullYear() - 1
        : berlinDate.getFullYear()
    this.logger.log(
      `AfA auto-booker starting for year=${prevYear} (previous month)`,
    )

    const companies = await this.prisma.company.findMany({
      select: { id: true, name: true, settings: true },
    })

    let bookedCount = 0
    let skippedCount = 0
    let errorCount = 0
    const errors: Array<{ company: string; msg: string }> = []

    for (const company of companies) {
      try {
        // Per-company opt-out: settings.autoBookAfa
        // === false means disabled. Default
        // is true (the field is missing).
        const settings = (company.settings ?? {}) as Record<
          string,
          unknown
        >
        if (settings.autoBookAfa === false) {
          skippedCount++
          continue
        }

        const result = await this.assets.bookAfaMonthly(
          company.id,
          prevYear,
        )
        bookedCount += result.bookedCount
        this.logger.log(
          `AfA auto-booker ${company.id} (${company.name}): bookedCount=${result.bookedCount} skippedAlready=${result.skippedAlreadyCount} total=${result.totalAnnualAfA}`,
        )
        // Write a per-company audit log entry.
        // The auto-booker is a scheduled event,
        // not a user action — we tag the
        // userId as null and the userAgent as
        // the auto-booker marker so the
        // Berater can see the source.
        // Tier 368: signed via AuditService so the scheduled booking joins the
        // hash chain. The surrounding try/catch stays — it guards the whole
        // bookAfaMonthly step, not just this write.
        await this.audit.writeActivity({
          companyId: company.id,
          userId: null,
          action: "assets.afa.auto_booked",
          entityType: "AssetAfaBooking",
          entityId: `auto-year-${prevYear}`,
          oldData: {
            year: prevYear,
            mode: "monthly",
            bookedCount: result.bookedCount,
            skippedAlreadyCount: result.skippedAlreadyCount,
            totalAnnualAfA: result.totalAnnualAfA,
            triggeredBy: "AfaAutoBookerScheduler",
          },
          ipAddress: null,
          userAgent: "de-invoice:AfaAutoBookerScheduler",
        })
      } catch (err) {
        errorCount++
        const msg = (err as Error).message
        errors.push({ company: company.name, msg })
        this.logger.error(
          `AfA auto-booker ${company.id} (${company.name}) failed: ${msg}`,
        )
      }
    }

    this.logger.log(
      `AfA auto-booker finished: companies=${companies.length} booked=${bookedCount} skipped=${skippedCount} errors=${errorCount}`,
    )
    if (errorCount > 0) {
      this.logger.warn(
        `AfA auto-booker errors: ${JSON.stringify(errors)}`,
      )
    }
    return `companies=${companies.length} booked=${bookedCount} skipped=${skippedCount} errors=${errorCount}`
    })
  }

  /**
   * Test-only entry point: force-trigger the
   * auto-booker for a specific year. The e2e
   * tests call this to verify the flow
   * without waiting for the 1st of the
   * month. Not exposed as an HTTP route in
   * production — the cron is the only
   * trigger.
   *
   * The `year` argument lets the test
   * book for a known year (not the
   * "previous month" computed from
   * `now()`).
   */
  async forceTriggerForYear(year: number) {
    this.logger.log(
      `AfA auto-booker force-triggered for year=${year}`,
    )
    const companies = await this.prisma.company.findMany({
      select: { id: true, name: true, settings: true },
    })

    let bookedCount = 0
    let skippedCount = 0
    let errorCount = 0
    const errors: Array<{ company: string; msg: string }> = []

    for (const company of companies) {
      try {
        const settings = (company.settings ?? {}) as Record<
          string,
          unknown
        >
        if (settings.autoBookAfa === false) {
          skippedCount++
          continue
        }

        const result = await this.assets.bookAfaMonthly(
          company.id,
          year,
        )
        bookedCount += result.bookedCount
        // Tier 368: signed via AuditService (was an unsigned direct insert).
        await this.audit.writeActivity({
          companyId: company.id,
          userId: null,
          action: "assets.afa.auto_booked",
          entityType: "AssetAfaBooking",
          entityId: `auto-year-${year}`,
          oldData: {
            year,
            mode: "monthly",
            bookedCount: result.bookedCount,
            skippedAlreadyCount: result.skippedAlreadyCount,
            totalAnnualAfA: result.totalAnnualAfA,
            triggeredBy: "AfaAutoBookerScheduler:force",
          },
          ipAddress: null,
          userAgent: "de-invoice:AfaAutoBookerScheduler:force",
        })
      } catch (err) {
        errorCount++
        const msg = (err as Error).message
        errors.push({ company: company.name, msg })
        this.logger.error(
          `AfA auto-booker ${company.id} (${company.name}) failed: ${msg}`,
        )
      }
    }
    return {
      companies: companies.length,
      bookedCount,
      skippedCount,
      errorCount,
      errors,
    }
  }
}
