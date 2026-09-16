import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  BadRequestException,
  Res,
} from '@nestjs/common'
import { Response } from 'express'
import { Auth, Require } from '../../auth/roles.decorator'
import { InvoiceTemplateService } from './invoice-template.service'
import { CreateInvoiceTemplateDto, UpdateInvoiceTemplateDto } from './dto/invoice-template.dto'

@Auth()
@Controller('invoice-templates')
export class InvoiceTemplateController {
  constructor(private readonly svc: InvoiceTemplateService) {}

  @Get()
  @Require('company.update')
  async list(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId is required')
    return this.svc.list(companyId)
  }

  @Get(':id')
  @Require('company.update')
  async getOne(@Param('id') id: string, @Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId is required')
    return this.svc.getOne(id, companyId)
  }

  @Post()
  @Require('company.update')
  async create(@Body() body: CreateInvoiceTemplateDto) {
    if (!body?.companyId) throw new BadRequestException('companyId is required')
    return this.svc.create(body.companyId, {
      name: body.name,
      templateType: body.templateType,
      configJson: body.configJson,
      isDefault: body.isDefault,
    })
  }

  @Put(':id')
  @Require('company.update')
  async update(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Body() body: UpdateInvoiceTemplateDto,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required')
    return this.svc.update(id, companyId, body)
  }

  @Delete(':id')
  @Require('company.update')
  async delete(@Param('id') id: string, @Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId is required')
    return this.svc.delete(id, companyId)
  }

  /**
   * Render a preview PDF with the template's
   * config + a sample invoice. Returns
   * application/pdf so the browser can
   * open it inline (or the user can
   * download it). The sample data is
   * hard-coded — the user does NOT need
   * to have a real invoice to see the
   * template.
   */
  @Post(':id/preview')
  @Require('company.update')
  async preview(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Res() res: Response,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required')
    const buf = await this.svc.renderPreview(id, companyId)
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="template-preview.pdf"`,
    })
    res.end(buf)
  }
}
