import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Body,
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
