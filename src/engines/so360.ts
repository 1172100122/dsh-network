/**
 * So360SearchEngine — 360搜索 (so.com), keyless HTML scrape.
 *
 * Endpoint: `https://www.so.com/s?q=…`
 *
 * No credential, no proof-of-work: the first request from a cold egress IP
 * returns a full SERP, with each result's real URL pre-rendered in the
 * anchor's `data-mdurl` attribute (the `so.com` `mu` equivalent — `href` is
 * a `so.com/link?m=…` redirect this parser cannot unwrap).
 *
 * 360 has an IP rate limit enforced by a *graphical CAPTCHA page served as
 * HTTP 200* (titled `访问异常页面`, ~6-9 KB). The block parses to zero
 * results, so `SO360_BLOCKED_MARKER` is checked before the parser.
 * The engine never retries (a retry extends the cooldown) and never emits an
 * `uncertainty` hint that would ask for more pages off an already-walled IP.
 *
 * Rich cards (`AI 答案 / 图片 / 短视频`) carry `<h3 class="g-title">` rather
 * than `res-title`, so a page yields 5-7 organic hits and the rest are cards;
 * `countSo360RichCards()` reports this in `uncertainty` so a short list reads
 * as displaced rather than exhausted.
 *
 * Paging is `pn` (1-based; `pn=2` is the next page), validated here so a typo
 * in the settings textarea cannot reach the host.
 */
import {
  type EngineBody,
  type EngineParseResult,
  type EngineRequest,
  type SearchEngine,
  type SearchSource,
  cleanText,
  composeEngineUrl,
  readEngineEnvOptions,
} from './index.ts'
import { FIREFOX_SO360 } from './header-profiles.ts'

export const SO360_ORIGIN = 'https://www.so.com'

export const SO360_ENGINE_ID = 'so360'

export const SO360_ENDPOINT = `${SO360_ORIGIN}/s`

/**
 * The CAPTCHA wall, served as HTTP 200. Two strings so a layout change costs
 * one rather than the whole marker; the marker is checked BEFORE the parser
 * because the block page parses to zero results.
 */
export const SO360_BLOCKED_MARKER = /访问异常页面|请输入验证码/

/** Upper bound on `pn`, mirroring the "don't forward junk" rule. */
const SO360_MAX_PAGE = 100

const TITLE_CAP = 200
const SNIPPET_CAP = 300

/** Whitespace-collapse + cap a string. */
function clip(s: string, cap = SNIPPET_CAP): string {
  const clean = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.length > cap ? `${clean.slice(0, cap - 1)}…` : clean
}

/** Read one attribute out of an already-matched tag body. */
function attr(tagAttrs: string, name: string): string {
  const match = new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(tagAttrs)
  if (!match) return ''
  // `&amp;` is decoded here so `cleanText`'s single decode pass stays single.
  return (match[1] ?? '').replace(/&amp;/gi, '&')
}

/**
 * One organic result heading. Matched structurally because attribute ORDER
 * and spacing are not stable — the same page emits `<h3   class="res-title">`,
 * `<h3 class="res-title" >` and `<h3 class="res-title " >`.
 */
const HEADING = /<h3\b[^>]*\bclass="[^"]*\bres-title\b[^"]*"[^>]*>([\s\S]*?)<\/h3>/gi

/** The anchor inside a heading, attributes split from the title text. */
const HEADING_ANCHOR = /<a\b([^>]*)>([\s\S]*?)<\/a>/i

/**
 * Snippet containers — `<p class="res-desc">` (plain) and
 * `<span class="res-list-summary">` (thumbed). TEMPERED on the container's
 * OWN closing tag: a lazy `([\s\S]*?)<\//` stops at the first `</em>` inside
 * a `<span>` and shreds the snippet, measured on the live 2026-10 SERP.
 */
const SNIPPET_PLAIN = new RegExp(
  String.raw`<p\b(?=[^>]*\bclass="[^"]*\bres-desc\b)[^>]*>((?:(?!<\/?p\b)[\s\S])*)</p>`,
  'i',
)
const SNIPPET_THUMBED = new RegExp(
  String.raw`<span\b(?=[^>]*\bclass="[^"]*\bres-list-summary\b)[^>]*>((?:(?!<\/?span\b)[\s\S])*)</span>`,
  'i',
)

/** Where a result block ends: the next heading, the next result `<li>`, or the pager. */
const BLOCK_END = /<h3\b[^>]*\bclass="[^"]*\bres-title\b|<li\b[^>]*\bclass="[^"]*\bres-list\b|<div\b[^>]*\bclass="[^"]*\bpage\b/i

/**
 * Count the rich-media cards that occupy result slots on this page. Loose
 * count of containers; only used to decide whether a short list was
 * displaced rather than exhausted.
 */
export function countSo360RichCards(html: string): number {
  return (String(html ?? '').match(/\bclass="[^"]*\bg-mohe\b/g) ?? []).length
}

/**
 * Parse 360's organic result list.
 *
 * Blocks are collected BY HEADING CLASS rather than by slicing
 * `<ul class="…">…</ul>`: the mohe cards nest their own lists, so a
 * list-boundary slice either swallows them or is swallowed. Each heading
 * borrows the text that follows it up to the next heading, so the snippet
 * cannot leak from the neighbouring card.
 */
export function parseSo360Results(html: string, max: number): SearchSource[] {
  const items: SearchSource[] = []
  const seen = new Set<string>()
  const body = String(html ?? '')
  HEADING.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = HEADING.exec(body)) !== null && items.length < max) {
    const heading = match[0]
    const anchor = HEADING_ANCHOR.exec(match[1] ?? '')
    if (!anchor) continue

    // `data-mdurl` is the real target, pre-rendered for SEO; `href` is the
    // `so.com/link?m=…` redirect this parser cannot unwrap. Rare cards fall
    // back rather than being dropped.
    const url = attr(anchor[1] ?? '', 'data-mdurl') || attr(anchor[1] ?? '', 'href')
    if (!/^https?:\/\//i.test(url)) continue
    if (seen.has(url)) continue
    seen.add(url)

    const title = clip(cleanText(anchor[2] ?? ''), TITLE_CAP) || url

    // The snippet lives in the text AFTER this heading. Bound by the next
    // heading / result `<li>` so a card's own body is never borrowed.
    const tailStart = match.index + heading.length
    const rest = body.slice(tailStart)
    const end = BLOCK_END.exec(rest)?.index ?? rest.length
    const tail = rest.slice(0, end)

    const snippet = SNIPPET_PLAIN.exec(tail) ?? SNIPPET_THUMBED.exec(tail)
    const source: SearchSource = { url, title }
    if (snippet) {
      // ONE decode pass, via `cleanText` — 360 hands out the occasional
      // double-escaped excerpt; a second pass would corrupt every snippet
      // whose content legitimately IS an entity example.
      const text = clip(cleanText(snippet[1] ?? ''))
      if (text) source.snippet = text
    }
    items.push(source)
  }
  return items
}

/**
 * Compose the SERP URL. The only supported option is `pn` — 360's 1-based
 * page index. Anything else is dropped rather than forwarded, matching
 * every other engine.
 */
export function buildSo360Url(
  query: string,
  options?: Readonly<Record<string, unknown>>,
): string {
  const opts = options ?? {}
  const extras: Record<string, string> = {}
  const page = Number(opts.pn ?? opts.page)
  if (Number.isInteger(page) && page > 1 && page <= SO360_MAX_PAGE) {
    extras.pn = String(page)
  }
  return composeEngineUrl(SO360_ENDPOINT, 'q', query, extras)
}

export class So360SearchEngine implements SearchEngine {
  readonly id = SO360_ENGINE_ID
  readonly displayName = '360搜索'
  readonly endpoint = SO360_ENDPOINT

  /**
   * No `auth` block: 360 asks for nothing. Its one gate is an IP-bound
   * CAPTCHA (see the file header), which is not a credential — no header
   * to inject, no key for the settings dialog to hold.
   */
  readonly defaultHeaders: Readonly<Record<string, string>> = FIREFOX_SO360

  private envOptions(): Readonly<Record<string, unknown>> {
    return readEngineEnvOptions(this.id)
  }

  buildUrl(query: string, options?: Readonly<Record<string, string>>): string {
    return buildSo360Url(query, { ...this.envOptions(), ...(options ?? {}) })
  }

  buildRequests(query: string, options?: Readonly<Record<string, unknown>>): EngineRequest[] {
    const q = String(query ?? '').trim()
    if (q.length === 0) return []
    const merged = { ...this.envOptions(), ...(options ?? {}) }
    return [{ key: SO360_ENGINE_ID, url: buildSo360Url(q, merged) }]
  }

  parseMany(bodies: EngineBody[], max: number): EngineParseResult {
    const warnings: string[] = []
    const uncertainty: string[] = []
    const items: SearchSource[] = []
    let richCards = 0

    for (const body of bodies) {
      if (body.error) {
        warnings.push(`${SO360_ENGINE_ID}: ${body.error}`)
        continue
      }

      const status = body.status ?? 0
      if (status === 429) {
        warnings.push(`${SO360_ENGINE_ID}: rate limited (HTTP 429); wait before searching again`)
        continue
      }
      if (status !== 0 && status !== 200) {
        warnings.push(`${SO360_ENGINE_ID}: unexpected HTTP ${status}`)
        continue
      }

      // The captcha wall arrives as a 200, so it has to be recognised here
      // BEFORE the parser turns it into a confident "no results". No retry
      // — a retry extends the cooldown, not clears it.
      if (SO360_BLOCKED_MARKER.test(body.body)) {
        warnings.push(
          `${SO360_ENGINE_ID}: 360 returned its anti-automation CAPTCHA page (访问异常页面, served with HTTP 200) ` +
            'instead of results. It is an IP rate limit — a burst of queries from one address earns a graphical ' +
            'verification, and the plugin cannot solve one. To clear it: open https://www.so.com in a browser and ' +
            'complete the verification once; 360 does not bind it to the request source, so the next search here ' +
            'goes through (the wall also lapses on its own within a few minutes). Until then the chain falls ' +
            'through to the next engine.',
        )
        continue
      }

      richCards += countSo360RichCards(body.body)
      for (const item of parseSo360Results(body.body, max - items.length)) {
        items.push(item)
      }
    }

    // A short list here is ambiguous (exhausted vs displaced); the card
    // count settles it, so the caller is told which case they are looking at.
    if (richCards > 0 && items.length < max) {
      uncertainty.push(
        `${SO360_ENGINE_ID}: this page interleaved ${richCards} rich-media card(s) (AI 答案 / 图片 / 短视频), which occupy ` +
          `result slots, so ${items.length} organic hits is short of the engine's real yield for this page — set the engine ` +
          `option pn=2 to fetch the next page`,
      )
    }

    return {
      items,
      warnings: warnings.length > 0 ? warnings : undefined,
      uncertainty: uncertainty.length > 0 ? uncertainty : undefined,
    }
  }

  /**
   * Single-body compatibility path (parity with the other engines). The
   * CAPTCHA check is repeated here because this path returns a bare
   * `SearchSource[]`, so a block page would otherwise look like an empty
   * index.
   */
  parse(html: string, max: number): SearchSource[] {
    if (SO360_BLOCKED_MARKER.test(html)) return []
    return parseSo360Results(html, max)
  }
}
