# de-invoice — Cloudflare integration (Tier 19)

Real-IP restore for Cloudflare-fronted deployments + automated
edge-IP list refresh.

## Why this exists

When Cloudflare is in front of nginx (orange-cloud DNS), every
incoming TCP connection comes from a CF edge IP, NOT the real
visitor. nginx's `$remote_addr` therefore shows CF IPs in:
- Access logs (audit/forensics becomes useless)
- Rate-limit zones (10 req/min becomes per-CF-edge, not per-visitor)
- Any future per-IP allowlist (GeoIP, fail2ban, etc)

Without intervention, the auth rate-limit becomes a no-op
because all visitors share one CF edge IP per request, and
the audit log records CF IPs instead of who actually clicked.

## What this tier does

1. **`cloudflare-real-ip.conf`** — nginx `set_real_ip_from` rules
   for every CF IPv4 + IPv6 edge range, plus
   `real_ip_header CF-Connecting-IP` + `real_ip_recursive on`.
   Result: `$remote_addr` is the real visitor IP for all CF traffic.

2. **`refresh-cloudflare-ips.sh`** + systemd timer — fetches the
   current CF edge IP list weekly, validates every CIDR, runs
   `nginx -t` for safety, then reloads. CF changes their list
   occasionally (last 2024-04, before that 2021) — without this
   you'd notice when rate-limit silently breaks for some users.

3. **`backend trust proxy` change** — switched from `trust proxy: true`
   (trusted ANY `X-Forwarded-For` — let attackers spoof IPs to
   bypass rate-limits and poison audit logs) to
   `trust proxy: 'loopback'` (only trust X-Forwarded-For from
   nginx on the same host).

4. **`nginx X-Forwarded-For` change** — switched from
   `$proxy_add_x_forwarded_for` (which appends to client-sent
   values, chain pollution risk) to `$remote_addr` (always uses
   the post-CF-restore socket IP, ignoring client headers).

## Files

| File | Purpose |
|------|---------|
| `cloudflare-real-ip.conf` | nginx include, declares `set_real_ip_from` for every CF range |
| `refresh-cloudflare-ips.sh` | Pulls fresh CF list, validates, writes file, reloads nginx |
| `cloudflare-refresh.service` | systemd service unit, oneshot |
| `cloudflare-refresh.timer` | systemd timer, weekly Mon 04:00 with 1h jitter |
| `test-real-ip.sh` | Docker-based smoke test, 9 assertions |

## One-time install

```bash
# 1. Copy files to the host
sudo mkdir -p /etc/nginx/cloudflare
sudo cp cloudflare-real-ip.conf /etc/nginx/cloudflare/
sudo chmod 644 /etc/nginx/cloudflare/cloudflare-real-ip.conf

# 2. Add to nginx.conf http {} block (currently commented out
#    in infra/prod/nginx.conf — uncomment for production)
sudo $EDITOR /etc/nginx/sites-available/rechnung.shleder.de
# Find the line:
#   # include /etc/nginx/cloudflare/cloudflare-real-ip.conf;
# Uncomment it.

# 3. Test + reload nginx
sudo nginx -t
sudo systemctl reload nginx

# 4. Install the refresh timer
sudo cp cloudflare-refresh.service /etc/systemd/system/
sudo cp cloudflare-refresh.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflare-refresh.timer

# 5. First manual refresh to verify everything works
sudo bash /opt/de-invoice/infra/cloudflare/refresh-cloudflare-ips.sh --apply
sudo journalctl -u cloudflare-refresh.service -n 20
```

## Cloudflare dashboard setup

In addition to the host setup above, configure CF itself:

1. **DNS**: Toggle the orange cloud ON for `rechnung.shleder.de`
   (DNS only mode means CF proxies, "DNS only" = no proxy — wrong).

2. **SSL/TLS → Overview**:
   - Encryption mode: **Full (Strict)**
     - "Full" accepts self-signed certs (insecure)
     - "Full (Strict)" verifies Let's Encrypt cert (correct)
   - Edge Certificates → Always Use HTTPS: ON
   - Minimum TLS Version: 1.2

3. **Security → Settings**:
   - Browser Integrity Check: ON (cheap bot filter)
   - Challenge Passage: 30 minutes
   - Privacy Pass Support: ON

4. **Security → Bots**:
   - Bot Fight Mode: ON (free tier has limited options)
   - Super Bot Fight Mode (paid): blocks obvious bots at edge

5. **Caching → Configuration**:
   - Browser Cache TTL: Respect Existing Headers
   - Crawler Hints: ON

6. **Don't** enable Cloudflare's "Trust Proxy Headers" — we
   handle that at the nginx layer. CF-Connecting-IP is the only
   header CF sets that you should trust.

## Verifying it works

After setup, hit your domain with `curl -v`:

```bash
curl -v https://rechnung.shleder.de/api/v1/health
```

In your nginx access log (`/var/log/nginx/de-invoice.access.log`),
the IP should be the visitor's real IP, NOT a CF edge IP like
`172.64.x.x` or `162.158.x.x`.

## Running the test suite

```bash
bash test-real-ip.sh
```

This spins up an nginx container with the CF real-IP config
loaded (plus a test-only `set_real_ip_from 0.0.0.0/0` so it
accepts curl requests from any source), sends 9 test cases
covering:
- CF-Connecting-IP honored over X-Forwarded-For
- X-Forwarded-For alone cannot spoof
- Direct connection shows real socket IP
- IPv6 works
- Spoofed chain is rejected (real_ip_recursive on)

Output should be `PASS: 9  FAIL: 0`.

## Updating the CF IP list manually

If the timer doesn't run (or you're debugging), refresh by hand:

```bash
# Dry-run — show what would be written
sudo bash refresh-cloudflare-ips.sh

# Apply — write + nginx reload
sudo bash refresh-cloudflare-ips.sh --apply
```

The script validates every CIDR with Python's `ipaddress` module
before writing. If a CF page returns garbage (it has happened),
the script aborts WITHOUT touching the existing file.

## Rollback

If a refresh breaks nginx:

```bash
# 1. Disable the timer
sudo systemctl disable --now cloudflare-refresh.timer

# 2. Restore the last known-good config
#    The script logs the previous content path — easier:
sudo cp /etc/nginx/cloudflare/cloudflare-real-ip.conf.bak \
        /etc/nginx/cloudflare/cloudflare-real-ip.conf
sudo nginx -t && sudo systemctl reload nginx
```

(The `.bak` isn't created automatically yet — manual process.
If you want automated backups, edit the script's `render_output`
section.)

## Security properties

- **No IP spoofing**: nginx reads `CF-Connecting-IP` (set by CF,
  not the client) — clients cannot inject this header. nginx
  also strips any client-supplied `X-Forwarded-For` because we
  use `$remote_addr` (post-CF-restore) instead of
  `$proxy_add_x_forwarded_for`.
- **Backend hardening**: `trust proxy: 'loopback'` only trusts
  X-Forwarded-For from nginx (127.0.0.0/8). Direct requests to
  the backend port (which shouldn't be exposed) won't get
  trust-proxy treatment.
- **Fail-closed refresh**: refresh script validates new IPs with
  `nginx -t` BEFORE replacing the live file. If CF returns
  garbage or a config typo, the old file stays in place.

## What this tier does NOT do

- Cloudflare Access (auth at edge): out of scope, requires
  Cloudflare Zero Trust setup + JWT validation.
- Cloudflare Workers (edge compute): out of scope, you can layer
  these on top if needed.
- Cloudflare Rate Limiting (their paid rate-limit feature): we
  use nginx + backend @Throttle, not CF's feature. Redundant
  if you have CF Pro/Enterprise but helpful for free tier.
- Bot management beyond Bot Fight Mode: real bot management
  needs CF Pro/Business tier.