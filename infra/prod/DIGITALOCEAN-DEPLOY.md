# Deploying de-invoice on DigitalOcean

> **Tier 114.** Same shape as `HETZNER-DEPLOY.md`, with the
> DigitalOcean-specific differences called out. Use this if
> you prefer DO over Hetzner (similar pricing, comparable
> service level).

## What differs from Hetzner

Everything in `HETZNER-DEPLOY.md` applies unchanged except
the provisioning step (step 1). The `HETZNER-DEPLOY.sh`
script works on DO too — it's distro-agnostic.

## Step 1 (DO): Provision the droplet

1. Go to https://cloud.digitalocean.com/ → **Create Droplet**.
2. **Image**: Debian 12 x64
3. **Plan**: Basic → Regular → **2 vCPU / 4 GB / 80 GB SSD** ($24/mo).
   - DO doesn't have an exact CX21 equivalent. The 4 GB
     tier is the right size.
4. **Datacenter region**: Frankfurt (`fra1`) or Amsterdam
   (`ams3`) for the lowest latency from Germany.
5. **Authentication**: SSH key (paste your `~/.ssh/id_ed25519.pub`).
6. **Hostname**: `de-invoice-prod-1`.
7. Note the **public IPv4** (shown in the dashboard once the
   droplet is created — takes ~30s).

### Optional: Block storage for off-site backups

DO Block Storage is analogous to Hetzner Volumes:

- **Create → Volumes** → **Create Volume**
  - **Name**: `de-invoice-backups`
  - **Size**: 50 GB
  - **Region**: same as the droplet
- Attach to `de-invoice-prod-1`, then format and mount:

  ```bash
  # Find the device.
  lsblk
  # Usually /dev/sda (the droplet) + /dev/disk/by-id/scsi-0DO_Volume_*

  # Format (one-time).
  sudo mkfs.ext4 /dev/disk/by-id/scsi-0DO_Volume_<id>
  # Mount.
  sudo mkdir -p /var/backups/de-invoice
  sudo mount /dev/disk/by-id/scsi-0DO_Volume_<id> /var/backups/de-invoice
  # Persist.
  echo "/dev/disk/by-id/scsi-0DO_Volume_<id> /var/backups/de-invoice ext4 defaults,nofail 0 2" \
    | sudo tee -a /etc/fstab
  ```

### DO Spaces (S3-compatible) for off-site backup

DO Spaces is the S3-equivalent service, much cheaper than
Hetzner Storage Box for small backups ($5/mo for 250 GB).

1. Create a Space:
   - https://cloud.digitalocean.com/spaces → **Create Space**
   - **Name**: `de-invoice-backups` (must be globally unique)
   - **Region**: same as the droplet
   - **CDN**: disabled (we don't need it for backups)
2. Create an API key:
   - **API → Spaces Keys → Generate New Key**
   - Note the **Access Key** + **Secret Key**.
3. Configure rclone on the VPS:

   ```bash
   rclone config
   # n) New remote
   # name> do-spaces
   # Storage> s3
   # provider> DigitalOcean Spaces
   # access_key_id> <paste from step 2>
   # secret_access_key> <paste from step 2>
   # region> fra1   (or whatever the Space's region is)
   # endpoint> fra1.digitaloceanspaces.com
   # location_constraint>   (blank — DO doesn't use one)
   # Edit advanced config> n
   # y) Yes this is OK
   # q) Quit config

   # Test.
   rclone lsd do-spaces:
   # Expect: list of buckets (including de-invoice-backups)
   ```

4. Wire it into `.env`:

   ```bash
   # /opt/de-invoice/infra/prod/.env
   BACKUP_RCLONE_REMOTE=do-spaces:de-invoice-backups
   ```

## Step 2 onwards: same as Hetzner

Follow `HETZNER-DEPLOY.md` from step 2 (DNS) onwards. The
script and the rest of the runbook are distro- and
cloud-agnostic.

## DO-specific notes

- **Snapshots**: DO supports droplet snapshots. Useful before
  major upgrades: Droplet → Snapshots → Take Snapshot. Costs
  $0.05/GB/month. DO also has **automated backups** ($1/GB/month,
  or 20% of droplet cost, whichever is greater) — turn these
  on for an extra safety net. They replace the manual
  snapshot ritual.
- **Firewalls**: DO Cloud Firewalls are stateful and applied
  at the hypervisor (vs UFW inside the guest). To use them
  instead of UFW, set up a firewall that opens 22 + 80 + 443
  and assign it to the droplet. UFW can then be disabled
  (the deploy-prep.sh script enables it by default; either
  swap it out or just leave it — two firewalls is
  redundant but harmless).
- **Monitoring**: DO has its own metrics (CPU / RAM / disk /
  network) in the dashboard. The `monitoring.yml` overlay
  in this repo gives you the same plus the backend's
  application-level metrics (request rate, error rate,
  DB connections).
- **API tokens**: create a DO API token at
  https://cloud.digitalocean.com/account/api/tokens for
  future snapshot automation. Store as `DO_API_TOKEN` in
  `.env` (not consumed by the stack today).
- **Pricing comparison** (4 GB tier):
  - Hetzner CX21: €4.85/mo (cheapest)
  - DO Basic 4 GB: $24/mo (5x more expensive)
  - DO Premium 4 GB: $28/mo (NVMe SSD)
  - Vultr 4 GB: $24/mo (similar to DO)
  - For a single-tenant app at 5 users, Hetzner wins on
    cost. Choose DO only if you have a DO credit, an
    existing DO account, or a specific compliance reason.

## Common gotchas (any cloud)

- **IPv6 disabled**: some providers disable IPv6 by default
  on new instances. The Caddyfile relies on IPv6 being
  routable. Enable it in the dashboard: Droplet → Settings
  → Networking → IPv6 → Enable.
- **Default firewall blocks 80/443**: most clouds default
  to "allow all outbound, block all inbound". Verify your
  firewall/security-group has 22/80/443 open before
  debugging Caddy.
- **DNS propagation**: the Let's Encrypt validator uses
  multiple DNS resolvers. A 5-minute TTL on the A record
  is fine; if you set 1-hour TTL, the first cert issue
  can take 30-60 minutes.
- **Time zone**: the deploy-prep.sh script doesn't set
  the system timezone. The `backup` container uses
  `TZ: Europe/Berlin` so backups run on Berlin time
  regardless. If you want system logs to also be in
  Berlin time: `sudo timedatectl set-timezone Europe/Berlin`.
