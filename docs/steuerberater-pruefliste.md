# Prüfung der Steuerformulare und offenen Fragen

Stand 13.10.2026. Auf Wunsch des Inhabers wurden die offenen Fragen so
geprüft, wie ein Steuerberater sie ansehen würde: am Gesetzestext
(gesetze-im-internet.de) und an den Anleitungen der Finanzverwaltung. Das
Ergebnis steht unten, mit dem, was daraufhin im Programm geändert wurde.

Diese Prüfung ersetzt keine Beratung durch einen zugelassenen Steuerberater
und keine Auskunft des Finanzamts. Wo sie an eine Grenze stößt, steht das
dabei.

Unterlagen: Buchhaltung › „Berater-Paket“ erzeugt für ein Jahr ein ZIP mit
allen Formularen als PDF und einer Übersicht (MANIFEST).

## A. Die offenen Fragen — Beurteilung

### 1. Fremdwährung: Umrechnungskurs für die Umsatzsteuer

**Rechtslage (§ 16 Abs. 6 UStG).** Werte in fremder Währung sind nach den
Durchschnittskursen umzurechnen, die das BMF für den Monat bekannt gibt, in
dem die Leistung ausgeführt wird (bei Ist-Versteuerung: in dem das Entgelt
vereinnahmt wird). „Das Finanzamt kann die Umrechnung nach dem Tageskurs, der
durch Bankmitteilung oder Kurszettel nachzuweisen ist, gestatten.“

**Beurteilung.** Das Programm rechnet mit dem EZB-Referenzkurs des
Rechnungstags und hält Kurs, Datum und Quelle an jeder Rechnung fest. Das ist
der Tageskurs — zulässig mit Gestattung des Finanzamts. Die Gestattung ist
formlos zu beantragen und wird üblicherweise erteilt; der Nachweis liegt im
Programm vor. Bis sie da ist, ist der Monatsdurchschnittskurs des BMF
maßgeblich: er lässt sich an jeder Rechnung von Hand eintragen.

**Empfehlung.** Gestattung beantragen (Text unten). Eine Umstellung des
Programms auf Monatsdurchschnittskurse wäre möglich, lohnt aber nur, wenn das
Finanzamt den Tageskurs ablehnt.

**Geändert.** Der Hinweis am Kursfeld der Rechnung nennt die Regel und die
Gestattung.

> An das Finanzamt …
> Steuernummer …
>
> **Antrag auf Gestattung der Umrechnung nach dem Tageskurs (§ 16 Abs. 6 Satz 3 UStG)**
>
> Sehr geehrte Damen und Herren,
>
> wir stellen vereinzelt Rechnungen in fremder Währung aus. Wir beantragen,
> die Werte in fremder Währung für die Berechnung der Umsatzsteuer und der
> abziehbaren Vorsteuerbeträge ab dem Voranmeldungszeitraum … nach dem
> Tageskurs umrechnen zu dürfen. Als Tageskurs verwenden wir den
> Euro-Referenzkurs der Europäischen Zentralbank des Rechnungsdatums; an
> Tagen ohne Feststellung den zuletzt festgestellten Kurs. Kurs, Datum und
> Quelle werden zu jeder Rechnung aufgezeichnet und können jederzeit
> nachgewiesen werden.
>
> Mit freundlichen Grüßen

### 2. OSS-Umsätze in der Umsatzsteuer-Voranmeldung

**Rechtslage.** Fernverkäufe und elektronische Leistungen an Verbraucher in
anderen EU-Staaten sind im Inland nicht steuerbar (Leistungsort im anderen
Mitgliedstaat), wären es aber bei Ausführung im Inland. Solche Umsätze
gehören nach der Anleitung zur Voranmeldung in die Kennzahl 45 („Übrige nicht
steuerbare Umsätze (Leistungsort nicht im Inland)“), in der Jahreserklärung
in die Kennzahl 205 — nur die Bemessungsgrundlage. Die Steuer wird über das
OSS-Verfahren beim BZSt erklärt (§ 18j UStG).

**Geändert.** Die Nettobeträge der OSS-Umsätze stehen jetzt in Kz 45 / Kz 205
(vorher in keiner Kennzahl); die Steuer bleibt außerhalb der Voranmeldung.

**Dabei gefunden und geändert.** Die OSS-Meldung rechnete Umsätze in fremder
Währung nicht um. § 16 Abs. 6 Satz 4 UStG schreibt dafür den EZB-Kurs des
letzten Tags des Besteuerungszeitraums (Quartals) vor. So wird jetzt
gerechnet; im laufenden Quartal vorläufig mit dem Kurs der Rechnung, und die
Meldung sagt das.

### 3. Verzugszinsen

**Rechtslage (§ 288 BGB).** Fünf Prozentpunkte über dem Basiszinssatz, unter
Unternehmern neun. Verzugszinsen und Mahnkosten sind Schadensersatz und
unterliegen nicht der Umsatzsteuer.

**Beurteilung.** Das Programm berechnet Zinsen auf den heute offenen Betrag
seit Fälligkeit und verlangt für bereits (verspätet) gezahlte Teile keine.
Das ist weniger, als verlangt werden dürfte, nie mehr — unbedenklich, und es
wird ohne Umsatzsteuer berechnet. Keine Änderung.

### 4. Mahngebühren

**Rechtslage.** Mahnkosten sind Verzugsschaden (§§ 280 Abs. 2, 286 BGB). Die
Kosten der Mahnung, die den Verzug erst begründet, sind nicht durch den
Verzug verursacht und können nicht verlangt werden. § 288 BGB kennt keine
Mahngebühr; unter Unternehmern gibt es die Pauschale von 40 € (Abs. 5).

**Geändert.** Für die Zahlungserinnerung ist keine Gebühr mehr voreingestellt
(vorher 5 €, mit dem Hinweis auf eine Reform des § 288 BGB, die es nicht
gibt). 1. Mahnung 5 €, Letzte Mahnung 10 € bleiben; alle Beträge sind in den
Einstellungen änderbar. Wer vertraglich einen Zahlungstermin vereinbart, bei
dem Verzug ohne Mahnung eintritt, kann die erste Stufe selbst setzen.

### 5. Abgabe über ELSTER

Das Programm übermittelt nichts. Die Voranmeldung wird entweder von der
Kanzlei abgegeben oder in Mein ELSTER eingetippt; dafür gibt es die Kennzahlen
als PDF und als XML-Datei. Die XML-Datei ist nicht nach dem ELSTER-Schema
geprüft — das Schema ist nur registrierten Software-Herstellern zugänglich —
und wird im Programm nicht mehr als Upload-Datei bezeichnet. Offen bleibt
nichts, solange niemand eine direkte Übermittlung wünscht.

### 6. Bankdateien

Nicht prüfbar ohne einen echten Kontoauszug der Hausbank (in der
Entwicklungsdatenbank liegt keiner). Den ersten heruntergeladenen CAMT.053-
oder MT940-Auszug zuerst in der Vorschau ansehen.

## B. Was bei der Durchsicht der Formulare außerdem geändert wurde

- **Steuern vom Einkommen als Ausgabe.** Körperschaftsteuer,
  Solidaritätszuschlag (§ 10 Nr. 2 KStG), Gewerbesteuer (§ 4 Abs. 5b EStG) und
  Einkommensteuer (§ 12 Nr. 3 EStG) sind in der Buchhaltung Aufwand, steuerlich
  aber keine Betriebsausgaben. Als Ausgabe erfasst, minderten sie den Gewinn
  der EÜR und das zu versteuernde Einkommen in KSt 1. Sie bleiben Ausgaben
  (die BWA zeigt sie in ihrer Zeile „Steuern vom Einkommen und Ertrag“),
  werden aber in EÜR, Anlage S, Anlage G und KSt 1 nicht mehr abgezogen.
- **Tilgung eines Darlehens** wird nicht als Ausgabe angenommen (nur Zinsen).
- **Geschenke:** Grenze 50 € je Empfänger ab 2024, 35 € davor (§ 4 Abs. 5
  Satz 1 Nr. 1 EStG) — vorher 50 € für jedes Jahr.
- **KSt 1:** Verlustabzug 70 % für 2024–2027, sonst 60 % (§ 10d Abs. 2 EStG).
- **Gewerbesteuer:** Kürzung nach § 9 Nr. 1 Satz 1 GewStG ab 2025 um die als
  Betriebsausgabe erfasste Grundsteuer.
- **Anlagen:** Grund und Boden wird nicht abgeschrieben.
- **Anlagen zur Einkommensteuererklärung** (N, KAP, SO, R, Kind, V, AUS): je
  einmal am Gesetz geprüft und berichtigt; jedes Formular nennt, was es nicht
  abbildet.

## C. Annahmen, die bleiben

**GmbH**

- **KSt 1:** 15 % Körperschaftsteuer, 5,5 % Solidaritätszuschlag darauf,
  Gewerbesteuer mit Messzahl 3,5 % und dem eingetragenen Hebesatz, kein
  Freibetrag, keine Anrechnung nach § 35 EStG. Berechnet werden nur die nicht
  abziehbaren Bewirtungskosten (30 %) und Geschenke über der Grenze.
  Platzhalter: verdeckte Gewinnausschüttungen, Spenden, Verlustabzug,
  ausländische Steuern, § 8b KStG.
- **Gewerbesteuer:** Hinzurechnung nach § 8 Nr. 1 GewStG (Zinsen 100 %, Mieten
  für Grundbesitz 50 %, Leasing beweglicher Güter 20 %; ein Viertel der Summe
  über 200 000 €). Die erweiterte Kürzung (§ 9 Nr. 1 Satz 2) fehlt.
- **Anlagevermögen:** Abschreibung linear nach Monaten; keine
  Sonderabschreibungen, keine degressive AfA; GWG über die eingetragene
  Nutzungsdauer.

**Anlagen zur Einkommensteuererklärung (für eine GmbH nicht einschlägig)**

- **Anlage N:** ohne Versorgungsbezüge, Altersentlastungsbetrag, steuerfreien
  Arbeitslohn.
- **Anlage KAP:** nur Gutschriften nicht verbuchter, privater Konten;
  maßgeblich ist die Steuerbescheinigung der Bank.
- **Anlage SO:** ohne das selbst bewohnte Haus, die Zehnjahresfrist für als
  Einkunftsquelle genutzte Güter, den Verlustrücktrag.
- **Anlage Kind:** volljährige Kinder zählen, wenn sie als berechtigt
  eingetragen sind — der Nachweis ist zu prüfen. Keine Günstigerprüfung.
- **Anlage V:** alle Rechnungen des Unternehmens gelten als Mieteinnahmen.
- **Anlage AUS:** Methode nach dem üblichen Inhalt der Abkommen, je Eintrag
  änderbar; das einzelne Abkommen ist zu prüfen.
