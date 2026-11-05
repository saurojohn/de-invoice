import { Controller, Get, Param, Res } from '@nestjs/common'
import type { Response } from 'express'
import { Public } from '../../auth/public.decorator'
import { FilingCalendarService } from './filing-calendar.service'

/**
 * Tier 805 — GET /calendar/<token>.ics, the deadlines for a calendar app.
 * Public: a calendar app sends no credentials; the token is the credential
 * (filing-calendar.service.ts). 404 for an unknown or withdrawn link.
 */
@Controller('calendar')
export class FilingCalendarController {
  constructor(private calendar: FilingCalendarService) {}

  @Public()
  @Get(':token')
  async feed(@Param('token') token: string, @Res() res: Response) {
    const ics = await this.calendar.feed(token)
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8')
    res.setHeader('Content-Disposition', 'inline; filename="steuertermine.ics"')
    res.setHeader('Cache-Control', 'private, max-age=900')
    // the URL is the secret: never sent on as a Referer, never indexed
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Robots-Tag', 'noindex')
    res.send(ics)
  }
}
