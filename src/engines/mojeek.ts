/**
 * MojeekSearchEngine — Mojeek's official Search API.
 *
 * ## Endpoint and credential
 *
 *   `GET https://www.mojeek.com/search?api_key=…&q=…&fmt=json`
 *
 * The credential rides in the URL itself (`api_key=…`).
 *
 * Every query is billed. The engine is opt-in: a fresh install must not
 * touch mojeek.com at all, and adding it requires a real
 * `searchEngineApiKeys.mojeek` (or `DSH_NETWORK_MOJEEK_API_KEY`) to be set.
 *
 */
import {
  type EngineAuth,
  type EngineBody,
  type EngineParseResult,
  type EngineRequest,
  type SearchEngine,
  type SearchSource,
  composeEngineUrl,
  readEngineEnvOptions,
} from './index.ts'

export const MOJEEK_ENGINE_ID = 'mojeek'

/** Shared with the free sibling: same origin, same search endpoint. */
export const MOJEEK_ENDPOINT = 'https://www.mojeek.com/search'

/** Single-engine env override (the host also injects the shared keys map). */
export const MOJEEK_API_KEY_ENV = 'DSH_NETWORK_MOJEEK_API_KEY'

/** Mojeek returns 10 by default; the docs do not pin a hard cap, but the
 *  safe envelope is well below Brave's 20. We clamp to 100 per request so a
 *  caller asking for "max possible" never asks Mojeek to repaint itself. */
const MAX_PER_PAGE = 100
const MIN_PER_PAGE = 1

/** Whitelist of accepted `since` / `before` values. Free-form dates must be
 *  the YYYYMMDD shape; nothing else. */
const DATE_KEYWORD = /^(day|month|year)$/i
const DATE_DAY = /^\d{8}$/

/** Title and snippet caps mirror the engine's own `tlen` / `dlen` ranges so
 *  even a server-configured length override can't blow up the search card. */
const TITLE_CAP = 200
const SNIPPET_CAP = 300

/**
 * Known query keys the engine forwards. Anything else from the settings
 * textarea is dropped so a typo can't burn a billed call on a 422 (the
 * engine sets `fmt=json` itself; the caller doesn't see this field).
 */
const EXTRA_KEYS = [
  'since',
  'before',
  'rb',
  'rbb',
  'lb',
  'lbb',
  'lr',
  'safe',
  'date',
  'cdate',
  'size',
  'datewr',
  'tlen',
  'dlen',
  'fi',
  'fe',
  'site',
  'qm',
] as const
type ExtraKey = (typeof EXTRA_KEYS)[number]

/** Loose JSON parse — tolerates a BOM / leading whitespace. */
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
 * Parse Mojeek's `date` field — the formatted `Tue Jul 10 05:19:00 2007`
 * string the API returns when `date=1`. We accept it as-is and let the
 * downstream `published_at` renderer carry it; malformed entries are
 * silently dropped (an unverifiable date in the evidence is worse than no
 * date, but the document style is recognizable enough that a hard year
 * check isn't called for here).
 */
function normalizeDate(raw: unknown): string {
  const value = String(raw ?? '').trim()
  if (value === '') return ''
  // Mojeek's format starts with an English weekday (`Tue Jul 10 …`); a
  // non-conforming string means the upstream shape changed.
  if (!/^[A-Z][a-z]{2}\s/.test(value)) return ''
  return value
}

/**
 * Translate a single option value into its `?key=value` form. Returns
 * `undefined` for anything the engine would have to drop (range violations,
 * unknown enums, malformed strings), so the caller can spread the result
 * without changing the URL shape.
 */
function optionValue(key: ExtraKey, raw: unknown): string | undefined {
  switch (key) {
    case 'since':
    case 'before': {
      const v = String(raw ?? '').trim()
      if (DATE_KEYWORD.test(v)) return v.toLowerCase()
      if (DATE_DAY.test(v)) return v
      return undefined
    }
    case 'rb':
    case 'lb': {
      // 2-letter ISO code. Empty after `trim` would burn a call.
      const v = String(raw ?? '').trim().toUpperCase()
      return /^[A-Z]{2}$/.test(v) ? v : undefined
    }
    case 'rbb':
    case 'lbb': {
      // Integer in [1, 100]. Out-of-range boosts are silently dropped so a
      // typo doesn't change the ranking silhouette.
      const n = Number(raw)
      return Number.isInteger(n) && n >= 1 && n <= 100 ? String(n) : undefined
    }
    case 'lr': {
      // Beta: comma-separated ISO 639-1 codes (Mojeek accepts `EN` and `FR`).
      const parts = String(raw ?? '').split(',').map((p) => p.trim().toUpperCase()).filter((p) => /^[A-Z]{2}$/.test(p))
      return parts.length > 0 ? parts.join(',') : undefined
    }
    case 'safe':
    case 'date':
    case 'cdate':
    case 'size':
    case 'datewr': {
      // Strict 0 / 1 (or 100) integers. `safe|0` and `datewr|100` are
      // documented; the others are documented as 0|1.
      const n = Number(raw)
      if (!Number.isInteger(n)) return undefined
      if (key === 'datewr') return n === 0 || n === 100 ? String(n) : undefined
      return n === 0 || n === 1 ? String(n) : undefined
    }
    case 'tlen': {
      const n = Number(raw)
      return Number.isInteger(n) && n >= 0 && n <= 127 ? String(n) : undefined
    }
    case 'dlen': {
      const n = Number(raw)
      return Number.isInteger(n) && n >= 0 && n <= 511 ? String(n) : undefined
    }
    case 'site': {
      const v = String(raw ?? '').trim()
      return v !== '' ? v : undefined
    }
    case 'fi':
    case 'fe': {
      // Comma-separated domains. Max 25 — we don't enforce that, Mojeek's
      // 400 page does, and refusing a 26th domain in the UI would push the
      // validation down into the engine anyway.
      const v = String(raw ?? '').trim()
      return v !== '' ? v : undefined
    }
    case 'qm': {
      const v = String(raw ?? '').trim()
      return v !== '' ? v : undefined
    }
    default:
      return undefined
  }
}

/**
 * Compose the `/search` URL. The key, the format and the page count go in
 * unconditionally; every other accepted option is gated by `optionValue`
 * so an unknown key or a bad enum value never reaches a billed call.
 */
export function buildMojeekApiUrl(
  query: string,
  options?: Readonly<Record<string, unknown>>,
  apiKey?: string,
): string {
  const opts = options ?? {}
  const extras: Record<string, string> = {
    fmt: 'json',
  }
  if (typeof apiKey === 'string' && apiKey !== '') {
    extras.api_key = apiKey
  }

  // `t` (results-per-page) follows the call's result cap (`perPage`), with
  // `max` as the standalone-CLI fallback. The clamp is what makes the engine
  // safe to add to a chain that wants "as many as possible" without
  // overrunning the API's pagination envelope.
  const perPageRaw = typeof opts.perPage === 'number' && Number.isFinite(opts.perPage)
    ? opts.perPage
    : opts.max
  const perPageNum = typeof perPageRaw === 'number' && Number.isFinite(perPageRaw) ? Math.floor(perPageRaw) : 10
  const perPage = Math.max(MIN_PER_PAGE, Math.min(perPageNum, MAX_PER_PAGE))
  extras.t = String(perPage)

  // Page offset — Mojeek is 1-based: `s=1` is the first hit, `s=11` is the
  // first hit of the second page when `t=10`. A 0 / negative value is a
  // typo and is dropped rather than sent as `s=0`.
  const start = Number(opts.s ?? opts.start)
  if (Number.isInteger(start) && start >= 1 && start <= 1000) {
    extras.s = String(start)
  }

  for (const k of EXTRA_KEYS) {
    const v = optionValue(k, opts[k])
    if (v !== undefined) extras[k] = v
  }

  return composeEngineUrl(MOJEEK_ENDPOINT, 'q', query, extras)
}

/**
 * Parse one Mojeek JSON response into at most `max` results.
 *
 * The response shape we recognize (verified against the official docs):
 *
 *   {
 *     "response": {
 *       "status": "OK" | "ERROR: …",
 *       "head":   { … totals + timing … },
 *       "results": [ { url, title, desc, date, size, … }, … ]
 *     }
 *   }
 *
 * Anything that does not look like that returns an empty list — the caller
 * (parseMany) classifies the body further and surfaces the rest as
 * warnings.
 */
export function parseMojeekApiResults(body: string, max: number): SearchSource[] {
  const parsed = parseJsonLoose(body)
  if (!parsed) return []
  const response = parsed.response
  if (!response || typeof response !== 'object') return []
  const results = (response as Record<string, unknown>).results
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
    const desc = String(r.desc ?? '').trim()
    if (desc) source.snippet = clip(desc)
    const date = normalizeDate(r.date)
    if (date) source.published_at = date
    out.push(source)
  }
  return out
}

/**
 * Mojeek JSON response — billed Search API. The credential travels in the
 * URL (`?api_key=…`), the response is JSON, and every query is billed.
 */
export class MojeekSearchEngine implements SearchEngine {
  readonly id = MOJEEK_ENGINE_ID
  readonly displayName = 'Mojeek (API)'
  readonly endpoint = MOJEEK_ENDPOINT

  /**
   * `header` is intentionally absent (the CLI never reads it) and `in`
   * routes the key into the URL via the new query-mode path. `apiKeyEnv`
   * is the standalone-CLI override (`DSH_NETWORK_MOJEEK_API_KEY`), so
   * `dsh-network search --engine mojeek` works without the host.
   */
  readonly auth: EngineAuth = {
    in: 'query',
    queryName: 'api_key',
    apiKeyEnv: MOJEEK_API_KEY_ENV,
  }

  /**
   * Brave-style minimal Accept — this is a JSON API, so there is no
   * browser fingerprint to mirror. The host's `userAgent` rides on top in
   * `runSearch`.
   */
  readonly defaultHeaders: Readonly<Record<string, string>> = {
    Accept: 'application/json',
  }

  private envOptions(): Readonly<Record<string, unknown>> {
    return readEngineEnvOptions(this.id)
  }

  /**
   * Single-request compatibility path. The `apiKey` argument is the
   * resolved secret; engines in `query` mode compose it into the URL
   * themselves, so the CLI never has to.
   */
  buildUrl(
    query: string,
    options?: Readonly<Record<string, string>>,
    apiKey?: string,
  ): string {
    const opts: Readonly<Record<string, unknown>> = {
      ...this.envOptions(),
      ...(options ?? {}),
    }
    return buildMojeekApiUrl(query, opts, apiKey)
  }

  buildRequests(
    query: string,
    options?: Readonly<Record<string, unknown>>,
  ): EngineRequest[] {
    const q = String(query ?? '').trim()
    if (q.length === 0) return []
    const merged: Readonly<Record<string, unknown>> = {
      ...this.envOptions(),
      ...(options ?? {}),
    }
    const apiKey = typeof merged.apiKey === 'string' ? merged.apiKey : undefined
    return [{ key: MOJEEK_ENGINE_ID, url: buildMojeekApiUrl(q, merged, apiKey) }]
  }

  parseMany(bodies: EngineBody[], max: number): EngineParseResult {
    const warnings: string[] = []
    const uncertainty: string[] = []
    const items: SearchSource[] = []

    for (const body of bodies) {
      if (body.error) {
        warnings.push(`${MOJEEK_ENGINE_ID}: ${body.error}`)
        continue
      }
      const status = body.status ?? 0

      if (status === 401 || status === 403) {
        // Mojeek answers 401 with no body for a missing `api_key`, and
        // 403 for a rejected one / per-IP throttling on the billed API.
        // The fix for both is "re-paste the key" — the engine surfaces
        // the same wording rather than guessing.
        warnings.push(
          `${MOJEEK_ENGINE_ID}: authentication failed (HTTP ${status}). ` +
            'Set the Mojeek Search API key in 网络 → 搜索引擎 ' +
            `(or DSH_NETWORK_${MOJEEK_API_KEY_ENV.slice('DSH_NETWORK_'.length)}). ` +
            'With no key configured no request is sent at all.',
        )
        continue
      }
      if (status === 429) {
        warnings.push(
          `${MOJEEK_ENGINE_ID}: rate limited (HTTP 429); the billed API shares the same throttle as the free SERP — wait before retrying`,
        )
        continue
      }
      if (status >= 400) {
        warnings.push(`${MOJEEK_ENGINE_ID}: unexpected HTTP ${status}`)
        continue
      }

      // 200 with the wrong shape: report it instead of letting the parser
      // quietly produce zero hits.
      const parsed = parseJsonLoose(body.body)
      if (!parsed || typeof parsed !== 'object') {
        warnings.push(`${MOJEEK_ENGINE_ID}: response was not JSON`)
        continue
      }
      const response = (parsed as Record<string, unknown>).response
      if (!response || typeof response !== 'object') {
        warnings.push(`${MOJEEK_ENGINE_ID}: unexpected response shape (no \`response\`)`, )
        continue
      }
      const apiStatus = String((response as Record<string, unknown>).status ?? '')

      // Mojeek answers 200 + `response.status === "ERROR: …"` for soft
      // failures (daily limit, malformed query). Parse would otherwise read
      // it as a zero-hit success.
      if (apiStatus !== '' && apiStatus.toUpperCase() !== 'OK') {
        warnings.push(`${MOJEEK_ENGINE_ID}: ${apiStatus}`)
        // Try parsing anyway: a malformed `results` is a separate defect
        // and there is no point saying "limit reached" if a list did arrive.
        for (const item of parseMojeekApiResults(body.body, max - items.length)) {
          items.push(item)
        }
        continue
      }

      for (const item of parseMojeekApiResults(body.body, max - items.length)) {
        items.push(item)
      }

      // `more_results_available` is implicit: when Mojeek returns the same
      // number as `t`, a higher `s` would yield a next page. The head also
      // carries an exact `results` count (capped at Mojeek's index size);
      // skip the second signal — the page boundary is what the caller can
      // act on with a paging call.
      const head = (response as Record<string, unknown>).head
      const exact = head && typeof head === 'object' ? (head as Record<string, unknown>).exact : undefined
      if (exact === false && items.length >= max) {
        uncertainty.push(
          `${MOJEEK_ENGINE_ID}: Mojeek reports the result count is approximate (approximate_total); narrow the query or raise the result cap`,
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
    return parseMojeekApiResults(body, max)
  }
}
