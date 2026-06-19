/**
 * System endpoints — error tracking + health checks.
 *
 * Public:
 *   POST /api/v1/system/errors        log a frontend error
 *                                      (works pre-auth via SoftAuthGuard)
 *
 * Admin-only (header auth + @Require('users.read')):
 *   GET    /api/v1/system/errors              list (per-company)
 *   POST   /api/v1/system/errors/:id/resolve  mark resolved
 *   POST   /api/v1/system/errors/:id/mute     mark muted
 *   POST   /api/v1/system/errors/prune        delete old (>30d) + resolved
 */
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  SetMetadata,
  UseGuards,
} from "@nestjs/common"
import { Request } from "express"
import { ErrorTrackingService } from "./error-tracking.service"
import { PrismaService } from "../../prisma/prisma.service"
import { HeaderAuthGuard } from "../../auth/header-auth.guard"
import { SoftAuthGuard } from "../../auth/soft-auth.guard"
import { RolesGuard } from "../../auth/roles.guard"
import { Require } from "../../auth/roles.decorator"

@Controller("system")
// No class-level guard — POST /errors is public (SoftAuthGuard),
// the rest use HeaderAuthGuard + RolesGuard per-method.
export class SystemController {
  constructor(
    private readonly tracker: ErrorTrackingService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Frontend posts unhandled errors here. Auth-optional
   * so login-page / register-page crashes (no
   * x-user-id available) still get captured.
   */
  @Post("errors")
  @SetMetadata("publicRoute", true)
  @UseGuards(SoftAuthGuard)
  async captureError(@Body() body: any, @Req() req: Request) {
    if (!body || typeof body.message !== "string") {
      // Don't persist garbage — just 200 OK so the
      // frontend doesn't see a noisy 400 in devtools.
      return { ok: true, deduped: false }
    }
    const saved = await this.tracker.capture({
      source: "frontend",
      kind: body.kind || "unhandled",
      message: String(body.message).slice(0, 4000),
      stack: body.stack ? String(body.stack).slice(0, 4096) : null,
      url: body.url || (req.headers.referer as string) || null,
      method: null,
      statusCode: null,
      userId: (req as any).user?.id || null,
      companyId: (req as any).user?.companyId || null,
      context: {
        component: body.component,
        browser: body.browser,
        level: body.level,
        ...body.context,
      },
      fingerprint: body.fingerprint || undefined,
    })
    return { ok: true, deduped: saved?.occurrences ?? 1 }
  }

  @Get("errors")
  @UseGuards(HeaderAuthGuard, RolesGuard)
  @Require("users.read")
  async listErrors(
    @Req() req: Request,
    @Query("status") status?: string,
    @Query("source") source?: string,
    @Query("take") take?: string,
    @Query("skip") skip?: string,
  ) {
    const companyId = (req as any).user?.companyId
    const where: any = {}
    if (status) where.status = status
    if (source) where.source = source
    // Admin sees only their own company's errors.
    if (companyId) where.companyId = companyId
    const [items, total, openCount] = await Promise.all([
      this.prisma.errorEvent.findMany({
        where,
        orderBy: { lastSeenAt: "desc" },
        take: Math.min(parseInt(take || "50", 10) || 50, 200),
        skip: parseInt(skip || "0", 10) || 0,
      }),
      this.prisma.errorEvent.count({ where }),
      this.prisma.errorEvent.count({
        where: { ...where, status: "open" },
      }),
    ])
    return { items, total, openCount }
  }

  @Post("errors/:id/resolve")
  @UseGuards(HeaderAuthGuard, RolesGuard)
  @Require("users.read")
  async resolve(@Req() req: Request, @Param("id") id: string) {
    const userId = (req as any).user?.id || "system"
    const event = await this.tracker.resolve(id, userId)
    return { ok: true, status: event.status }
  }

  @Post("errors/:id/mute")
  @UseGuards(HeaderAuthGuard, RolesGuard)
  @Require("users.read")
  async mute(@Param("id") id: string) {
    const event = await this.tracker.mute(id)
    return { ok: true, status: event.status }
  }

  @Post("errors/prune")
  @UseGuards(HeaderAuthGuard, RolesGuard)
  @Require("users.read")
  async prune() {
    const result = await this.tracker.prune(30)
    return { ok: true, ...result }
  }
}
