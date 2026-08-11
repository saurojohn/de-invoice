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

### 4.2 — USt-Voranmeldung

1. **UStVA** (Sidebar oder Berichtscenter)
2. Jahr + Monat
3. Tabelle: Bemessungsgrundlage 19% / 7% / 0% / §13b / igL + USt + Zahllast
4. **`📥 UStVA-PDF`** (für ELSTER-Versand oder Archiv)

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

### Sicherheits-Garantien

- **Tenant-Isolation**: Mandant A kann nie Mandant B einsehen (404 / 401)
- **Audit-Trail**: Jede Aktion mit User + IP + Timestamp
- **Read-Only-Modus**: Optional pro Request aktivierbar

---

## Support-Kontakt

Bei Fragen: `support@example.com` (TODO: durch echte E-Mail ersetzen)

Bei Fehlern:
1. Screenshot + Browser-Konsole
2. Welche Schritte haben zum Fehler geführt?
3. Welche Company + welcher User?
4. Audit-Log-Zeitstempel?

Diese 4 Angaben beschleunigen die Diagnose erheblich.
