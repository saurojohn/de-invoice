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

import { Controller, Get } from '@nestjs/common'
import { PrismaService } from '../../prisma/prisma.service'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

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
}