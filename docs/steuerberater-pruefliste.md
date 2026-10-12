# Prüfliste für den Steuerberater

Stand 12.10.2026. Die Steuerformulare der Anwendung sind Vorschauen: sie
rechnen aus den erfassten Daten und sagen auf jedem Formular, was sie nicht
abbilden. Diese Liste nennt, was ein Steuerberater einmal ansehen sollte,
bevor die Zahlen verwendet werden — zuerst die Fragen, die eine Entscheidung
brauchen, dann die Annahmen je Formular.

Unterlagen dazu: Buchhaltung › „Berater-Paket“ erzeugt für ein Jahr ein ZIP
mit allen Formularen als PDF und einer Übersicht (MANIFEST).

## A. Fragen, die eine Entscheidung brauchen

1. **Fremdwährung — Umrechnungskurs (§ 16 Abs. 6 UStG).** Rechnungen in
   fremder Währung werden mit dem EZB-Referenzkurs des Rechnungstags
   umgerechnet. Das Gesetz nennt die monatlichen Durchschnittskurse des BMF;
   der Tageskurs braucht die Gestattung des Finanzamts. Soll diese Gestattung
   beantragt werden — oder soll die Anwendung auf Monatsdurchschnittskurse
   umgestellt werden?
2. **OSS-Umsätze in der UStVA.** Nimmt das Unternehmen am OSS-Verfahren teil,
   erscheinen die dort gemeldeten Umsätze in keiner Kennzahl der UStVA.
   Richtig so, oder sind sie in einer Kennzahl nachrichtlich anzugeben?
3. **Verzugszinsen in Mahnungen.** Zinsen werden auf den heute offenen Betrag
   für die ganze Zeit seit Fälligkeit berechnet; ein verspätet gezahlter Teil
   trägt keine. Das ist weniger als § 288 BGB erlaubt, nie mehr. Gewollt?
4. **Mahngebühren.** Voreinstellung 5 € / 5 € / 10 € ab der ersten Mahnung.
   Ob für die Mahnung, die den Verzug erst begründet, eine Gebühr verlangt
   werden darf, ist mit einem Anwalt zu klären.
5. **ELSTER.** Die Anwendung übermittelt nichts. UStVA und UStJA lassen sich
   als PDF und als XML mit den Kennzahlen herunterladen; die XML-Datei ist
   nicht nach dem ELSTER-Schema geprüft und nicht zum Hochladen gedacht. Wie
   sollen die Voranmeldungen abgegeben werden — durch die Kanzlei (DATEV), oder
   durch Abschreiben in Mein ELSTER?
6. **Bankdateien.** Die Leser für CAMT.053 und MT940 sind nach dem Schema
   gebaut, aber noch mit keinem echten Kontoauszug der Hausbank erprobt.

## B. Annahmen je Formular

**GmbH (die eigene Rechtsform)**

- **KSt 1:** 15 % Körperschaftsteuer, 5,5 % Solidaritätszuschlag darauf,
  Gewerbesteuer mit Messzahl 3,5 % und dem eingetragenen Hebesatz, kein
  Freibetrag, keine Anrechnung nach § 35 EStG. Berechnet werden nur die nicht
  abziehbaren Bewirtungskosten (30 %) und Geschenke über 50 € je Empfänger.
  Platzhalter, vom Berater zu ergänzen: verdeckte Gewinnausschüttungen,
  Spenden, Verlustabzug (§ 10d Abs. 2 EStG: 70 % für 2024–2027, sonst 60 %),
  ausländische Steuern, § 8b KStG.
- **Gewerbesteuer:** Hinzurechnung nach § 8 Nr. 1 GewStG (Zinsen 100 %, Mieten
  für Grundbesitz 50 %, Leasing beweglicher Güter 20 %; ein Viertel der Summe
  über 200 000 €). Kürzung nach § 9 Nr. 1 Satz 1 ab 2025 um die als
  Betriebsausgabe erfasste Grundsteuer; bis 2024 Platzhalter (Einheitswert
  nicht bekannt). Die erweiterte Kürzung (Satz 2) ist nicht abgebildet.
- **Anlagen:** Abschreibung linear nach Monaten (§ 7 Abs. 1 EStG), der Monat
  der Anschaffung und der Veräußerung zählt voll. Grund und Boden wird nicht
  abgeschrieben. Keine Sonderabschreibungen, keine degressive AfA, GWG wie
  jede andere Anlage über die eingetragene Nutzungsdauer.
- **Umsatzsteuer:** Kennzahlen nach USt 1 A / USt 2 A 2026. Die Tilgung eines
  Darlehens wird nicht als Ausgabe angenommen (nur die Zinsen).

**Anlagen zur Einkommensteuererklärung (für eine GmbH nicht einschlägig)**

- **Anlage N:** Arbeitnehmer-Pauschbetrag statt der Werbungskosten, wenn diese
  nicht höher sind, höchstens der Arbeitslohn (§ 9a EStG). Nicht abgebildet:
  Versorgungsbezüge, Altersentlastungsbetrag, steuerfreier Arbeitslohn.
- **Anlage KAP:** Gutschriften der importierten Konten, deren Verwendungszweck
  Zinsen oder Dividenden nennt und die nicht verbucht sind. Erträge eines
  betrieblichen Kontos gehören nicht hierher (§ 20 Abs. 8 EStG). Die Gutschrift
  ist der Betrag nach einbehaltener Steuer; maßgeblich ist die
  Steuerbescheinigung der Bank.
- **Anlage SO:** Fristen des § 23 Abs. 1 EStG (Grundstücke zehn Jahre, andere
  Wirtschaftsgüter ein Jahr; seit 2009 angeschaffte Wertpapiere gehören in die
  Anlage KAP), Verlustverrechnung innerhalb des Jahres, Freigrenze 1 000 €
  (bis 2023: 600 €). Nicht abgebildet: das selbst bewohnte Haus, die
  Zehnjahresfrist für als Einkunftsquelle genutzte Güter, ein Verlustrücktrag.
- **Anlage R:** Besteuerungsanteil nach dem Jahr des Rentenbeginns,
  Ertragsanteil nach dem Alter bei Beginn (§ 22 Nr. 1 Satz 3 EStG).
- **Anlage Kind:** Kindergeld monatlich, Freibeträge des § 32 Abs. 6 EStG je
  Elternteil und Monat, bei Zusammenveranlagung verdoppelt; Beträge der Jahre
  2021–2026. Volljährige Kinder zählen, wenn sie als berechtigt eingetragen
  sind — der Nachweis ist zu prüfen. Keine Günstigerprüfung.
- **Anlage V:** alle Rechnungen des Unternehmens gelten als Mieteinnahmen, die
  Ausgaben werden nach ihrer Kategorie den Zeilen zugeordnet.
- **Anlage AUS:** Methode nach dem üblichen Inhalt der Abkommen (Dividenden und
  Zinsen: Anrechnung; Arbeitslohn, Betriebsstätte, Grundbesitz:
  Freistellung), je Eintrag änderbar. Das einzelne Abkommen ist zu prüfen. Die
  anzurechnende Steuer ist die gezahlte, nicht der zulässige Höchstbetrag.
