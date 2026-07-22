import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'

/**
 * Tier 83: Anlagenverzeichnis (Asset Register).
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
 * v1 honesty: the user can register a
 * Sachanlage but the AfA expense itself is
 * NOT auto-posted. The G+V "7a Abschreibungen"
 * line shows the COMPUTED annual AfA (so the
 * Berater sees the right number) but the
 * underlying Expense row is NOT created
 * automatically. The user can either:
 *   (a) accept the computed amount and have
 *       the system create the AfA expense
 *       row (future: one-click "AfA buchen"
 *       button in the Anlagenverzeichnis UI);
 *   (b) create the AfA expense row manually
 *       with the right amount; or
 *   (c) skip it and let the Berater book it
 *       outside the system.
 *
 * v2 work (not in scope here):
 *   - One-click "AfA buchen" button
 *   - Geometric / degressive AfA
 *   - Außerplanmäßige Abschreibungen (§ 253
 *     Abs. 3 HGB) + Zuschreibungen
 *   - Component approach (§ 253 Abs. 1 HGB S. 2)
 *   - AfA-Buch (separate journal) for partial-
 *     year disposals
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

function diffMonths(from: Date, to: Date): number {
  // Floor of the months between `from` (inclusive)
  // and `to` (inclusive). Matches the § 7 Abs. 1
  // EStG "AfA pro rata" convention — a December
  // acquisition counts as 1 month in December.
  if (to < from) return 0
  const y = to.getFullYear() - from.getFullYear()
  const m = to.getMonth() - from.getMonth()
  let total = y * 12 + m
  if (to.getDate() >= from.getDate()) total += 1
  return Math.max(0, total)
}

@Injectable()
export class AssetsService {
  private readonly logger = new Logger(AssetsService.name)

  constructor(private prisma: PrismaService) {}

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
    const ak = Number(asset.anschaffungsKosten)
    const restwert = Number(asset.restwert)
    const nd = asset.nutzungsdauerMonate
    const depreciable = Math.max(0, ak - restwert)
    const monthlyAfA = nd > 0 ? depreciable / nd : 0

    // If the asset is disposed before snapshot,
    // treat snapshot as the disposal date for
    // Buchwert purposes (the asset is no longer
    // in the pool at snapshot).
    const effectiveEnd =
      asset.verkauftAm && asset.verkauftAm <= snapshot
        ? asset.verkauftAm
        : snapshot

    // Full months from acquisition to snapshot
    // (capped at ND — an asset is fully
    // depreciated after ND months).
    const monthsHeld = Math.min(diffMonths(asset.anschaffungsDatum, effectiveEnd), nd)
    const accumulatedAfA = round2(monthsHeld * monthlyAfA)
    // Floor at restwert: if the computation
    // would depreciate below the residual, clamp
    // to (AK - Restwert) and we're done.
    const cappedAccumulated = Math.min(accumulatedAfA, depreciable)
    const buchwert = round2(ak - cappedAccumulated)

    // Annual AfA: months held within the snapshot's
    // calendar year, capped at the REMAINING
    // Nutzungsdauer at the start of the year. If
    // the asset was fully depreciated before the
    // year started, the remaining ND is 0 and the
    // annual AfA is 0.
    const year = snapshot.getFullYear()
    const yearStart = new Date(year, 0, 1)
    const yearEnd = new Date(year, 11, 31, 23, 59, 59, 999)
    const assetStart = asset.anschaffungsDatum
    const assetEnd =
      asset.verkauftAm && asset.verkauftAm < yearEnd
        ? asset.verkauftAm
        : yearEnd
    // Year-to-charge window: max(asset acquisition,
    // year start) → min(asset disposal, year end).
    const start =
      assetStart > yearStart ? assetStart : yearStart
    const end = assetEnd < yearEnd ? assetEnd : yearEnd
    // Remaining ND at yearStart: how many months of
    // AfA are still due. monthsAlreadyHeldAtYearStart
    // is the months the asset was in the pool up to
    // yearStart (capped at ND). remainingNd is the
    // unfilled ND, capped at 12 (we only care about
    // one year here).
    const monthsAlreadyHeldAtYearStart = Math.min(
      Math.max(0, diffMonths(assetStart, yearStart) - 1),
      nd,
    )
    const remainingNd = Math.max(0, nd - monthsAlreadyHeldAtYearStart)
    const monthsInYearSimple =
      start <= end
        ? Math.min(diffMonths(start, end), remainingNd)
        : 0
    const annualAfA = round2(monthsInYearSimple * monthlyAfA)

    return {
      assetId: asset.id,
      anschaffungsKosten: round2(ak),
      restwert: round2(restwert),
      monthlyAfA: round2(monthlyAfA),
      monthsHeld,
      accumulatedAfA: round2(cappedAccumulated),
      buchwert,
      annualAfA,
      disposed: !!asset.verkauftAm,
    }
  }
}
