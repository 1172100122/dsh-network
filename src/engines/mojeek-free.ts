/**
 * MojeekFreeSearchEngine — Mojeek's own index, reached through its Altcha-gated
 * HTML SERP.
 *
 * Endpoint: `https://www.mojeek.com/search?q=…`
 *
 * ## Two paths for the cookie
 *
 *   1. **Auto (persistent server, the normal path).** A per-process
 *      `MojeekSession` (see `src/mojeek-session.ts`) lazily solves the Altcha
 *      proof-of-work the first time `mojeek-free` lands in a search, caches
 *      the `chllg` cookie for ~30 days, and transparently re-solves on the
 *      rare `HTTP 200` + Altcha page (a stale / revoked cookie). The user pays
 *      the 1-2 s PoW at most once per server lifetime — "first call slow by
 *      1-2 s" is the only user-visible cost, and nothing has to be pasted
 *      anywhere. The CLI injects `Cookie: chllg=…` the same way it injects
 *      Brave's `X-Subscription-Token`.
 *   2. **Manual (single-shot CLI only).** `dsh-network mojeek-login` solves
 *      the proof-of-work, prints the `chllg=…` cookie, and the operator
 *      exports it as `DSH_NETWORK_MOJEEK_COOKIE` (or puts it in
 *      `searchEngineApiKeys['mojeek-free']`). There is no session in a
 *      one-shot process, so this is the only way there.
 *
 * Consequences that are load-bearing:
 *   - Registered LAST and never in the default chain: an unconfigured
 *     install must not touch mojeek.com at all. The single-shot CLI has no
 *     `MojeekSession`, so it still needs the manual cookie; the persistent
 *     server solves it for you.
 *   - A missing cookie on the single-shot CLI means NO request is sent (the
 *     CLI synthesizes a 401), so "no credential" and "rejected credential"
 *     classify on one path there. Inside the persistent server the session
 *     fills that gap invisibly, which is why the host never asks for the
 *     cookie.
 *   - Mojeek serves 10 results per page. The engine asks for one page and
 *     says so in `uncertainty` when the caller wanted more; paging would
 *     double the request count against a rate-limited host.
 *   - Mojeek's index is English-heavy: a Chinese query returns 200 with no
 *     result list. That is reported as an empty answer.
 */
import {
  type EngineAuth,
  type EngineBody,
  type EngineParseResult,
  type EngineRequest,
  type SearchEngine,
  type SearchSource,
  cleanText,
  composeEngineUrl,
  readEngineEnvOptions,
} from './index.ts'
import { FIREFOX_MOJEEK } from './header-profiles.ts'

export const MOJEEK_FREE_ORIGIN = 'https://www.mojeek.com'

export const MOJEEK_FREE_ENGINE_ID = 'mojeek-free'

export const MOJEEK_FREE_ENDPOINT = `${MOJEEK_FREE_ORIGIN}/search`

/** Altcha challenge endpoint (GET → JSON parameters + signature). */
export const MOJEEK_FREE_CHALLENGE_URL = `${MOJEEK_FREE_ORIGIN}/captcha/challenge`

/** Altcha verification endpoint (POST multipart, field name `altcha`). */
export const MOJEEK_FREE_VERIFY_URL = `${MOJEEK_FREE_ORIGIN}/captcha/verify`

/** Auth header name; the CLI is what fills the value in. */
export const MOJEEK_FREE_AUTH_HEADER = 'Cookie'

/**
 * Single-engine env override (the host also injects the shared keys map).
 * The value is the whole cookie pair, e.g. `chllg=eyJvayI6…`.
 */
export const MOJEEK_FREE_COOKIE_ENV = 'DSH_NETWORK_MOJEEK_COOKIE'

/** Mojeek's per-page result count (its SERP paginates by `s=11`, `s=21`, …). */
export const MOJEEK_FREE_RESULTS_PER_PAGE = 10

/**
 * The JS-required challenge page, served with **HTTP 200** whenever the
 * `chllg` cookie is missing, stale or revoked. A stale cookie otherwise
 * looks like a perfectly successful search that happens to parse to zero
 * hits, which is why the body is sniffed before the parser runs.
 */
export const MOJEEK_FREE_CHALLENGE_MARKER = /captcha-wrap|Verification required/

const TITLE_CAP = 200
const SNIPPET_CAP = 300

/** One `<li class="rN…">` block from the standard result list. */
const RESULT_BLOCK = /<li class="r\d[^"]*">([\s\S]*?)<\/li>/g

const HEADING_LINK = /<h2>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/i
const SNIPPET_PARAGRAPH = /<p class="s">([\s\S]*?)<\/p>/i

/** Whitespace-collapse + cap a string. */
function clip(s: string, cap = SNIPPET_CAP): string {
  const clean = String(s ?? '').replace(/\s+/g, ' ').trim()
  return clean.length > cap ? `${clean.slice(0, cap - 1)}…` : clean
}

/** Read one attribute out of an already-matched tag body. */
function attr(tagAttrs: string, name: string): string {
  const match = new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(tagAttrs)
  return match ? (match[1] ?? '') : ''
}

/**
 * Parse Mojeek's standard result list.
 *
 * Verified markup (2026-10, `mojeek-serp.html`):
 *
 *   <ul class="results-standard">
 *     <li class="r1"><a title="…" href="…" class="ob"><p class="i">…</p></a>
 *       <h2><a class="title" title="…" href="…">Title</a></h2>
 *       <p class="s">Snippet with <strong>markup</strong></p></li>
 *     <li class="r3 clu-result">…</li>
 *
 * Attribute ORDER is not stable (the `<a class="ob">` carries `href` last, the
 * `<h2>` link carries it last too but `title` first), so the heading link is
 * matched structurally and its `href` read out of the attribute blob rather
 * than pinned by a single regex over the whole tag.
 *
 * Blocks are collected by their class (`r` + digit — the standard list only;
 * the quickbox / infobox at the top of the page uses plain `<li>`), NOT by
 * slicing `<ul class="results-standard">…</ul>`, so an unbalanced list
 * cannot swallow the results.
 */
export function parseMojeekResults(html: string, max: number): SearchSource[] {
  const items: SearchSource[] = []
  const seen = new Set<string>()
  RESULT_BLOCK.lastIndex = 0
  let block: RegExpExecArray | null
  while ((block = RESULT_BLOCK.exec(html)) !== null) {
    if (items.length >= max) break
    const body = block[1] ?? ''
    const heading = HEADING_LINK.exec(body)
    if (!heading) continue
    const url = attr(heading[1] ?? '', 'href').trim()
    if (!/^https?:\/\//i.test(url)) continue
    if (seen.has(url)) continue
    seen.add(url)
    const title = clip(cleanText(heading[2] ?? ''), TITLE_CAP) || url
    const source: SearchSource = { url, title }
    const snippet = SNIPPET_PARAGRAPH.exec(body)
    if (snippet) {
      const text = clip(cleanText(snippet[1] ?? ''))
      if (text) source.snippet = text
    }
    items.push(source)
  }
  return items
}

/**
 * Compose the SERP URL. The only supported option is `s` — Mojeek's
 * 1-based start index (`s=11` is page 2 of 10). Anything else is dropped
 * rather than forwarded: an unknown key in the settings textarea must not
 * reach a rate-limited host as a bogus parameter.
 */
export function buildMojeekUrl(
  query: string,
  options?: Readonly<Record<string, unknown>>,
): string {
  const opts = options ?? {}
  const extras: Record<string, string> = {}
  const start = Number(opts.s ?? opts.start)
  if (Number.isInteger(start) && start > 1 && start <= 1000) extras.s = String(start)
  return composeEngineUrl(MOJEEK_FREE_ENDPOINT, 'q', query, extras)
}

export class MojeekFreeSearchEngine implements SearchEngine {
  readonly id = MOJEEK_FREE_ENGINE_ID
  readonly displayName = 'Mojeek'
  readonly endpoint = MOJEEK_FREE_ENDPOINT

  /**
   * The cookie IS the credential, so it travels through the shared key map
   * (`searchEngineApiKeys['mojeek-free']` or `DSH_NETWORK_MOJEEK_COOKIE`)
   * and the CLI injects the header. Engines only ever see `hasApiKey`.
   *
   * Declaring `auth` here does NOT mean the settings dialog offers an
   * "API Key" box for this engine — that gate is `ENGINE_HAS_API_KEY` in
   * `dsh/client.settings.js`, and it is deliberately `false`: inside the
   * host the persistent server's `MojeekSession` solves Altcha on the first
   * search, so there is nothing for a user to paste. The map entry is still
   * honoured when it exists (hand-written config, a cookie minted by
   * `mojeek-login`), and a stale one self-heals through the same session.
   * See this file's top-of-file docstring.
   */
  readonly auth: EngineAuth = {
    header: MOJEEK_FREE_AUTH_HEADER,
    scheme: 'raw',
    apiKeyEnv: MOJEEK_FREE_COOKIE_ENV,
  }

  /**
   * The Firefox profile the cookie was minted under. Mojeek's Altcha gate is
   * NOT defeated by a fingerprint (a full browser-shaped request without the
   * cookie gets the challenge page too — verified), so this profile only
   * keeps the search looking like the same navigation the cookie belongs to.
   */
  readonly defaultHeaders: Readonly<Record<string, string>> = FIREFOX_MOJEEK

  private envOptions(): Readonly<Record<string, unknown>> {
    return readEngineEnvOptions(this.id)
  }

  buildUrl(query: string, options?: Readonly<Record<string, string>>): string {
    return buildMojeekUrl(query, { ...this.envOptions(), ...(options ?? {}) })
  }

  buildRequests(query: string, options?: Readonly<Record<string, unknown>>): EngineRequest[] {
    const q = String(query ?? '').trim()
    if (q.length === 0) return []
    const merged = { ...this.envOptions(), ...(options ?? {}) }
    return [{ key: MOJEEK_FREE_ENGINE_ID, url: buildMojeekUrl(q, merged) }]
  }

  parseMany(bodies: EngineBody[], max: number): EngineParseResult {
    const warnings: string[] = []
    const uncertainty: string[] = []
    const items: SearchSource[] = []

    for (const body of bodies) {
      if (body.error) {
        warnings.push(`${MOJEEK_FREE_ENGINE_ID}: ${body.error}`)
        continue
      }

      const status = body.status ?? 0

      // 401/403: a real rejection, or the CLI-synthesized 401 for a missing
      // cookie. The persistent server auto-solves a missing cookie via its
      // `MojeekSession` before this branch is reached, so this warning only
      // fires on the standalone CLI (which has no session) or when that solve
      // itself failed. Mojeek answers the rate gate with 403 + "your network
      // appears to be sending automated queries", and the fix is patience,
      // not a retry — so the two are worded differently.
      if (status === 401) {
        warnings.push(
          `${MOJEEK_FREE_ENGINE_ID}: no chllg cookie and the auto-login could not issue one. ` +
            'This engine authenticates with a cookie, not an API key: run `dsh-network mojeek-login` ' +
            'and export the printed cookie as DSH_NETWORK_MOJEEK_COOKIE (the persistent dsh server ' +
            'solves this itself, so the settings dialog has nothing to configure); nothing was sent ' +
            'to mojeek.com.',
        )
        continue
      }
      if (status === 403) {
        warnings.push(
          `${MOJEEK_FREE_ENGINE_ID}: HTTP 403 — Mojeek flagged this network as automated (it blocks bursts, then ` +
            'recovers after a few minutes of silence). Do not retry immediately; the chain fell ' +
            'through to the next engine.',
        )
        continue
      }
      if (status === 429) {
        warnings.push(`${MOJEEK_FREE_ENGINE_ID}: rate limited (HTTP 429); wait before searching again`)
        continue
      }
      if (status !== 0 && status !== 200) {
        warnings.push(`${MOJEEK_FREE_ENGINE_ID}: unexpected HTTP ${status}`)
        continue
      }

      // A 200 that is really the JS challenge: the cookie is stale or was
      // revoked. Parsing it would report a silent zero-hit answer. The
      // persistent server's search path sees this before the parser
      // classifies it and auto-recovers by re-solving; standalone CLI /
      // a supplied cookie that the session doesn't manage both fall
      // through to the warning below.
      if (MOJEEK_FREE_CHALLENGE_MARKER.test(body.body)) {
        warnings.push(
          `${MOJEEK_FREE_ENGINE_ID}: the verification page came back instead of results — the chllg cookie is ` +
            'stale or was refused. Inside dsh the persistent server re-solves it without surfacing this; ' +
            'on the standalone CLI run `dsh-network mojeek-login` again.',
        )
        continue
      }

      for (const item of parseMojeekResults(body.body, max - items.length)) {
        items.push(item)
      }
    }

    // Mojeek paginates 10 at a time; saying so beats letting the caller read
    // "10 hits" as "10 total". The signal is "the page filled up AND the call
    // wanted more than one page" — a caller who asked for 10 got what it
    // asked for, and a short page is a genuine end of results.
    if (max > MOJEEK_FREE_RESULTS_PER_PAGE && items.length >= MOJEEK_FREE_RESULTS_PER_PAGE) {
      uncertainty.push(
        `${MOJEEK_FREE_ENGINE_ID}: Mojeek serves ${MOJEEK_FREE_RESULTS_PER_PAGE} results per page and this engine fetches one page; ` +
          `set the engine option s=${MOJEEK_FREE_RESULTS_PER_PAGE + 1} for the next page`,
      )
    }

    return {
      items,
      warnings: warnings.length > 0 ? warnings : undefined,
      uncertainty: uncertainty.length > 0 ? uncertainty : undefined,
    }
  }

  /** Single-body compatibility path (parity with the other engines). */
  parse(html: string, max: number): SearchSource[] {
    if (MOJEEK_FREE_CHALLENGE_MARKER.test(html)) return []
    return parseMojeekResults(html, max)
  }
}
