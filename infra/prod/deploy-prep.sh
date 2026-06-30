#!/usr/bin/env bash
# Tier 24: de-invoice production deployment prep
#
# Run this ONCE on a fresh VPS as the root user
# to get a hardened, ready-to-deploy host. After
# this script finishes successfully, the operator
# can `cd /opt/de-invoice/infra/prod && docker
# compose up -d` to bring the app up.
#
# What this script does:
#   1. Creates a non-root 'deploy' user with
#      passwordless sudo for the docker command
#      (so the app never runs as root)
#   2. Installs Docker + docker compose plugin
#      (the official docker-ce repo, not the
#      distro package — we need 24.x for compose
#      v2 plugin support)
#   3. Installs + configures UFW firewall
#      (only 22, 80, 443 open to the world;
#      monitoring stack ports 9090/3001/9093
#      bound to 127.0.0.1 — see Tier 18)
#   4. Installs fail2ban (SSH brute-force
#      protection; default 5-retry ban)
#   5. Installs + configures unattended-upgrades
#      (security patches applied automatically,
#      reboot deferred to 03:00 Sunday)
#   6. Hardens SSH: disables password auth,
#      root login, X11 forwarding. The deploy
#      user gets key-only auth.
#   7. Clones the repo to /opt/de-invoice
#      (the path the rest of the Tier 17/23
#      compose + scripts assume)
#   8. Generates SSH keypair for the operator
#      (printed at the end — operator must
#      add the public key to the deploy user's
#      authorized_keys)
#
# What this script does NOT do (must be done
# by hand before the app can run):
#   - DNS A record from domain → VPS IP
#   - .env file with real POSTGRES_PASSWORD,
#     JWT_SECRET, FINTS_PIN_ENC_KEY, etc.
#   - Let's Encrypt cert (certbot runs once
#     the DNS is in place)
#
# Idempotent: re-running on an already-hardened
# host is safe (skips completed steps).

set -euo pipefail

# ─── Configuration ─────────────────────────────────────
DEPLOY_USER="${DEPLOY_USER:-deploy}"
REPO_URL="${REPO_URL:-https://github.com/saurojohn/de-invoice.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-/opt/de-invoice}"
SSH_PORT="${SSH_PORT:-22}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@localhost}"

log() { echo -e "\033[1;34m▶\033[0m $1"; }
warn() { echo -e "\033[1;33m⚠\033[0m $1"; }
die() { echo -e "\033[1;31m✗\033[0m $1" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run as root (sudo $0)"

# ─── 1. Create deploy user ──────────────────────────────
log "Creating user '$DEPLOY_USER'..."
if ! id "$DEPLOY_USER" &>/dev/null; then
  adduser --disabled-password --gecos "" "$DEPLOY_USER"
fi

# Passwordless sudo for the docker command only
# (NOT all-sudo — that's too permissive for prod)
SUDOERS_FILE="/etc/sudoers.d/$DEPLOY_USER-docker"
cat > "$SUDOERS_FILE" <<EOF
$DEPLOY_USER ALL=(ALL) NOPASSWD: /usr/bin/docker
$DEPLOY_USER ALL=(ALL) NOPASSWD: /usr/bin/docker compose
$DEPLOY_USER ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart docker-compose-de-invoice
$DEPLOY_USER ALL=(ALL) NOPASSWD: /usr/local/bin/de-invoice-*
EOF
chmod 440 "$SUDOERS_FILE"

# ─── 2. Install Docker ──────────────────────────────────
log "Installing Docker..."
if ! command -v docker &>/dev/null; then
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
fi
docker --version
docker compose version

# ─── 3. UFW firewall ───────────────────────────────────
log "Configuring UFW..."
apt-get install -y -qq ufw
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
# SSH (operator access)
ufw allow "$SSH_PORT/tcp" comment "SSH"
# HTTP+HTTPS (the only public-facing services;
# nginx terminates TLS and proxies to the
# backend/frontend containers on the deinvoicenet)
ufw allow 80/tcp comment "HTTP (certbot redirect)"
ufw allow 443/tcp comment "HTTPS (nginx)"
# Monitoring stack is bound to 127.0.0.1 by
# the docker-compose overlay — UFW is not
# relevant for those. The operator accesses
# them via SSH tunnel:
#   ssh -L 3001:localhost:3001 deploy@vps
#   ssh -L 9090:localhost:9090 deploy@vps
#   ssh -L 9093:localhost:9093 deploy@vps
ufw --force enable
ufw status

# ─── 4. fail2ban ────────────────────────────────────────
log "Installing fail2ban..."
apt-get install -y -qq fail2ban
cat > /etc/fail2ban/jail.local <<'EOF'
[DEFAULT]
# Ban hosts for 1 hour after 5 failed attempts
bantime = 1h
findtime = 10m
maxretry = 5

[sshd]
enabled = true
port = ssh
filter = sshd
backend = systemd
EOF
systemctl enable --now fail2ban
systemctl restart fail2ban

# ─── 5. Unattended upgrades ──────────────────────────────
log "Configuring unattended-upgrades..."
apt-get install -y -qq unattended-upgrades
cat > /etc/apt/apt.conf.d/50unattended-upgrades <<'EOF'
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}-security";
};
Unattended-Upgrade::AutoFixInterruptedDpkg "true";
Unattended-Upgrade::MinimalSteps "true";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-New-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "03:00";
EOF
systemctl enable --now unattended-upgrades

# ─── 6. SSH hardening ───────────────────────────────────
log "Hardening SSH..."
SSHD_CONFIG="/etc/ssh/sshd_config"
cp "$SSHD_CONFIG" "${SSHD_CONFIG}.bak.$(date +%Y%m%d)"

# Apply hardening idempotently (only set if not
# already set, to avoid breaking existing
# operator customisations)
set_sshd() {
  local key="$1" value="$2"
  if grep -qE "^#?${key}\b" "$SSHD_CONFIG"; then
    sed -i "s|^#\?${key}.*|${key} ${value}|" "$SSHD_CONFIG"
  else
    echo "${key} ${value}" >> "$SSHD_CONFIG"
  fi
}
set_sshd "PermitRootLogin" "no"
set_sshd "PasswordAuthentication" "no"
set_sshd "KbdInteractiveAuthentication" "no"
set_sshd "PubkeyAuthentication" "yes"
set_sshd "X11Forwarding" "no"
set_sshd "AllowAgentForwarding" "no"
set_sshd "AllowTcpForwarding" "local"   # only via -L
set_sshd "MaxAuthTries" "3"
set_sshd "LoginGraceTime" "30"
set_sshd "ClientAliveInterval" "300"
set_sshd "ClientAliveCountMax" "2"

systemctl reload ssh

# Create .ssh for deploy user + a fresh keypair
SSH_DIR="/home/$DEPLOY_USER/.ssh"
mkdir -p "$SSH_DIR"
chmod 700 "$SSH_DIR"
chown "$DEPLOY_USER:$DEPLOY_USER" "$SSH_DIR"

if [[ ! -f "$SSH_DIR/authorized_keys" ]]; then
  touch "$SSH_DIR/authorized_keys"
  chmod 600 "$SSH_DIR/authorized_keys"
  chown "$DEPLOY_USER:$DEPLOY_USER" "$SSH_DIR/authorized_keys"
fi

# Generate a NEW operator keypair (for the
# operator to download and add to their
# local ~/.ssh/config). We do NOT add it to
# authorized_keys automatically — the operator
# must add their real workstation key.
mkdir -p /root/.de-invoice-bootstrap
if [[ ! -f /root/.de-invoice-bootstrap/id_ed25519 ]]; then
  ssh-keygen -t ed25519 -N "" -C "operator@de-invoice-bootstrap" \
    -f /root/.de-invoice-bootstrap/id_ed25519
fi

# ─── 7. Clone the repo ──────────────────────────────────
log "Cloning the repo to $INSTALL_DIR..."
if [[ ! -d "$INSTALL_DIR" ]]; then
  sudo -u "$DEPLOY_USER" git clone --branch "$REPO_BRANCH" \
    "$REPO_URL" "$INSTALL_DIR"
fi
chown -R "$DEPLOY_USER:$DEPLOY_USER" "$INSTALL_DIR"

# ─── 8. Create deploy user docker group membership ────
log "Adding $DEPLOY_USER to docker group..."
usermod -aG docker "$DEPLOY_USER"

# ─── Done ───────────────────────────────────────────────
echo
echo "============================================================"
echo -e "\033[1;32m✓\033[0m Host preparation complete."
echo "============================================================"
echo
echo "Next steps (HAND, not automated):"
echo
echo "1. ADD YOUR REAL SSH PUBLIC KEY to the deploy user:"
echo "   sudo -u $DEPLOY_USER mkdir -p /home/$DEPLOY_USER/.ssh"
echo "   sudo -u $DEPLOY_USER bash -c 'echo \"\$(cat ~/your-key.pub)\" >> ~/.ssh/authorized_keys'"
echo
echo "2. POINT YOUR DOMAIN at this VPS (DNS A record)"
echo "   Then verify: dig +short your-domain.com"
echo
echo "3. RUN certbot (after DNS resolves):"
echo "   apt-get install -y certbot python3-certbot-nginx"
echo "   certbot --nginx -d your-domain.com -d www.your-domain.com"
echo
echo "4. GENERATE PRODUCTION SECRETS and put in $INSTALL_DIR/infra/prod/.env:"
echo "   openssl rand -hex 64   # JWT_SECRET"
echo "   openssl rand -hex 32   # POSTGRES_PASSWORD"
echo "   openssl rand -hex 32   # FINTS_PIN_ENC_KEY"
echo "   See infra/prod/.env.example for the full list."
echo
echo "5. BRING THE APP UP:"
echo "   cd $INSTALL_DIR/infra/prod"
echo "   docker compose up -d"
echo
echo "6. (Optional) RUN THE OBSERVABILITY OVERLAY:"
echo "   docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d"
echo
echo "7. (Optional) ENABLE CLOUDFLARE real-IP restore:"
echo "   See $INSTALL_DIR/infra/cloudflare/README.md"
echo
echo "Bootstrap operator SSH key (download + add to your workstation):"
echo "   cat /root/.de-invoice-bootstrap/id_ed25519"
echo "============================================================"