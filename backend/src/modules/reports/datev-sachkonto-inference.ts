/**
 * Tier 26: SKR03 Sachkonten auto-inference for expenses.
 *
 * The DATEV export (buildBuchungenFromDb) already
 * handles user-chosen accounts via VoucherLine.accountId
 * (FK to the Account table). The problem Tier 26
 * solves: when the user creates an Expense WITHOUT
 * a chosen account (the common case — they don't know
 * the SKR03 number off the top of their head), we
 * auto-suggest an account based on the Buchungstext
 * (description + supplier name).
 *
 * Pattern matching is keyword-based, case-insensitive,
 * German-first (this is a German tax codebase). The
 * mapping is the SKR03 standard (DATEV's most-used
 * Kontenplan for German SMBs). 99% of German Buchführer
 * use SKR03 or SKR04 — we ship SKR03; SKR04 users can
 * fork the mapping table.
 *
 * The mapping is conservative: we never auto-book
 * to a "risky" account (e.g. 4000-series revenue) —
 * only 4xxx-49xx expense accounts are inferred. The
 * user can override by setting accountId on the
 * VoucherLine directly; that always wins.
 *
 * Confidence scoring (0-100):
 *   - 100: exact full-string match
 *   - 75:  word-boundary match
 *   - 50:  substring match
 *   - 25:  fuzzy / partial
 *   - 0:   no match (caller falls back to 4900)
 *
 * The exported `inferExpenseAccount()` returns the
 * best match + confidence; callers (the Voucher POST
 * handler, the expense-import flow) can use the
 * confidence to decide whether to auto-apply or
 * surface a confirmation UI.
 *
 * Why not a more sophisticated ML approach?
 *   - Buchungstext is short (60 chars typical). Not
 *     enough signal for ML.
 *   - A Steuerberater's intake form is usually the
 *     same 30-50 categories — rule-based is enough.
 *   - Rules are auditable: every auto-suggestion has
 *     a keyword + match-position the user can see.
 *   - Tax law changes infrequently; rule maintenance
 *     is one PR per BMF-Schreiben. Retraining a model
 *     would be much more painful.
 */

import { PrismaClient } from '@prisma/client';

/**
 * SKR03 default account for a given Buchungstext
 * (description) — return value of the highest-scoring
 * rule, or `null` if no rule matched.
 */
export interface SachkontoInference {
  accountNumber: string
  accountName: string
  confidence: number
  matchedKeyword: string
  ruleIndex: number
}

/**
 * Single rule: a list of keywords (lowercased) that
 * each trigger the same Sachkonto. The first match
 * (in declaration order) wins for a given description
 * — we use word-boundary + substring fall-through so
 * "Bürobedarf" matches before "Büro".
 */
interface InferenceRule {
  accountNumber: string
  accountName: string
  /** Lowercased, deduped at module load */
  keywords: string[]
}

/**
 * SKR03 expense inference rules.
 *
 * Declaration order matters: rules higher in the list
 * win for overlapping keywords. We put the
 * highest-specificity rules first ("bürobedarf"
 * before the generic "software" that would otherwise
 * match "bürosoftware").
 */
// Tier 830: the SKR03 numbers checked against the Kontenrahmen, and the
// accounts a trading or crafts business needs added (the month-end drill
// exported every bill to 4900). Were wrong: Porto / Telefon on 4970 (that is
// „Nebenkosten des Geldverkehrs"), Versicherungen on 4380 („Beiträge"),
// Werbung and Reisen on 4760 („Verkaufsprovisionen"). Goods go to 3200
// „Wareneingang", not to the automatic 3400: the export gives every row its
// tax key, and DATEV takes no key on an automatic account.
const RULES: InferenceRule[] = [
  {
    accountNumber: '4930',
    accountName: 'Bürobedarf',
    keywords: ['bürobedarf', 'druckerpatrone', 'toner', 'papier', 'stempel', 'kugelschreiber', 'büromaterial', 'ordner', 'hefter'],
  },
  {
    accountNumber: '4940',
    accountName: 'Zeitschriften, Bücher',
    keywords: ['zeitschrift', 'fachliteratur', 'fachbuch', 'bücher', 'buch ', 'abo', 'ihk-', 'ihk ', 'handelsblatt', 'wirtschaftswoche', 'manager magazin', 'fachzeitschrift'],
  },
  {
    accountNumber: '4955',
    accountName: 'Buchführungskosten',
    keywords: ['buchführung', 'buchhaltung', 'lohnabrechnung', 'jahresabschluss'],
  },
  {
    accountNumber: '4950',
    accountName: 'Rechts- und Beratungskosten',
    // RA = Rechtsanwalt, StB = Steuerberater, WP = Wirtschaftsprüfer
    keywords: ['rechtsanwalt', 'steuerberater', 'notar', 'kanzlei', 'wirtschaftsprüfer', 'ra-', 'stb-', 'wp-', 'ra.', 'stb.', 'wp.', 'steuerb.', 'rechtsberatung', 'steuerberatung', 'notariat', 'lohnsteuerhilfe'],
  },
  {
    accountNumber: '4910',
    accountName: 'Porto',
    keywords: ['porto', 'briefmarke', 'deutsche post', 'dhl', 'hermes', 'dpd', 'gls', 'ups', 'fedex', 'versandkosten'],
  },
  {
    accountNumber: '4920',
    accountName: 'Telefon',
    keywords: ['telefon', 'mobilfunk', 'vodafone', 'telekom', 't-mobile', 'o2', '1&1', 'internet', 'kabelanschluss', 'glasfaser', 'dsl', 'fon', 'tel.'],
  },
  {
    accountNumber: '4970',
    accountName: 'Nebenkosten des Geldverkehrs',
    keywords: ['kontoführung', 'kontogebühr', 'bankgebühr', 'bankentgelt', 'kartengebühr', 'paypal-gebühr', 'stripe-gebühr', 'sumup'],
  },
  {
    accountNumber: '4964',
    accountName: 'Aufwendungen für die zeitlich befristete Überlassung von Rechten (Software, Cloud)',
    keywords: [
      'software', 'saas', 'cloud', 'hosting', 'server', 'warenwirtschaft', 'lizenz',
      'domain', 'ssl', 'tls',
      'aws', 'amazon web', 'azure', 'google cloud', 'gcp',
      'github', 'gitlab', 'bitbucket',
      'figma', 'sketch', 'adobe', 'canva',
      'notion', 'slack', 'discord', 'zoom', 'teams',
      'microsoft 365', 'office 365', 'm365', 'o365',
      'atlassian', 'jira', 'confluence', 'trello',
      'salesforce', 'zendesk', 'freshdesk',
      'github copilot', 'openai', 'anthropic', 'claude api',
    ],
  },
  {
    accountNumber: '4210',
    accountName: 'Miete (unbewegliche Wirtschaftsgüter)',
    keywords: ['miete', 'pacht', 'raumkosten', 'büromiete', 'ladenmiete', 'hallenmiete', 'gewerbemiet'],
  },
  {
    accountNumber: '4240',
    accountName: 'Gas, Strom, Wasser',
    keywords: ['energie', 'strom', 'gas', 'wasser', 'heizung', 'fernwärme', 'stadtwerke', 'e.on', 'rwe', 'vattenfall', 'lichtblick'],
  },
  {
    accountNumber: '4360',
    accountName: 'Versicherungen',
    keywords: ['versicherung', 'versich.', 'haftpflicht', 'kfz-versich', 'gewerbeversich', 'allianz', 'huk', 'axa', 'r+v', 'generali'],
  },
  {
    accountNumber: '4380',
    accountName: 'Beiträge',
    keywords: ['beitrag', 'beiträge', 'kammerbeitrag', 'ihk-beitrag', 'hwk-beitrag', 'verbandsbeitrag', 'mitgliedsbeitrag'],
  },
  {
    accountNumber: '4500',
    accountName: 'Fahrzeugkosten',
    // running costs of the company's own vehicles, not goods for resale
    keywords: ['tanken', 'tankstelle', 'benzin', 'diesel', 'kraftstoff', 'e-fuel', 'adac', 'dkv', 'shell', 'total energies', 'aral', 'esso', 'bp ', 'parkhaus', 'parken', 'maut', 'tüv', 'hu ', 'kfz-', 'kfz.', 'autowäsche', 'reifen', 'autobatterie'],
  },
  {
    accountNumber: '4600',
    accountName: 'Werbekosten',
    keywords: ['werbung', 'werbekosten', 'werbematerial', 'werbeartikel', 'flyer', 'marketing', 'google ads', 'meta ads', 'facebook ads', 'linkedin ads', 'messestand', 'messeauftritt', 'messegebühr', 'messeteilnahme', 'anzeige', 'banner', 'plakat', 'flugblatt', 'newsletter', 'mailing', 'seo', 'sea', 'hubspot', 'mailchimp', 'sendinblue', 'brevo'],
  },
  {
    accountNumber: '4650',
    accountName: 'Bewirtungskosten',
    keywords: ['bewirtung', 'geschäftsessen', 'restaurants', 'restaurant', 'speisen', 'gastronomie'],
  },
  {
    accountNumber: '4660',
    accountName: 'Reisekosten',
    keywords: ['reisekosten', 'flug', 'hotel', 'übernachtung', 'bahn', 'db ', 'deutsche bahn', 'flixbus', 'uber', 'taxi', 'mietwagen', 'geschäftsreise'],
  },
  {
    accountNumber: '4945',
    accountName: 'Fortbildungskosten',
    keywords: ['fortbildung', 'weiterbildung', 'seminar', 'schulung', 'lehrgang'],
  },
  {
    accountNumber: '4805',
    accountName: 'Reparaturen und Instandhaltung von Betriebs- und Geschäftsausstattung',
    keywords: ['reparatur', 'instandhaltung', 'wartung', 'instandsetzung'],
  },
  {
    accountNumber: '4985',
    accountName: 'Werkzeuge und Kleingeräte',
    keywords: ['werkzeug', 'kleingerät'],
  },
  {
    accountNumber: '3200',
    accountName: 'Wareneingang',
    keywords: ['wareneinkauf', 'wareneingang', 'handelsware', 'waren'],
  },
  {
    accountNumber: '4710',
    accountName: 'Verpackungsmaterial',
    keywords: ['verpackung', 'versandkarton', 'karton', 'luftpolster'],
  },
  {
    accountNumber: '3000',
    accountName: 'Roh-, Hilfs- und Betriebsstoffe',
    keywords: ['rohstoff', 'hilfsstoff', 'betriebsstoff', 'material'],
  },
  {
    accountNumber: '3100',
    accountName: 'Fremdleistungen',
    keywords: ['fremdleistung', 'subunternehmer', 'nachunternehmer'],
  },
  {
    accountNumber: '4900',
    accountName: 'Sonstige betriebliche Aufwendungen',
    // the fallback when nothing above matched (inferExpenseAccount)
    keywords: ['sonstige', 'diverses', 'sachaufwand', 'betriebsausgabe', 'aufwand', 'auslagen', 'spesen'],
  },
]

/** Tier 830: the name of an expense account the inference can choose (for lists that name the account). */
export function inferredAccountName(accountNumber: string): string | undefined {
  return RULES.find((r) => r.accountNumber === accountNumber)?.accountName
}

/** Compile the keyword list once at module load. The
 *  regex anchors matter: a keyword "büro" should
 *  match "Bürobedarf" (a word-start match) but not
 *  "Software für Bürosoftware" (substring would
 *  false-positive here). We use word boundaries for
 *  short keywords (< 4 chars) and substring for the
 *  rest. The full match decision tree is:
 *    1. if keyword length < 4: word-boundary match
 *    2. else: substring match (still word-aware in
 *       practice because descriptions are short and
 *       whitespace-tokenised).
 *  This avoids "gas" false-matching "Gastarbeiter"
 *  while still allowing "Telekom" to match "telekom".
 */
const COMPILED: Array<InferenceRule & { re: RegExp[] }> = RULES.map((r) => ({
  ...r,
  re: r.keywords.map((kw) => {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (kw.length < 4) {
      // word-boundary match, case-insensitive. Tier 832: on both sides when
      // the keyword ends in a letter or digit — „gas" took „Gastronomie" and
      // „Gasthaus" (a restaurant bill on 4240), „fon" „Fondue", „sea" „Seat",
      // „ups" „Upside", „abo" „Abort".
      return new RegExp(/[a-z0-9]$/i.test(kw) ? `\\b${escaped}\\b` : `\\b${escaped}`, 'i')
    }
    // substring match, case-insensitive
    return new RegExp(escaped, 'i')
  }),
}))

/**
 * Score a single rule against the description. Returns
 * the highest match's score (0-100) and the keyword
 * that triggered it. Confidence levels:
 *   - 100: keyword at position 0 + word-boundary
 *   - 75:  word-boundary elsewhere
 *   - 50:  substring match
 *
 * "Position 0" matters: a description that STARTS
 * with "Miete" is more confident than one that
 * mentions "Miete" mid-sentence. We use that to
 * break ties between overlapping rules.
 */
function scoreRule(rule: InferenceRule & { re: RegExp[] }, descLower: string): { score: number; kw: string } {
  let bestScore = 0
  let bestKw = ''
  for (let i = 0; i < rule.keywords.length; i++) {
    const re = rule.re[i]
    const kw = rule.keywords[i]
    const m = descLower.match(re)
    if (!m) continue
    let score: number
    if (re.source.startsWith('\\b')) {
      // word-boundary
      score = m.index === 0 ? 100 : 75
    } else {
      // substring
      score = m.index === 0 ? 75 : 50
    }
    if (score > bestScore) {
      bestScore = score
      bestKw = kw
    }
  }
  return { score: bestScore, kw: bestKw }
}

/**
 * Infer the SKR03 expense Sachkonto from a description
 * (typically the Voucher description + supplier name).
 *
 * Returns the highest-scoring rule, or a synthetic
 * 4900 fallback (Sonstige betriebliche Aufwendungen,
 * confidence 0) if no rule matched. The caller can
 * decide what to do with confidence=0 (typically:
 * auto-apply the fallback if the user hasn't set
 * a manual account).
 */
export function inferExpenseAccount(description: string): SachkontoInference {
  const descLower = (description || '').toLowerCase()
  let best: SachkontoInference | null = null
  for (let i = 0; i < COMPILED.length; i++) {
    const rule = COMPILED[i]
    // Skip the 4900 catch-all in the scoring loop;
    // we use it as the explicit fallback below.
    if (rule.accountNumber === '4900') continue
    const { score, kw } = scoreRule(rule, descLower)
    if (score === 0) continue
    // Tier 832: on equal scores the longer, more specific keyword wins
    // („Bewirtung Gasthaus": bewirtung, not a short word of another rule)
    if (!best || score > best.confidence || (score === best.confidence && kw.length > best.matchedKeyword.length)) {
      best = {
        accountNumber: rule.accountNumber,
        accountName: rule.accountName,
        confidence: score,
        matchedKeyword: kw,
        ruleIndex: i,
      }
    }
  }
  if (best) return best
  // No match — explicit 4900 fallback at 0 confidence.
  // The caller distinguishes "no rule matched" from
  // "4900 was matched" by the confidence value.
  return {
    accountNumber: '4900',
    accountName: 'Sonstige betriebliche Aufwendungen',
    confidence: 0,
    matchedKeyword: '',
    ruleIndex: COMPILED.findIndex((r) => r.accountNumber === '4900'),
  }
}

/**
 * Apply the inference to a real VoucherLine in the DB.
 * Sets `accountId` on the VoucherLine based on the
 * inferred Sachkonto, creating the Account row in
 * the company's chart of accounts if it doesn't
 * exist yet.
 *
 * Safe to call on every Voucher create — it's a no-op
 * if `accountId` is already set.
 *
 * Returns the inferred Sachkonto details (so the
 * caller can log the decision to the audit trail).
 */
export async function applyExpenseInference(
  // Use PrismaClient (not PrismaService) as the
  // type here so the function is unit-testable
  // with a fresh PrismaClient — PrismaService
  // has onModuleInit/onModuleDestroy hooks that
  // need the Nest DI container, which doesn't
  // exist in the test runner. PrismaService
  // extends PrismaClient so production callers
  // can pass `this.prisma` directly.
  prisma: PrismaClient,
  voucherLineId: string,
  description: string,
): Promise<SachkontoInference | null> {
  // Look up the voucher line's company via the
  // voucher relation. The Account we create (or
  // reuse) is scoped to that company.
  const line = await prisma.voucherLine.findUnique({
    where: { id: voucherLineId },
    include: { voucher: { select: { companyId: true } } },
  })
  if (!line) return null
  // If the line already has an accountId, the user
  // (or a previous inference) has made a choice —
  // don't override.
  if (line.accountId) return null

  const inference = inferExpenseAccount(description)
  // Look up or create the Account row.
  // Account has a unique constraint on (companyId,
  // accountNumber) — a one-time upsert handles the
  // "first time we see this Kontenrahmen-Sachkonto
  // for this company" case.
  const account = await prisma.account.upsert({
    where: {
      companyId_accountNumber: {
        companyId: line.voucher.companyId,
        accountNumber: inference.accountNumber,
      },
    },
    update: {},
    create: {
      companyId: line.voucher.companyId,
      accountNumber: inference.accountNumber,
      name: inference.accountName,
      // Mark as expense (per SKR03); the user's chart
      // may have multiple "Sonstige" accounts but
      // the type is consistent.
      type: 'expense',
      // 'operating' is the typical sub-category for
      // SKR03 4xxx-4999 expense accounts.
      category: 'operating',
    },
  })
  await prisma.voucherLine.update({
    where: { id: voucherLineId },
    data: { accountId: account.id },
  })
  return inference
}
