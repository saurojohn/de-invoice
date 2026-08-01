# Tier 127 — Cloud Deploy Checklist

> Date: 2026-08-01
> Target: Hetzner Cloud CX21 (Debian 12) + `invoice.shleder.de`
> Reference: `infra/prod/HETZNER-DEPLOY.md` (full runbook)

## What's already done

- [x] Production secrets generated (`infra/prod/.env.prod.generated`)
  - 48-char `POSTGRES_PASSWORD` (43 base64 chars)
  - 64-char `JWT_SECRET` (openssl hex 32)
  - 64-char `FINTS_PIN_ENC_KEY` (openssl hex 32)
  - 32-char `GRAFANA_ADMIN_PASSWORD`
  - 32-char `BACKUP_ENCRYPTION_PASSPHRASE`
  - 32-char `ALERTMANAGER_SMTP_AUTH_PASSWORD`
- [x] Domain decided: **`invoice.shleder.de`**
- [x] Caddyfile + docker-compose + init.sql present
- [x] Caddyfile.staging variant for `staging.shleder.de`
- [x] deploy-prep.sh + HETZNER-DEPLOY.sh (executable)
- [x] RUNBOOK.md + SECURITY.md + DR-TEST.md

## Steps for you (user) to do

### 1. DNS — point `invoice.shleder.de` to the new VPS

In your DNS provider (Cloudflare or wherever shleder.de lives):

```
Type: A
Name: invoice
Value: <VPS_IP>     ← paste after you create the VPS
TTL: 300 (5 min, so you can change it)
Proxy: DNS only (grey cloud, NOT orange) — Caddy needs
       to see the real client IP for the
       CF-Connecting-IP trust chain.
```

Wait for DNS to propagate before continuing:
```bash
dig +short invoice.shleder.de
# → should return your VPS_IP within 5 min
```

### 2. Create the VPS

In Hetzner Cloud Console (or `hcloud server create --name de-invoice-prod \
  --type cx21 --image debian-12 --location nbg1 --ssh-key <your_key>`):

- Type: **CX21** (€4.39/mo — 2 vCPU, 4 GB RAM, 40 GB SSD)
- Image: **Debian 12**
- Location: **NBG1** (Nuremberg — closest to your Berlin office)
- Backups: **enabled** (+20% but worth it for the DB)
- SSH key: your existing public key

Note the **public IPv4** — that's your `VPS_IP`.

### 3. Open ports on Hetzner firewall

Hetzner Cloud Firewall (recommended) OR rely on the `deploy-prep.sh` UFW.

If using Hetzner firewall, open:
- TCP 22 (SSH)
- TCP 80 + 443 (Caddy → frontend + backend)
- TCP 9090 (Prometheus, optional — only if you want external monitoring)

If NOT using Hetzner firewall, `deploy-prep.sh` installs UFW and opens
22/80/443/9090 automatically.

### 4. Give me the VPS IP + SSH access

Reply in the chat with:
```
VPS_IP=xxx.xxx.xxx.xxx
SSH_KEY=~/.ssh/id_ed25519   # your local private key path
# OR
SSH_USER=root
```

I'll SSH in and run `bash infra/prod/HETZNER-DEPLOY.sh` which does:
1. `deploy-prep.sh` — Docker + UFW + fail2ban + unattended-upgrades
2. Repo clone to `/opt/de-invoice`
3. Copy `.env.prod.generated` → `/opt/de-invoice/.env`
4. `docker compose up -d --build`
5. `init.sql` re-apply (search_tsv re-create)
6. Smoke test (curl /api/v1/health, GET /, check 200)
7. Caddy cert issue verification
8. Print the final status + next steps

### 5. After successful deploy

- First user: I'll seed via SQL (admin@shleder.de, you change pw on first login)
- Backups: set up rclone on the host pointing to Hetzner Storage Box (€3/mo, 1 TB)
- Email: configure SMTP in `.env` so invoice emails actually send
- Monitor: optionally bring up observability stack (`docker compose -f docker-compose.observability.yml up -d`)

## Rollback

If anything goes wrong, `infra/prod/rollback.sh`:
1. Stops the new stack
2. Restores the latest pg_dump from `~/data/backups/de-invoice/`
3. Brings the old version back up (if it was a version rollback)

## Cost

| Item | €/mo |
|------|------|
| CX21 server | 4.39 |
| CX21 backups (+20%) | 0.88 |
| Storage Box 1 TB (optional, for off-site backup) | 3.00 |
| Domain (already paid) | 0.00 |
| **Total** | **~5.27** (or ~8.27 with Storage Box) |

No traffic charges on Hetzner Cloud.
