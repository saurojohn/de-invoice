# DEPLOY.md — Production Deployment Guide

Diese Anleitung führt Schritt für Schritt durch drei Deployment-Szenarien:

1. **Lokales Dev** (Docker-Compose, alles auf einem Rechner) — für Entwicklung & Demo
2. **Hetzner VPS** (Production Single-Server) — `HETZNER-DEPLOY.sh` + nginx + systemd
3. **Backup / Restore** — GoBD-konforme 10-Jahres-Aufbewahrung

---

## 1. Lokales Dev (10 Min Setup)

### Voraussetzungen
- Docker 24+ (mit Compose v2)
- Node 22 LTS (`nvm install 22`)
- macOS / Linux (Windows über WSL2)

### Schritte

```bash
# 1. Repo
git clone <repo-url> de-invoice
cd de-invoice

# 2. Environment (anpassen, .env-Vars siehe unten)
cp backend/.env.example backend/.env
# → DATABASE_URL, JWT_SECRET, MAIL_* etc. setzen

# 3. Postgres via Docker
docker compose up -d postgres
# Warten auf healthy: docker compose ps (Status "Up (healthy)")

# 4. Prisma: Schema + optional Seed
cd backend
npm ci
npx prisma migrate deploy
# (für Demo-Daten: npx prisma db seed)

# 5. Backend starten (Production-Mode, da dev mode Fork-Storm hat)
npm run start    # oder: bash scripts/start-backend.sh
# → Backend läuft auf http://localhost:3001

# 6. Frontend (separates Terminal)
cd ../frontend
npm ci
npm run build
npx next start
# → Frontend läuft auf http://localhost:3100

# 7. Login
# E-Mail:    info@shleder.de (Seed)
# Passwort: Test1234!
```

### Wichtige Environment-Variablen (`backend/.env`)

```bash
DATABASE_URL=postgresql://de_invoice:de_invoice@localhost:5432/de_invoice
JWT_SECRET=<32-byte random base64>
JWT_EXPIRES_IN=7d

# SMTP (für Rechnungs-/Mahnungs-E-Mails)
MAIL_HOST=smtp.example.com
MAIL_PORT=587
MAIL_USER=...
MAIL_PASS=...
MAIL_FROM="de-invoice <noreply@example.com>"

# Storage (lokaler FS-Pfad für PDF + Belege)
STORAGE_LOCAL_PATH=/Users/YOU/data/invoice-system
```

### Production-Mode vs Dev-Mode

⚠️ **Immer `npm run start` (Production) verwenden, NICHT `npm run start:dev`!**

- Dev-Mode (`start:dev`) verwendet Turbopack + watch — auf diesem Monorepo (40k+ Files) verursacht es einen Fork-Storm der macOS `kern.maxprocperuid` in Minuten erschöpft (siehe `nextjs-frontend-gotchas.md` §0)
- Production-Mode (`npm run build` + `npx next start`) hat keinen File-Watcher, einzelner Prozess, 0% CPU im Steady-State

### Häufige Stolpersteine

- **`prisma db seed` schlägt fehl mit "null value in column 'address'"** → die `Company.address`-Spalte ist seit Tier 7 NOT NULL. Das Seed-Skript muss `{street:'', city:'', postalCode:'', country:'DE'}` setzen.
- **Port 3001 / 3100 schon belegt** → `lsof -iTCP:3001 -sTCP:LISTEN | awk 'NR==2 {print $2}' | xargs -I{} kill -9 {}`

---

## 2. Hetzner VPS (Production, 1-2 Std)

### Voraussetzungen
- Hetzner CX22 (€4-5/Mo, 2 vCPU / 4 GB RAM — Minimum) oder CCX13 (Dedicated)
- Ubuntu 24.04 LTS, root SSH-Zugang
- Domain mit A-Record auf die Server-IP (für HTTPS via Let's Encrypt)
- DNS: `mail.example.com` (für SMTP, optional eigener Mailserver)

### Schritte

```bash
# 1. Per SSH connecten
ssh root@<HETZNER_IP>

# 2. System vorbereiten
apt update && apt upgrade -y
apt install -y docker.io docker-compose-v2 nginx certbot python3-certbot-nginx ufw
ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw enable

# 3. Repo + .env
cd /opt
git clone <repo-url> de-invoice
cd de-invoice
cp backend/.env.example backend/.env
nano backend/.env   # DATABASE_URL, JWT_SECRET, MAIL_*, STORAGE_LOCAL_PATH

# 4. Domain + TLS
# DNS: A-Record example.com → <HETZNER_IP>
certbot --nginx -d example.com -d www.example.com --non-interactive --agree-tos -m admin@example.com

# 5. Production Compose hochfahren
docker compose -f docker-compose.prod.yml up -d
# Logs: docker compose -f docker-compose.prod.yml logs -f

# 6. Schema + Seed
docker exec -it de-invoice-backend npx prisma migrate deploy
# (optional) docker exec -it de-invoice-backend npx prisma db seed

# 7. Health-Check
curl https://example.com/api/v1/health/deep
# → {"status":"ok", ...}
```

### Production Compose — was ist anders?

`docker-compose.prod.yml` (vs `docker-compose.yml`):
- **Backend + Frontend-Services** sind lokale Builds (kein registry pull)
- **Postgres-Port** nicht auf Host publiziert (nur intern erreichbar)
- **Volumes** named (statt anonymous) → leichteres Backup mit `scripts/backup.sh`
- **Healthchecks** auf jedem Service
- **Restart-Policy**: `unless-stopped`
- **Nginx** als Reverse-Proxy davor (Port 80/443 → backend 3001 / frontend 3100)

### Nginx Config (Beispiel `/etc/nginx/sites-available/de-invoice`)

```nginx
server {
    listen 80;
    server_name example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name example.com;

    ssl_certificate /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

    # Backend API
    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # Streaming-PDF braucht kein Buffering
        proxy_buffering off;
        client_max_body_size 50M;
    }

    # Frontend (alles andere)
    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

`certbot --nginx` ergänzt die SSL-Server-Blöcke automatisch.

### Backup auf Hetzner

`scripts/backup.sh` läuft täglich via systemd-Timer. Volumes müssen named sein (siehe `docker-compose.prod.yml`):

```bash
# /etc/systemd/system/de-invoice-backup.timer
[Unit]
Description=de-invoice daily backup

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
# /etc/systemd/system/de-invoice-backup.service
[Unit]
Description=de-invoice daily backup
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/opt/de-invoice/scripts/backup.sh
User=root
```

```bash
systemctl enable --now de-invoice-backup.timer
```

Optional: S3-Upload — `BACKUP_S3_BUCKET` und AWS-Credentials in `/root/.aws/credentials`.

---

## 3. Backup / Restore (GoBD § 147 AO)

### Warum?

GoBD § 147 Abs. 3 AO = 10 Jahre Aufbewahrungspflicht für:
- Rechnungen
- Mahnungen
- Belege (Eingangsrechnungen)
- Audit-Log

`scripts/backup.sh` erstellt:
1. `pg_dump` der DB (komprimiert, custom-format)
2. Tarball der Storage-Volumes (PDFs, Belege, OCR-Output)
3. Staged unter `$BACKUP_ROOT/daily/YYYY-MM-DD/`
4. Rotation: 7 daily + 4 weekly + alles im aktuellen Monat

### Manueller Backup

```bash
bash scripts/backup.sh
# → /var/backups/de-invoice/daily/2026-08-11/
#    ├── db-2026-08-11.dump
#    └── storage-2026-08-11.tar.gz
```

### Restore (Test jedes Quartal!)

```bash
# 1. DB-Restore in Test-DB
docker exec -i de-invoice-postgres \
  pg_dump -U de_invoice -d de_invoice > backup.sql   # Test: Backup → Test-DB
docker exec de-invoice-postgres createdb -U de_invoice de_invoice_restore_test
cat backup.sql | docker exec -i de-invoice-postgres psql -U de_invoice -d de_invoice_restore_test

# 2. Storage-Restore
docker run --rm \
  -v de-invoice_storage_prod:/target \
  -v /var/backups/de-invoice/daily/2026-08-11:/backup:ro \
  alpine tar xzf /backup/storage-2026-08-11.tar.gz -C /target

# 3. Verify
curl https://example.com/api/v1/health/deep
# Im Frontend einloggen, einige PDFs herunterladen + prüfen
```

### GTM-Akzeptanz (Multi-Company)

Vor Production-Go-Live immer testen, dass neue Company-Registrierungen den Tenant-Wechsel sauber durchlaufen — siehe `frontend/e2e/multi-tenant-acceptance-gtm.spec.ts` (6 Tests, alle Tenant-Edge-Cases).

```bash
cd frontend && npx playwright test e2e/multi-tenant-acceptance-gtm.spec.ts
# → 6 passed
```

---

## Troubleshooting

| Problem                                    | Lösung                                                         |
|--------------------------------------------|----------------------------------------------------------------|
| Backend 401 "Kein Zugriff auf diese Firma" | `UserCompany`-Grant fehlt → siehe `auth.service.register`     |
| PDF-Download 500                           | `STORAGE_LOCAL_PATH` existiert nicht → mkdir + chown           |
| Frontend 500 "production build not found"  | `npm run build` in `frontend/` vergessen                       |
| Mahnung sendet keine Mail                  | `MAIL_*` Vars in `.env` gesetzt? `docker logs de-invoice-backend` |
| FinTS-Verbindung failt                     | Bank-Credentials neu, TAN-Verfahren neu — `fints/connection`  |
| Backup-Restore zeigt 0 rows                | `--restrict`-Direktive in pg_dump 17+ → psql 17+ oder strip  |
| Postgres OOM                               | `shared_buffers` zu groß — Empfehlung: 25% RAM, max 2 GB     |

Für mehr: siehe `backend/scripts/`, `scripts/`, `nextjs-frontend-gotchas.md`,
`nestjs-prisma-gotchas.md`.
