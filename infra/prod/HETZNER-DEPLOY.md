# Deploying de-invoice on Hetzner Cloud

> **Tier 114.** Zero-to-running runbook for SH Leder GmbH's
> invoice web app on a Hetzner Cloud CX21 VPS. A parallel
> runbook for DigitalOcean lives in `DIGITALOCEAN-DEPLOY.md`.

## What you'll have at the end

- A Hetzner Cloud CX21 VPS (Debian 12, 4 GB RAM, 2 vCPU, 40 GB SSD).
- The `de-invoice` stack running in Docker Compose, fronted by
  Caddy with a real Let's Encrypt cert.
- Daily `pg_dump` backups to a Hetzner Storage Box (off-site).
- Prometheus + Grafana + postgres/node exporters for monitoring.
- Fail2ban, UFW, and SSH key-only auth.

## Time required

- 60-90 minutes for the first deploy, mostly waiting for DNS
  propagation + Docker image builds.
- 10 minutes for each subsequent deploy (`git pull && docker
  compose up -d`).

---

## 1. Provision the Hetzner Cloud server

1. Go to https://console.hetzner.cloud/ → **New Project** (e.g. `de-invoice-prod`).
2. **Add Server**:
   - **Image**: Debian 12
   - **Type**: CX21 (2 vCPU, 4 GB RAM, 40 GB SSD) — €4.85/mo
   - **Location**: Falkenstein (`fsn1`) or Nuremberg (`nbg1`)
   - **Networking**: Public IPv4 + IPv6
   - **SSH key**: upload your `~/.ssh/id_ed25519.pub`
   - **Name**: `de-invoice-prod-1`
3. Note the **public IPv4** — you'll need it for DNS and SSH.
4. Note the **server ID** (top-right of the server page) for
   the Hetzner API token setup later.

### Optional: volume for backup offload

Hetzner Cloud Volumes are network-attached and survive server
destruction. We use one for the off-site backup copy.

- **Add Volume**:
  - **Name**: `de-invoice-backups`
  - **Size**: 50 GB
  - **Location**: same as the server
  - **Format**: ext4
- Once created, click the volume → **Attach** to `de-invoice-prod-1`.
- On the server, format and mount:
  ```bash
  # Find the device name (usually /dev/disk/by-id/scsi-0HC_Volume_<id>).
  ls /dev/disk/by-id/scsi-0HC_Volume_*
  # Format (one-time).
  sudo mkfs.ext4 /dev/disk/by-id/scsi-0HC_Volume_<id>
  # Mount.
  sudo mkdir -p /var/backups/de-invoice
  sudo mount /dev/disk/by-id/scsi-0HC_Volume_<id> /var/backups/de-invoice
  # Persist across reboots.
  echo "/dev/disk/by-id/scsi-0HC_Volume_<id> /var/backups/de-invoice ext4 defaults,nofail 0 2" \
    | sudo tee -a /etc/fstab
  ```

---

## 2. Point DNS

In your DNS provider (Hetzner DNS Console, Cloudflare, or wherever
`shleder.de` is hosted):

| Type | Name | Value | TTL |
|------|------|-------|-----|
| A | `rechnung` | `<public IPv4>` | 300 |
| AAAA | `rechnung` | `<public IPv6>` | 300 |

**Don't skip the AAAA record.** Modern browsers prefer IPv6, and
Caddy will use it for the HTTP-01 challenge if the visitor
reached the site over IPv6.

Verify before continuing:

```bash
dig +short invoice.shleder.de A
dig +short invoice.shleder.de AAAA
# Both should return values within a minute or two.
# Propagation can take up to 30 min depending on the registrar.
```

---

## 3. Initial server prep

SSH as `root`:

```bash
ssh root@<public IPv4>
```

Then run `deploy-prep.sh` from the repo. The script is
idempotent — re-running on an already-hardened host is safe.

```bash
# Option A: run the script from the repo (after cloning).
# Easier to audit and version-pin.
apt install -y git
git clone https://github.com/saurojohn/de-invoice.git /opt/de-invoice
cd /opt/de-invoice
bash infra/prod/deploy-prep.sh

# Option B: curl-piped.
# Faster but you can't review the script before it runs.
# Not recommended for production.
# bash <(curl -sSL https://raw.githubusercontent.com/saurojohn/de-invoice/main/infra/prod/deploy-prep.sh)
```

What this does (full list in the script's header):
- Creates the `deploy` user with `NOPASSWD: docker`.
- Installs Docker 24+ with the Compose v2 plugin.
- Configures UFW: open 22, 80, 443 only.
- Installs fail2ban (5 retries → 1h ban).
- Installs `unattended-upgrades` (security patches auto-applied).
- Hardens SSH: no root login, no password auth, no X11.
- Clones the repo to `/opt/de-invoice` (as `deploy` user).

### Add your real SSH key

The script generates a *bootstrap* key in `/root/.de-invoice-bootstrap/`,
but you need to add **your** real workstation key to the `deploy` user:

```bash
# From your workstation:
cat ~/.ssh/id_ed25519.pub
# Copy the output.

# Back on the server, as root:
sudo -u deploy mkdir -p /home/deploy/.ssh
sudo -u deploy bash -c 'echo "<paste your public key here>" >> ~/.ssh/authorized_keys'
sudo -u deploy chmod 600 ~/.ssh/authorized_keys
```

Test from your workstation (in a **new** terminal — the current
one is still connected as root):

```bash
ssh deploy@<public IPv4> 'whoami && docker --version'
# Expect: deploy
# Expect: Docker version 24.x.y, build ...
```

**From now on, do everything as `deploy`, not `root`.**

---

## 4. Configure `.env`

```bash
sudo -u deploy ssh deploy@<public IPv4>
cd /opt/de-invoice/infra/prod
cp .env.example .env
$EDITOR .env
```

Set the following (everything else can keep its default):

```bash
# Database.
POSTGRES_PASSWORD=<openssl rand -base64 32>   # generate fresh
POSTGRES_USER=de_invoice
POSTGRES_DB=de_invoice

# Public URL (no trailing slash).
FRONTEND_URL=https://invoice.shleder.de

# JWT signing key. Rotating this logs all users out.
JWT_SECRET=<openssl rand -hex 64>

# FinTS bank-sync encryption key (required for any real
# bank connection). Generate ONCE; losing it means re-creating
# every bank connection.
FINTS_PIN_ENC_KEY=<openssl rand -hex 32>

# Backup ping (Healthchecks.io).
HEALTHCHECK_URL=https://hc-ping.com/<your-uuid>
HEALTHCHECK_PING_URL=https://hc-ping.com/<your-uuid>/fail

# Observability (if you enable the monitoring stack).
GRAFANA_ADMIN_PASSWORD=<openssl rand -base64 24>

# Off-site backup target. Optional but recommended.
BACKUP_S3_BUCKET=
BACKUP_RCLONE_REMOTE=  # e.g. hetzner-storagebox:de-invoice-backups (see step 8)
BACKUP_WEBHOOK_URL=    # Slack/Discord webhook for backup results
```

**Lock the file down:**

```bash
chmod 600 .env
```

---

## 5. Build the Docker images

```bash
cd /opt/de-invoice
sudo docker compose -f infra/prod/docker-compose.yml build
```

This takes 3-5 minutes on a CX21 (cold cache). Subsequent builds
are <30s because the deps layer is cached.

---

## 6. Initialize the database

```bash
# Start ONLY postgres first so the migrations have a target.
sudo docker compose -f infra/prod/docker-compose.yml up -d postgres
sleep 10

# Confirm postgres is healthy.
sudo docker compose -f infra/prod/docker-compose.yml exec postgres \
  pg_isready -U de_invoice -d de_invoice
# Expect: /var/run/postgresql:5432 - accepting connections
```

Apply the Prisma schema. **`prisma db push` is fine for the
first deploy on a brand-new DB** (no prior migrations to skip),
but on a restore-from-backup, you'd use `prisma migrate deploy`
instead. See the backup section.

```bash
sudo docker compose -f infra/prod/docker-compose.yml run --rm backend \
  npx prisma db push --accept-data-loss --skip-generate

sudo docker compose -f infra/prod/docker-compose.yml run --rm backend \
  npx prisma generate
```

Verify the tables exist:

```bash
sudo docker compose -f infra/prod/docker-compose.yml exec postgres \
  psql -U de_invoice -d de_invoice -c '\dt'
# Expect: 30+ tables (Company, Customer, Invoice, ...)
```

### Seed the first company

The backend has no public "register" flow that creates a new
company (admin invites only). Seed the SH Leder GmbH row
manually:

```bash
sudo docker compose -f infra/prod/docker-compose.yml exec postgres \
  psql -U de_invoice -d de_invoice -c "
    INSERT INTO \"Company\" (id, name, \"createdAt\", \"updatedAt\")
    VALUES ('00000000-0000-0000-0000-000000000001',
            'SH Leder GmbH', NOW(), NOW())
    ON CONFLICT DO NOTHING;
  "
```

Then create the first user via the backend's API (after the
stack is up in step 7) or by hitting `/api/v1/auth/register`
through the browser.

---

## 7. Bring up the full stack

```bash
sudo docker compose -f infra/prod/docker-compose.yml up -d
sudo docker compose -f infra/prod/docker-compose.yml ps
```

Expected output:

```
NAME                       STATUS              PORTS
de-invoice-postgres        Up (healthy)        5432/tcp
de-invoice-backend         Up (healthy)        3001/tcp
de-invoice-frontend        Up (healthy)        3000/tcp
de-invoice-caddy           Up                  0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp
de-invoice-backup          Up
```

Watch the logs for the first ~30 seconds:

```bash
sudo docker compose -f infra/prod/docker-compose.yml logs -f --tail=50
```

Look for:
- `de-invoice-caddy: ... serving initial configuration`
- `de-invoice-caddy: ... obtained certificate` (first request)
- `de-invoice-backend: Nest application successfully started`
- `de-invoice-frontend: ▲ Next.js 14 (prod)`

---

## 8. Verify HTTPS

From your workstation:

```bash
# 1. DNS resolves.
dig +short invoice.shleder.de A
# Expect: <public IPv4>

# 2. HTTPS returns 200.
curl -sI https://invoice.shleder.de | head -3
# Expect: HTTP/2 200, then server, content-type headers

# 3. Cert is valid + LE-issued.
echo | openssl s_client -servername invoice.shleder.de \
  -connect invoice.shleder.de:443 2>/dev/null \
  | openssl x509 -noout -subject -dates -issuer
# Expect:
#   subject=CN = invoice.shleder.de
#   issuer=C = US, O = Let's Encrypt, CN = R10
#   notBefore=..., notAfter=...  (90 days from now)

# 4. HSTS header is set.
curl -sI https://invoice.shleder.de | grep -i strict-transport
# Expect: strict-transport-security: max-age=31536000; includeSubDomains; preload

# 5. Backend health.
curl -s https://invoice.shleder.de/api/v1/health | jq
# Expect: { "status": "ok", ... }
```

If the cert didn't issue, the most common cause is that DNS
hasn't propagated to the Let's Encrypt validator's PoPs yet.
Wait 5 minutes, then `docker compose restart caddy`.

---

## 9. Set up off-site backups

`scripts/backup-prod.sh` is the upgraded backup script (Tier 114).
It runs `pg_dump`, optionally encrypts the result, and uploads
to either S3-compatible storage (via `rclone`) or a local
directory. Schedule it via cron on the host.

### Install rclone (one-time)

```bash
curl https://rclone.org/install.sh | sudo bash
```

### Configure the Hetzner Storage Box remote

Hetzner Storage Box supports SFTP. rclone handles it natively:

```bash
rclone config
# n) New remote
# name> hetzner-storagebox
# Storage> sftp
# host> u<username>.your-storagebox.de   (find this in Hetzner Robot)
# user> u<username>
# pass> <your storage box password>
# Edit advanced config> n
# y) Yes this is OK
# q) Quit config
```

Test it:

```bash
rclone lsd hetzner-storagebox:
# Expect: list of directories in your storage box
```

### Wire it into .env

```bash
# /opt/de-invoice/infra/prod/.env
BACKUP_RCLONE_REMOTE=hetzner-storagebox:de-invoice-backups
BACKUP_WEBHOOK_URL=https://hooks.slack.com/services/...   # optional
BACKUP_ENCRYPTION_PASSPHRASE=<openssl rand -base64 24>    # optional but recommended
```

The encrypted-backup passphrase is needed to restore. Store
it somewhere SAFE AND OFFSITE (a password manager is fine;
do NOT store it on the VPS).

### Schedule the backup

```bash
sudo -u deploy crontab -e
# Add:
0 3 * * * cd /opt/de-invoice && bash scripts/backup-prod.sh >> /var/log/de-invoice-backup.log 2>&1
```

The `0 3 * * *` matches the in-container `prodrigestivill/postgres-backup-local`
schedule. Pick one — we recommend the host cron with the
upgraded `backup-prod.sh` over the container (you get
encryption, S3, and the webhook). To disable the in-container
one, remove the `backup` service from the compose file.

---

## 10. Enable monitoring (optional but recommended)

```bash
cd /opt/de-invoice/infra/prod
sudo docker compose -f docker-compose.yml -f monitoring.yml up -d
```

This adds Prometheus, Grafana, node-exporter, and
postgres-exporter. See `RUNBOOK.md` for the Grafana setup
and the `infra/prod/prometheus/alerts.yml` for the alert
rules.

---

## 11. Final verification

Run the post-deploy smoke test from your workstation:

```bash
cd /opt/de-invoice
DOMAIN=invoice.shleder.de VPS_IP=<public IPv4> \
  bash infra/prod/smoke-test.sh
```

All 13 checks should pass. The script exits 0 on success, 1 on
any failure. If something fails, see the troubleshooting
section in `RUNBOOK.md`.

---

## What's next

- **Domain hardening**: submit to https://hstspreload.org/.
- **2FA**: enable TOTP for the admin user (Tier 15 feature).
- **Audit log review**: weekly cron job that emails
  `SELECT * FROM "AuditLog" WHERE created_at > NOW() - INTERVAL '7 days'`
  results.
- **Disaster recovery test**: see `DR-TEST.md`.
- **Backups offsite**: confirmed via `rclone lsd`.

## Hetzner-specific notes

- **Snapshots**: Hetzner Cloud can snapshot a running server.
  Useful before major upgrades: Console → Server → Snapshots →
  Create snapshot. Costs €0.01/GB/month.
- **Object Storage** (alternative to Storage Box): Hetzner
  Object Storage is S3-compatible. The same rclone config
  works, just swap the storage type to `s3` and point at
  `fsn1.your-objectstorage.com`.
- **Firewall**: Hetzner Cloud Firewalls (vs UFW) are
  stateful and applied at the hypervisor — one less thing
  the VPS has to do. If you go this route, disable UFW
  (it's redundant) and add a Cloud Firewall that opens
  22, 80, 443. See https://docs.hetzner.cloud/#firewalls.
- **API tokens**: for snapshot automation, create a token
  in the Hetzner Cloud Console → Project → API Tokens.
  Store it in `.env` as `HCLOUD_TOKEN`. (Not used by the
  stack today; here for future automation.)
