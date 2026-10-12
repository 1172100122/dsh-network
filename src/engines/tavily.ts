/**
 * TavilySearchEngine — Tavily Search API.
 *
 * Endpoint: `POST https://api.tavily.com/search` with a JSON body.
 *
 * The credential rides in `Authorization: Bearer <tvly-…>` (OpenAPI
 * `bearerAuth`). 
 * 
 * Tavily's keyless mode is a documented free tier rather than a 
 * misconfiguration, and the rate limit is described in the warning 
 * the engine emits from a 429 body.
 *
 * Every query is BILLED (1 API credit at `basic`, 2 at `advanced`).
 * Registered LAST and absent from the default chain, same reasoning as
 * Brave.
 *
 */
import {
  type EngineAuth,
  type EngineBody,
  type EngineParseResult,
  type EngineRequest,
  type SearchEngine,
  type SearchSource,
  readEngineEnvOptions,
} from './index.ts'

export const TAVILY_ENGINE_ID = 'tavily'

export const TAVILY_ENDPOINT = 'https://api.tavily.com/search'

/** Single-engine env override (the host also injects the shared keys map). */
export const TAVILY_API_KEY_ENV = 'DSH_NETWORK_TAVILY_API_KEY'

/** Bearer / keyless headers. Authoritative spelling — MUST match upstream. */
export const TAVILY_AUTH_HEADER = 'Authorization'
export const TAVILY_KEYLESS_HEADER = 'X-Tavily-Access-Mode'

/** Tavily caps `max_results` at 20. */
const MAX_RESULTS = 20
const MIN_RESULTS = 1

/** Tavily caps `chunks_per_source` at 3 (1..3 inclusive). */
const MIN_CHUNKS = 1
const MAX_CHUNKS = 3

/** Per-field domain-list maxima, straight from the OpenAPI schema. */
const MAX_EXCLUDE_DOMAINS = 150
const MAX_INCLUDE_DOMAINS = 300

/** Whitelisted enum / constrained-string fields from the openapi schema. */
const SEARCH_DEPTHS = ['advanced', 'basic', 'fast', 'ultra-fast'] as const
const TOPICS = ['general', 'news', 'finance'] as const
const TIME_RANGES = ['day', 'week', 'month', 'year', 'd', 'w', 'm', 'y'] as const
const INCLUDE_ANSWER_VALUES = ['true', 'false', 'basic', 'advanced'] as const
const INCLUDE_RAW_CONTENT_VALUES = ['false', 'markdown'] as const
/** How `include_domains` applies: `restrict` is a hard filter, `prefer`
 *  merely boosts the listed domains. The default is `restrict`, so the mode
 *  is only emitted alongside an `includeDomains` list. */
const INCLUDE_DOMAINS_MODES = ['restrict', 'prefer'] as const

/** Title and snippet caps mirror Brave's — a runaway value here is the
 *  same class of defect, and the same cap was chosen. */
const TITLE_CAP = 200
const SNIPPET_CAP = 400

/** Country enum — the full ISO 3166 list Tavily ships (lower-cased). One
 *  element per supported locale; matches the OpenAPI exactly. */
const COUNTRIES = new Set<string>([
  'afghanistan', 'albania', 'algeria', 'andorra', 'angola', 'argentina', 'armenia',
  'australia', 'austria', 'azerbaijan', 'bahamas', 'bahrain', 'bangladesh', 'barbados',
  'belarus', 'belgium', 'belize', 'benin', 'bhutan', 'bolivia',
  'bosnia and herzegovina', 'botswana', 'brazil', 'brunei', 'bulgaria', 'burkina faso',
  'burundi', 'cambodia', 'cameroon', 'canada', 'cape verde', 'central african republic',
  'chad', 'chile', 'china', 'colombia', 'comoros', 'congo', 'costa rica', 'croatia',
  'cuba', 'cyprus', 'czech republic', 'denmark', 'djibouti', 'dominican republic',
  'ecuador', 'egypt', 'el salvador', 'equatorial guinea', 'eritrea', 'estonia',
  'ethiopia', 'fiji', 'finland', 'france', 'gabon', 'gambia', 'georgia', 'germany',
  'ghana', 'greece', 'guatemala', 'guinea', 'haiti', 'honduras', 'hungary', 'iceland',
  'india', 'indonesia', 'iran', 'iraq', 'ireland', 'israel', 'italy', 'jamaica',
  'japan', 'jordan', 'kazakhstan', 'kenya', 'kuwait', 'kyrgyzstan', 'laos', 'latvia',
  'lebanon', 'lesotho', 'liberia', 'libya', 'liechtenstein', 'lithuania', 'luxembourg',
  'madagascar', 'malawi', 'malaysia', 'maldives', 'mali', 'malta', 'mauritania',
  'mauritius', 'mexico', 'moldova', 'monaco', 'mongolia', 'montenegro', 'morocco',
  'mozambique', 'myanmar', 'namibia', 'nepal', 'netherlands', 'new zealand',
  'nicaragua', 'niger', 'nigeria', 'north korea', 'north macedonia', 'norway', 'oman',
  'pakistan', 'palau', 'panama', 'papua new guinea', 'paraguay', 'peru', 'philippines',
  'poland', 'portugal', 'qatar', 'romania', 'russia', 'rwanda', 'saudi arabia',
  'senegal', 'serbia', 'singapore', 'slovakia', 'slovenia', 'solomon islands',
  'somalia', 'south africa', 'south korea', 'south sudan', 'spain', 'sri lanka',
  'sudan', 'sweden', 'switzerland', 'syria', 'taiwan', 'tajikistan', 'tanzania',
  'thailand', 'togo', 'trinidad and tobago', 'tunisia', 'turkey', 'turkmenistan',
  'tuvalu', 'uganda', 'ukraine', 'united arab emirates', 'united kingdom',
  'united states', 'uruguay', 'uzbekistan', 'vanuatu', 'venezuela', 'vietnam',
  'yemen', 'zambia', 'zimbabwe',
])

/**
 * Loose language check: `en`, `fr`, `zh-cn`, or an English name like
 * `english`. 1–16 lowercase letters and dashes only — no spaces, no
 * newlines, no markup. Tavily's own docs accept both the ISO 639-1 code
 * and the English name, and there is no published enum for the latter, so
 * the check is a shape gate rather than a vocabulary gate.
 */
const LANGUAGE_RE = /^[a-z][a-z-]{0,15}$/

/** Loose JSON parse — tolerates a BOM / leading whitespace, returns null
 *  on any failure (same shape the other engines use). */
function parseJsonLoose(body: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(String(body ?? '').replace(/^\uFEFF/, '').trim())
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Whitespace-collapse + cap a string. */
function clip(s: string, cap = SNIPPET_CAP): string {
  const clean = String(s ?? '').replace(/\s+/g, ' ').trim()
  return clean.length > cap ? `${clean.slice(0, cap - 1)}…` : clean
}

/**
 * Accept `published_date` only when it looks like Tavily's
 * `Tue, 11 Mar 2025 17:00:00 GMT` shape (or anything RFC-822-ish with a
 * clear weekday prefix). The renderer prints the raw string, so a wrong
 * shape in the search card is worse than no date.
 */
function plausiblePublishedAt(raw: unknown): string {
  const value = String(raw ?? '').trim()
  if (value === '') return ''
  // HTTP-date / RFC-822 always starts with a 3-letter English weekday.
  // The comma that follows is part of the format (`Tue, 11 Mar 2025`)
  // and the whitespace class below would reject it, so accept both the
  // `Tue, ` and the unusually-stripped `Tue ` shapes.
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(,|\s)/i.test(value)) return ''
  return value
}

/** `max_results` for the request body. The CLI passes `perPage` (the call's
 *  result cap) and `max` is the single-shot fallback. Server value wins so a
 *  `count` argument is honored. */
function clampMaxResults(perPage: unknown, max: unknown): number {
  const raw = typeof perPage === 'number' && Number.isFinite(perPage) ? perPage : max
  const v = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 10
  if (v < MIN_RESULTS) return MIN_RESULTS
  return Math.min(v, MAX_RESULTS)
}

/** Resolve one enum value; accept only the exact spellings. Empty/blank
 *  returns undefined so the field is just dropped. */
function enumValue<T extends string>(
  values: readonly T[],
  raw: unknown,
): T | undefined {
  const v = typeof raw === 'string' ? raw.trim() : ''
  if (v === '') return undefined
  return (values as readonly string[]).includes(v) ? (v as T) : undefined
}

/** Boolean that accepts either a real boolean or the literal strings
 *  `true` / `false`. The settings dialog always ships strings; a hand-written
 *  config or a programmatic caller (a future pipeline) would send a real
 *  boolean — both shapes must reach the body. */
function boolValue(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (v === 'true') return true
  if (v === 'false') return false
  return undefined
}

/** Country lock to Tavily's enum. Empty after normalize is dropped. */
function countryValue(raw: unknown): string | undefined {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (v === '') return undefined
  return COUNTRIES.has(v) ? v : undefined
}

/** Language — free-form per docs, but reasonable shape only. A newline or
 *  pipe in the middle of the value would reach Tavily as a malformed
 *  argument, so only letters and dashes survive the gate. */
function languageValue(raw: unknown): string | undefined {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (v === '') return undefined
  return LANGUAGE_RE.test(v) ? v : undefined
}

/**
 * Comma-separated domain list, capped at the field's own documented maximum
 * (`exclude_domains` 150, `include_domains` 300). The cap is applied HERE
 * rather than left to the API because both fields are free-form textareas in
 * the settings UI, where an over-long list is a realistic typo — and an
 * over-long list costs a 400 on a billed call.
 */
function domainListValue(raw: unknown, cap: number): string[] | undefined {
  if (typeof raw !== 'string') return undefined
  const parts = raw.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0)
  if (parts.length === 0) return undefined
  return parts.slice(0, cap)
}

/** `chunks_per_source` ∈ 1..3 (Tavily rejects anything else). */
function chunksValue(raw: unknown): number | undefined {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < MIN_CHUNKS || n > MAX_CHUNKS) return undefined
  return n
}

/**
 * Compose the JSON body Tavily expects. Pure, sync — every known option is
 * validated (or dropped) here so a typo in the settings textarea never
 * reaches a billed call on a 422.
 *
 * `perPage` is the call's result cap (the CLI sets it from
 * `searchMaxResults`); `max` is the single-shot fallback. The clamp lives
 * next to the field so the body shape stays in one place.
 */
function buildTavilyBody(
  query: string,
  options: Readonly<Record<string, unknown>>,
  perPage: unknown,
  max: unknown,
): Record<string, unknown> {
  const body: Record<string, unknown> = { query: String(query ?? '').trim() }
  body.max_results = clampMaxResults(perPage, max)

  const depth = enumValue(SEARCH_DEPTHS, options.searchDepth)
  if (depth !== undefined) body.search_depth = depth

  const topic = enumValue(TOPICS, options.topic)
  if (topic !== undefined) body.topic = topic

  const range = enumValue(TIME_RANGES, options.timeRange)
  if (range !== undefined) body.time_range = range

  const includeAnswerRaw = typeof options.includeAnswer === 'string' ? options.includeAnswer.trim().toLowerCase() : ''
  if ((INCLUDE_ANSWER_VALUES as readonly string[]).includes(includeAnswerRaw)) {
    body.include_answer = includeAnswerRaw
  }

  const rawContentRaw = typeof options.includeRawContent === 'string' ? options.includeRawContent.trim().toLowerCase() : ''
  if ((INCLUDE_RAW_CONTENT_VALUES as readonly string[]).includes(rawContentRaw)) {
    body.include_raw_content = rawContentRaw
  }

  const incImages = boolValue(options.includeImages)
  if (incImages !== undefined) body.include_images = incImages

  // Tavily only honours image descriptions when images are actually
  // requested, and it renders them INSIDE each image entry. Sending the
  // flag alone would be a no-op, so it is gated on `include_images` and
  // silently dropped otherwise — the alternative is a billed call whose
  // option did nothing.
  const incImageDescriptions = boolValue(options.includeImageDescriptions)
  if (incImages === true && incImageDescriptions !== undefined) {
    body.include_image_descriptions = incImageDescriptions
  }

  const incFavicon = boolValue(options.includeFavicon)
  if (incFavicon !== undefined) body.include_favicon = incFavicon

  const excludeDomains = domainListValue(options.excludeDomains, MAX_EXCLUDE_DOMAINS)
  if (excludeDomains !== undefined) body.exclude_domains = excludeDomains

  // `include_domains_mode` is only meaningful alongside `include_domains`
  // (Tavily answers 400 for the mode alone), so the mode is emitted only
  // when the domain list survived validation.
  const includeDomains = domainListValue(options.includeDomains, MAX_INCLUDE_DOMAINS)
  if (includeDomains !== undefined) {
    body.include_domains = includeDomains
    const mode = enumValue(INCLUDE_DOMAINS_MODES, options.includeDomainsMode)
    if (mode !== undefined) body.include_domains_mode = mode
  }

  const exactMatch = boolValue(options.exactMatch)
  if (exactMatch !== undefined) body.exact_match = exactMatch

  const safeSearch = boolValue(options.safeSearch)
  if (safeSearch !== undefined) body.safe_search = safeSearch

  const country = countryValue(options.country)
  if (country !== undefined) body.country = country

  const language = languageValue(options.language)
  if (language !== undefined) body.language = language

  const chunks = chunksValue(options.chunksPerSource)
  if (chunks !== undefined) body.chunks_per_source = chunks

  return body
}

/**
 * Parse one Tavily JSON response into at most `max` results.
 *
 * Recognized shape:
 *   {
 *     query: string,
 *     results: [
 *       { title, url, content, score, published_date?, favicon? }
 *     ],
 *     response_time, usage?, answer?, images?
 *   }
 *
 * Empty results return an empty list — `parseMany` is the one that classifies
 * a missing `results` array as a foreign-shaped error.
 */
export function parseTavilyResults(body: string, max: number): SearchSource[] {
  const parsed = parseJsonLoose(body)
  if (!parsed) return []
  const results = parsed.results
  if (!Array.isArray(results)) return []

  const out: SearchSource[] = []
  const seen = new Set<string>()
  for (const raw of results) {
    if (out.length >= max) break
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const url = String(r.url ?? '').trim()
    if (url === '') continue
    if (!/^https?:\/\//i.test(url)) continue
    if (seen.has(url)) continue
    seen.add(url)
    const title = String(r.title ?? '').trim() || url
    const source: SearchSource = { url, title: clip(title, TITLE_CAP) || url }
    const content = String(r.content ?? '').trim()
    if (content) source.snippet = clip(content)
    const date = plausiblePublishedAt(r.published_date)
    if (date) source.published_at = date
    out.push(source)
  }
  return out
}

/**
 * Best-effort extraction of Tavily's error message from a non-2xx body.
 * The shape varies (sometimes the body is JSON `{"detail":{"error":"…"}}`,
 * sometimes just a plain string). Return the most actionable string we can
 * find, or '' when nothing recognisable comes back.
 */
function errorBodyMessage(body: string): string {
  const parsed = parseJsonLoose(body)
  if (!parsed) return ''
  const detail = parsed.detail
  if (detail && typeof detail === 'object') {
    const detailObj = detail as Record<string, unknown>
    if (typeof detailObj.error === 'string') return detailObj.error
  }
  if (Array.isArray(parsed.detail)) {
    // 422 validation: `detail` is an array of `{loc, msg, type}` entries.
    const parts: string[] = []
    for (const entry of (parsed.detail as unknown[]).slice(0, 3)) {
      if (!entry || typeof entry !== 'object') continue
      const e = entry as Record<string, unknown>
      const loc = Array.isArray(e.loc) ? (e.loc as unknown[]).map((p) => String(p)).join('.') : ''
      const msg = typeof e.msg === 'string' ? e.msg : ''
      if (msg) parts.push(loc ? `${loc}: ${msg}` : msg)
    }
    if (parts.length > 0) return parts.join('; ')
  }
  if (typeof parsed.error === 'string') return parsed.error
  if (typeof parsed.message === 'string') return parsed.message
  return ''
}

/** Sniff a body for an auth complaint. Used to distinguish a 401 / 403 from
 *  a 422 caused by something else — Tavily's docs say 401 covers both a
 *  missing header and an invalid one (no separate 403 path), so the only
 *  check that matters is "does the body mention the credential". */
function isAuthComplaint(body: string): boolean {
  return /api key|authorization|bearer|tvly-/i.test(String(body ?? ''))
}

/**
 * TavilySearchEngine — Tavily Search API.
 *
 * The engine itself never holds the key; the CLI resolves
 * `DSH_NETWORK_SEARCH_ENGINE_API_KEYS['tavily']` first (the host-injected
 * per-invoke map) and falls back to `DSH_NETWORK_TAVILY_API_KEY`. With no
 * key the `auth.optional` flag bypasses the synthetic-401 short-circuit and
 * `authFor`'s `fallbackHeader` ships `X-Tavily-Access-Mode: keyless` —
 * Tavily's documented rate-limited tier.
 */

/**
 * Pure helper: build the request `buildRequests()` would have produced.
 * Exported so the unit tests can verify the body shape and method without
 * spinning up a class.
 */
export function buildTavilyRequest(
  query: string,
  options?: Readonly<Record<string, unknown>>,
): EngineRequest | null {
  const q = String(query ?? '').trim()
  if (q.length === 0) return null
  const merged = options ?? {}
  const body = buildTavilyBody(q, merged, merged.perPage, merged.max)
  return {
    key: TAVILY_ENGINE_ID,
    url: TAVILY_ENDPOINT,
    // Tavily is POST-only with a JSON body — the alternative is a 405.
    method: 'POST',
    body: JSON.stringify(body),
    contentType: 'application/json',
  }
}

export class TavilySearchEngine implements SearchEngine {
  readonly id = TAVILY_ENGINE_ID
  readonly displayName = 'Tavily Search'
  readonly endpoint = TAVILY_ENDPOINT

  /**
   * `optional: true` + `fallbackHeader` is what tells `authFor` to use
   * `X-Tavily-Access-Mode: keyless` instead of returning empty headers when
   * the user has not pasted a key. Tavily is the only current engine that
   * ships a documented keyless mode.
   */
  readonly auth: EngineAuth = {
    header: TAVILY_AUTH_HEADER,
    scheme: 'bearer',
    apiKeyEnv: TAVILY_API_KEY_ENV,
    optional: true,
    fallbackHeader: { name: TAVILY_KEYLESS_HEADER, value: 'keyless' },
  }

  /** JSON API — minimal Accept. Auth + content-type are filled in by the
   *  CLI (`authFor` for auth, `runClientFetch` default for content-type
   *  when the body setter is used). No browser fingerprint. */
  readonly defaultHeaders: Readonly<Record<string, string>> = {
    Accept: 'application/json',
  }

  private envOptions(): Readonly<Record<string, unknown>> {
    return readEngineEnvOptions(this.id)
  }

  /**
   * Single-request compatibility path. The CLI's hybrid path uses
   * `buildRequests` (Tavily is single-request, but the buildRequests +
   * parseMany combination makes the engine slot-comparable with Brave,
   * GitHub, Mojeek-billed). This URL helper is what tests / single-shot
   * CLI consumers see when they reach for the bare endpoint.
   */
  buildUrl(query: string, options?: Readonly<Record<string, string>>): string {
    // Tavily is POST-only with a JSON body; a GET URL is not a meaningful
    // artefact, but the interface requires one for the scraper parity
    // path. Return the endpoint — the engine's parseMany is what the CLI
    // actually calls.
    void options
    return this.endpoint
  }

  buildRequests(query: string, options?: Readonly<Record<string, unknown>>): EngineRequest[] {
    const merged: Readonly<Record<string, unknown>> = {
      ...this.envOptions(),
      ...(options ?? {}),
    }
    const req = buildTavilyRequest(query, merged)
    return req ? [req] : []
  }

  /**
   * Classify one Tavily response by status and parse its `results`.
   *
   * The engine is auth-unaware here on purpose: the credential (bearer or
   * the keyless fallback header) is injected by `runSearch` from the
   * engine's `auth` block, and `body.status` is whatever the transport saw.
   * Re-deriving either from the request would duplicate the layers above.
   */
  parseMany(bodies: EngineBody[], max: number): EngineParseResult {
    const warnings: string[] = []
    const uncertainty: string[] = []
    const items: SearchSource[] = []
    for (const body of bodies) {
      if (body.error) {
        warnings.push(`${TAVILY_ENGINE_ID}: ${body.error}`)
        continue
      }
      const status = body.status ?? 0

      if (status === 401 || status === 403) {
        const msg = errorBodyMessage(body.body)
        warnings.push(
          `${TAVILY_ENGINE_ID}: authentication failed (HTTP ${status}${msg ? ` — ${clip(msg, 120)}` : ''}). ` +
            'Set the Tavily API key in 网络 → 搜索引擎 (or DSH_NETWORK_TAVILY_API_KEY). ' +
            'With no key the engine falls back to a rate-limited keyless mode rather than rejecting the request.',
        )
        continue
      }
      if (status === 422) {
        // Tavily answers 422 for both an authorization-shape problem and a
        // genuine query-validation problem; distinguish the two via the body
        // text so the wrong suggestion is never printed.
        const msg = errorBodyMessage(body.body)
        if (isAuthComplaint(body.body)) {
          warnings.push(
            `${TAVILY_ENGINE_ID}: authentication rejected (422${msg ? ` — ${clip(msg, 120)}` : ''}). ` +
              'Re-paste the Tavily API key in 网络 → 搜索引擎 ' +
              `(or DSH_NETWORK_${TAVILY_API_KEY_ENV.slice('DSH_NETWORK_'.length)}).`,
          )
        } else {
          warnings.push(
            `${TAVILY_ENGINE_ID}: query rejected (422${msg ? ` — ${clip(msg, 120)}` : ''}) — check the query and the engine options`,
          )
        }
        continue
      }
      if (status === 429) {
        const msg = errorBodyMessage(body.body)
        warnings.push(
          `${TAVILY_ENGINE_ID}: rate limited (HTTP 429${msg ? ` — ${clip(msg, 120)}` : ''}); ` +
            'keyless mode shares the same throttle — pasting a Tavily API key raises the per-minute quota',
        )
        continue
      }
      if (status === 432) {
        warnings.push(
          `${TAVILY_ENGINE_ID}: plan / key limit exceeded (HTTP 432). ` +
            'Upgrade the plan or check the key on the Tavily dashboard.',
        )
        continue
      }
      if (status === 433) {
        warnings.push(
          `${TAVILY_ENGINE_ID}: pay-as-you-go limit exceeded (HTTP 433). ` +
            'Raise the PayGo limit on the Tavily dashboard.',
        )
        continue
      }
      if (status >= 400) {
        const msg = errorBodyMessage(body.body)
        warnings.push(`${TAVILY_ENGINE_ID}: unexpected HTTP ${status}${msg ? ` — ${clip(msg, 120)}` : ''}`)
        continue
      }

      const parsed = parseJsonLoose(body.body)
      if (!parsed || typeof parsed !== 'object') {
        warnings.push(`${TAVILY_ENGINE_ID}: response was not JSON`)
        continue
      }
      const results = (parsed as Record<string, unknown>).results
      if (!Array.isArray(results)) {
        warnings.push(`${TAVILY_ENGINE_ID}: unexpected response shape (no \`results\`)`)
        continue
      }

      for (const item of parseTavilyResults(body.body, max - items.length)) {
        items.push(item)
      }

      // Tavily ships `response_time` even when the response is fast; if the
      // search took long enough to time out near the 60s envelope the model
      // can plan around it next call. Light uncertainty hint, not a flag.
      const responseTime = Number((parsed as Record<string, unknown>).response_time)
      if (Number.isFinite(responseTime) && responseTime >= 30) {
        uncertainty.push(
          `${TAVILY_ENGINE_ID}: request took ${responseTime.toFixed(1)}s — narrow the query or reduce search_depth`,
        )
      }
    }
    return {
      items,
      warnings: warnings.length > 0 ? warnings : undefined,
      uncertainty: uncertainty.length > 0 ? uncertainty : undefined,
    }
  }

  /** Single-body compatibility path (parity with the other engines). */
  parse(body: string, max: number): SearchSource[] {
    return parseTavilyResults(body, max)
  }
}
