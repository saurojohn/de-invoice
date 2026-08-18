#!/usr/bin/env bash
# e2e 43: /metrics endpoint contract.
#
# Verifies the Prometheus text-format contract:
#   1. Endpoint is reachable (200, correct Content-Type)
#   2. HELP + TYPE metadata lines for every metric we expose
#   3. Gauges present with numeric values (uptime, db_connected,
#      storage_writable, RSS, heap)
#   4. Counter present (errors_total, >= 0)
#   5. Histogram present with all 11 buckets + +Inf + _sum + _count
#   6. After hitting a few endpoints, http_requests_total counter
#      has rows for those routes
#   7. Format is byte-valid (no obviously broken values)

set -uo pipefail
HOST="${HOST:-http://localhost:3001}"
PASS=0
FAIL=0

assert() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "  PASS: $label"
    PASS=$((PASS+1))
  else
    echo "  FAIL: $label (expected: $expected, got: $actual)"
    FAIL=$((FAIL+1))
  fi
}

# Use a hardcoded user/company pair — HeaderAuthGuard accepts these
# directly (no login round-trip needed). Login is also tested
# explicitly (we make a real /auth/login call below so the request
# counter has a row for that route).
# Generate some traffic so http_requests_total populates.
# We use a /auth/login call so we can verify that route also
# gets recorded.
curl -sS -X POST "$HOST/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"info@shleder.de","password":"Test1234!"}' >/dev/null
curl -sS "$HOST/api/v1/customers?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" >/dev/null
curl -sS "$HOST/api/v1/invoices?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" >/dev/null
curl -sS "$HOST/api/v1/products?companyId=$COMPANY_ID" \
  -H "x-user-id: $USER_ID" -H "x-company-id: $COMPANY_ID" >/dev/null

# Scrape /metrics. We capture into a file because $(...) command
# substitution strips trailing newlines, which would break the
# "trailing newline" assertion below.
METRICS_FILE=$(mktemp)
curl -sS "$HOST/metrics" > "$METRICS_FILE"
METRICS=$(cat "$METRICS_FILE")
CT=$(curl -sS -o /dev/null -w '%{content_type}' "$HOST/metrics")

echo "== Endpoint contract =="
assert "content-type starts with text/plain" "1" "$([[ $CT == text/plain* ]] && echo 1 || echo 0)"
assert "non-empty body"                   "1" "$([[ -s "$METRICS_FILE" ]] && echo 1 || echo 0)"
# Trailing-newline check: hex dump the last byte (od -An -tx1)
# so we don't accidentally strip a newline via tr.
LAST_HEX=$(tail -c 1 "$METRICS_FILE" | od -An -tx1 | tr -d ' \n')
assert "trailing newline (0x0a)"          "0a" "$LAST_HEX"

echo "== HELP + TYPE metadata =="
for m in de_invoice_uptime_seconds de_invoice_db_connected \
         de_invoice_storage_writable de_invoice_process_resident_memory_bytes \
         de_invoice_process_heap_bytes de_invoice_build_info \
         de_invoice_errors_total de_invoice_http_requests_total \
         de_invoice_http_request_duration_seconds; do
  assert "HELP $m"   "1" "$(echo "$METRICS" | grep -F -c "# HELP $m " || true)"
  assert "TYPE $m"   "1" "$(echo "$METRICS" | grep -F -c "# TYPE $m " || true)"
done

echo "== Gauges populated =="
# Each gauge should appear with a numeric value.
UPTIME=$(echo "$METRICS" | grep '^de_invoice_uptime_seconds ' | awk '{print $2}')
DBOK=$(echo "$METRICS" | grep '^de_invoice_db_connected ' | awk '{print $2}')
STORAGE=$(echo "$METRICS" | grep '^de_invoice_storage_writable ' | awk '{print $2}')
RSS=$(echo "$METRICS" | grep '^de_invoice_process_resident_memory_bytes ' | awk '{print $2}')
HEAP=$(echo "$METRICS" | grep '^de_invoice_process_heap_bytes ' | awk '{print $2}')

assert "uptime is positive float"        "1" "$(python3 -c "print(1 if float('$UPTIME') > 0 else 0)")"
assert "db_connected is 1"               "1" "$([[ $DBOK == 1 ]] && echo 1 || echo 0)"
assert "storage_writable is 1"           "1" "$([[ $STORAGE == 1 ]] && echo 1 || echo 0)"
assert "rss is positive int"             "1" "$(python3 -c "print(1 if int('$RSS') > 0 else 0)")"
assert "heap is positive int"            "1" "$(python3 -c "print(1 if int('$HEAP') > 0 else 0)")"

echo "== Build info labels =="
assert "build_info has version label"    "1" "$(echo "$METRICS" | grep -F -c 'de_invoice_build_info{version=' || true)"
assert "build_info has node label"       "1" "$(echo "$METRICS" | grep -F -c 'node="v' || true)"

echo "== Counters populated =="
ERRORS=$(echo "$METRICS" | grep '^de_invoice_errors_total ' | awk '{print $2}')
assert "errors_total is numeric"         "1" "$(python3 -c "print(1 if '$ERRORS'.isdigit() else 0)")"
REQ_TOTAL_LINES=$(echo "$METRICS" | grep -F -c 'de_invoice_http_requests_total{')
assert "http_requests_total has rows"    "1" "$([[ $REQ_TOTAL_LINES -ge 1 ]] && echo 1 || echo 0)"

# We hit /api/v1/customers, /api/v1/invoices, /api/v1/products —
# the request counter should have at least one row for each.
# (req.path excludes the query string, so the route label is the
# literal "/api/v1/customers" — no :id substitution because the
# UUID is in the query, not the path.)
ROWS_FOR_CUSTOMERS=$(echo "$METRICS" | grep -F -c 'de_invoice_http_requests_total{method="GET",route="/api/v1/customers",status="200"}')
ROWS_FOR_INVOICES=$(echo "$METRICS"  | grep -F -c 'de_invoice_http_requests_total{method="GET",route="/api/v1/invoices",status="200"}')
ROWS_FOR_PRODUCTS=$(echo "$METRICS"  | grep -F -c 'de_invoice_http_requests_total{method="GET",route="/api/v1/products",status="200"}')
assert "customers route counted"         "1" "$([[ $ROWS_FOR_CUSTOMERS -ge 1 ]] && echo 1 || echo 0)"
assert "invoices route counted"          "1" "$([[ $ROWS_FOR_INVOICES  -ge 1 ]] && echo 1 || echo 0)"
assert "products route counted"          "1" "$([[ $ROWS_FOR_PRODUCTS  -ge 1 ]] && echo 1 || echo 0)"

echo "== Histogram shape =="
# /api/v1/customers should have a histogram row. Each histogram emits
# 11 bucket lines + 1 +Inf line + 1 _sum + 1 _count.
BASE='de_invoice_http_request_duration_seconds_bucket{method="GET",route="/api/v1/customers"'
HIST_BUCKETS=$(echo "$METRICS" | grep -F -c "${BASE},le=")
HIST_INF=$(echo "$METRICS" | grep -F -c "${BASE},le=\"+Inf\"")
HIST_SUM=$(echo "$METRICS" | grep -F -c 'de_invoice_http_request_duration_seconds_sum{method="GET",route="/api/v1/customers"}')
HIST_COUNT=$(echo "$METRICS" | grep -F -c 'de_invoice_http_request_duration_seconds_count{method="GET",route="/api/v1/customers"}')

# We only require at least the +Inf + _sum + _count trio to be present
# (the customers histogram is from this test's request — earlier
# requests to other routes also generated their own histograms).
assert "histogram +Inf bucket present"   "1" "$([[ $HIST_INF   -ge 1 ]] && echo 1 || echo 0)"
assert "histogram _sum present"          "1" "$([[ $HIST_SUM   -ge 1 ]] && echo 1 || echo 0)"
assert "histogram _count present"        "1" "$([[ $HIST_COUNT -ge 1 ]] && echo 1 || echo 0)"

# The customers histogram should have exactly 11 le-bucket lines
# (each bounded bucket), plus 1 +Inf line = 12 total. The grep
# above matches all 12 (the +Inf line has le="+Inf" which
# also starts with "le="). So $HIST_BUCKETS is actually 12.
assert "histogram has 11 buckets + 1 +Inf (12 lines)" "12" "$HIST_BUCKETS"

# Verify the bucket values are monotonically non-decreasing
# (a Prometheus contract — buckets are cumulative).
LE_OK=$(echo "$METRICS" | grep -F "${BASE},le=" | sed -E 's/.*le="([0-9.+Inf]+)".* ([0-9.]+)$/\1 \2/' | python3 -c "
import sys
prev = -1
ok = True
for line in sys.stdin:
    parts = line.strip().split()
    if not parts or len(parts) < 2: continue
    le, cnt = parts[0], parts[1]
    try: cnt = int(cnt)
    except: continue
    if cnt < prev:
        ok = False
        break
    prev = cnt
print(1 if ok else 0)
")
assert "histogram buckets are monotonic" "1" "$LE_OK"

echo "== Format sanity =="
# No NaN / Infinity / negative numbers in the body (basic sanity).
BAD_LINES=$(echo "$METRICS" | grep -F -c -e 'NaN' -e 'Infinity' -e '-0.0' || true)
assert "no NaN/Infinity in body"         "0" "$BAD_LINES"

echo
echo "==== $PASS passed, $FAIL failed ===="
rm -f "$METRICS_FILE"
exit $FAIL
