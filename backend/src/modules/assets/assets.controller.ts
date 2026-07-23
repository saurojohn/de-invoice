import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Body,
  Req,
  UseGuards,
  BadRequestException,
} from '@nestjs/common'
import { HeaderAuthGuard } from '../../auth/header-auth.guard'
import { AssetsService, AssetCreateDto, AssetUpdateDto, AssetDisposeDto } from './assets.service'

/**
 * Tier 83: Anlagenverzeichnis REST endpoints.
 *
 * Standard CRUD + dispose. The Berater (and
 * the Mandant) can register a Sachanlage, edit
 * it, and mark it as sold. The AfA computation
 * is in-memory (AssetsService.computeAfA) and
 * is called by the BilanzService + GuVService
 * to fill the report positions.
 */
@Controller('assets')
@UseGuards(HeaderAuthGuard)
export class AssetsController {
  constructor(private assets: AssetsService) {}

  @Get()
  async list(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    return this.assets.list(companyId)
  }

  // ----------------------------------------------------------------
  // Tier 87: AfA-Buchung (one-click auto-post)
  // Declared BEFORE the :id routes — NestJS
  // matches @Get(':id') for any single-segment
  // path, so a literal 'booking-status' must
  // come first to avoid being captured as
  // findOne('booking-status', ...).
  // ----------------------------------------------------------------

  /**
   * Booking-status for one year. Per asset,
   * returns the computed annual AfA + whether
   * it's been booked + the booked amount. The
   * frontend uses this to show ✓/— badges.
   */
  @Get('booking-status')
  async bookingStatus(
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const year = yearRaw ? Number(yearRaw) : new Date().getFullYear()
    return this.assets.getBookingStatus(companyId, year)
  }

  /**
   * One-click "AfA buchen" for a year. Walks
   * the Asset pool and creates one Expense
   * row per asset with positive annualAfA.
   * Idempotent — re-running the same year
   * does not double-book (dedup on
   * relatedAssetId+afaYear).
   *
   * The `year` is required. If omitted, the
   * system books for the current calendar
   * year.
   */
  @Post('book-afa')
  async bookAfa(
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const year = yearRaw ? Number(yearRaw) : new Date().getFullYear()
    return this.assets.bookAfa(companyId, year)
  }

  /**
   * Tier 90: Storno all booked AfA Expense
   * rows for the year (any mode: annual +
   * monthly). After storno, the user can
   * re-book in either mode. Idempotent
   * (stornoedCount=0 if no bookings exist).
   *
   * Writes an AuditLog entry
   * ('assets.afa.stornoed') so the Berater
   * can see the storno event in the audit
   * trail — the deleted Expense rows
   * themselves are gone.
   */
  @Post('storno-afa')
  async stornoAfa(
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
    @Req() req?: any,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const year = yearRaw ? Number(yearRaw) : new Date().getFullYear()
    // The userId is in the x-user-id header
    // (HeaderAuthGuard sets req.user). v1:
    // pull it directly; falls back to null
    // if the guard didn't run.
    const userId: string | undefined = req?.user?.id
    return this.assets.stornoAfa(companyId, year, userId)
  }

  /**
   * Tier 89: "AfA monatlich buchen" — same
   * flow as book-afa but creates 12 monthly
   * rows per asset (one per month, dated
   * last day of the month, grossAmount =
   * -annualAfA/12 each). The BWA 3100 line
   * then shows real booked AfA in each
   * month instead of the "0 Jan-Nov + full
   * amount in Dec" pattern of the annual
   * mode.
   *
   * Mutually exclusive with the annual mode:
   * 400 if an annual booking already exists
   * for any asset in the year. The user
   * must storno the annual booking first.
   *
   * Idempotent on (relatedAssetId, afaYear,
   * afaMonth).
   */
  @Post('book-afa-monthly')
  async bookAfaMonthly(
    @Query('companyId') companyId: string,
    @Query('year') yearRaw?: string,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const year = yearRaw ? Number(yearRaw) : new Date().getFullYear()
    return this.assets.bookAfaMonthly(companyId, year)
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    return this.assets.findOne(id, companyId)
  }

  @Post()
  async create(@Query('companyId') companyId: string, @Body() body: AssetCreateDto) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    return this.assets.create(companyId, {
      ...body,
      anschaffungsDatum: new Date(body.anschaffungsDatum),
    })
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Body() body: AssetUpdateDto,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    const update = {
      ...body,
      anschaffungsDatum: body.anschaffungsDatum
        ? new Date(body.anschaffungsDatum)
        : undefined,
    }
    return this.assets.update(id, companyId, update)
  }

  /**
   * Dispose (sell / write off) a Sachanlage.
   * Sets verkauftAm + verkaufsPreis. After
   * this, the asset no longer contributes to
   * the Bilanz pool. The Berater uses the
   * sale event to record any Veräußerungs-
   * erlös on the G+V.
   */
  @Post(':id/dispose')
  async dispose(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Body() body: AssetDisposeDto,
  ) {
    if (!companyId) throw new BadRequestException('companyId ist erforderlich')
    return this.assets.dispose(id, companyId, {
      verkauftAm: new Date(body.verkauftAm),
      verkaufsPreis: body.verkaufsPreis,
    })
  }
}
