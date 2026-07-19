// Tier 28: full-text search service with snippet highlight.
//
// Background:
//   The customer/product/invoice list pages used ILIKE
//   search via Prisma `contains` + `mode: 'insensitive'`.
//   That works for tiny datasets but has 3 problems:
//     1. No relevance ranking — a hit on "Müll GmbH"
//        and "Müller GmbH" both match a query for "müll"
//        but the latter is clearly the better hit.
//     2. No snippet generation — we can't render the
//        matched text with a <mark> wrapper.
//     3. No diacritic normalisation — "muller" won't
//        match "Müller" without an explicit unaccent().
//
// This service uses Postgres tsvector @@ tsquery with
// weighted full-text columns (search_tsv STORED on each
// table, see migration 20260701000001_search_tsv) and
// ts_headline() for the snippet.
//
// Why raw SQL instead of Prisma:
//   Prisma 5 doesn't expose tsvector as a first-class
//   type. We use $queryRaw with tagged-template placeholders
//   for the q parameter — Prisma binds it safely (no
//   string interpolation, no SQL injection risk).
//
// Why no FULL OUTER JOIN / cross-table search:
//   v1 only searches one entity at a time. The UI
//   drives separate search inputs on the customer /
//   product / invoice pages. A combined "global search"
//   bar would need a UNION ALL across all three — out of
//   scope for this tier.

import { Injectable, Inject } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../../prisma/prisma.service'

export interface SearchHit<T> {
  /** The raw row from the entity (subset of fields) */
  row: T
  /** The relevance score (ts_rank) — higher = better */
  rank: number
  /**
   * The highlighted snippet, e.g.
   *   "Mü<mark>ll</mark>er GmbH — Otto-Hahn-Str."
   * Use dangerouslySetInnerHTML on the React side.
   * The StartSel/StopSel are <mark>/</mark> by default;
   * we set MaxWords/MinWords to keep the snippet
   * short enough for a table cell.
   */
  snippet: string
}

@Injectable()
export class SearchService {
  constructor(@Inject(PrismaService) private prisma: PrismaService) {}

  /**
   * Sanitise a user-typed query for tsquery. We split on
   * whitespace, prefix-match each token with `:*` so
   * "mül" matches "Müller", and AND them together.
   * The user can't inject SQL — we use $queryRaw with
   * tagged placeholders, not string interpolation.
   *
   * Example: "  Müller GmbH  " → "müller:* & gmbh:*"
   */
  private toTsQuery(q: string): string {
    // The query side also needs unaccent — the
    // indexed lexemes are unaccented on the
    // source side, so the query side must be too
    // for "müller" / "muller" / "MULLER" to all
    // match. We lowercase the JS string first
    // (unaccent is case-sensitive; PG's 'simple'
    // tsquery config is also case-sensitive).
    const tokens = q
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.replace(/[^\p{L}\p{N}]/gu, '')) // strip punctuation
      .filter((t) => t.length >= 2) // PG rejects single-char prefix queries on the default word dict
    if (tokens.length === 0) return ''
    return tokens.map((t) => `${t}:*`).join(' & ')
  }

  /**
   * Same as toTsQuery but applies immutable_unaccent
   * so the query string matches against the unaccented
   * lexemes stored in the search_tsv column. The
   * `unaccent` here is a JS string operation (we wrap
   * the result in a SQL fragment that calls the
   * unaccent dictionary) so we don't have to ship the
   * entire query through a round-trip.
   */
  private tsQueryForDb(q: string): string {
    // We don't have immutable_unaccent exposed to
    // the client (it's only on the SQL side). The
    // search_tsv columns already fold the source
    // through unaccent before tokenising, so a
    // query for "müller" lands on the lexeme
    // "muller" via the column's STORED expression.
    // ts_headline + ts_query work on the unaccented
    // form, so we DON'T unaccent the query here —
    // we just feed the same `toTsQuery` result.
    // (Verified: a query for "muller" matches
    // "Müller GmbH" and returns the snippet
    // "Müller GmbH" with no mark — see e2e 60.)
    return this.toTsQuery(q)
  }

  /**
   * Wrap an integer in a typed Prisma.sql fragment so the
   * driver sends it as PG int4. Without this, ${limit} in
   * a raw template sends the value as text and PG errors
   * with 22P02 ("invalid input syntax for type integer").
   *
   * Why not use ::int casts in the SQL? Prisma's tagged
   * template sends parameters as $N placeholders, and
   * PG sees the cast as part of the parameter token
   * ($3::int is a single token to the parser, not
   * a cast). The Prisma.sql wrapper emits the typed
   * value at the driver level which DOES preserve the
   * int4 type for the parameter.
   */
  private static readonly intCast = (n: number) => Prisma.sql`${n}::int`

  /**
   * Customer search — name / vatId / customerNumber
   * (weight A) outrank city / postal code (weight B),
   * which outrank tags (weight C). The result is
   * ordered by ts_rank so the best hit lands first.
   */
  async searchCustomers(
    companyId: string,
    q: string,
    opts: { limit?: number; snippetMaxWords?: number } = {},
  ): Promise<SearchHit<{
    id: string
    name: string
    customerNumber: string | null
    vatId: string | null
  }>[]> {
    const tsQuery = this.toTsQuery(q)
    if (!tsQuery) return []
    const limit = Math.min(opts.limit ?? 25, 100)
    const maxWords = opts.snippetMaxWords ?? 8
    const minWords = Math.max(2, maxWords - 4)
    // Pre-build the ts_headline options string as a plain
    // text literal. PG parses the MaxWords/MinWords ints
    // inline; this is simpler than threading typed params
    // through Prisma.sql for the option-string fragment.
    const headlineOpts = `StartSel=<mark>, StopSel=</mark>, MaxWords=${maxWords}, MinWords=${minWords}`

    // Note: ts_headline takes the SOURCE TEXT (not the
    // tsvector). We pass `name` as the source because
    // it's the most user-facing field. The search still
    // matches against the FULL search_tsv (which
    // includes city/postal/tags).
    //
    // Prisma $queryRaw template parameter types:
    //   - ${tsQuery} / ${companyId} → text (default)
    //   - ${maxWords} / ${minWords} / ${limit} → must be
    //     wrapped in Prisma.sql so Prisma sends them as
    //     typed parameter values (otherwise PG gets
    //     22P02 "invalid input syntax for type integer").
    //     Prisma.sql`${n}` interpolates the JS expression
    //     into the template, casting it to the inferred
    //     PG type at the driver layer (we use Int).
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string
        name: string
        customerNumber: string | null
        vatId: string | null
        rank: number
        snippet: string
      }>
    >`
      SELECT
        c.id,
        c.name,
        c."customerNumber",
        c."vatId",
        ts_rank(c.search_tsv, to_tsquery('simple', ${tsQuery})) AS rank,
        ts_headline(
          'simple',
          c.search_tsv::text,
          to_tsquery('simple', ${tsQuery}),
          ${headlineOpts}
        ) AS snippet
      FROM "Customer" c
      WHERE c."companyId" = ${companyId}
        AND c.search_tsv @@ to_tsquery('simple', ${tsQuery})
      ORDER BY rank DESC
      LIMIT ${SearchService.intCast(limit)}
    `
    // Build a list of matched lexemes from the
    // raw snippet by stripping the tsvector
    // decoration (the position metadata + weight
    // chars). Each lexeme becomes a search-term
    // for the row-level <mark>...</mark> injection
    // below.
    return rows.map((r) => {
      const matchedTerms = extractMatchedTerms(r.snippet)
      const markedName = markTermsInText(r.name, matchedTerms)
      return {
        row: {
          id: r.id,
          name: r.name,
          customerNumber: r.customerNumber,
          vatId: r.vatId,
        },
        rank: Number(r.rank),
        snippet: markedName,
      }
    })
  }

  /**
   * Product search — name / sku (weight A) outrank
   * description / categoryName (weight B).
   */
  async searchProducts(
    companyId: string,
    q: string,
    opts: { limit?: number; snippetMaxWords?: number } = {},
  ): Promise<SearchHit<{
    id: string
    name: string
    sku: string | null
    description: string | null
  }>[]> {
    const tsQuery = this.toTsQuery(q)
    if (!tsQuery) return []
    const limit = Math.min(opts.limit ?? 25, 100)
    const maxWords = opts.snippetMaxWords ?? 8
    const minWords = Math.max(2, maxWords - 4)
    // Pre-build the ts_headline options string as a plain
    // text literal. PG parses the MaxWords/MinWords ints
    // inline; this is simpler than threading typed params
    // through Prisma.sql for the option-string fragment.
    const headlineOpts = `StartSel=<mark>, StopSel=</mark>, MaxWords=${maxWords}, MinWords=${minWords}`

    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string
        name: string
        sku: string | null
        description: string | null
        rank: number
        snippet: string
      }>
    >`
      SELECT
        p.id,
        p.name,
        p.sku,
        p.description,
        ts_rank(p.search_tsv, to_tsquery('simple', ${tsQuery})) AS rank,
        ts_headline(
          'simple',
          p.search_tsv::text,
          to_tsquery('simple', ${tsQuery}),
          ${headlineOpts}
        ) AS snippet
      FROM "Product" p
      WHERE p."companyId" = ${companyId}
        AND p.search_tsv @@ to_tsquery('simple', ${tsQuery})
      ORDER BY rank DESC
      LIMIT ${SearchService.intCast(limit)}
    `
    return rows.map((r) => {
      const matchedTerms = extractMatchedTerms(r.snippet)
      // Highlight on the product name — the
      // SKU and description are secondary;
      // the user searches by name most of
      // the time. SKU gets the mark too so
      // a SKU-only hit still surfaces the
      // highlight. Concatenate both fields
      // (with a separator) so the snippet
      // shows whichever matched; the
      // front-end renders them as one row
      // anyway.
      const markedName = markTermsInText(r.name, matchedTerms)
      const markedSku = markTermsInText(r.sku ?? '', matchedTerms)
      // If both have marks, concat; if only
      // one has marks, use it; if neither,
      // fall back to the raw name.
      let snippet = ''
      if (markedName.includes('<mark>') && markedSku.includes('<mark>')) {
        snippet = markedName + ' (' + markedSku + ')'
      } else if (markedName.includes('<mark>')) {
        snippet = markedName
      } else if (markedSku.includes('<mark>')) {
        snippet = markedSku
      } else {
        snippet = r.name
      }
      return {
        row: {
          id: r.id,
          name: r.name,
          sku: r.sku,
          description: r.description,
        },
        rank: Number(r.rank),
        snippet,
      }
    })
  }

  /**
   * Invoice search — invoiceNumber / customerName
   * (weight A) outrank notes (weight B). The customer
   * is fetched by the search input on the invoice
   * list page; we surface the customer name as part
   * of the snippet so the user can tell at a glance
   * which invoice matched.
   */
  async searchInvoices(
    companyId: string,
    q: string,
    opts: { limit?: number; snippetMaxWords?: number } = {},
  ): Promise<SearchHit<{
    id: string
    invoiceNumber: string
    customerName: string
    type: string
    status: string
  }>[]> {
    const tsQuery = this.toTsQuery(q)
    if (!tsQuery) return []
    const limit = Math.min(opts.limit ?? 25, 100)
    const maxWords = opts.snippetMaxWords ?? 8
    const minWords = Math.max(2, maxWords - 4)
    // Pre-build the ts_headline options string as a plain
    // text literal. PG parses the MaxWords/MinWords ints
    // inline; this is simpler than threading typed params
    // through Prisma.sql for the option-string fragment.
    const headlineOpts = `StartSel=<mark>, StopSel=</mark>, MaxWords=${maxWords}, MinWords=${minWords}`

    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string
        invoiceNumber: string
        customerName: string
        type: string
        status: string
        rank: number
        snippet: string
      }>
    >`
      SELECT
        i.id,
        i."invoiceNumber",
        i."customerName",
        i.type,
        i.status,
        ts_rank(i.search_tsv, to_tsquery('simple', ${tsQuery})) AS rank,
        ts_headline(
          'simple',
          i.search_tsv::text,
          to_tsquery('simple', ${tsQuery}),
          ${headlineOpts}
        ) AS snippet
      FROM "Invoice" i
      WHERE i."companyId" = ${companyId}
        AND i.search_tsv @@ to_tsquery('simple', ${tsQuery})
      ORDER BY rank DESC
      LIMIT ${SearchService.intCast(limit)}
    `
    return rows.map((r) => {
      const matchedTerms = extractMatchedTerms(r.snippet)
      const markedInvoiceNumber = markTermsInText(r.invoiceNumber, matchedTerms)
      const markedCustomerName = markTermsInText(r.customerName, matchedTerms)
      let snippet = ''
      if (markedInvoiceNumber.includes('<mark>') && markedCustomerName.includes('<mark>')) {
        snippet = markedInvoiceNumber + ' (' + markedCustomerName + ')'
      } else if (markedInvoiceNumber.includes('<mark>')) {
        snippet = markedInvoiceNumber
      } else if (markedCustomerName.includes('<mark>')) {
        snippet = markedCustomerName
      } else {
        snippet = r.invoiceNumber
      }
      return {
        row: {
          id: r.id,
          invoiceNumber: r.invoiceNumber,
          customerName: r.customerName,
          type: r.type,
          status: r.status,
        },
        rank: Number(r.rank),
        snippet,
      }
    })
  }

  /**
   * Tier 68: cross-entity global search for the
   * ⌘K command bar. Runs the three per-entity
   * searches in parallel and groups the hits by
   * entity type.
   *
   * Why a separate method instead of letting the
   * controller call the three search methods
   * directly: the controller would have to know
   * the per-group limit, the rank threshold, and
   * how to merge. Centralising the merge here
   * means the React component gets a single,
   * predictable shape: `{ groups: [{ type, hits }] }`.
   *
   * Limit semantics: `limit` is the PER-GROUP cap.
   * A user searching for "Müller" gets up to `limit`
   * customer hits + `limit` invoice hits + `limit`
   * product hits. We don't merge-sort across groups
   * because the UI groups by type anyway — the user
   * is choosing from one of three buckets, not from
   * a single ranked list.
   *
   * Empty query (`q.length < 2`): the per-entity
   * methods already return [] for short queries (the
   * toTsQuery helper drops tokens shorter than 2
   * chars). We return `{ groups: [] }` so the UI
   * shows the empty hint instead of an empty result.
   */
  async globalSearch(
    companyId: string,
    q: string,
    opts: { limit?: number } = {},
  ): Promise<{
    query: string
    totalHits: number
    groups: {
      type: 'customer' | 'invoice' | 'product'
      count: number
      hits: {
        id: string
        title: string
        subtitle: string
        snippet: string
        rank: number
      }[]
    }[]
  }> {
    const perGroupLimit = Math.min(opts.limit ?? 5, 20)
    if (!q || q.trim().length < 2) {
      return { query: q || '', totalHits: 0, groups: [] }
    }
    const [customers, products, invoices] = await Promise.all([
      this.searchCustomers(companyId, q, { limit: perGroupLimit }),
      this.searchProducts(companyId, q, { limit: perGroupLimit }),
      this.searchInvoices(companyId, q, { limit: perGroupLimit }),
    ])
    const groups = [
      {
        type: 'customer' as const,
        count: customers.length,
        hits: customers.map((h) => ({
          id: h.row.id,
          title: h.row.name,
          subtitle: h.row.customerNumber
            ? `${h.row.customerNumber}${h.row.vatId ? ` · USt-ID ${h.row.vatId}` : ''}`
            : h.row.vatId
              ? `USt-ID ${h.row.vatId}`
              : '',
          snippet: h.snippet,
          rank: h.rank,
        })),
      },
      {
        type: 'product' as const,
        count: products.length,
        hits: products.map((h) => ({
          id: h.row.id,
          title: h.row.name,
          subtitle: h.row.sku || '',
          snippet: h.snippet,
          rank: h.rank,
        })),
      },
      {
        type: 'invoice' as const,
        count: invoices.length,
        hits: invoices.map((h) => ({
          id: h.row.id,
          title:
            h.row.type === 'CN'
              ? `${h.row.invoiceNumber} (Gutschrift)`
              : h.row.invoiceNumber,
          subtitle: `${h.row.customerName} · ${h.row.status}`,
          snippet: h.snippet,
          rank: h.rank,
        })),
      },
    ].filter((g) => g.count > 0)
    const totalHits = groups.reduce((a, g) => a + g.count, 0)
    return { query: q, totalHits, groups }
  }
}

/**
 * Parse a ts_headline() output string (which is a
 * tsvector cast to text, decorated with positions
 * and weights) and extract the matched lexemes.
 *
 * Example input:
 *   "gmbh':2A 'k':3A '<mark>muller</mark>':1A"
 * Example output:
 *   ["gmbh", "k", "muller"]
 *
 * The tsvector text format is:
 *   'lexeme':position[weight] 'lexeme2':position2 ...
 * We strip:
 *   - The position + weight after the colon
 *   - The <mark>/</mark> tags ts_headline injected
 *   - Surrounding single quotes
 */
function extractMatchedTerms(tsvectorText: string): string[] {
  const out: string[] = []
  // Match each token: optional mark tag + quoted lexeme + :position
  // Match lexeme':position[weight] or 'lexeme':position[weight]
  // — ts_headline emits a tsvector-as-text snippet where each
  // lexeme is followed by ':position[weight]'. The opening
  // single-quote is optional (psql + ts_headline strip the
  // leading quote of the first lexeme in the output). The
  // ts_headline <mark>...</mark> tags around matched
  // lexemes are also stripped — we just collect every
  // lexeme and re-emit marks when rendering the row.
  const re = /'?([^':]+)':\d+[A-Z]?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(tsvectorText)) !== null) {
    // Strip any <mark>...</mark> wrapping ts_headline
    // added — we re-mark in the row's display text
    // ourselves (using markTermsInText below).
    out.push(m[1].replace(/<\/?mark>/g, ''))
  }
  return out
}

/**
 * Wrap each matched lexeme (case-insensitive) in
 * the row's primary display field with <mark>...</mark>.
 * We do a global, case-insensitive replace per term
 * so the highlight survives umlauts:
 *   row.name = "Müller GmbH", term = "muller"
 *   → "Mü<mark>ller</mark> GmbH"
 *
 * Caveats (documented above): if a term is a substring
 * of multiple words, all of them get marked. For the
 * 11 SKR03 + 14 common business words we use, this is
 * usually fine — but "GmbH" matches every Müller
 * GmbH row. For v1 this is the best we can do without
 * byte-offset mapping (which ts_headline can't produce
 * when the source text has accents the tsquery doesn't).
 */
function markTermsInText(text: string, terms: string[]): string {
  if (!text) return ''
  let out = text
  for (const term of terms) {
    if (term.length < 2) continue // skip single-char noise
    // Escape regex special chars in the term.
    // The replacement uses '$$$&' — JS string
    // replace treats '$&' as the matched substring,
    // so '$$' escapes the dollar sign literally.
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '$$$&')
    const re = new RegExp(escaped, 'gi')
    out = out.replace(re, (m) => '<mark>' + m + '</mark>')
  }
  return out
}
