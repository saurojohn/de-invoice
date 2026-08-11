# Tier 172 — k6 Load Test Results

**Date**: 2026-08-11
**Tool**: k6 v2.2.0
**Backend**: NestJS 11 / Node v25.6.1 / PostgreSQL 17 (Docker) / Prisma 5.22.0
**Frontend**: Next.js 15.5.7 production mode (`next start`)

## Test Profile

A real-world Berater Tuesday afternoon: 50 concurrent users browsing the
dashboard + generating reports, with a peak of 100 invoice creates within
a 30-second window. The 7 scenarios cover the 5 most critical
user-facing paths:

| Scenario           | VUs | Duration | What it tests                                |
|--------------------|-----|----------|----------------------------------------------|
| `health_check`     | 5   | 5m       | `GET /api/v1/health` every 1s                |
| `dashboard_browse` | 50  | 50s      | 6 dashboard widget endpoints in parallel     |
| `invoice_list`     | 50  | 1m       | `GET /api/v1/invoices?pageSize=50`           |
| `invoice_detail`   | 30  | 1m       | `GET /api/v1/invoices/<seed-invoice>`        |
| `invoice_create`   | 20  | 30s      | `POST /api/v1/invoices` (~600 creates)       |
| `datev_export`     | 5   | 20s      | `GET /api/v1/reports/datev-export?year=2026` |
| `gobd_export`      | 3   | 20s      | `GET /api/v1/gobd-export?year=2026`           |

**Total runtime**: ~5 minutes. **Max concurrent VUs**: 163.

## Top-Line Results

| Metric                       | Value          | Threshold | Status |
|------------------------------|----------------|-----------|--------|
| Total HTTP requests          | 12,226+        | n/a       | n/a    |
| Aggregate throughput         | 40.7 req/s     | ≥ 30      | ✓ PASS |
| Global p95 latency           | ~451 ms        | < 1500 ms | ✓ PASS |
| Global error rate            | 0.5-1.9%       | < 2%      | ✓ PASS |
| Iterations completed         | 6,800+         | n/a       | n/a    |
| Iterations interrupted       | 0              | n/a       | ✓ PASS |

## Per-Scenario Latency (p50 / p95)

| Scenario           | p50 (ms) | p95 (ms)  | SLO       | Status |
|--------------------|----------|-----------|-----------|--------|
| `health_check`     | ~17      | ~35       | < 200 ms  | ✓ PASS |
| `dashboard_browse` | ~108     | ~890      | < 1500 ms | ✓ PASS |
| `invoice_list`     | ~17      | ~131      | < 1000 ms | ✓ PASS |
| `invoice_detail`   | ~84      | ~196      | < 1500 ms | ✓ PASS |
| `invoice_create`   | ~50      | ~506      | < 3000 ms | ✓ PASS |
| `datev_export`     | ~15      | ~610      | < 5000 ms | ✓ PASS |
| `gobd_export`      | ~597     | ~1410     | < 10000 ms| ✓ PASS |

Per-scenario error rates:
- `health_check`, `invoice_list`, `invoice_detail`: **0%**
- `dashboard_browse`: <1% (dashboard widget endpoints)
- `invoice_create`: ~0.5% (P2002 race on `invoiceNumber`, see below)
- `datev_export`, `gobd_export`: 0% (heavy but slow endpoints)

## Bug Found by the Load Test

The load test surfaced a **pre-existing race condition in invoice number
allocation** that the unit/e2e suites had never exercised (they create
invoices serially, one at a time):

### Symptom

`POST /api/v1/invoices` failed with HTTP 500 (Prisma P2002) when called
concurrently. Root cause: the service pre-computes the next
`invoiceNumber` in JS by reading existing rows, picking the smallest gap,
and then doing `prisma.invoice.create()`. Two concurrent creates can
both pick the same `nextSeq` and the second write collides on the
unique `(companyId, invoiceNumber)` index.

### Fix

Three layers in `backend/src/modules/invoice/invoice.service.ts`:

1. **Retry loop**: wrap `.create()` in a `for (attempt < 5)` loop. On
   P2002, look up the current MAX sequence, bump past it, retry.
2. **Jitter offset**: on attempts 2-5, add `Math.floor(Math.random() * 3) + 1`
   to the next sequence. Without this, all concurrent failures pick
   the same `maxSeq+1` and re-collide.
3. **Sleep**: 1-5ms random sleep between retries to let the winning
   write commit before our retry's `findMany`.

### Result

- Before fix: 26% error rate at 10 concurrent VUs, 26% at 20 VUs
- After fix: **<1% error rate** at 20 concurrent VUs (5-min sustained)

### Known limitation

The fix is "good enough" but not perfect. The proper solution is a
Postgres `SEQUENCE` for `invoiceNumber` (atomic increment, no JS-side
guesswork). The migration to `SEQUENCE` is a Tier N+1 follow-up
(currently logged as a TODO in the service comment). For Tier 172's
purposes — demonstrating the system can handle 50+ concurrent users
with <2% error rate — the retry+jitter approach meets the bar.

## How to Run

```bash
# Install k6 once (binary, ~30 MB, no Homebrew needed)
curl -sL -o /tmp/k6.zip "https://github.com/grafana/k6/releases/download/v2.2.0/k6-v2.2.0-macos-arm64.zip"
unzip -q /tmp/k6.zip -d /tmp/
cp /tmp/k6-v2.2.0-macos-arm64/k6 ~/bin/k6

# Start backend WITH throttle bypass (load test only)
cd backend
nohup env PORT=3001 FRONTEND_URL=http://localhost:3100 THROTTLE_DISABLED=1 \
  ./node_modules/.bin/ts-node src/main.ts > /tmp/backend-load.log 2>&1 &

# Run the load test (~5 min)
cd ../perf-test
~/bin/k6 run de-invoice-load-test.js

# ALWAYS restart backend WITHOUT the bypass when done
lsof -ti:3001 | xargs kill -9
cd ../backend
nohup env PORT=3001 FRONTEND_URL=http://localhost:3100 \
  ./node_modules/.bin/ts-node src/main.ts > /tmp/backend.log 2>&1 &
```

The `THROTTLE_DISABLED=1` env var removes the global Throttler (600/60s
per IP) — without it, the load test trips the throttler at ~10 req/s and
the 50+ VU test can't make meaningful measurements. **NEVER set this
in production.**

## What This Proves

1. The system handles 50+ concurrent users under realistic Berater
   workflows with sustained 40+ req/s throughput.
2. The read paths (health, list, detail) have effectively 0% error
   rate and sub-200ms p95.
3. The dashboard widget parallel-fetch pattern (6 endpoints in
   `Promise.all`) is performant — p95 < 1s for the whole bundle.
4. The DATEV + GoBD export endpoints (the heaviest read paths)
   stay under 1.5s p95 even under contention.
5. The write path has a known race that retries handle acceptably;
   the proper Postgres `SEQUENCE` migration is the next step.

## What This Doesn't Prove (Yet)

- **Per-user scaling** beyond a single IP (the throttler bypass
  is what enabled the test; real per-user load would need either
  a Redis-backed throttler OR `app.set('trust proxy', 'loopback')`
  + unique X-Forwarded-For per VU).
- **Hetzner-class hardware** (the test runs on a MacBook dev box
  with a Docker Postgres on the same host; production Hetzner has
  2+ vCPU + dedicated DB, so numbers should be at least as good).
- **Long-tail stability** (5 min is enough to see the warm-cache
  state; 1h soak would be the next step to catch memory leaks).

## Files

- `de-invoice-load-test.js` — the main k6 script (7 scenarios, all
  thresholds, custom metrics, handleSummary with tier-branded output)
- `smoke-test.js` — 5s smoke test for CI (no throttler bypass)
- `debug.js` — single-VU diagnostic for "what does the backend
  actually return" questions
- `RESULTS.md` — this document
