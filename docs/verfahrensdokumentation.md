# Verfahrensdokumentation de-invoice (Vorlage)

**Version 1.0 · Stand 30.10.2026 · gilt für den Programmstand ab Tier 742**

Diese Vorlage beschreibt, was das Programm de-invoice tatsächlich tut. Jeder
Satz über das Programm wurde am Quelltext oder durch eine Messung am laufenden
Programm geprüft. Sie ist keine fertige Verfahrensdokumentation: Eine
Verfahrensdokumentation beschreibt das Verfahren *eines Unternehmens*, und was
außerhalb des Programms geschieht, weiß das Programm nicht. Diese Stellen sind
markiert:

> **[Auszufüllen]** … hier trägt das Unternehmen seine Angaben ein.

Abschnitt 7 nennt die Grenzen des Programms. Sie sind Teil der Dokumentation und
sollten mit dem Steuerberater besprochen werden. Die Vorlage ersetzt keine
steuerliche Beratung.

**Rechtsgrundlagen:** §§ 145–147 AO, §§ 238 ff., 257 HGB, § 14b UStG; GoBD (BMF-Schreiben
vom 28.11.2019, geändert am 11.03.2024 und 14.07.2025), dort Rz. 151 ff. zur
Verfahrensdokumentation. Art und Umfang richten sich nach der Größe und
Komplexität des Unternehmens; bei einem kleinen Unternehmen fällt sie entsprechend
knapper aus.

---

## 1. Allgemeine Beschreibung

### 1.1 Das Unternehmen

> **[Auszufüllen]** Firma, Rechtsform, Anschrift, Steuernummer, USt-IdNr., Gewinnermittlung
> (Bilanz oder EÜR), Soll- oder Ist-Versteuerung, Kleinunternehmer ja/nein, Art des Geschäfts,
> ungefähre Zahl der Belege im Jahr, steuerlicher Berater.

> **[Auszufüllen]** Verantwortlich für die Buchführung; Vertretung; wer Rechnungen freigibt;
> wer Eingangsrechnungen erfasst; wer die Kasse führt; wer den Betrieb des Programms verantwortet
> (eigener Server oder Betreiber).

### 1.2 Aufgabe des Programms

de-invoice ist eine Webanwendung für Rechnungsstellung und Buchführung. Sie deckt ab:

- Ausgangsrechnungen, Gutschriften, Angebote, Lieferscheine, Auftragsbestätigungen, Proforma-Rechnungen, Quittungen, Mahnungen;
- Eingangsrechnungen und Ausgaben, auch als E-Rechnung und als Scan;
- Zahlungen, Bankauszüge, Kassenbuch;
- Buchungsbelege und Journal nach SKR03, Anlagevermögen und AfA;
- Umsatzsteuer-Voranmeldung, Zusammenfassende Meldung, EÜR, BWA und weitere Auswertungen;
- Exporte für den Steuerberater (DATEV) und für die Betriebsprüfung (GoBD-Archiv).

Das Programm übermittelt nichts an die Finanzverwaltung. ELSTER-Dateien werden
erzeugt und im Portal des Unternehmens eingelesen.

### 1.3 Aufbewahrungsfristen

| Unterlage | Frist | Rechtsgrundlage |
|---|---|---|
| Bücher, Aufzeichnungen, Inventare, Jahresabschlüsse, Lageberichte | 10 Jahre | § 147 Abs. 1 Nr. 1, Abs. 3 AO; § 257 Abs. 1 Nr. 1, Abs. 4 HGB |
| Buchungsbelege, auch Rechnungen | 8 Jahre | § 147 Abs. 1 Nr. 4, Abs. 3 AO; § 257 Abs. 4 HGB; § 14b Abs. 1 UStG |
| Empfangene und abgesandte Handelsbriefe | 6 Jahre | § 147 Abs. 1 Nr. 2, 3, Abs. 3 AO; § 257 Abs. 4 HGB |
| Sonstige steuerlich bedeutsame Unterlagen | 6 Jahre | § 147 Abs. 1 Nr. 5, Abs. 3 AO |

Die Frist beginnt mit dem Schluss des Kalenderjahres, in dem die Unterlage
entstanden ist (§ 147 Abs. 4 AO). Sie läuft nicht ab, solange die Unterlage für
eine noch offene Steuerfestsetzung von Bedeutung ist (§ 147 Abs. 3 Satz 3 AO).
Das Programm löscht keine Unterlagen nach Fristablauf (siehe 7).

---

## 2. Anwenderdokumentation

Die Bedienung Schritt für Schritt steht in `USER-GUIDE.md`. Hier steht, welche
Regeln das Programm dabei durchsetzt.

### 2.1 Ausgangsrechnungen

- **Nummer.** Beim Anlegen vergibt das Programm eine fortlaufende Nummer je Firma, Belegart und Jahr, z. B. `INV-2026-000001` (`backend/src/modules/invoice/invoice-number.ts`). Eine einmal an den Kunden gelangte Nummer wird nie wieder vergeben; auch nach dem Löschen eines Dokuments oder nach einer Wiederherstellung aus einer Sicherung nicht (`RetiredInvoiceNumber`).
- **Ausstellen.** Ein Entwurf wird erst ausgestellt, wenn die Pflichtangaben des § 14 UStG vollständig sind (`backend/src/modules/invoice/mandatory-details.ts`). Ein Entwurf ist in keiner Auswertung enthalten.
- **Die aufbewahrte Fassung.** Beim Ausstellen legt das Programm die Rechnung als PDF ab, bei E-Rechnungen auch das XML, und gibt danach diese Fassung aus, nicht eine neu berechnete (`backend/src/modules/invoice/invoice-document.ts`).
- **Änderung.** Eine ausgestellte Rechnung lässt sich nur an ihrem Ausstellungstag ändern oder löschen, und nur solange keine Zahlung und keine Gutschrift darauf gebucht ist und sie nicht an den Kunden versendet wurde. Danach wird mit einer Gutschrift korrigiert. Ein ausgestelltes Dokument wird außerhalb dieser Regel nicht wieder zum Entwurf.
- **E-Rechnung.** Ausgehend XRechnung 3.0 (UBL) und ZUGFeRD/Factur-X (Profil EN 16931).

### 2.2 Eingangsrechnungen und Ausgaben

- **Eingang.** Eingangsrechnungen werden von Hand hochgeladen; es gibt keinen Abruf aus einem Postfach und kein Peppol.

> **[Auszufüllen]** Eingangswege des Unternehmens (Post, E-Mail-Adresse, Portal), wer dort
> wann nachsieht, wie lange es dauert, bis ein Beleg erfasst ist.

- **E-Rechnung.** XRechnung (UBL, CII) und ZUGFeRD/Factur-X werden gelesen, nicht abgetippt. Das Programm prüft jede eingehende E-Rechnung mit dem offiziellen KoSIT-Validator gegen EN 16931 und vermerkt das Ergebnis bei der Ausgabe. Eine Rechnung, die die Prüfung nicht besteht, kann erfasst werden; der Lieferant ist um eine korrigierte Rechnung zu bitten. Die empfangene Datei wird byte-genau als Beleg gespeichert und kann nicht entfernt werden.
- **Scan.** Ein Scan oder Foto wird per Texterkennung gelesen; das Ergebnis ist ein Vorschlag, den ein Mensch prüft und bestätigt. Der Scan wird als Beleg gespeichert. Mehrere Steuersätze auf einem Beleg werden als eine Ausgabe mit einer Zeile je Steuersatz erfasst.
- **Prüfungen beim Erfassen.** Kein Rechnungsdatum in der Zukunft, Beträge passen zusammen, dieselbe Rechnungsnummer desselben Lieferanten wird nur nach ausdrücklicher Bestätigung ein zweites Mal erfasst, kein Erfassen in einem abgeschlossenen Zeitraum.
- **Änderung.** Eine Ausgabe, die bezahlt ist oder zu einer anderen Buchung gehört (SEPA-Lauf, Kassenbuch, Bankbuchung, AfA), lässt sich nicht mehr ändern oder löschen (`backend/src/modules/expense/expense-lock.ts`). Korrigiert wird mit einer Lieferanten-Gutschrift.

> **[Auszufüllen]** Prüfung und Freigabe von Eingangsrechnungen: Wer prüft sachlich und
> rechnerisch? Papierbelege: Werden sie nach dem Scannen vernichtet? Das setzt ein in dieser
> Dokumentation beschriebenes Scanverfahren voraus (wer scannt, wann, Vollständigkeitskontrolle);
> ohne diese Beschreibung bleiben die Papierbelege aufzubewahren. Nachweise für Belege, die
> außersteuerlich im Original aufzubewahren sind, gehen vor.

### 2.3 Belegablage

- Jeder Beleg hängt an seinem Datensatz (Ausgabe, Buchungsbeleg, Rechnung) und ist von dort aus aufrufbar. So ist die Verbindung von Beleg und Buchung jederzeit nachvollziehbar.
- Beim Speichern wird der SHA-256-Hash des Inhalts festgehalten. Das GoBD-Archiv vergleicht jede Datei damit und nennt fehlende oder veränderte Dateien.
- **Ein Beleg wird nicht gelöscht** (`backend/src/modules/attachment/attachments.service.ts`). Eine versehentlich angehängte Datei lässt sich von einem offenen Datensatz nehmen: Sie verschwindet aus der Ansicht, Datensatz und Datei bleiben erhalten, die Änderung steht im Protokoll, und die GoBD-Archive führen sie unter `entfernt/`. In abgeschlossenen Zeiträumen ist das nicht möglich. Die Dateiverwaltung der Einstellungen entfernt nur Dateien, die zu nichts gehören.

### 2.4 Zahlungen, Bank

- Bankauszüge werden als CAMT.053 oder MT940 eingelesen und vorab angezeigt; Zahlungen werden Rechnungen und Ausgaben zugeordnet.
- FinTS kann Umsätze abrufen. TAN-Eingabe und Überweisungen sind nicht umgesetzt.

> **[Auszufüllen]** Wer gleicht die Bank ab, wie oft, und wer gibt Zahlungen frei?

### 2.5 Kassenbuch

- Kasseneinnahmen und -ausgaben werden täglich festgehalten; ein negativer Kassenbestand wird abgewiesen.
- Bis zum Tagesabschluss lässt sich ein Eintrag ändern; jede Änderung steht im Protokoll. Nach dem Tagesabschluss ist nur noch ein Storno möglich, das den ursprünglichen Eintrag stehen lässt und den Tag als nachträglich geändert kennzeichnet. Der Tagesabschluss trägt einen Hash, der sich prüfen lässt.

> **[Auszufüllen]** Gibt es eine Kasse? Wer zählt, wann? Offene Ladenkasse oder elektronisches
> Kassensystem? Ein elektronisches Kassensystem hat eigene Pflichten (§ 146a AO), die de-invoice
> nicht erfüllt: Das Kassenbuch des Programms ist keine zertifizierte Kasse.

### 2.6 Buchungsbelege und Journal

- Buchungsbelege werden nach SKR03 erfasst. Ein gebuchter Beleg wird nicht geändert: Der Storno ist ein neuer Beleg mit umgekehrten Zeilen, der auf den ursprünglichen verweist (`backend/src/modules/accounting/voucher.service.ts`).
- Das Programm liefert den Kontenrahmen SKR03 aus.

### 2.7 Abschluss von Zeiträumen

- **Umsatzsteuer.** Eine übermittelte Voranmeldung sperrt die Rechnungen, Ausgaben, Zahlungen, Kassen- und Bankbuchungen ihres Zeitraums. Eine Berichtigung gibt ihn frei; das steht im Protokoll.
- **Festschreibung.** Ein Administrator kann die Bücher bis zu einem Tag abschließen. Bis zu diesem Tag wird nichts mehr geschrieben, geändert oder gelöscht; das gilt für alle Belegarten, das Kassenbuch und das Entfernen von Belegen (`backend/src/modules/reports/filed-period.ts`). Ein Administrator kann den Abschluss mit Begründung aufheben; auch das steht im Protokoll.

> **[Auszufüllen]** Wann wird festgeschrieben (z. B. monatlich nach der Voranmeldung)? Wer darf
> einen Abschluss aufheben, und aus welchen Gründen?

---

## 3. Technische Systemdokumentation

### 3.1 Aufbau

| Baustein | Technik |
|---|---|
| Oberfläche | Next.js (Browser) |
| Anwendung | NestJS (Node.js), Prisma |
| Datenbank | PostgreSQL 16 |
| Dateien | Dateisystem (Volume), Pfad je Firma |
| Prüfwerkzeuge | KoSIT-Validator (Java) für E-Rechnungen |
| Betrieb | Docker Compose, Caddy als TLS-Vorschaltung (`infra/prod/docker-compose.yml`) |

Mehrere Firmen liegen in einer Datenbank. Jeder Zugriff ist auf die Firma des
Anmeldenden beschränkt; das wird bei jeder Anfrage geprüft (`backend/src/auth/header-auth.guard.ts`).

Geschäftstage rechnet das Programm in der Zeitzone Europe/Berlin (`backend/src/common/business-date.ts`).

### 3.2 Benutzer und Rechte

| Rolle | Darf |
|---|---|
| `admin` | alles, auch Benutzer und Firmeneinstellungen, Festschreibung |
| `accountant` | Geschäftsdaten erfassen und ändern, Protokoll lesen; keine Benutzer und Firmeneinstellungen |
| `berater` | wie `accountant`; in Protokollen als Berater erkennbar |
| `viewer` | nur lesen, ohne Protokoll, ohne Umsatzsteuer-Voranmeldung, ohne Benutzerverwaltung |

Die Matrix steht in `backend/src/modules/users/users.service.ts`. Anmeldung mit
Passwort, wahlweise mit zweitem Faktor (TOTP). Sitzungen sind serverseitig
gespeichert und enden nach 30 Tagen ohne Nutzung. Die E-Mail-Adresse wird durch
einen zugesandten Link bestätigt.

### 3.3 Protokoll

Das Programm schreibt Anlegen, Ändern und Löschen der Geschäftsdaten automatisch
in ein Protokoll, mit Zeit, Benutzer, IP-Adresse und Inhalt vorher/nachher
(`backend/src/prisma/audit-log.extension.ts`), dazu fachliche Ereignisse wie
Anmeldungen. Die Einträge einer Firma bilden eine SHA-256-Hash-Kette; Audit-Trail →
„Audit-Kette verifizieren" berechnet sie neu (`GET /audit-logs/verify`).

Die Kette macht eine nachträgliche Änderung erkennbar, sie verhindert sie nicht.
Siehe 7.

### 3.4 Schnittstellen

- DATEV Buchungsstapel (EXTF), Belegexport, Personenkonten; eingelesen in DATEV ist das noch nicht erprobt.
- ELSTER: UStVA-XML, ZM-CSV als Dateien; nach den öffentlichen Beschreibungen erstellt, Einlesen im Portal noch nicht erprobt.
- E-Mail über den SMTP-Server der Firma oder der Installation.
- Bank: CAMT.053, MT940, FinTS (Abruf).
- Webhooks für eigene Anbindungen.

> **[Auszufüllen]** Welche Schnittstellen nutzt das Unternehmen, und wer prüft die Übergabe?

---

## 4. Betriebsdokumentation

Die Angaben gelten für den Betrieb nach `infra/prod/`. Der Betreiber bestätigt, dass sie
eingehalten werden.

> **[Auszufüllen]** Betreiber, Serverstandort, Auftragsverarbeitungsvertrag, wer Administratorzugang
> zu Server und Datenbank hat.

- **Datensicherung.** Die Datenbank wird stündlich gesichert. Aufbewahrt werden die Sicherungen der letzten 24 Stunden, eine je Tag für 30 Tage, eine je Woche für 12 Wochen, eine je Monat für 120 Monate. Die Dateien werden stündlich gespiegelt. Ist die letzte Sicherung älter als 3 Stunden, meldet das Programm das.
- **Kopie außer Haus.** Der Dienst `offsite-backup` kopiert Sicherungen und Dateien an einen entfernten Speicher (`infra/prod/offsite-backup.sh`). Er löscht dort nichts wegen des Zustands des Servers. Er muss eingerichtet werden (`BACKUP_OFFSITE_REMOTE`).
- **Wiederherstellung.** Ablauf und Probe stehen in `infra/prod/DR-TEST.md`, `infra/prod/restore.sh`. Nach einer Wiederherstellung prüft das Programm, ob es Rechnungen gibt, die neuer sind als die Datenbanksicherung, meldet sie und sperrt ihre Nummern (`backend/src/modules/backup/restore-check.service.ts`).
- **Überwachung.** Der Zustand der Dienste und der geplanten Aufgaben ist für den Betreiber einsehbar (`infra/prod/RUNBOOK.md`).
- **Änderungen am Programm.** Jede Änderung ist im Git-Verlauf mit Datum und Begründung nachvollziehbar und durchläuft automatische Tests.

> **[Auszufüllen]** Wann werden Updates eingespielt, wer prüft sie, wie wird die Version
> festgehalten? Wann wurde zuletzt eine Wiederherstellung geprobt (Datum, Ergebnis)?

---

## 5. Internes Kontrollsystem

Das Programm setzt durch:

| Kontrolle | Wie |
|---|---|
| Zugriff | Rollen, je Firma, geprüft bei jeder Anfrage; zweiter Faktor wählbar |
| Vollständigkeit der Rechnungen | fortlaufende Nummern, gesperrte Nummern, Pflichtangaben vor dem Ausstellen |
| Doppelerfassung | Warnung bei gleicher Lieferantenrechnung und gleicher Datei |
| Plausibilität | Beträge, Datum, Kassenbestand |
| Unveränderbarkeit | Änderungsregeln (2.1–2.7), Festschreibung, aufbewahrte Fassung, Protokoll, Hash-Kette, SHA-256 der Belege |
| Betrug | abweichende IBAN auf einer E-Rechnung wird gemeldet und nicht übernommen |

> **[Auszufüllen]** Kontrollen des Unternehmens außerhalb des Programms: Vier-Augen-Prinzip bei
> Zahlungen, regelmäßige Durchsicht des Protokolls und der Hash-Kette, Kontenabstimmung,
> Vergabe und Entzug von Zugängen bei Personalwechsel.

---

## 6. Datenzugriff der Finanzverwaltung (§ 147 Abs. 6 AO)

| Art | Umsetzung |
|---|---|
| **Unmittelbar (Z1)** | Dem Prüfer wird ein Benutzer mit der Rolle `viewer` eingerichtet: Er sieht Rechnungen, Ausgaben, Kunden, Buchhaltung und Auswertungen und ändert nichts. Protokoll und Umsatzsteuer-Voranmeldungen sieht diese Rolle nicht; das Protokoll ist Teil des GoBD-Archivs, die Voranmeldungen zeigt ein Mitarbeiter (Z2). Eine eigene Prüfer-Rolle gibt es nicht. |
| **Mittelbar (Z2)** | Ein Mitarbeiter wertet nach Vorgabe des Prüfers im Programm aus. |
| **Datenüberlassung (Z3)** | Audit-Trail → „GoBD-Archiv" (Jahr oder Monat): Rechnungen, Gutschriften, Ausgaben, Belege, Protokoll und ein Manifest mit den SHA-256-Werten aller Dateien. Buchhaltung → „GoBD-Archiv" (Jahr): zusätzlich der Buchungsstapel. Beides ist ein ZIP. |

Die Daten liegen in maschinell auswertbarer Form vor (CSV, JSON, XML).

---

## 7. Grenzen des Programms

Diese Punkte sind offen. Sie sind hier genannt, damit niemand mehr unterstellt, als das
Programm leistet.

1. **Protokoll und Hash-Kette sind nicht gegen den Datenbank-Administrator geschützt.** Die Datenbank hat keine Sperre gegen das Ändern von Protokollzeilen, und die Kette ist nicht außerhalb des Systems verankert. Wer Administratorrechte auf der Datenbank hat, könnte sie neu berechnen. Unabhängige Belege dafür sind die Sicherungen, vor allem die Kopie außer Haus. Deshalb ist der Kreis der Administratoren festzuhalten (Abschnitt 4).
2. **Die Festschreibung lässt sich aufheben.** Das ist gewollt (Berichtigungen) und protokolliert, aber sie ist keine technische Endgültigkeit.
3. **Das Format der Datenüberlassung ist nicht der Beschreibungsstandard.** Das Archiv enthält keine `index.xml` nach dem GDPdU-Beschreibungsstandard. Ob das für die Prüfung genügt, ist mit dem Steuerberater zu klären; gegebenenfalls ist der Export zu ergänzen.
4. **Versendete E-Mails sind nicht vollständig gespeichert.** Das Programm hält Empfänger, Betreff, die ersten 500 Zeichen des Textes und die Namen der Anhänge fest, nicht die ganze E-Mail. Handelsbriefe sind deshalb im E-Mail-Archiv des Unternehmens aufzubewahren. Die Rechnung selbst ist als aufbewahrte Fassung im Programm.
5. **Eingang.** Belege, die per E-Mail kommen, gelangen nur durch Hochladen ins Programm. Bis dahin liegen sie im Postfach; dort sind sie zu sichern.
6. **Elektronische Kassen.** Keine Anbindung, keine TSE.
7. **Wiederherstellung eines entfernten Belegs** geht nur durch den Betreiber.
8. **Nichts wird nach Fristablauf gelöscht.** Auch geschlossene Firmen bleiben gespeichert, bis der Betreiber handelt.
9. **Geschlossene Firmen.** Wer sein Konto löscht und einziges Mitglied ist, schließt die Firma; ihre Unterlagen bleiben bis zum 31.12. des zehnten Jahres gespeichert. Das Unternehmen bleibt selbst aufbewahrungspflichtig und muss vorher die GoBD-Archive herunterladen.
10. **Praxistests stehen aus.** DATEV-Import, ELSTER-Import, Auszüge einer echten Bank; siehe `docs/steuerberater-pruefliste.md`.

---

## 8. Änderungshistorie

Diese Dokumentation ist zu versionieren: Jede Änderung am Verfahren wird mit Datum festgehalten, und
ältere Fassungen sind so lange aufzubewahren, wie die Unterlagen aufzubewahren sind, für die sie galten.

| Version | Datum | Änderung | Verantwortlich |
|---|---|---|---|
| 1.0 | 30.10.2026 | Vorlage aus dem Programmstand erstellt | de-invoice |
| | | **[Auszufüllen]** Übernahme durch das Unternehmen | |
