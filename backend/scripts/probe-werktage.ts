/**
 * Tier 846 — the Werktage of a dunning letter, for backend spec 540: fixed
 * dates, so that the check does not depend on the day it runs.
 * Prints one line: "<BY> <BE> <no Land> <Karfreitag 2031 a Werktag?> <Reformationstag 2028 in BB a Werktag?>".
 */
import { countWerktage, isWerktag } from '../src/modules/reminder/werktage'

const d = (iso: string) => new Date(`${iso}T00:00:00`)
// Fri 29.10.2027 → Wed 03.11.2027: between them Sat, Sun, Mon 01.11. (Allerheiligen in BY), Tue
const span = (land?: string) => countWerktage(d('2027-10-29'), d('2027-11-03'), land)
console.log(
  [span('BY'), span('BE'), span(), isWerktag(d('2031-04-11'), 'BE'), isWerktag(d('2028-10-31'), 'BB')].join(' '),
)
