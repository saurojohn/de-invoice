/**
 * Tier 156: Note template controller.
 *
 *   GET    /api/v1/note-templates?companyId=…
 *     → NoteTemplateRow[]
 *     Auto-seeds 5 German defaults on first touch
 *     (same convention as Tier 151 Mahnung-Vorlagen).
 *
 *   POST   /api/v1/note-templates?companyId=…
 *     body { label, text, sortOrder? }
 *     → NoteTemplateRow
 *
 *   PATCH  /api/v1/note-templates/:id?companyId=…
 *     body { label?, text?, sortOrder? }
 *     → NoteTemplateRow
 *     Editing clears the `isDefault` badge.
 *
 *   DELETE /api/v1/note-templates/:id?companyId=…
 *     → { ok: true }
 *
 *   POST   /api/v1/note-templates/:id/preview?companyId=…
 *     body { customerName?, invoiceNumber?, dueDate?, total?, companyName? }
 *     → { text: string }   // placeholders substituted
 *     The frontend uses this to show the operator a
 *     preview when they click "Vorschau" on a
 *     template row in the settings page.
 *
 *   POST   /api/v1/note-templates/reset-defaults?companyId=…
 *     Wipes all custom templates and re-seeds the
 *     5 German defaults. Useful when the operator
 *     wants to start over (mirrors the Mahnung
 *     templates/reset endpoint).
 *
 * Auth: the standard HeaderAuthGuard + @Require.
 * The operator's permission for "invoice.update"
 * matches what the Mahnung-Vorlagen editor uses
 * — same screen, same action.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common'
import { Auth, Require } from '../../auth/roles.decorator'
import { NoteTemplateService } from './note-template.service'
import { CreateNoteTemplateDto, PreviewNoteTemplateDto, UpdateNoteTemplateDto } from './dto/note-template.dto'

@Auth()
@Controller('note-templates')
export class NoteTemplateController {
  constructor(private readonly svc: NoteTemplateService) {}

  @Get()
  @Require('invoice.read')
  async list(@Query('companyId') companyId: string) {
    return this.svc.listForCompany(companyId)
  }

  @Post()
  @Require('invoice.update')
  async create(
    @Query('companyId') companyId: string,
    @Body() body: CreateNoteTemplateDto,
  ) {
    return this.svc.create(companyId, body)
  }

  @Patch(':id')
  @Require('invoice.update')
  async update(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Body() body: UpdateNoteTemplateDto,
  ) {
    return this.svc.update(id, companyId, body)
  }

  @Delete(':id')
  @Require('invoice.update')
  async delete(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
  ) {
    return this.svc.delete(id, companyId)
  }

  @Post(':id/preview')
  @Require('invoice.read')
  async preview(
    @Param('id') id: string,
    @Query('companyId') companyId: string,
    @Body() body: PreviewNoteTemplateDto,
  ) {
    if (!id || !companyId) {
      throw new BadRequestException('id and companyId are required')
    }
    const list = await this.svc.listForCompany(companyId)
    const tpl = list.find((t) => t.id === id)
    if (!tpl) {
      throw new BadRequestException('Template not found')
    }
    return { text: this.svc.render(tpl.text, body || {}) }
  }

  @Post('reset-defaults')
  @Require('invoice.update')
  async resetDefaults(@Query('companyId') companyId: string) {
    if (!companyId) {
      throw new BadRequestException('companyId is required')
    }
    await this.svc.listForCompany(companyId).then(async (existing) => {
      for (const t of existing) {
        await this.svc.delete(t.id, companyId)
      }
    })
    const n = await this.svc.seedDefaults(companyId)
    return { reset: n }
  }
}
