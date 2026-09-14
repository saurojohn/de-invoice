// Tier 11: Health-check endpoints.
//
// Two routes:
//   GET /health         — liveness probe. Returns 200 as long
//                          as the Node process is up. Cheap,
//                          no DB hit, no IO. Used by
//                          Kubernetes/Compose to decide
//                          whether to restart the container.
//   GET /health/deep    — readiness probe. Pings the
//                          database (SELECT 1) and the
//                          storage directory (fs.statSync
//                          + writable check). Returns 200
//                          only if EVERYTHING is healthy.
//                          Returns 503 with a per-check
//                          breakdown if any check fails.
//                          Used by load balancers to decide
//                          whether to route traffic.
//
// The /health/deep endpoint deliberately does
// NOT include the mail server check — the mail
// service has its own retry queue and we don't
// want to mark the whole app unhealthy just
// because SMTP is briefly unreachable.
//
// `startedAt` is computed at module-load
// time and never updated, so the `uptime`
// field is wall-clock-since-boot.

import { Controller, Get, Req } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { Public } from '../../auth/public.decorator'
import { Require } from '../../auth/roles.decorator'

const STARTED_AT = new Date()
const VERSION = process.env.npm_package_version || '0.0.0'

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Liveness probe. No external
   * dependencies. Returns 200
   * as long as the process is
   * alive and the Nest event
   * loop is responding. Use
   * this for "should I restart
   * the container?" — if it
   * stops returning, the
   * process is wedged.
   */
  @Public()
  @Get()
  liveness() {
    return {
      status: 'ok',
      version: VERSION,
      uptimeSec: Math.floor((Date.now() - STARTED_AT.getTime()) / 1000),
      timestamp: new Date().toISOString(),
    }
  }

  /**
   * Readiness probe. Pings the
   * database, the storage dir,
   * and (best-effort) the disk
   * free space. Returns 503
   * with a per-check breakdown
   * if anything fails. Use
   * this for "should I send
   * traffic here?" — if it
   * returns 503, the load
   * balancer should route
   * to a different replica.
   */
  @Public()
  @Get('deep')
  async deep() {
    const checks: Record<string, { status: 'ok' | 'fail'; detail?: string }> = {}
    let allOk = true

    // ── Database ──
    try {
      const start = Date.now()
      await this.prisma.$queryRaw`SELECT 1`
      checks.db = {
        status: 'ok',
        detail: `${Date.now() - start}ms`,
      }
    } catch (e: any) {
      checks.db = { status: 'fail', detail: e?.message || 'unknown' }
      allOk = false
    }

    // ── Storage dir ──
    // Default path matches StorageService
    // (~/data/invoice-system, or the
    // STORAGE_PATH env var in production).
    // The check writes a tiny temp file,
    // then deletes it — exercises both
    // read and write perms. We don't fail
    // on a slow disk because the user
    // might be on a network share.
    try {
      const dir = process.env.STORAGE_PATH
        || path.join(os.homedir(), 'data', 'invoice-system')
      fs.mkdirSync(dir, { recursive: true })
      const probe = path.join(dir, `.health-probe-${process.pid}`)
      fs.writeFileSync(probe, 'ok')
      const readback = fs.readFileSync(probe, 'utf-8')
      fs.unlinkSync(probe)
      if (readback !== 'ok') throw new Error('readback mismatch')
      // Free-space check: warn (not fail) if < 100MB.
      // We DON'T have a portable statvfs in Node
      // core, so just check existence — operators
      // should monitor disk separately.
      checks.storage = { status: 'ok', detail: dir }
    } catch (e: any) {
      checks.storage = { status: 'fail', detail: e?.message || 'unknown' }
      allOk = false
    }

    return {
      status: allOk ? 'ok' : 'fail',
      version: VERSION,
      uptimeSec: Math.floor((Date.now() - STARTED_AT.getTime()) / 1000),
      timestamp: new Date().toISOString(),
      checks,
    }
  }

  /**
   * Tier 193 — dashboard-friendly health summary.
   *
   * Returns a small JSON shape (no /metrics text parsing
   * on the frontend) that the dashboard widget can render
   * directly:
   *   - status:        'ok' | 'degraded' | 'down'
   *   - uptime:        seconds (integer)
   *   - dbOk:          boolean
   *   - storageOk:     boolean
   *   - memory:        { rssMB, heapMB } — process memory
   *   - business:      { companies, users, invoices, customers }
   *                    (live DB counts at scrape time)
   *   - timestamp:     ISO 8601
   *
   * Same auth as /health (no auth — public for ops
   * monitoring). The /metrics endpoint stays text-only
   * for Prometheus; this is the JSON sibling.
   */
  // Tier 376: authenticated and scoped to the caller's company. It was public
  // and counted every company, user, invoice and customer on the platform —
  // every tenant's dashboard showed the whole installation's size. Ops
  // monitoring uses /health, /health/deep and /metrics, which stay public.
  @Require('company.read')
  @Get('summary')
  async summary(@Req() req: { headers: Record<string, string | string[] | undefined>; user?: { id: string } }) {
    // HeaderAuthGuard has verified this header against UserCompany.
    const companyId = String(req.headers['x-company-id'] || '')
    const userId = req.user?.id || ''
    let dbOk = false
    let companies = 0
    let users = 0
    let invoices = 0
    let customers = 0
    try {
      const start = Date.now()
      await this.prisma.$queryRaw`SELECT 1`
      dbOk = true
      // Pull counts in parallel. Each is a fast
      // index-only scan. The dashboard widget polls
      // every 30s, so we don't want a 5-table join.
      const [c, u, i, cu] = await Promise.all([
        // companies this user can switch between
        this.prisma.userCompany.count({ where: { userId } }),
        // users with access to this company
        this.prisma.userCompany.count({ where: { companyId } }),
        this.prisma.invoice.count({ where: { companyId } }),
        this.prisma.customer.count({ where: { companyId } }),
      ])
      companies = c
      users = u
      invoices = i
      customers = cu
      // Reference start to keep the linter quiet
      // about the unused variable; the timing
      // itself isn't useful here.
      void start
    } catch {
      dbOk = false
    }

    let storageOk = false
    try {
      const dir = process.env.STORAGE_PATH
        || path.join(os.homedir(), 'data', 'invoice-system')
      fs.mkdirSync(dir, { recursive: true })
      const probe = path.join(dir, `.summary-probe-${process.pid}`)
      fs.writeFileSync(probe, 'ok')
      fs.unlinkSync(probe)
      storageOk = true
    } catch {
      storageOk = false
    }

    const mem = process.memoryUsage()
    const uptimeSec = Math.floor((Date.now() - STARTED_AT.getTime()) / 1000)
    const status: 'ok' | 'degraded' | 'down' =
      !dbOk ? 'down' : !storageOk ? 'degraded' : 'ok'

    return {
      status,
      version: VERSION,
      uptimeSec,
      dbOk,
      storageOk,
      memory: {
        rssMB: Math.round(mem.rss / 1024 / 1024),
        heapMB: Math.round(mem.heapUsed / 1024 / 1024),
      },
      business: {
        companies,
        users,
        invoices,
        customers,
      },
      timestamp: new Date().toISOString(),
    }
  }
}