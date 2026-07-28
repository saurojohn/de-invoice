# Security hardening — de-invoice production

> **Tier 114.** This is the running checklist. The Tier 24
> `deploy-prep.sh` script applies the host-level items
> automatically; the rest is for the operator to maintain.

A ✅ means the item is applied by `deploy-prep.sh` or
sitting in `.env.example`. A 📋 means the operator must
do it manually (or it requires a real environment like
a Hetzner account).

## 1. Host

| # | Control | Status | Where / how |
|---|---------|--------|-------------|
| 1 | SSH key-only auth | ✅ | `deploy-prep.sh` sets `PasswordAuthentication no` |
| 2 | Root login disabled | ✅ | `deploy-prep.sh` sets `PermitRootLogin no` |
| 3 | X11 forwarding disabled | ✅ | `deploy-prep.sh` sets `X11Forwarding no` |
| 4 | MaxAuthTries = 3 | ✅ | `deploy-prep.sh` |
| 5 | LoginGraceTime = 30s | ✅ | `deploy-prep.sh` |
| 6 | fail2ban (5 retries → 1h ban) | ✅ | `deploy-prep.sh` |
| 7 | UFW: 22, 80, 443 only | ✅ | `deploy-prep.sh` |
| 8 | unattended-upgrades (security only) | ✅ | `deploy-prep.sh` |
| 9 | Auto-reboot at 03:00 Sunday for kernel updates | ✅ | `deploy-prep.sh` |
| 10 | Hetzner Cloud Firewall as defense in depth | 📋 | Console → Firewalls |
| 11 | SSH on non-default port | 📋 | Optional; if so, update UFW + Hetzner Firewall |
| 12 | Hostname set to `de-invoice-prod-1` | 📋 | `sudo hostnamectl set-hostname de-invoice-prod-1` |
| 13 | Time zone Europe/Berlin | 📋 | `sudo timedatectl set-timezone Europe/Berlin` |
| 14 | NTP enabled | ✅ | systemd-timesyncd is on by default on Debian 12 |
| 15 | Audit daemon (auditd) | 📋 | `apt install auditd` for compliance-heavy setups |

## 2. Network

| # | Control | Status | Where / how |
|---|---------|--------|-------------|
| 1 | TLS only — HTTP → HTTPS redirect | ✅ | Caddyfile |
| 2 | TLS 1.2+ (no TLS 1.0/1.1) | ✅ | Caddy's default |
| 3 | HSTS 1 year + includeSubDomains + preload | ✅ | Caddyfile |
| 4 | Strong cipher suites | ✅ | Caddy's default (Mozilla "intermediate") |
| 5 | Let's Encrypt auto-renewal | ✅ | Caddy (Tier 114 — was certbot in Tier 17) |
| 6 | Rate limit `/api/v1/auth/*` 10 req/min/IP | ✅ | Caddyfile `rate_limit` |
| 7 | `X-Content-Type-Options: nosniff` | ✅ | Caddyfile |
| 8 | `X-Frame-Options: SAMEORIGIN` | ✅ | Caddyfile |
| 9 | `Referrer-Policy: strict-origin-when-cross-origin` | ✅ | Caddyfile |
| 10 | `Permissions-Policy` minimal | ✅ | Caddyfile |
| 11 | Server header removed | ✅ | Caddyfile (`-Server`) |
| 12 | Cloudflare real-IP restore | 📋 | Uncomment the `trusted_proxies` block in Caddyfile |
| 13 | Database port not exposed externally | ✅ | `docker-compose.yml` (no host port) |
| 14 | Monitoring stack bound to 127.0.0.1 | ✅ | `monitoring.yml` (port 127.0.0.1 only) |

## 3. Application

| # | Control | Status | Where / how |
|---|---------|--------|-------------|
| 1 | `JWT_SECRET` ≥ 64 hex chars | 📋 | Set in `.env` (runbook §"Rotate JWT_SECRET") |
| 2 | `POSTGRES_PASSWORD` ≥ 32 random chars | 📋 | Set in `.env` |
| 3 | `FINTS_PIN_ENC_KEY` ≥ 32 hex chars | 📋 | Set in `.env` (real-bank mode) |
| 4 | bcrypt password hashing | ✅ | Backend uses bcrypt cost 12 |
| 5 | Throttling on `/api/v1/auth/login` | ✅ | NestJS `@Throttle(5, 60)` |
| 6 | CORS allowlist (FRONTEND_URL only) | ✅ | Backend reads `FRONTEND_URL` env var |
| 7 | Input validation (class-validator) | ✅ | Backend uses class-validator on every DTO |
| 8 | SQL injection prevention | ✅ | Prisma parameterises everything |
| 9 | Webhook payload HMAC-SHA256 signed | ✅ | Backend uses HMAC, secret shown once |
| 10 | Audit log on all write operations | ✅ | Prisma middleware + AuditLog table |
| 11 | 2FA for admin user | 📋 | Tier 15 — enable after first login |
| 12 | Password complexity rules | ✅ | Backend enforces min 12 chars + mixed case + digit |
| 13 | Session cookies HttpOnly + SameSite=Lax | ✅ | Backend sets these on the auth response |
| 14 | Session cookies Secure flag | ✅ | Backend sets `Secure` in production |
| 15 | File upload validation (PDF only, ≤50MB) | ✅ | Backend StorageService enforces mime + size |

## 4. Data

| # | Control | Status | Where / how |
|---|---------|--------|-------------|
| 1 | Daily `pg_dump` to local volume | ✅ | `prodrigestivill/postgres-backup-local` |
| 2 | Daily off-site copy (rclone) | 📋 | Set `BACKUP_RCLONE_REMOTE` in `.env` |
| 3 | Backups encrypted (gpg symmetric) | 📋 | Set `BACKUP_ENCRYPTION_PASSPHRASE` in `.env` |
| 4 | 30 daily + 7 weekly + 12 monthly retention | ✅ | `backup-prod.sh` |
| 5 | Healthchecks.io backup ping | 📋 | Set `HEALTHCHECK_URL` in `.env` |
| 6 | Restore-test on every backup | 📋 | Set `BACKUP_RESTORE_TEST=1` in `.env` |
| 7 | GoBD §146 AO retention (10 years) | 📋 | Off-site rclone remote; local keeps 12 months |
| 8 | Backups verified restorable (quarterly) | 📋 | `DR-TEST.md` |
| 9 | PII minimisation in logs | ✅ | Backend redacts emails + tokens from logs |
| 10 | PDF originals retained for 10 years | ✅ | Storage volume + `attachments.tar.gz` in backup |

## 5. Identity & secrets

| # | Control | Status | Where / how |
|---|---------|--------|-------------|
| 1 | `deploy` user has no shell login (use SSH key) | ✅ | `deploy-prep.sh` |
| 2 | `deploy` user has passwordless sudo for `docker` only | ✅ | `/etc/sudoers.d/deploy-docker` |
| 3 | `.env` file mode 600 | ✅ | `HETZNER-DEPLOY.sh` chmods it |
| 4 | `.env` file not committed to git | ✅ | `.gitignore` has `.env` |
| 5 | Secrets generated with `openssl rand` | ✅ | Runbook commands |
| 6 | `JWT_SECRET` rotated quarterly | 📋 | Runbook §"Rotate JWT_SECRET" |
| 7 | `POSTGRES_PASSWORD` rotated quarterly | 📋 | Runbook §"Rotate POSTGRES_PASSWORD" |
| 8 | `FINTS_PIN_ENC_KEY` NEVER rotated (or all banks re-enroll) | 📋 | Documented constraint |
| 9 | `BACKUP_ENCRYPTION_PASSPHRASE` stored in password manager | 📋 | Runbook §"Set up off-site backups" |
| 10 | Grafana admin password != default | 📋 | Set `GRAFANA_ADMIN_PASSWORD` in `.env` |
| 11 | Healthchecks.io / Slack webhooks in password manager | 📋 | — |

## 6. Operations

| # | Control | Status | Where / how |
|---|---------|--------|-------------|
| 1 | Post-deploy smoke test on every deploy | ✅ | `infra/prod/smoke-test.sh` |
| 2 | External uptime monitoring | 📋 | Healthchecks.io / UptimeRobot |
| 3 | External Prometheus + Alertmanager | 📋 | `monitoring.yml` + Alertmanager in `observability.yml` |
| 4 | Slack alerts on critical failures | 📋 | `SLACK_WEBHOOK_URL` in `.env` |
| 5 | Audit log review (weekly) | 📋 | Runbook §"View a user's audit log" |
| 6 | Admin user list review (monthly) | 📋 | Runbook §"Security operations" |
| 7 | Disk usage alert at 85% | ✅ | `DeInvoiceDiskSpaceLow` in `prometheus/alerts.yml` |
| 8 | TLS cert expiry alert at <14 days | ✅ | `DeInvoiceCertExpiringSoon` (needs `blackbox_exporter` to actually fire — placeholder) |
| 9 | Backup freshness alert at >36h | ✅ | `DeInvoiceBackupStale` (placeholder) |
| 10 | Quarterly DR test | 📋 | `DR-TEST.md` |

## 7. Things explicitly NOT done (and why)

| Item | Why not |
|------|---------|
| Multi-host HA | SH Leder is ~5 users; RTO 1h on a single host is fine. |
| WAF (ModSecurity / Coraza) | Cloudflare's free tier + Caddy's rate limit cover the common cases. If you ever get targeted traffic, add a WAF. |
| HSM-backed JWT signing | The cost (~€200/mo) doesn't pay back at this scale. `openssl rand` is fine. |
| Email signing (DKIM) | Set up at the SMTP provider (Mailgun, SES, etc.), not on the VPS. |
| Intrusion detection (OSSEC / Wazuh) | Overkill for a single tenant. fail2ban is enough. |
| Disk encryption at rest (LUKS) | Hetzner Cloud Volumes can be encrypted, but the performance cost (~5%) doesn't pay back for non-PII workloads. If you store medical or financial data, do it. |
| IP allowlist for admin login | The user has 2FA + audit log; IP allowlist is a false sense of security because attackers use residential proxies. |

## 8. Reporting a security issue

- **Private disclosure**: `security@shleder.de` (PGP key
  on request). Please don't file public GitHub issues for
  security bugs.
- **Response SLA**: best-effort within 72h.
- **Hall of fame**: TBD.

## 9. Security changelog

- **Tier 114**: switched from nginx + certbot to Caddy. Removes
  the certbot renewal-hooks attack surface (any malicious
  renewal hook was executed as root). Caddy runs in a
  container with read-only config + persistent data volume.
- **Tier 17**: initial production hardening (deploy-prep.sh,
  UFW, fail2ban, unattended-upgrades).
