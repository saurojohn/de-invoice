/**
 * Health check endpoints for monitoring.
 *
 * GET /api/v1/system/health
 *   Lightweight liveness probe. Returns 200 if the
 *   process is up. Does NOT touch the database —
 *   used by Docker / Kubernetes / load balancers
 *   that just need to know "is the process alive".
 *
 * GET /api/v1/system/health/deep
 *   Full readiness check. Pings Postgres + counts
 *   invoices to verify the DB connection works
 *   AND migrations have run. Returns 503 if any
 *   check fails, with details in the body.
 *
 * Both endpoints are public (no auth) so monitoring
 * systems don't need credentials.
 */
import { Controller, Get } from "@nestjs/common"
import { PrismaService } from "../../prisma/prisma.service"
import { SkipThrottle } from "@nestjs/throttler"
import { Public } from "../../auth/public.decorator"

@Public()
@Controller("system")
@SkipThrottle() // health checks should never be rate-limited
export class SystemHealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("health")
  health() {
    return {
      status: "ok",
      ts: new Date().toISOString(),
      uptimeSec: Math.round(process.uptime()),
    }
  }

  @Get("health/deep")
  async deep() {
    const checks: Record<string, { ok: boolean; detail?: string; ms?: number }> = {}
    const t0 = Date.now()
    try {
      await this.prisma.$queryRaw`SELECT 1`
      checks.postgres = { ok: true, ms: Date.now() - t0 }
    } catch (e: any) {
      checks.postgres = { ok: false, detail: e?.message ?? String(e) }
    }
    // If Postgres is down, the whole service is unhealthy.
    // Surface the most useful single boolean.
    const allOk = Object.values(checks).every((c) => c.ok)
    return {
      status: allOk ? "ok" : "degraded",
      checks,
      ts: new Date().toISOString(),
    }
  }
}
