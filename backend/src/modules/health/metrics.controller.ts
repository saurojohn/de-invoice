// Tier 12: Prometheus-format /metrics endpoint.
//
// Hand-rolled collector (no @willsoto/nestjs-prometheus) — the surface we
// need is 3 gauges + 1 counter + 1 histogram. The host's node_exporter
// covers process_cpu/heap/etc., so we don't need the prom-client default
// metrics.
//
// Endpoint is GET /metrics (no /api/v1/ prefix — Prometheus scrapers use
// a flat path). Throttler still applies (600/60s default) so a runaway
// scraper can't DoS the endpoint.

import { Controller, Get, OnApplicationBootstrap, Res } from '@nestjs/common'
import { Response } from 'express'
import { PrismaService } from '../../prisma/prisma.service'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'

const STARTED_AT = Date.now()
const VERSION = process.env.npm_package_version || '0.0.0'

interface Histogram {
  buckets: { le: number; count: number }[]
  sum: number
  count: number
  labels: Record<string, string>
}

// Buckets in seconds. Chosen so p50, p95, p99 land in distinct buckets
// (meaningful Grafana heatmap).
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]

interface Counter {
  value: number
  labels: Record<string, string>
}

interface Gauge {
  value: number
  labels: Record<string, string>
}

const labelsKey = (labels: Record<string, string>): string =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join('\x00')

const labelKV = (labels: Record<string, string>): string =>
  Object.entries(labels)
    .map(([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    .join(',')

// /api/v1/customers/8c6a9669-... → /api/v1/customers/:id
// Naive UUID/number detection — good enough for top-10 routes.
const normalizeRoute = (route: string): string =>
  route
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      ':id',
    )
    .replace(/\/\d+(?=\/|$)/g, '/:n')

@Controller('metrics')
export class MetricsController implements OnApplicationBootstrap {
  private readonly counters = new Map<string, Counter>()
  private readonly gauges = new Map<string, Gauge>()
  private readonly histograms = new Map<string, Histogram>()
  private errorCount = 0

  constructor(private readonly prisma: PrismaService) {}

  // Express middleware — registered in main.ts so it wraps ALL routes.
  // The static instance pointer is wired in onApplicationBootstrap()
  // below — the middleware only runs after Nest has finished
  // bootstrapping, so the timing is safe.
  static instance: MetricsController | null = null

  static setInstance(c: MetricsController) {
    MetricsController.instance = c
  }

  onApplicationBootstrap() {
    MetricsController.setInstance(this)
  }

  static middleware() {
    return (req: any, res: any, next: any) => {
      const start = process.hrtime.bigint()
      res.on('finish', () => {
        const inst = MetricsController.instance
        if (!inst) return
        const route = normalizeRoute(req.route?.path || req.path || 'unknown')
        if (route === '/metrics' || route.startsWith('/metrics')) return
        const seconds = Number(process.hrtime.bigint() - start) / 1e9
        const status = res.statusCode as number
        inst.recordRequest(req.method, route, status, seconds)
      })
      next()
    }
  }

  recordRequest(method: string, route: string, status: number, seconds: number) {
    // Counter: requests by (method, route, status)
    const cLabels = { method, route, status: String(status) }
    const cKey = labelsKey(cLabels)
    const c = this.counters.get(cKey) || { value: 0, labels: cLabels }
    c.value += 1
    this.counters.set(cKey, c)
    if (status >= 500) this.errorCount += 1

    // Histogram: latency by (method, route) — labels kept on the
    // histogram itself, not in a parallel map.
    const hLabels = { method, route }
    const hKey = labelsKey(hLabels)
    let h = this.histograms.get(hKey)
    if (!h) {
      h = {
        buckets: BUCKETS.map((le) => ({ le, count: 0 })),
        sum: 0,
        count: 0,
        labels: hLabels,
      }
      this.histograms.set(hKey, h)
    }
    for (const b of h.buckets) {
      if (seconds <= b.le) b.count += 1
    }
    h.sum += seconds
    h.count += 1
  }

  // Pull-model: each scrape pings DB + storage. If DB is briefly
  // unreachable, the gauge shows 0 for one scrape interval.
  private async checkDb(): Promise<number> {
    try {
      await this.prisma.$queryRaw`SELECT 1`
      return 1
    } catch {
      return 0
    }
  }

  private checkStorage(): number {
    const dir = process.env.STORAGE_PATH || path.join(os.homedir(), 'data', 'invoice-system')
    try {
      fs.mkdirSync(dir, { recursive: true })
      const probe = path.join(dir, `.metrics-probe-${process.pid}`)
      fs.writeFileSync(probe, 'ok')
      fs.unlinkSync(probe)
      return 1
    } catch {
      return 0
    }
  }

  @Get()
  async metrics(@Res() res: Response) {
    const dbOk = await this.checkDb()
    const storageOk = this.checkStorage()
    const uptime = (Date.now() - STARTED_AT) / 1000
    const mem = process.memoryUsage()

    // Build the response in a single pass — stable key order so two
    // consecutive scrapes produce byte-identical output (helps with
    // diff-based dashboards).
    const lines: string[] = []
    const push = (s: string) => lines.push(s)

    push('# HELP de_invoice_uptime_seconds Process uptime in seconds')
    push('# TYPE de_invoice_uptime_seconds gauge')
    push(`de_invoice_uptime_seconds ${uptime}`)

    push('# HELP de_invoice_db_connected 1 if DB responds to SELECT 1, 0 otherwise')
    push('# TYPE de_invoice_db_connected gauge')
    push(`de_invoice_db_connected ${dbOk}`)

    push('# HELP de_invoice_storage_writable 1 if storage dir is writable, 0 otherwise')
    push('# TYPE de_invoice_storage_writable gauge')
    push(`de_invoice_storage_writable ${storageOk}`)

    push('# HELP de_invoice_process_resident_memory_bytes RSS in bytes')
    push('# TYPE de_invoice_process_resident_memory_bytes gauge')
    push(`de_invoice_process_resident_memory_bytes ${mem.rss}`)

    push('# HELP de_invoice_process_heap_bytes Heap used in bytes')
    push('# TYPE de_invoice_process_heap_bytes gauge')
    push(`de_invoice_process_heap_bytes ${mem.heapUsed}`)

    push('# HELP de_invoice_build_info Build info (always 1)')
    push('# TYPE de_invoice_build_info gauge')
    push(
      `de_invoice_build_info{version="${VERSION}",node="${process.version}"} 1`,
    )

    // Tier 193 — business-level gauges. Pulled at scrape
    // time via parallel index-only counts. Each is a
    // single SELECT COUNT(*) — fast even with 100k
    // rows. We don't aggregate by type/status here
    // (Prometheus labels would explode the cardinality
    // if every invoice status became a label); just
    // total counts.
    try {
      const [companies, users, invoices, customers] = await Promise.all([
        this.prisma.company.count(),
        this.prisma.user.count(),
        this.prisma.invoice.count(),
        this.prisma.customer.count(),
      ])
      push('# HELP de_invoice_business_companies Total companies in DB')
      push('# TYPE de_invoice_business_companies gauge')
      push(`de_invoice_business_companies ${companies}`)

      push('# HELP de_invoice_business_users Total users in DB')
      push('# TYPE de_invoice_business_users gauge')
      push(`de_invoice_business_users ${users}`)

      push('# HELP de_invoice_business_invoices Total invoices in DB (all types/statuses)')
      push('# TYPE de_invoice_business_invoices gauge')
      push(`de_invoice_business_invoices ${invoices}`)

      push('# HELP de_invoice_business_customers Total customers in DB')
      push('# TYPE de_invoice_business_customers gauge')
      push(`de_invoice_business_customers ${customers}`)
    } catch (e: any) {
      // If the business count fails, don't fail the
      // whole scrape — the operator still wants uptime
      // + process metrics.
      push(
        `# de_invoice_business_count_error: ${(e?.message ?? String(e)).replace(/\n/g, ' ')}`,
      )
    }

    push('# HELP de_invoice_errors_total HTTP responses with status >= 500 since process start')
    push('# TYPE de_invoice_errors_total counter')
    push(`de_invoice_errors_total ${this.errorCount}`)

    push('# HELP de_invoice_http_requests_total HTTP requests by method/route/status')
    push('# TYPE de_invoice_http_requests_total counter')
    for (const c of [...this.counters.values()].sort((a, b) =>
      labelsKey(a.labels) < labelsKey(b.labels) ? -1 : 1,
    )) {
      push(
        `de_invoice_http_requests_total{${labelKV(c.labels)}} ${c.value}`,
      )
    }

    push('# HELP de_invoice_http_request_duration_seconds Request duration in seconds')
    push('# TYPE de_invoice_http_request_duration_seconds histogram')
    for (const h of [...this.histograms.values()].sort((a, b) =>
      labelsKey(a.labels) < labelsKey(b.labels) ? -1 : 1,
    )) {
      const base = labelKV(h.labels)
      for (const b of h.buckets) {
        push(
          `de_invoice_http_request_duration_seconds_bucket{${base},le="${b.le}"} ${b.count}`,
        )
      }
      push(
        `de_invoice_http_request_duration_seconds_bucket{${base},le="+Inf"} ${h.count}`,
      )
      push(
        `de_invoice_http_request_duration_seconds_sum{${base}} ${h.sum}`,
      )
      push(
        `de_invoice_http_request_duration_seconds_count{${base}} ${h.count}`,
      )
    }

    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
    res.send(lines.join('\n') + '\n')
  }
}
