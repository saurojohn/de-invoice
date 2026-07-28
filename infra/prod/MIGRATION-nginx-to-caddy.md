# Migration: nginx + certbot → Caddy

> **Tier 114.** This guide is for existing de-invoice deployments
> that were set up under the old `nginx.conf` + `certbot` pattern
> (Tier 17). New deployments skip this entirely — the `caddy`
> service in `docker-compose.yml` is the default.

The migration takes about 15 minutes and has zero expected
downtime if you follow the staged-switch order below.

## Why migrate

- **Auto-TLS, zero maintenance.** Caddy issues and renews
  Let's Encrypt certs itself. No `certbot.timer`, no
  `/etc/letsencrypt/renewal-hooks`, no "cert expired at 3am"
  alerts.
- **Fewer moving parts.** Drops two host packages
  (`certbot`, `python3-certbot-nginx`) and one site config
  (`/etc/nginx/sites-available/rechnung.shleder.de`).
- **Same security guarantees.** The Caddyfile in this
  directory ships the same security headers, the same
  rate limit on `/api/v1/auth`, and the same proxy
  topology as the old `nginx.conf`.

## Prerequisites

- A working Tier 17/18/24 deploy (nginx on host, certbot
  renewing certs, `docker compose -f infra/prod/docker-compose.yml up -d`).
- SSH access as the `deploy` user.
- 15 minutes of focused time.
- The domain's DNS A record still pointing at the VPS.

## Migration steps

### 1. Snapshot the current state

```bash
# Capture the current cert (we'll need it to compare
# the new Caddy-issued cert against the old certbot
# cert on the cutover).
sudo openssl x509 -in /etc/letsencrypt/live/rechnung.shleder.de/cert.pem \
  -noout -subject -dates -issuer

# Note the current external IP (we want to verify it
# doesn't change during migration).
curl -4 https://ifconfig.co
```

### 2. Pull the latest infra

```bash
cd /opt/de-invoice
git pull
```

This brings in:
- `infra/prod/Caddyfile` (replaces `nginx.conf`)
- `infra/prod/docker-compose.yml` (adds the `caddy` service,
  drops the unused `nginxconf` volume)
- `infra/prod/deploy-prep.sh` (no longer installs certbot)

### 3. Add the `caddy` service to the running stack

```bash
cd /opt/de-invoice/infra/prod
docker compose up -d caddy
```

Watch the logs:

```bash
docker compose logs -f caddy
```

You should see:

```
{"level":"info","ts":...,"msg":"serving initial configuration"}
```

Caddy will try to issue a Let's Encrypt cert on the first
incoming HTTPS request. **Right now the ports are still
served by nginx**, so Caddy can't bind them — but the
`caddy` container will sit waiting and that is fine.

### 4. Verify Caddy is healthy before the cutover

```bash
# The Caddy admin API listens on :2019 inside the container.
docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile
# Expected: "valid configuration"

# Confirm the Caddyfile mounts correctly.
docker compose exec caddy cat /etc/caddy/Caddyfile | head -20
```

If `caddy validate` fails, **stop here** and fix the
Caddyfile before continuing. Common issues:
- The `email` directive is missing → add one.
- The domain name doesn't match your DNS → fix the
  `rechnung.shleder.de` site block.

### 5. Stop nginx (the cutover)

This is the only step with any real downtime (~5 seconds):

```bash
sudo systemctl stop nginx
```

The 80 + 443 ports are now free. Caddy, which has been
sitting waiting, will (on its next config poll) bind them
and start serving. The first request to `https://rechnung.shleder.de`
will trigger the ACME HTTP-01 challenge; Caddy will issue
the new cert, install it, and serve the page. Total time
from `systemctl stop nginx` to "site loads": usually <10s.

### 6. Verify the new cert

```bash
# From your workstation (NOT the VPS, because
# the VPS sees Caddy as 127.0.0.1 sometimes):
curl -vI https://rechnung.shleder.de 2>&1 | grep -E '(< HTTP|issuer|expire|subject)'

# Expect:
#   < HTTP/2 200
#   issuer: C = US, O = Let's Encrypt, CN = R3 (or R10/R11)
#   expire: ... 90 days from now
#   subject: CN = rechnung.shleder.de
```

Also verify the HSTS header is present:

```bash
curl -sI https://rechnung.shleder.de | grep -i strict-transport
# Expect: strict-transport-security: max-age=31536000; includeSubDomains; preload
```

### 7. Disable + uninstall the old nginx + certbot

Only do this once you've confirmed step 6 passes (cert
issued, HSTS present, `/api/v1/health` returns 200).

```bash
# Disable nginx so it doesn't restart on reboot.
sudo systemctl disable nginx

# Verify Caddy is still serving.
curl -sI https://rechnung.shleder.de | head -3

# Uninstall. On Debian/Ubuntu:
sudo apt remove --purge nginx nginx-common nginx-core certbot python3-certbot-nginx
sudo apt autoremove

# Clean up the old config.
sudo rm -rf /etc/nginx /var/log/nginx /var/www/html
```

### 8. Persist Caddy's auto-start

Caddy runs inside a Docker container, so it auto-starts via
the `restart: unless-stopped` policy in `docker-compose.yml`.
There's no separate systemd unit to enable.

Verify Docker itself is enabled (it should be already from
`deploy-prep.sh`):

```bash
sudo systemctl is-enabled docker
# Expect: enabled
```

### 9. Set up renewal monitoring

Caddy renews certs automatically ~30 days before expiry. To
catch the rare case where renewal silently fails (e.g. DNS
misconfiguration, ACME rate limit), wire `/api/v1/health`
into an external uptime monitor:

- **Healthchecks.io** (recommended, free tier): create a
  check that pings every 5 minutes. The backend's
  `/api/v1/health` returns 200 only when the full stack
  (DB + storage) is up, so a failure there is a real signal.
- **UptimeRobot** (alternative, also free): same idea.

This is not specific to Caddy — but it's worth doing
during the migration so you don't lose the renewal
visibility that certbot's systemd timer gave you.

### 10. Final verification

```bash
# Backend health (through Caddy).
curl -s https://rechnung.shleder.de/api/v1/health | jq
# Expect: { "status": "ok", ... }

# Deep health (DB + storage).
curl -s https://rechnung.shleder.de/api/v1/health/deep | jq
# Expect: { "status": "ok", "database": { "status": "ok" }, ... }

# Confirm nginx is gone.
systemctl status nginx
# Expect: Unit nginx.service could not be found.

# Confirm Caddy is in the compose stack.
docker compose -f /opt/de-invoice/infra/prod/docker-compose.yml ps caddy
# Expect: State = Up, Ports = 0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp
```

## Rollback (if something goes wrong)

If Caddy is misbehaving and you need the old nginx back:

```bash
# Reinstall nginx + certbot.
sudo apt install -y nginx certbot python3-certbot-nginx

# Restore the old config from /opt/de-invoice/infra/prod/nginx.conf
# (the file is still in the repo).
sudo cp /opt/de-invoice/infra/prod/nginx.conf \
        /etc/nginx/sites-available/rechnung.shleder.de
sudo ln -sf /etc/nginx/sites-available/rechnung.shleder.de \
            /etc/nginx/sites-enabled/
sudo nginx -t

# Stop Caddy, start nginx.
cd /opt/de-invoice/infra/prod
docker compose stop caddy
sudo systemctl enable --now nginx
sudo certbot --nginx -d rechnung.shleder.de --non-interactive --agree-tos \
  -m ops@shleder.de
```

You'll lose ~5 minutes of cert validity (certbot will issue
a new cert) but the site stays up throughout.

## FAQ

**Q: Does this migration lose any data?**
A: No. The cert is the only thing that changes. The DB,
volumes, and configs are untouched.

**Q: Will Caddy rate-limit by source IP correctly?**
A: Yes, by default. The Caddyfile's `rate_limit {remote_host} 10r/m`
uses the source IP, which is correct as long as you're NOT behind
Cloudflare. If you are, follow step 7 in the Caddyfile
(uncomment the `trusted_proxies` block) so Caddy reads the
`CF-Connecting-IP` header instead.

**Q: What about HSTS preload?**
A: The Caddyfile already sets `max-age=31536000; includeSubDomains; preload`.
Before submitting your domain to https://hstspreload.org/, confirm
HTTPS works reliably for at least a month (HSTS preload is a
one-way ratchet — you can't undo it without shipping a browser
update).

**Q: Can I run Caddy as a host systemd service instead of a container?**
A: Yes. The `caddy` service in `docker-compose.yml` is the
default because it keeps everything in one `docker compose up -d`,
but the Caddyfile is portable. To run Caddy on the host:
1. `apt install caddy` (Caddy is in Debian/Ubuntu's default repos).
2. `cp infra/prod/Caddyfile /etc/caddy/Caddyfile`.
3. `systemctl enable --now caddy`.

You'd then remove the `caddy` service from the compose file and
skip the `docker compose up -d caddy` step.
