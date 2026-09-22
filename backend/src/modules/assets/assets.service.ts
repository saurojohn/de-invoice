import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../prisma/prisma.service'
import { AuditService } from '../audit/audit.service'
import { computeAfaSummary } from './afa'

/**
 * Tier 83+87: Anlagenverzeichnis (Asset Register)
 * + AfA-Buchung (one-click auto-post).
 *
 * CRUD + dispose for Sachanlagen. The AfA
 * schedule (linear, per-month) is computed
 * IN-MEMORY by the helper functions at the
 * bottom of this file — no separate
 * DepreciationEntry table. The BilanzService
 * + GuVService read the Asset pool and ask
 * for the Buchwert / annual AfA at any point
 * in time.
 *
 * Tier 87 adds the booking side: a one-click
 * "AfA buchen" flow on /dashboard/assets that
 * creates one Expense row per Asset (with
 * `category='AfA'`, `relatedAssetId`, `afaYear`)
 * so the G+V 7a, BWA 3100, and Anlage S 4600
 * lines show REAL booked values, not just
 * computed numbers. The (relatedAssetId,
 * afaYear) pair is the dedup key, so re-running
 * the booking is idempotent.
 *
 * When a year has any booked AfA rows, the
 * report services (BwaService, GuVService,
 * AnlageSService) prefer the booked sum over
 * the in-memory computed value. The BWA's
 * monthly columns are derived from the year-end
 * booking by `bookedSum / 12` proration (the
 * same v1 simplification as the computed
 * fallback). For exact per-month AfA figures,
 * the user can split the booking into monthly
 * rows manually — v2 work.
 *
 * v2 work (not in scope here):
 *   - Geometric / degressive AfA
 *   - Außerplanmäßige Abschreibungen (§ 253
 *     Abs. 3 HGB) + Zuschreibungen
 *   - Component approach (§ 253 Abs. 1 HGB S. 2)
 *   - AfA-Buch (separate journal) for partial-
 *     year disposals
 *   - Monthly AfA booking (one row per month
 *     instead of one row per year)
 *   - Storno / reversal flow (delete + audit)
 */

export type AssetType =
  | 'Grundstueck'
  | 'Gebaeude'
  | 'Maschine'
  | 'Fahrzeug'
  | 'Betriebsausstattung'
  | 'GWG'
  | 'Software'
  | 'Sonstiges'

/**
 * Map an asset type to its default § 266 HGB
 * Bilanz position. The user can override this
 * with `Asset.bilanzKonto` for unusual cases
 * (e.g. a Maschine mapped to 0400 instead of
 * 0300 because it's small enough to count as
 * Betriebsausstattung).
 *
 * Grundstueck + Gebaeude both go to 0200
 * because v1 doesn't split "Grundstücke mit
 * Geschäftsbauten" / "Grundstücke ohne Bauten"
 * / "Grundstücksgleiche Rechte" — that split
 * is v2 work.
 *
 * GWG is combined with Betriebsausstattung in
 * 0400. Real accounting tracks GWG separately
 * because they're Sofortabschreibung (full
 * write-off in year of purchase) — but v1
 * uses the same linear AfA schedule for all
 * assets; the 7a Abschreibungen sum is
 * correct either way for the G+V.
 */
export const DEFAULT_BILANZ_KONTO: Record<AssetType, string> = {
  Grundstueck: '0200',
  Gebaeude: '0200',
  Maschine: '0300',
  Fahrzeug: '0400',
  Betriebsausstattung: '0400',
  GWG: '0400',
  Software: '0100',
  Sonstiges: '0400',
}

const ALLOWED_TYPES: AssetType[] = [
  'Grundstueck',
  'Gebaeude',
  'Maschine',
  'Fahrzeug',
  'Betriebsausstattung',
  'GWG',
  'Software',
  'Sonstiges',
]

export interface AssetCreateDto {
  type: string
  bezeichnung: string
  anschaffungsDatum: Date
  anschaffungsKosten: number
  nutzungsdauerMonate: number
  restwert?: number
  afaMethode?: string
  bilanzKonto?: string | null
  notiz?: string | null
}

export interface AssetUpdateDto {
  type?: string
  bezeichnung?: string
  anschaffungsDatum?: Date
  anschaffungsKosten?: number
  nutzungsdauerMonate?: number
  restwert?: number
  afaMethode?: string
  bilanzKonto?: string | null
  notiz?: string | null
}

export interface AssetDisposeDto {
  verkauftAm: Date
  verkaufsPreis: number
}

/**
 * AfA summary for a single asset at a given
 * snapshot date. Used by the BilanzService +
 * GuVService to populate the report positions.
 */
export interface AssetAfaSummary {
  assetId: string
  anschaffungsKosten: number
  restwert: number
  monthlyAfA: number
  monthsHeld: number        // months between anschaffungsDatum and snapshot
  accumulatedAfA: number    // min(monthsHeld, ND) * monthlyAfA
  buchwert: number          // AK - accumulatedAfA, floored at Restwert
  annualAfA: number         // AfA expense for the calendar year of snapshot
  disposed: boolean
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}


@Injectable()
export class AssetsService {
  private readonly logger = new Logger(AssetsService.name)

  constructor(
    private prisma: PrismaService,
    // Tier 368: signs the AfA storno marker row (was unsigned).
    private audit: AuditService,
  ) {}

  async list(companyId: string) {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    return this.prisma.asset.findMany({
      where: { companyId },
      orderBy: { anschaffungsDatum: 'asc' },
    })
  }

  async findOne(id: string, companyId: string) {
    const asset = await this.prisma.asset.findFirst({
      where: { id, companyId },
    })
    if (!asset) {
      throw new NotFoundException('Anlage nicht gefunden')
    }
    return asset
  }

  async create(companyId: string, dto: AssetCreateDto) {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    this.validateCreate(dto)
    return this.prisma.asset.create({
      data: {
        companyId,
        type: dto.type,
        bezeichnung: dto.bezeichnung,
        anschaffungsDatum: dto.anschaffungsDatum,
        anschaffungsKosten: dto.anschaffungsKosten,
        nutzungsdauerMonate: dto.nutzungsdauerMonate,
        restwert: dto.restwert ?? 0,
        afaMethode: dto.afaMethode ?? 'linear',
        bilanzKonto: dto.bilanzKonto ?? DEFAULT_BILANZ_KONTO[dto.type as AssetType] ?? null,
        notiz: dto.notiz ?? null,
      },
    })
  }

  async update(id: string, companyId: string, dto: AssetUpdateDto) {
    const existing = await this.findOne(id, companyId)
    if (existing.verkauftAm) {
      throw new BadRequestException(
        'Eine veräußerte Anlage kann nicht mehr bearbeitet werden',
      )
    }
    if (dto.type !== undefined && !ALLOWED_TYPES.includes(dto.type as AssetType)) {
      throw new BadRequestException(`Ungültiger Anlagentyp: ${dto.type}`)
    }
    if (dto.anschaffungsKosten !== undefined && dto.anschaffungsKosten <= 0) {
      throw new BadRequestException('Anschaffungskosten müssen > 0 sein')
    }
    if (dto.nutzungsdauerMonate !== undefined && dto.nutzungsdauerMonate <= 0) {
      throw new BadRequestException('Nutzungsdauer muss > 0 Monate sein')
    }
    return this.prisma.asset.update({
      where: { id },
      data: {
        ...(dto.type !== undefined && { type: dto.type }),
        ...(dto.bezeichnung !== undefined && { bezeichnung: dto.bezeichnung }),
        ...(dto.anschaffungsDatum !== undefined && {
          anschaffungsDatum: dto.anschaffungsDatum,
        }),
        ...(dto.anschaffungsKosten !== undefined && {
          anschaffungsKosten: dto.anschaffungsKosten,
        }),
        ...(dto.nutzungsdauerMonate !== undefined && {
          nutzungsdauerMonate: dto.nutzungsdauerMonate,
        }),
        ...(dto.restwert !== undefined && { restwert: dto.restwert }),
        ...(dto.afaMethode !== undefined && { afaMethode: dto.afaMethode }),
        ...(dto.bilanzKonto !== undefined && { bilanzKonto: dto.bilanzKonto }),
        ...(dto.notiz !== undefined && { notiz: dto.notiz }),
      },
    })
  }

  private validateCreate(dto: AssetCreateDto): void {
    if (!ALLOWED_TYPES.includes(dto.type as AssetType)) {
      throw new BadRequestException(`Ungültiger Anlagentyp: ${dto.type}`)
    }
    if (!dto.bezeichnung || dto.bezeichnung.trim().length === 0) {
      throw new BadRequestException('Bezeichnung ist erforderlich')
    }
    if (!dto.anschaffungsDatum) {
      throw new BadRequestException('Anschaffungsdatum ist erforderlich')
    }
    if (dto.anschaffungsKosten == null || dto.anschaffungsKosten <= 0) {
      throw new BadRequestException('Anschaffungskosten müssen > 0 sein')
    }
    if (!dto.nutzungsdauerMonate || dto.nutzungsdauerMonate <= 0) {
      throw new BadRequestException('Nutzungsdauer muss > 0 Monate sein')
    }
    if (dto.restwert != null && dto.restwert < 0) {
      throw new BadRequestException('Restwert darf nicht negativ sein')
    }
    if (dto.restwert != null && dto.restwert > dto.anschaffungsKosten) {
      throw new BadRequestException('Restwert darf nicht größer als AK sein')
    }
  }

  async dispose(id: string, companyId: string, dto: AssetDisposeDto) {
    const existing = await this.findOne(id, companyId)
    if (existing.verkauftAm) {
      throw new BadRequestException('Anlage ist bereits veräußert')
    }
    if (!dto.verkauftAm) {
      throw new BadRequestException('verkauftAm ist erforderlich')
    }
    if (dto.verkauftAm < existing.anschaffungsDatum) {
      throw new BadRequestException(
        'Verkaufsdatum liegt vor dem Anschaffungsdatum',
      )
    }
    return this.prisma.asset.update({
      where: { id },
      data: {
        verkauftAm: dto.verkauftAm,
        verkaufsPreis: dto.verkaufsPreis ?? 0,
      },
    })
  }

  // ----------------------------------------------------------------
  // Tier 87: AfA-Buchung (one-click auto-post)
  // ----------------------------------------------------------------

  /**
   * One-click "AfA buchen" for a year. Walks the
   * Asset pool, computes the annual AfA for each
   * asset at year-end, and creates one Expense
   * row per asset that has positive annualAfA
   * for this year AND has not been booked yet.
   *
   * Idempotent: re-running for the same (asset,
   * year) does not create a second row — we
   * check `Expense.relatedAssetId + afaYear`
   * inside the transaction. The dedup index
   * `Expense_relatedAssetId_afaYear_idx` makes
   * the lookup fast.
   *
   * Mutually exclusive with `bookAfaMonthly`
   * (tier 89): if any monthly rows already exist
   * for the year (afaMonth IS NOT NULL), this
   * call fails with 400. The user must storno
   * the monthly booking first.
   *
   * Returns a summary: how many assets were
   * considered, how many actually got booked
   * (vs already-booked, vs zero-AfA), and the
   * total booked amount. The frontend uses
   * this to show a confirmation toast.
   *
   * The booking Expense has:
   *   - category='AfA'        → matchers find it
   *   - vatRate=0             → § 12 Abs. 3 UStG
   *   - netAmount=-annualAfA  → reduces profit
   *   - relatedAssetId        → back-link to Asset
   *   - afaYear               → the calendar year
   *   - afaMonth=NULL         → annual mode marker
   *   - invoiceDate=year-12-31 → year-end (DATEV
   *                              convention for
   *                              annual postings)
   *   - status='booked'       → counts in UStVA
   *                              Vorsteuer (=0 here)
   */
  async bookAfa(companyId: string, year: number) {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }

    // Pre-check: refuse if any monthly
    // booking already exists for the year
    // (afaMonth IS NOT NULL with afaYear=year).
    // The two modes are mutually exclusive —
    // the user must storno the monthly
    // booking first.
    const monthlyExisting = await this.prisma.expense.count({
      where: {
        companyId,
        afaYear: year,
        relatedAssetId: { not: null },
        afaMonth: { not: null },
      },
    })
    if (monthlyExisting > 0) {
      throw new BadRequestException(
        'AfA wurde bereits monatlich gebucht. Bitte zuerst stornieren (siehe Anlagenverzeichnis) oder ein anderes Jahr wählen.',
      )
    }

    const assets = await this.prisma.asset.findMany({
      where: { companyId },
    })
    const yearEnd = new Date(year, 11, 31, 23, 59, 59, 999)
    const yearEndDate = new Date(year, 11, 31)

    // Pre-fetch existing bookings for this year so
    // we can skip them in the loop (cheaper than a
    // per-asset query).
    const existing = await this.prisma.expense.findMany({
      where: {
        companyId,
        afaYear: year,
        relatedAssetId: { not: null },
      },
      select: { relatedAssetId: true, grossAmount: true },
    })
    const alreadyBookedByAsset = new Map<string, number>()
    for (const e of existing) {
      if (!e.relatedAssetId) continue
      alreadyBookedByAsset.set(
        e.relatedAssetId,
        (alreadyBookedByAsset.get(e.relatedAssetId) ?? 0) +
          Math.abs(Number(e.grossAmount)),
      )
    }

    const booked: Array<{
      assetId: string
      assetName: string
      expenseId: string
      annualAfA: number
    }> = []
    const skippedAlready: Array<{ assetId: string; assetName: string }> = []
    const skippedZero: Array<{ assetId: string; assetName: string }> = []

    // We use a serial transaction (not a $transaction
    // block) because we want to log per-row outcomes
    // for the response payload, and a Prisma interactive
    // transaction adds overhead for what is essentially
    // a "find or create" per asset.
    for (const a of assets) {
      const summary = this.computeAfA(a, yearEnd)
      if (summary.annualAfA <= 0) {
        skippedZero.push({ assetId: a.id, assetName: a.bezeichnung })
        continue
      }
      if (alreadyBookedByAsset.has(a.id)) {
        skippedAlready.push({ assetId: a.id, assetName: a.bezeichnung })
        continue
      }
      const expense = await this.prisma.expense.create({
        data: {
          companyId,
          supplierId: null,
          invoiceNumber: null,
          description: `AfA ${a.bezeichnung} ${year}`,
          invoiceDate: yearEndDate,
          netAmount: -round2(summary.annualAfA),
          vatRate: 0,
          vatAmount: 0,
          grossAmount: -round2(summary.annualAfA),
          category: 'AfA',
          isIntraEU: false,
          isReverseCharge: false,
          status: 'booked',
          notes: `Automatisch gebucht aus Anlagenverzeichnis (Asset ${a.id})`,
          relatedAssetId: a.id,
          afaYear: year,
          afaMonth: null,
        },
      })
      booked.push({
        assetId: a.id,
        assetName: a.bezeichnung,
        expenseId: expense.id,
        annualAfA: round2(summary.annualAfA),
      })
    }

    const totalBooked = booked.reduce((s, b) => s + b.annualAfA, 0)
    this.logger.log(
      `AfA-Buchung ${companyId} year=${year}: booked=${booked.length} skippedAlready=${skippedAlready.length} skippedZero=${skippedZero.length} total=${round2(totalBooked)}`,
    )
    return {
      year,
      mode: 'annual' as const,
      bookedCount: booked.length,
      skippedAlreadyCount: skippedAlready.length,
      skippedZeroCount: skippedZero.length,
      totalAnnualAfA: round2(totalBooked),
      booked,
      skippedAlready,
      skippedZero,
    }
  }

  /**
   * Tier 89: monthly AfA booking. Like
   * `bookAfa` but creates 12 monthly rows
   * per asset (one per month, dated last day
   * of the month, grossAmount = -annualAfA/12
   * each). The BWA 3100 line then shows real
   * booked AfA in each month instead of the
   * "0 Jan-Nov + full amount in Dec" pattern
   * the annual booking produces.
   *
   * Mutually exclusive with the annual mode:
   * if an annual booking already exists for
   * any asset in the year, this call fails
   * with a 400. The user must storno the
   * annual booking first (or use a different
   * year).
   *
   * Idempotent: re-running for the same year
   * does not double-book (the
   * (relatedAssetId, afaYear, afaMonth)
   * triple is unique).
   */
  async bookAfaMonthly(companyId: string, year: number) {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }

    // Pre-check: refuse if any annual
    // booking already exists for the year
    // (afaMonth IS NULL with afaYear=year).
    // The two modes are mutually exclusive —
    // the user must storno the annual
    // booking first.
    const annualExisting = await this.prisma.expense.count({
      where: {
        companyId,
        afaYear: year,
        relatedAssetId: { not: null },
        afaMonth: null,
      },
    })
    if (annualExisting > 0) {
      throw new BadRequestException(
        'AfA wurde bereits jährlich gebucht. Bitte zuerst stornieren (siehe Anlagenverzeichnis) oder ein anderes Jahr wählen.',
      )
    }

    const assets = await this.prisma.asset.findMany({
      where: { companyId },
    })
    const yearEnd = new Date(year, 11, 31, 23, 59, 59, 999)

    // Pre-fetch existing monthly bookings
    // so we can skip them in the loop.
    const existing = await this.prisma.expense.findMany({
      where: {
        companyId,
        afaYear: year,
        relatedAssetId: { not: null },
        afaMonth: { not: null },
      },
      select: {
        relatedAssetId: true,
        afaMonth: true,
        grossAmount: true,
      },
    })
    const existingByAssetMonth = new Map<string, number>()
    for (const e of existing) {
      if (!e.relatedAssetId || e.afaMonth == null) continue
      const key = `${e.relatedAssetId}|${e.afaMonth}`
      existingByAssetMonth.set(
        key,
        (existingByAssetMonth.get(key) ?? 0) + Math.abs(Number(e.grossAmount)),
      )
    }

    const booked: Array<{
      assetId: string
      assetName: string
      month: number
      expenseId: string
      monthlyAfA: number
    }> = []
    const skippedAlready: Array<{
      assetId: string
      assetName: string
      month: number
    }> = []
    const skippedZero: Array<{ assetId: string; assetName: string }> = []

    for (const a of assets) {
      const summary = this.computeAfA(a, yearEnd)
      if (summary.annualAfA <= 0) {
        skippedZero.push({ assetId: a.id, assetName: a.bezeichnung })
        continue
      }
      // Split the annual AfA into 12 equal
      // monthly amounts. The last month (Dec)
      // absorbs the rounding remainder so the
      // 12 months sum exactly to the annual
      // total.
      const monthlyBase = round2(summary.annualAfA / 12)
      const monthlyAmounts: number[] = []
      let allocated = 0
      for (let m = 1; m <= 12; m++) {
        let amount: number
        if (m === 12) {
          // Last month absorbs the rounding
          // remainder: annualAfA - 11*monthlyBase
          amount = round2(summary.annualAfA - 11 * monthlyBase)
        } else {
          amount = monthlyBase
        }
        monthlyAmounts.push(amount)
        allocated += amount
      }
      // Sanity check: allocated should equal
      // annualAfA. If not (due to repeated
      // rounding), log a warning.
      if (Math.abs(allocated - round2(summary.annualAfA)) > 0.01) {
        this.logger.warn(
          `AfA monthly split mismatch for ${a.id}: annual=${round2(summary.annualAfA)} allocated=${allocated}`,
        )
      }

      for (let m = 1; m <= 12; m++) {
        const key = `${a.id}|${m}`
        if (existingByAssetMonth.has(key)) {
          skippedAlready.push({ assetId: a.id, assetName: a.bezeichnung, month: m })
          continue
        }
        const monthlyAmount = monthlyAmounts[m - 1]
        // Last day of the month: new Date(year, m, 0)
        // gives the last day of month m (since
        // month is 0-indexed in JS Date).
        const monthEndDate = new Date(year, m, 0, 12, 0, 0, 0)
        const expense = await this.prisma.expense.create({
          data: {
            companyId,
            supplierId: null,
            invoiceNumber: null,
            description: `AfA ${a.bezeichnung} ${year}-${String(m).padStart(2, '0')}`,
            invoiceDate: monthEndDate,
            netAmount: -monthlyAmount,
            vatRate: 0,
            vatAmount: 0,
            grossAmount: -monthlyAmount,
            category: 'AfA',
            isIntraEU: false,
            isReverseCharge: false,
            status: 'booked',
            notes: `Automatisch gebucht aus Anlagenverzeichnis (Asset ${a.id}, Monat ${m})`,
            relatedAssetId: a.id,
            afaYear: year,
            afaMonth: m,
          },
        })
        booked.push({
          assetId: a.id,
          assetName: a.bezeichnung,
          month: m,
          expenseId: expense.id,
          monthlyAfA: monthlyAmount,
        })
      }
    }

    const totalBooked = booked.reduce((s, b) => s + b.monthlyAfA, 0)
    this.logger.log(
      `AfA-Monthly-Buchung ${companyId} year=${year}: booked=${booked.length} skippedAlready=${skippedAlready.length} skippedZero=${skippedZero.length} total=${round2(totalBooked)}`,
    )
    return {
      year,
      mode: 'monthly' as const,
      bookedCount: booked.length,
      skippedAlreadyCount: skippedAlready.length,
      skippedZeroCount: skippedZero.length,
      totalAnnualAfA: round2(totalBooked),
      booked,
      skippedAlready,
      skippedZero,
    }
  }

  // ----------------------------------------------------------------
  // Tier 90: AfA-Storno (Buchung rückgängig machen)
  // ----------------------------------------------------------------

  /**
   * Storno all booked AfA Expense rows for
   * the year (any mode: annual + monthly).
   * The rows are physically deleted (not
   * soft-deleted) so the rebook flow can
   * re-create them cleanly. The user can
   * then re-book in either mode.
   *
   * Idempotent: if no AfA bookings exist
   * for the year, returns
   * `stornoedCount=0` and does nothing.
   *
   * Audit trail: writes an AuditLog row
   * with action='assets.afa.stornoed'
   * carrying the year + the count +
   * the original grossAmount sum. The
   * audit log is the only durable
   * evidence that the booking existed
   * before storno (the Expense rows are
   * gone).
   *
   * v1: simple DELETE + audit log. v2:
   * could also support a "storno single
   * asset" mode (delete one asset's
   * rows) — not in v1.
   */
  async stornoAfa(
    companyId: string,
    year: number,
    userId?: string,
  ): Promise<{
    year: number
    stornoedCount: number
    stornoedTotal: number
  }> {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }

    // Find all booked AfA rows for the year
    // (both annual + monthly modes — the
    // `category='AfA'` predicate covers both
    // since tier 87+89 set category='AfA' on
    // all auto-posted rows).
    const existing = await this.prisma.expense.findMany({
      where: {
        companyId,
        afaYear: year,
        relatedAssetId: { not: null },
        category: 'AfA',
      },
      select: { id: true, grossAmount: true, afaMonth: true },
    })

    if (existing.length === 0) {
      return {
        year,
        stornoedCount: 0,
        stornoedTotal: 0,
      }
    }

    const ids = existing.map((e) => e.id)
    // Tier 245: Decimal累加 — `s.plus(d.abs())` instead of
    // `s + Math.abs(Number(decimal))` to avoid float64 precision
    // loss on 4+ decimal-place amounts.
    const stornoedTotal = round2(
      existing.reduce(
        (s, e) => s.plus(new Prisma.Decimal(e.grossAmount ?? 0).abs()),
        new Prisma.Decimal(0),
      ).toNumber(),
    )
    // Detect which mode the user had booked
    // for the audit log.
    const hadAnnual = existing.some((e) => e.afaMonth == null)
    const hadMonthly = existing.some((e) => e.afaMonth != null)
    const modeDesc =
      hadAnnual && hadMonthly
        ? 'annual+monthly'
        : hadMonthly
          ? 'monthly'
          : 'annual'

    // Delete the rows. The audit log
    // captures the evidence.
    const { count } = await this.prisma.expense.deleteMany({
      where: { id: { in: ids } },
    })

    // Write the audit log entry. The
    // AuditLog extension (in prisma/
    // audit-log.extension.ts) wraps every
    // mutation with auto-audit. The
    // .deleteMany() is auto-audited. The
    // explicit `assets.afa.stornoed`
    // entry below is a SEMANTIC marker
    // (not auto-audited) so the Berater
    // can see "this was a storno, not
    // a manual delete" in the audit log.
    // Tier 368: signed via AuditService so this marker joins the hash chain.
    // writeActivity never throws (it logs internally and swallows), so the
    // try/catch that used to guard the storno is no longer needed.
    await this.audit.writeActivity({
      companyId,
      userId: userId ?? null,
      action: 'assets.afa.stornoed',
      entityType: 'AssetAfaBooking',
      entityId: `year-${year}`,
      oldData: {
        year,
        mode: modeDesc,
        stornoedCount: count,
        stornoedTotal,
      },
      // No "new" state for a storno — the rows are gone.
      ipAddress: null,
      userAgent: 'de-invoice:AssetsService.stornoAfa',
    })

    this.logger.log(
      `AfA-Storno ${companyId} year=${year}: deleted=${count} total=${stornoedTotal} (mode=${modeDesc})`,
    )
    return {
      year,
      stornoedCount: count,
      stornoedTotal,
    }
  }

  /**
   * Booking-status for one year: per asset, return
   * the computed annual AfA + whether it's been
   * booked + the booked amount + the booking
   * mode ('annual' | 'monthly'). The frontend
   * uses this to show a "✓ gebucht" / "— nicht
   * gebucht" badge on each row + the booking
   * mode chip (tier 89).
   */
  async getBookingStatus(companyId: string, year: number) {
    if (!companyId) {
      throw new BadRequestException('companyId ist erforderlich')
    }
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('year ist ungültig')
    }

    const [assets, existing] = await Promise.all([
      this.prisma.asset.findMany({ where: { companyId } }),
      this.prisma.expense.findMany({
        where: {
          companyId,
          afaYear: year,
          relatedAssetId: { not: null },
        },
        select: {
          id: true,
          relatedAssetId: true,
          grossAmount: true,
          // Tier 89: needed to detect booking
          // mode (afaMonth != null → monthly)
          afaMonth: true,
        },
      }),
    ])

    const yearEnd = new Date(year, 11, 31, 23, 59, 59, 999)
    const byAsset = new Map<
      string,
      {
        expenseId: string
        bookedAfA: number
        mode: 'annual' | 'monthly'
      }
    >()
    for (const e of existing) {
      if (!e.relatedAssetId) continue
      const prev = byAsset.get(e.relatedAssetId)
      const add = Math.abs(Number(e.grossAmount))
      // Promote to monthly if any row has
      // afaMonth set. The two modes are
      // mutually exclusive per (asset, year)
      // — book-afa refuses if monthly rows
      // exist, book-afa-monthly refuses if
      // annual rows exist.
      const rowMode: 'annual' | 'monthly' =
        e.afaMonth != null ? 'monthly' : 'annual'
      const nextMode: 'annual' | 'monthly' =
        prev?.mode === 'monthly' || rowMode === 'monthly'
          ? 'monthly'
          : 'annual'
      byAsset.set(e.relatedAssetId, {
        expenseId: prev?.expenseId ?? e.id,
        bookedAfA: (prev?.bookedAfA ?? 0) + add,
        mode: nextMode,
      })
    }

    return assets.map((a) => {
      const summary = this.computeAfA(a, yearEnd)
      const booking = byAsset.get(a.id) ?? null
      const computedAfA = round2(summary.annualAfA)
      const bookedAfA = booking ? round2(booking.bookedAfA) : 0
      return {
        assetId: a.id,
        bezeichnung: a.bezeichnung,
        type: a.type,
        anschaffungsDatum: a.anschaffungsDatum,
        verkauftAm: a.verkauftAm,
        computedAfA,
        booked: booking !== null,
        bookedAfA,
        // Tier 89: 'annual' | 'monthly' | null
        bookingMode: booking?.mode ?? null,
        expenseId: booking?.expenseId ?? null,
      }
    })
  }

  /**
   * Compute the AfA summary for one asset at a
   * given snapshot date. Linear AfA only in v1.
   *
   * The Buchwert is the net book value at
   * snapshot: AK - accumulatedAfA, floored at
   * Restwert (i.e. the asset never depreciates
   * below its residual value).
   *
   * The annualAfA is the AfA expense for the
   * CALENDAR YEAR of the snapshot — used by
   * the G+V 7a Abschreibungen line. For a full
   * year of ownership this is 12 * monthlyAfA;
   * for a partial year (acquisition year /
   * disposal year) it's prorated.
   */
  /** Tier 427: the calculation lives in afa.ts — see there for what changed. */
  computeAfA(
    asset: {
      id: string
      anschaffungsKosten: any
      restwert: any
      nutzungsdauerMonate: number
      anschaffungsDatum: Date
      verkauftAm: Date | null
    },
    snapshot: Date,
  ): AssetAfaSummary {
    return computeAfaSummary(asset, snapshot)
  }
}
