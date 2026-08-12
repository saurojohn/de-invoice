# USER-GUIDE.md — Akzeptanz-Walkthrough für Steuerberater & Mandant

Dieser Leitfaden führt Sie als **Steuerberater** oder **Mandant-Inhaber** durch
die täglichen Workflows in de-invoice, so wie sie ein echter Betriebsprüfer
nachvollziehen würde.

> **Zielgruppe**: Dritter, der die Software **ohne Vorkenntnisse** öffnet und
> die Geschäftslogik versteht. Jeder Schritt ist prüfbar, jede Annahme ist
> nachvollziehbar.

## Voraussetzungen

- Browser (Chrome / Firefox / Safari)
- Login-Daten (vom Administrator vergeben)
- Beim ersten Login ggf. 2FA-Token (E-Mail)

## Akzeptanz-Test-Plan (5 Pfade)

1. **Rechnung erstellen + PDF herunterladen + signierte Version prüfen**
2. **Eingangsrechnung (Beleg) erfassen + DATEV-Sachkonto-Inferenz prüfen**
3. **Mahnung senden — Live-Preview Mahngebühr + Verzugszins**
4. **BWA / UStVA / DATEV-Export — Berater-Export**
5. **GoBD-Archiv-Export — für Betriebsprüfung**

Jeder Pfad endet mit einer **Bestätigungs-Checkliste** — was wurde geprüft,
welche Erwartung trifft zu, welche Beweise liegen vor.

---

## Authentifizierung — Header-basiertes Schema

Alle API-Aufrufe (außer `/auth/login`, `/auth/register`, `/impressum`,
`/datenschutz`, den Cookie-/DSGVO-Endpoints und `GET /health`) benötigen
zwei Header:

```
x-user-id:    <UUID>     # User, der die Anfrage stellt
x-company-id: <UUID>     # Mandant, auf den sich die Anfrage bezieht
```

Beide Header werden vom Frontend nach erfolgreichem Login in
`localStorage` abgelegt und bei jedem API-Call mitgesendet. Der
`HeaderAuthGuard` validiert bei jedem Request:

1. **User existiert** und ist `status=active` (sonst 401)
2. **UserCompany-Grant existiert** für die Kombination
   (`x-user-id`, `x-company-id`) — sonst 401
   "Kein Zugriff auf diese Firma"
3. **Per-Company-Rolle** wird aus `UserCompany.role` gelesen
   und an `req.user.role` angehängt (überschreibt das globale
   `User.role`)

**Read-Only-Modus**: zusätzlich `x-readonly: 1` setzen — der
Mutation-Interceptor im Service-Layer antwortet dann mit 403
statt die Änderung durchzuführen. Berater nutzen das für
sicheres Review eines Mandanten ohne Schreib-Risiko.

> **Session-Introspektion**: für Frontend-Init (Mandant-Switcher,
> Rollen-Anzeige) siehe `GET /api/v1/auth/me` weiter unten.

---

## Pfad 1 — Rechnung erstellen (Kern-Workflow)

**Rolle**: Inhaber / Accountant
**Ziel**: Eine vollständige, signierte Rechnung erstellen und an einen Kunden versenden.

### Schritte

1. **Login** (oben rechts) → Dashboard
2. Klick **`+ Neue Rechnung`** (oben rechts, groß)
3. **Kunde wählen** (Combobox) oder **`+ Neuer Kunde`** (Modal)
4. **Position hinzufügen** — Beschreibung, Menge, Einzelpreis
   - Mehrere Positionen möglich (Rabatte auf Gesamtsumme via "Rabatt %")
   - Skonto-Hinweis: 2% bei Zahlung binnen 7 Tagen
5. **Steuersatz** pro Position wählen (19% / 7% / 0% / §13b / igL)
6. **`Vorschau`** klicken — visuelles PDF erscheint rechts
7. **Speichern** — Rechnung wird im Status `draft` angelegt
8. Klick **`📧 Per E-Mail senden`** (oben rechts auf Rechnungsdetail-Seite)
   - Sprache DE/EN/中文 wählbar
   - Empfänger vorausgefüllt, editierbar
   - Senden — Toast "Rechnung per E-Mail versendet"
9. **Status wechselt auf `sent`** — sichtbar in Listen-Ansicht

### Akzeptanz-Checkliste

- [ ] Rechnungs-PDF heruntergeladen → Endung `*_signed.pdf` (GoBD §146)
- [ ] PDF in Adobe Reader geöffnet → Signatur-Badge sichtbar (grünes Häkchen)
- [ ] "Signatur prüfen" im PDF-Panel → "✓ Signatur gültig"
- [ ] Signierer = Ihr Firmenname (z.B. "SH Leder GmbH")
- [ ] Fingerprint (SHA-256) im PDF-Panel sichtbar
- [ ] PDF enthält alle Positionen, Steuersätze, Gesamtbetrag korrekt
- [ ] E-Mail-Status im Reiter "E-Mail-Verlauf" → "sent" mit Zeitstempel
- [ ] Audit-Log: Rechnung erstellt + Rechnung versendet, beide mit User + IP

---

## Pfad 2 — Eingangsrechnung (Beleg) erfassen

**Rolle**: Inhaber / Accountant
**Ziel**: Eine Lieferantenrechnung erfassen, OCR-fertig, mit DATEV-Sachkonto.

### Schritte

1. **Eingangsrechnungen** (Sidebar) → **`+ Neue Eingangsrechnung`**
2. **Lieferant wählen** (Combobox) oder neu anlegen
3. **Beleg-Bild hochladen** (PDF / JPG, drag & drop) — Tesseract-OCR
   extrahiert Betrag + Datum automatisch (Vorschau)
4. **Betrag / Datum / Sachkonto** — manuell bestätigen oder automatisch
5. **Sachkonto** — Dropdown zeigt:
   - **Auto-Vorschlag** (z.B. "4900 — Sonstige betriebliche Aufwendungen"
     bei Schlüsselwort "Bürobedarf")
   - Vollständige SKR03-Liste (1400 Konten) als Alternative
6. **Speichern** → Status `pending`, dann `booked` nach Buchung
7. Optional: **`→ Rechnung umwandeln`** (z.B. wenn Gutschrift vom Lieferanten)

### Akzeptanz-Checkliste

- [ ] Beleg-Bild sichtbar im Reiter "Belege"
- [ ] OCR-extrahierter Betrag stimmt mit PDF überein
- [ ] Sachkonto-Inferenz zeigt erkanntes Schlüsselwort (z.B. "Bürobedarf")
- [ ] DATEV-Export zeigt korrektes Konto in Buchungsstapel-Zeile
- [ ] Audit-Log: Beleg erfasst, OCR verarbeitet, Sachkonto zugewiesen

---

## Pfad 3 — Mahnung senden (Live-Preview Mahngebühr + Verzugszins)

**Rolle**: Inhaber / Accountant
**Ziel**: Vor dem Versand die Kosten sehen, dann bestätigen.

> **API-Parameter (für direkten Aufruf / API-Tests)**:
> - `GET /api/v1/reminders/mahnungen/fees-preview?invoiceId={uuid}&level=first|second|final`
>   → liefert `{mahngebuehr, verzugszins, offenerBetrag, gesamtforderung}`.
>   **Achtung**: der Parameter heißt `invoiceId` (NICHT `principal+daysOverdue`
>   wie ältere Skizzen / Phase-3-Walkthrough-Skripte es versucht haben).
> - `GET /api/v1/reminders/mahnungen/fees-config` → liefert die konfigurierten
>   Gebühren (`mahngebuehr: {first, second, final}` und `verzugszinsPct`).
>   Default: `5 / 5 / 10 EUR` und `9%` (post-2023 § 288 BGB).

### Schritte

1. **Rechnungen** → Überfällige Rechnung auswählen (Status `overdue` oder älter)
2. Rechnungsdetail → **`📨 Mahnung senden`** (Button oben)
3. Modal öffnet sich — **Live-Preview** zeigt:
   ```
   Offener Betrag:                    250,00 €
   1. Mahnung — Mahngebühr:              5,00 €
   Verzugszins (9%, 18 Tage):           1,11 €
   ─────────────────────────────────
   Gesamtforderung:                   256,11 €
   ```
4. **Stufe wählen**: 1. / 2. / Letzte Mahnung (default 1.)
5. **Neue Zahlungsfrist** setzen (default +7 Tage)
6. **Vorschau E-Mail** — Subject + Body mit Platzhaltern
7. **`Senden`** — PDF wird generiert, E-Mail raus, Audit-Eintrag

### Akzeptanz-Checkliste

- [ ] Mahngebühr-Wert: 5,00 € (1. Mahnung, post-2023 § 288 BGB)
- [ ] Verzugszins korrekt: 9% × offener Betrag × Tage/365
- [ ] Gesamtforderung = Offen + Mahngebühr + Verzugszins (innerhalb 0,05 €)
- [ ] E-Mail-Status → "sent"
- [ ] Mahnung-PDF in `/mahnungen/` des GoBD-Archiv-Exports
- [ ] Audit-Log: Mahnung versendet, mit Vorlage-Version + Empfänger

---

## Pfad 4 — Berater-Export (BWA / UStVA / DATEV)

**Rolle**: Berater / Steuerberater
**Ziel**: Alle Daten für den Mandanten an die Steuerkanzlei übergeben.

### 4.1 — BWA (Betriebswirtschaftliche Auswertung)

1. **Berichtscenter** → Tab "**BWA**"
2. Jahr + ggf. Quartal/Monat wählen
3. **`Vorschau`** → KPI-Karten + Tabelle nach DATEV-Bucket
4. Optional: **`📥 Als PDF`** → DATEV-konformes PDF (für Kanzlei)

> **API-Parameter (für direkten Aufruf)**:
> - `GET /api/v1/reports/bwa?year=2026` — Jahres-BWA
> - `GET /api/v1/reports/bwa-quarterly?year=2026&quarter=Q3` — Quartals-BWA
>   **Achtung**: das Quartal-Format ist **`Q1` / `Q2` / `Q3` / `Q4`** (Großbuchstabe
>   `Q` gefolgt von 1-4, kein Integer). Andere Schreibweisen (`q3`, `3`, `III`)
>   werden mit 400 abgewiesen.
> - `GET /api/v1/reports/bwa.pdf?year=2026` — BWA-Jahres-PDF

### 4.2 — USt-Voranmeldung

1. **UStVA** (Sidebar oder Berichtscenter)
2. Jahr + Monat
3. Tabelle: Bemessungsgrundlage 19% / 7% / 0% / §13b / igL + USt + Zahllast
4. **ELSTER-Versand / Archiv**: aktuell wird statt eines UStVA-PDFs die
   **ELSTER-XML** über `GET /api/v1/ustva/filings/:id/elster-xml` ausgeliefert.
   Ein dedizierter `GET /api/v1/ustva/ustva.pdf`-Endpoint ist in der
   Roadmap (siehe Tier 177 in `PHASE3-WALKTHROUGH-FINDINGS.md`).
   Für Berater-Archivierung die ELSTER-XML-Datei direkt im `ustva-filings`
   Tab herunterladen.

### 4.3 — DATEV-Export

1. **Berichtscenter** → Tab "**DATEV-Export**"
2. Zeitraum wählen (default = aktuelles Jahr)
3. Vier Buttons verfügbar:
   - **`📥 CSV herunterladen`** — DATEV-Buchungsstapel (maschinenlesbar)
   - **`📦 CSV + Belegbilder (ZIP)`** — mit jedem Beleg-PDF
   - **`📅 Per Monat aufteilen (ZIP)`** — ein ZIP pro Monat
   - **`📊 Buchungsliste (ZIP)`** — Berater-Übersicht (eine Zeile pro Sachkonto + USt-Verprobung)
4. ZIP-Datei an Steuerberater weiterleiten (oder in DATEV importieren)

### Akzeptanz-Checkliste

- [ ] BWA summiert zu 0 (Soll = Haben)
- [ ] UStVA-Zahllast plausibel (Differenz Vorsteuer / USt-Schuld)
- [ ] DATEV-Buchungsstapel in DATEV importierbar ohne Format-Fehler
- [ ] Buchungsliste TOTAL-Saldo = 0
- [ ] USt-Verprobung stimmt mit UStVA überein (gleiche Summen pro Schlüssel)

---

## Pfad 5 — GoBD-Archiv-Export (Betriebsprüfung)

**Rolle**: Inhaber / Berater
**Ziel**: Auf Anfrage der Finanzamts-Prüfer ein vollständiges Archiv liefern.

### Schritte

1. **Audit-Trail** (Sidebar) → Tab "**Audit-Log**"
2. Button **`🗄 GoBD-Archiv`** + Jahr-Picker (default = aktuelles Jahr)
3. ZIP wird generiert (~50-500 KB pro Jahr), Download startet
4. ZIP-Inhalt:
   ```
   GoBD-2026-SH_Leder_GmbH-2026-08-11.zip
   ├── manifest.json              (mit Self-Hash, prüfbar)
   ├── company-snapshot.json      (Firmenstand + Zertifikat-Fingerprint)
   ├── verification-report.json   (Datei-Status + SHA-256)
   ├── audit-logs/
   │   └── audit-logs-2026.csv
   ├── invoices/
   │   ├── INV-2026-000203_signed.pdf
   │   └── INV-2026-000203.meta.json
   ├── credit-notes/
   ├── mahnungen/
   ├── recurrings/
   └── emails/
   ```
5. ZIP dem Prüfer geben. Prüfer verifiziert:
   - `shasum -a 256 <file>` für jede Datei
   - Vergleich gegen `manifest.json` Hashes
   - `manifest.selfHash` = SHA-256(manifest without selfHash field) — beweist Unverfälschtheit des Manifests

### Akzeptanz-Checkliste

- [ ] ZIP enthält 5+ Dateien pro Jahr
- [ ] Alle PAdes-PDFs tragen `_signed.pdf`-Suffix
- [ ] `manifest.json` selfHash stimmt (testbar: SHA-256 von manifest ohne selfHash)
- [ ] `audit-logs-YYYY.csv` enthält alle Mutationen (Invoice.create, .update, .send, etc.)
- [ ] `company-snapshot.json` zeigt Zertifikat-Fingerprint, der zu den signierten PDFs passt

---

## Multi-Company / Berater-Mandantenverwaltung

### Neuen Mandanten anlegen

1. **`+ Neues Unternehmen`** (oben rechts im Company-Switcher)
2. Firmenname + Ihre E-Mail + Passwort
3. **Login wechseln** — Company-Switcher oben rechts → neuer Mandant
4. Kunden, Rechnungen, Belege sind **strikt getrennt** — keine Vermischung

### Berater-Zugriff auf Mandantendaten

- **Variante 1** (typisch): Berater ist in jedem Mandanten-Company als User eingeladen
- **Variante 2** (selten): Mandant gewährt explizit via `UserCompany`-Grant
- **Lese-Modus**: Header `x-readonly: 1` aktivieren — Berater kann nur lesen, nicht schreiben

### Session-Introspektion (`GET /api/v1/auth/me`)

- Endpoint `GET /api/v1/auth/me` (HeaderAuthGuard-geschützt) liefert den
  Live-Server-Stand der Session:
  ```json
  {
    "id": "<userId>",
    "email": "...",
    "companyId": "<activeCompanyId>",
    "role": "admin",   // ← per-company role (UserCompany.role), NICHT global User.role
    "status": "active",
    "companies": [     // ← alle Mandanten, auf die der User Zugriff hat
      { "id": "...", "name": "SH Leder GmbH", "legalName": null, "role": "admin" }
    ]
  }
  ```
- **Empfohlene Nutzung im Frontend**: bei jedem Page-Load aufrufen, um
  1. die Session zu re-validieren (kein Vertrauen in stale `localStorage`),
  2. den Mandant-Switcher mit der vollständigen Liste der granted
     Mandanten zu befüllen,
  3. die per-Company-Rolle anzuzeigen (kann vom globalen `User.role`
     abweichen, z.B. wenn ein Berater global "admin" ist, aber auf
     einem Mandant nur "berater").
- **Sicherheit**: `passwordHash` / `passwordResetToken` /
  `passwordResetExpires` werden nie in der Response zurückgegeben
  (nicht im Prisma-`select`).

### Sicherheits-Garantien

- **Tenant-Isolation**: Mandant A kann nie Mandant B einsehen (404 / 401)
- **Audit-Trail**: Jede Aktion mit User + IP + Timestamp
- **Read-Only-Modus**: Optional pro Request aktivierbar

---

## API-Endpoint-Übersicht (für API-Tests / Berater-Integration)

Alle Endpoints verlangen `x-user-id` + `x-company-id` Header
(siehe "Authentifizierung" oben) sofern nicht anders vermerkt.

### Auth
- `POST /api/v1/auth/login` — Login (Body: `email`, `password`) — **public**
- `POST /api/v1/auth/register` — Registrierung (Body: `email`, `password`, `name`) — **public**
- `GET /api/v1/auth/me` — Session-Introspektion (User + granted Companies)

### Rechnungen (Kern)
- `POST /api/v1/invoices?companyId=...` — Rechnung erstellen
- `GET /api/v1/invoices?companyId=...&status=&page=&pageSize=&search=` — Liste
- `GET /api/v1/invoices/:id?companyId=...` — Detail
- `PATCH /api/v1/invoices/:id?companyId=...` — Update (draft only)
- `DELETE /api/v1/invoices/:id?companyId=...` — Hard-Delete (nur am Ausstellungstag)
- `GET /api/v1/invoices/:id/pdf?companyId=...` — PDF
- `GET /api/v1/invoices/:id/xrechnung?companyId=...` — XRechnung (UBL XML)
- `GET /api/v1/invoices/:id/zugferd?companyId=...` — ZUGFeRD (PDF+XML)
- `POST /api/v1/invoices/:id/send-email?companyId=...` — E-Mail-Versand
- `POST /api/v1/invoices/:id/credit-note?companyId=...` — Gutschrift (CN)
- `GET /api/v1/invoices/:id/internal-notes?companyId=...` — Berater-Notizen
- `GET /api/v1/invoices/:id/payments?companyId=...` — Zahlungen
- `GET /api/v1/invoices/duplicate-check?companyId=...&customerId=...&amount=...&from=...&to=...` — Duplikate

### Belege (Eingangsrechnungen)
- `POST /api/v1/expenses?companyId=...` — Beleg erfassen
  (Body: `description`, `invoiceDate`, `amount`, `vatAmount`, `accountNumber`, `supplier`, …)
- `GET /api/v1/expenses?companyId=...&pageSize=...` — Liste
- `GET /api/v1/accounting/accounts?companyId=...` — SKR03-Kontenplan

### Mahnungen
- `GET /api/v1/reminders/mahnungen?companyId=...` — Mahnungs-Liste
- `GET /api/v1/reminders/mahnungen/fees-preview?invoiceId=...&level=first|second|final` — Live-Preview
- `GET /api/v1/reminders/mahnungen/fees-config?companyId=...` — Konfigurierte Gebühren
- `GET /api/v1/reminders/templates/{first|second|final}/preview?companyId=...&invoiceId=...` — Template-Vorschau
- `POST /api/v1/reminders/send?companyId=...` — Mahnung(en) versenden
- `GET /api/v1/reminders/stats?companyId=...` — Overdue-Counter
- `GET /api/v1/reminders/auto-settings?companyId=...` — Auto-Run-Konfiguration

### Berater-Export
- `GET /api/v1/reports/bwa?companyId=...&year=...` — BWA Jahres
- `GET /api/v1/reports/bwa-quarterly?companyId=...&year=...&quarter=Q1|Q2|Q3|Q4` — BWA Quartal
- `GET /api/v1/reports/bwa.pdf?companyId=...&year=...` — BWA-Jahres-PDF
- `GET /api/v1/reports/dashboard?companyId=...` — Dashboard-KPIs
- `GET /api/v1/reports/datev-export?companyId=...&year=...&month=...` — DATEV-CSV
- `GET /api/v1/reports/datev-export-bundle?companyId=...&year=...` — DATEV-CSV-Bundle (ZIP, alle Monate)
- `GET /api/v1/reports/datev-preview?companyId=...&year=...&month=...` — DATEV-CSV-Preview (JSON)
- `GET /api/v1/ustva/compute?companyId=...&year=...&month=...` — UStVA-Berechnung
- `GET /api/v1/ustva/filings/:id/elster-xml` — ELSTER-XML
- `GET /api/v1/ustva/history?companyId=...` — UStVA-Historie (vergangene Einreichungen)
- `GET /api/v1/accounting/euer?companyId=...&year=...` — EÜR
- `GET /api/v1/accounting/anlage-s?companyId=...&year=...` — Anlage S
- `GET /api/v1/accounting/bilanz?companyId=...&year=...` — Bilanz
- `GET /api/v1/accounting/anlage-so-v2?companyId=...&year=...` — Anlage SO (v2)

### GoBD
- `GET /api/v1/gobd-export?companyId=...&year=...` — Vollständiges Archiv (ZIP)

---

## Support-Kontakt

Bei Fragen: `support@example.com` (TODO: durch echte E-Mail ersetzen)

Bei Fehlern:
1. Screenshot + Browser-Konsole
2. Welche Schritte haben zum Fehler geführt?
3. Welche Company + welcher User?
4. Audit-Log-Zeitstempel?

Diese 4 Angaben beschleunigen die Diagnose erheblich.
