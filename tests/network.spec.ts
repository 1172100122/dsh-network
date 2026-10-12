/**
 * Unit tests for dsh-network pure modules.
 *
 *   - network.ts: URL parsing, redirect resolution, IP/class checks, allowlist
 *   - search-engines.ts: Bing/DuckDuckGo/Baidu URL building + result parsing
 *   - html.ts: HTML → Markdown conversion
 *   - cli.ts: argv flag parsing (no execution)
 *
 * These match the discipline in the dsh-handbook ch.4 (logic in pure
 * functions, dependency-free, tested in milliseconds). No network is ever
 * contacted here; integration testing belongs in the evals (run with
 * `pnpm eval`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  appendQuery,
  classifyFetchError,
  hasHeader,
  hostAllowed,
  isFakeIpv4,
  isIpv4Literal,
  isPrivateHost,
  isPrivateIpv4,
  isPrivateIpv6Literal,
  parseHttpUrl,
  resolveRedirect,
  sameRedirectDomain,
  sameRedirectProtocol,
} from '../src/network.ts'
import {
  b64UrlDecode,
  baiduSnippet,
  buildEngineUrl,
  parseBaiduResults,
  parseBingResults,
  parseDuckDuckGoResults,
  unwrapBingUrl,
  unwrapDuckDuckGoUrl,
} from '../src/search-engines.ts'
import { htmlToMarkdown } from '../src/html.ts'
import {
  cleanHtmlText,
  decodeEntities,
  extractVisibleTextFromHtml,
} from '../src/html-extract.ts'
import { buildRequestUrl } from '../src/http_request.ts'
import { normalizeConfig } from '../src/config.ts'
import { inferFileType, parseDocument } from '../src/document.ts'
import { GitHubSearchEngine, routeGithubIndexes } from '../src/engines/github.ts'
import {
  SEARXNG_DEFAULT_ENDPOINT,
  SEARXNG_ENV,
  SearxngSearchEngine,
  buildSearxngUrl,
  normalizeSearxngEndpoint,
} from '../src/engines/searxng.ts'
import { BRAVE_API_KEY_ENV, BraveSearchEngine, buildBraveUrl } from '../src/engines/brave.ts'
import {
  MOJEEK_ENGINE_ID,
  MOJEEK_API_KEY_ENV,
  MojeekSearchEngine,
  buildMojeekApiUrl,
  parseMojeekApiResults,
} from '../src/engines/mojeek.ts'
import {
  TAVILY_API_KEY_ENV,
  TAVILY_AUTH_HEADER,
  TAVILY_ENGINE_ID,
  TAVILY_KEYLESS_HEADER,
  TavilySearchEngine,
  buildTavilyRequest,
  parseTavilyResults,
} from '../src/engines/tavily.ts'
import { cleanText, defaultRegistry, registerDefaultEngines } from '../src/engines/index.ts'
import {
  SO360_ENGINE_ID,
  SO360_BLOCKED_MARKER,
  So360SearchEngine,
  buildSo360Url,
  countSo360RichCards,
  parseSo360Results,
} from '../src/engines/so360.ts'
import {
  WEB_SITEMAP,
  buildSearchUrl,
  categoriesInUse,
  canonicalHost,
  findByDomain,
  findByKey,
  listByCategory,
  renderPromptDigest,
  searchSitemap,
  snapshot,
  summarize,
} from '../src/sitemap.ts'

// ───────────────────────────── network.ts ─────────────────────────────
describe('network URL/IP helpers', () => {
  it('parseHttpUrl: simple https URL', () => {
    expect(parseHttpUrl('https://example.com/a?b=1#c')).toEqual({
      scheme: 'https', host: 'example.com', port: '', path: '/a?b=1#c',
    })
  })
  it('parseHttpUrl: explicit port', () => {
    expect(parseHttpUrl('http://api.example.com:8080/v1')).toEqual({
      scheme: 'http', host: 'api.example.com', port: '8080', path: '/v1',
    })
  })
  it('parseHttpUrl: IPv6 literal', () => {
    expect(parseHttpUrl('http://[::1]:3000/')).toEqual({
      scheme: 'http', host: '::1', port: '3000', path: '/',
    })
  })
  it('parseHttpUrl: strips userinfo', () => {
    expect(parseHttpUrl('https://user:pass@example.com/x').host).toBe('example.com')
  })
  it('parseHttpUrl: rejects non-http schemes', () => {
    expect(() => parseHttpUrl('ftp://example.com')).toThrow(/scheme/)
  })
  it('parseHttpUrl: rejects whitespace', () => {
    expect(() => parseHttpUrl('https://exa mple.com')).toThrow(/whitespace/)
  })
  it('parseHttpUrl: rejects missing host', () => {
    expect(() => parseHttpUrl('https:///path')).toThrow(/no host/)
  })

  it('isPrivateIpv4 classification', () => {
    for (const s of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.1', '169.254.1.1', '224.0.0.1', '0.0.0.0']) {
      expect(isPrivateIpv4(s)).toBe(true)
    }
    for (const s of ['8.8.8.8', '93.184.216.34', '1.1.1.1']) {
      expect(isPrivateIpv4(s)).toBe(false)
    }
  })
  it('isPrivateIpv6Literal classification', () => {
    expect(isPrivateIpv6Literal('::1')).toBe(true)
    expect(isPrivateIpv6Literal('fe80::1')).toBe(true)
    expect(isPrivateIpv6Literal('fd00::1')).toBe(true)
    expect(isPrivateIpv6Literal('fc00::1')).toBe(true)
    expect(isPrivateIpv6Literal('2606:2800:220:1::1')).toBe(false)
  })
  it('isPrivateHost: loopback / private literals, public hosts pass', () => {
    expect(isPrivateHost('localhost')).toBe(true)
    expect(isPrivateHost('[::1]')).toBe(true)
    expect(isPrivateHost('127.0.0.1')).toBe(true)
    expect(isPrivateHost('10.0.0.5')).toBe(true)
    expect(isPrivateHost('192.168.1.10')).toBe(true)
    expect(isPrivateHost('::1')).toBe(true)
    expect(isPrivateHost('fd00::1')).toBe(true)
    expect(isPrivateHost('8.8.8.8')).toBe(false)
    expect(isPrivateHost('example.com')).toBe(false)
    expect(isPrivateHost('searxng.lan')).toBe(false) // static check: hostname resolution is not consulted
  })
  it('isFakeIpv4 (RFC 2544 proxy space)', () => {
    expect(isFakeIpv4('198.18.0.1')).toBe(true)
    expect(isFakeIpv4('198.19.255.255')).toBe(true)
    expect(isFakeIpv4('198.17.0.1')).toBe(false)
    expect(isFakeIpv4('8.8.8.8')).toBe(false)
  })
  it('ip literal helper', () => {
    expect(isIpv4Literal('127.0.0.1')).toBe(true)
    expect(isIpv4Literal('256.0.0.1')).toBe(false)
    expect(isIpv4Literal('example.com')).toBe(false)
  })
  it('hostAllowed wildcard matching', () => {
    expect(hostAllowed('example.com', ['example.com'])).toBe(true)
    expect(hostAllowed('www.example.com', ['*.example.com'])).toBe(true)
    expect(hostAllowed('example.com', ['*.example.com'])).toBe(false)
    expect(hostAllowed('evil.com', ['*.example.com'])).toBe(false)
    expect(hostAllowed('anything.net', ['*'])).toBe(true)
    expect(hostAllowed('example.com', [])).toBe(false)
    expect(hostAllowed('EXAMPLE.COM', ['example.com'])).toBe(true)
  })
  it('resolveRedirect: absolute, protocol-relative, root-relative, relative', () => {
    expect(resolveRedirect('https://a.com/x/y', 'https://b.com/z')).toBe('https://b.com/z')
    expect(resolveRedirect('https://a.com/x', '//b.com/z')).toBe('https://b.com/z')
    expect(resolveRedirect('https://a.com/x/y', '/z')).toBe('https://a.com/z')
    expect(resolveRedirect('https://a.com/x/y', 'z')).toBe('https://a.com/x/z')
  })
  it('sameRedirectDomain: same host passes, other hosts and ports differ correctly', () => {
    expect(sameRedirectDomain('https://a.com/x', 'https://a.com/y')).toBe(true)
    expect(sameRedirectDomain('https://a.com/x', 'https://A.com/y')).toBe(true) // case-insensitive
    expect(sameRedirectDomain('https://a.com/x', 'https://a.com:8443/y')).toBe(true) // port is not a domain change
    expect(sameRedirectDomain('https://a.com/x', 'https://b.com/y')).toBe(false)
    expect(sameRedirectDomain('https://a.com/x', 'https://www.a.com/y')).toBe(false) // subdomain is a different domain
    expect(sameRedirectDomain('https://a.com/x', 'ftp://a.com/y')).toBe(false) // non-http(s) target never passes
  })
  it('sameRedirectProtocol: scheme switch is detected in both directions', () => {
    expect(sameRedirectProtocol('https://a.com/x', 'https://a.com/y')).toBe(true)
    expect(sameRedirectProtocol('http://a.com/x', 'http://a.com/y')).toBe(true)
    expect(sameRedirectProtocol('https://a.com/x', 'http://a.com/y')).toBe(false) // downgrade
    expect(sameRedirectProtocol('http://a.com/x', 'https://a.com/y')).toBe(false) // upgrade
    expect(sameRedirectProtocol('https://a.com/x', 'ftp://a.com/y')).toBe(false)
  })
  it('appendQuery: encodes and joins', () => {
    expect(appendQuery('https://a.com/search', { q: 'hello world', page: '2' }))
      .toBe('https://a.com/search?q=hello%20world&page=2')
    expect(appendQuery('https://a.com/?x=1', { y: '2' })).toBe('https://a.com/?x=1&y=2')
    expect(appendQuery('https://a.com/', {})).toBe('https://a.com/')
    expect(appendQuery('https://a.com/', undefined)).toBe('https://a.com/')
    expect(appendQuery('https://a.com/', { a: 1, b: null, c: undefined })).toBe('https://a.com/?a=1')
  })
  it('hasHeader is case-insensitive', () => {
    expect(hasHeader({ 'X-Token': 'a' }, 'x-token')).toBe(true)
    expect(hasHeader({ 'X-Token': 'a' }, 'Authorization')).toBe(false)
  })
  it('classifyFetchError maps common Node fetch codes', () => {
    expect(classifyFetchError(new Error('dns') as unknown).code).toMatch(/Error/)
    expect(classifyFetchError(Object.assign(new Error('boom'), { code: 'ENOTFOUND' })).code).toBe('DNS_FAILED')
    expect(classifyFetchError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })).code).toBe('CONNECTION_RESET')
    expect(classifyFetchError(Object.assign(new Error('tls'), { code: 'CERT_HAS_EXPIRED' })).code).toBe('TLS_CERT')
    expect(classifyFetchError(Object.assign(new Error('timed out'), { name: 'TimeoutError' })).code).toBe('TIMEOUT')
  })
})

// ─────────────────────────── search-engines.ts ──────────────────────────
describe('search engine URL building', () => {
  it('buildEngineUrl: all engines', () => {
    expect(buildEngineUrl('bing', 'a b')).toMatch(/^https:\/\/www\.bing\.com\/search\?q=a%20b/)
    expect(buildEngineUrl('duckduckgo', 'x')).toMatch(/^https:\/\/html\.duckduckgo\.com\/html\/\?q=x$/)
    expect(buildEngineUrl('baidu', 'x')).toMatch(/^https:\/\/www\.baidu\.com\/s\?wd=x/)
  })
  it('parseBingResults: extracts url/title/snippet', () => {
    const html =
      '<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=a1&ntb=1">Title A</a></h2><p>Snippet A</p></li>' +
      '<li class="b_algo"><h2><a href="https://example.org/b">Title B</a></h2></li>'
    const results = parseBingResults(html, 10)
    expect(results.length).toBe(2)
    expect(results[0]?.title).toBe('Title A')
    expect(results[0]?.snippet).toBe('Snippet A')
  })
  it('unwrapBingUrl: base64 a1 redirect', () => {
    const target = 'https://real.example/page'
    const encoded = btoa(target).replace(/\+/g, '-').replace(/\//g, '_')
    const href = `https://www.bing.com/ck/a?u=a1${encoded}&ntb=1`
    expect(unwrapBingUrl(href)).toBe(target)
    expect(unwrapBingUrl('https://example.org/plain')).toBe('https://example.org/plain')
  })
  it('unwrapDuckDuckGoUrl: uddg param', () => {
    const href = '//duckduckgo.com/l/?uddg=' + encodeURIComponent('https://real.example/x')
    expect(unwrapDuckDuckGoUrl(href)).toBe('https://real.example/x')
  })
  it('parseDuckDuckGoResults: skips ad click-trackers', () => {
    const html =
      '<a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a>' +
      '<a class="result__a" href="https://example.org/r">Real</a>' +
      '<a class="result__snippet" href="#">snip text</a>'
    const results = parseDuckDuckGoResults(html, 10)
    expect(results.length).toBe(1)
    expect(results[0]?.title).toBe('Real')
    expect(results[0]?.snippet).toBe('snip text')
  })
  it('parseBaiduResults: mu attribute wins over href', () => {
    const html =
      '<div class="c-container"><h3><a href="https://www.baidu.com/link?url=x" mu="https://real.example/1">Title 1</a></h3><span class="c-abstract">Abs 1</span></div>' +
      '<div class="c-container"><h3><a href="https://real.example/2">Title 2</a></h3></div>'
    const results = parseBaiduResults(html, 10)
    expect(results.length).toBe(2)
    expect(results[0]?.url).toBe('https://real.example/1')
    expect(results[0]?.snippet).toBe('Abs 1')
    expect(results[1]?.url).toBe('https://real.example/2')
  })
  it('b64UrlDecode round-trips and returns null on garbage', () => {
    expect(b64UrlDecode(Buffer.from('hello').toString('base64'))).toBe('hello')
    expect(b64UrlDecode('!!!not-base64!!!')).toBeNull()
  })
  it('baiduSnippet matches multiple container shapes', () => {
    expect(baiduSnippet('<div class="c-abstract">Snippet here</div>')).toBe('Snippet here')
    // Baidu's cu-line-clamp pattern lives under a parent carrying data-module="abstract".
    expect(baiduSnippet('<div data-module="abstract"><span class="cu-line-clamp">S</span></div>')).toBe('S')
    expect(baiduSnippet('<span class="c-color">C</span>')).toBe('C')
    expect(baiduSnippet('<div></div>')).toBe('')
  })
})

// ─────────────────────── HTML entity decoding ───────────────────────
//
// Source markup is entity-encoded, and every text node this package
// emits goes to a Markdown renderer or a model that can only render
// what it is given: a literal `&nbsp;` used to reach a result card, a
// web_search answer and the model's own reply verbatim. These cases are
// the regression fence for that.
describe('decodeEntities', () => {
  it('decodes the entities that actually show up in result markup', () => {
    expect(decodeEntities('Aug 19, 2026&nbsp;&#0183;&#32;DeepSeek')).toBe('Aug 19, 2026 · DeepSeek')
    expect(decodeEntities('&amp;NBSP HTML')).toBe('&NBSP HTML')
    expect(decodeEntities("they&#x27;re built with code")).toBe("they're built with code")
    expect(decodeEntities('&quot;quoted&quot; &lt;tag&gt;')).toBe('"quoted" <tag>')
    expect(decodeEntities('&copy; 2026 &mdash; done&hellip;')).toBe('© 2026 — done…')
    expect(decodeEntities('&rsquo; &ldquo;x&rdquo; &euro;5 &frac12;')).toBe('\u2019 \u201cx\u201d €5 ½')
  })

  it('resolves each reference exactly once (no double decode)', () => {
    // `&amp;lt;` is the page ESCAPING the text "&lt;". Decoding it twice
    // would hand the stripper a real `<` — the classic entity-injection
    // bug this single pass exists to avoid.
    expect(decodeEntities('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;')
    expect(decodeEntities('a &amp;amp; b')).toBe('a &amp; b')
  })

  it('handles numeric, zero-padded and uppercase-entity forms', () => {
    expect(decodeEntities('&#183;')).toBe('·')
    expect(decodeEntities('&#0183;')).toBe('·')
    expect(decodeEntities('&#x2F;')).toBe('/')
    expect(decodeEntities('&#X2f;')).toBe('/')
    expect(decodeEntities('&NBSP;')).toBe(' ')
    // Uppercase HEX DIGITS too — `&#xE9;` is how a page that is *about*
    // entity escaping (a reference table, a spec) writes it.
    expect(decodeEntities('&#xE9;')).toBe('é')
    expect(decodeEntities('&#XAB;')).toBe('\u00ab')
    expect(decodeEntities('&ddagger;')).toBe('‡')
  })

  it('leaves unknown and out-of-range references visible instead of blanking them', () => {
    expect(decodeEntities('&notarealentity;')).toBe('&notarealentity;')
    expect(decodeEntities('a & b')).toBe('a & b')
    // Surrogates and > U+10FFFF are not scalar values: emit nothing
    // rather than a lone surrogate that breaks the UTF-8 encode.
    expect(decodeEntities('x&#xD800;y')).toBe('xy')
    expect(decodeEntities('x&#1114112;y')).toBe('xy')
    expect(decodeEntities('x&#0;y')).toBe('xy')
  })

  it('normalizes every flavour of non-breaking whitespace to a space', () => {
    expect(decodeEntities('a\u00a0b')).toBe('a b')
    expect(decodeEntities('a&ensp;b&emsp;c&thinsp;d')).toBe('a b c d')
    // Zero-width characters are dropped, not turned into a space: a page
    // inserts U+200B to break a line INSIDE a word, so "a<ZWSP>b" is the
    // single word "ab" and `&shy;` is a hyphenation hint, not content.
    expect(decodeEntities('a\u200bb')).toBe('ab')
    expect(decodeEntities('un\u00adbroken')).toBe('unbroken')
    expect(decodeEntities('a&shy;b')).toBe('ab')
    expect(decodeEntities('a\ufeffb')).toBe('ab')
  })
})

describe('cleanHtmlText / extractVisibleTextFromHtml', () => {
  it('cleanText (engine helper) strips tags AND decodes in one step', () => {
    expect(cleanText('<b>R&amp;D</b> &#8212; <span>1&nbsp;000</span>')).toBe('R&D — 1 000')
    expect(cleanText('  \n <em>a</em>\t b ')).toBe('a b')
  })

  it('extractVisibleTextFromHtml decodes the title and the body', () => {
    const { title, text } = extractVisibleTextFromHtml(
      '<html><head><title>Caf&eacute; &amp; Bar</title></head>' +
        '<body><p>First&nbsp;line</p><p>Second &#8212; line</p></body></html>',
    )
    expect(title).toBe('Café & Bar')
    expect(text).toBe('First line\nSecond — line')
  })

  it('extractVisibleTextFromHtml keeps an empty title null, not an empty string', () => {
    expect(extractVisibleTextFromHtml('<html><head><title>  </title></head><body>x</body></html>').title).toBeNull()
    expect(extractVisibleTextFromHtml('<html><body>x</body></html>').title).toBeNull()
  })
})

describe('search engines decode entities at the parser boundary', () => {
  it('parseBingResults: the date separator entity decodes in the snippet', () => {
    const html =
      '<li class="b_algo"><h2><a href="https://example.org/a">R&amp;D Tools</a></h2>' +
      '<p>Aug 19, 2026&nbsp;&#0183;&#32;Plugin to manage &quot;proxy&quot;.</p></li>'
    const [hit] = parseBingResults(html, 10)
    expect(hit?.title).toBe('R&D Tools')
    expect(hit?.snippet).toBe('Aug 19, 2026 · Plugin to manage "proxy".')
  })

  it('parseDuckDuckGoResults: titles and snippets decode', () => {
    const html =
      '<a class="result__a" href="https://example.org/r">&amp;NBSP HTML: Examples</a>' +
      '<a class="result__snippet" href="#">It&#x27;s a non&nbsp;breaking space.</a>'
    const [hit] = parseDuckDuckGoResults(html, 10)
    expect(hit?.title).toBe('&NBSP HTML: Examples')
    expect(hit?.snippet).toBe("It's a non breaking space.")
  })

  it('parseBaiduResults: titles and every snippet layout decode', () => {
    const html =
      '<div class="c-container"><h3><a href="https://real.example/1">A &amp; B</a></h3>' +
      '<div data-module="abstract"><span class="cu-line-clamp">1&nbsp;000&#183;res</span></div></div>'
    const [hit] = parseBaiduResults(html, 10)
    expect(hit?.title).toBe('A & B')
    expect(hit?.snippet).toBe('1 000·res')
  })

  it('never emits a raw reference for any of the scraped engines', () => {
    // The end-to-end assertion the bug report maps to: whatever shape the
    // markup takes, no `&...;` reaches the model or a card.
    const fragments = [
      parseBingResults('<li class="b_algo"><h2><a href="https://e.org/1">T&amp;T</a></h2><p>a&nbsp;b</p></li>', 5),
      parseDuckDuckGoResults(
        '<a class="result__a" href="https://e.org/2">T&#39;s</a><a class="result__snippet" href="#">a&nbsp;b</a>',
        5,
      ),
      parseBaiduResults(
        '<div class="c-container"><h3><a href="https://e.org/3">T&amp;T</a></h3><span class="c-abstract">a&nbsp;b</span></div>',
        5,
      ),
      parseSo360Results(
        '<li class="res-list"><h3 class="res-title"><a href="https://www.so.com/link?m=x" data-mdurl="https://e.org/4">T&amp;T</a></h3>' +
          '<p class="res-desc">a&nbsp;b</p></li>',
        5,
      ),
    ]
    for (const hits of fragments) {
      expect(hits.length).toBe(1)
      expect(hits[0]?.title).not.toMatch(/&[a-z#][a-z0-9]*;/i)
      expect(hits[0]?.snippet).not.toMatch(/&[a-z#][a-z0-9]*;/i)
    }
  })
})

// ─────────────────────────── github engine ──────────────────────────
describe('GitHubSearchEngine', () => {
  const engine = new GitHubSearchEngine()

  it('routes queries to indexes by intent', () => {
    expect(routeGithubIndexes('react 18')).toEqual(['repositories'])
    expect(routeGithubIndexes('react 18 用法示例')).toEqual(['repositories', 'code'])
    expect(routeGithubIndexes('浏览器 crash 报错')).toEqual(['repositories', 'issues'])
    expect(routeGithubIndexes('@torvalds')).toEqual(['users'])
    expect(routeGithubIndexes('language:typescript stars:>1000')).toEqual(['repositories'])
    expect(routeGithubIndexes('   ')).toEqual([])
  })

  it('buildRequests: token-gated code request without a token', () => {
    const reqs = engine.buildRequests('how to use x', { hasToken: false, perPage: 10 })
    expect(reqs.map((r) => r.key)).toEqual(['repositories', 'code'])
    expect(reqs.find((r) => r.key === 'code')?.requiresToken).toBe(true)
    const withToken = engine.buildRequests('how to use x', { hasToken: true, perPage: 10 })
    expect(withToken.find((r) => r.key === 'code')?.requiresToken).toBeUndefined()
  })

  it('buildRequests: caps per_page at 100 and query at 256 chars', () => {
    const reqs = engine.buildRequests('x'.repeat(300), { perPage: 500 })
    const url = reqs[0]!.url
    expect(url).toContain('per_page=100')
    const q = decodeURIComponent(url.split('q=')[1]!.split('&')[0]!)
    expect(q.length).toBe(256)
  })

  it('buildRequests: explicit index selection wins over routing', () => {
    const reqs = engine.buildRequests('vue 3', { indexes: ['users', 'issues', 'forks'], hasToken: false })
    expect(reqs.map((r) => r.key)).toEqual(['users', 'issues']) // unknown id dropped
    const codeOnly = engine.buildRequests('vue 3', { indexes: ['code'], hasToken: true })
    expect(codeOnly.map((r) => r.key)).toEqual(['code'])
  })

  it('buildRequests: sort applies to repositories only', () => {
    const reqs = engine.buildRequests('vue 3', { indexes: ['repositories', 'issues'], sort: 'stars' })
    expect(reqs.find((r) => r.key === 'repositories')?.url).toContain('sort=stars&order=desc')
    expect(reqs.find((r) => r.key === 'issues')?.url).not.toContain('sort=')
    const best = engine.buildRequests('vue 3', { sort: 'best' })
    expect(best[0]?.url).not.toContain('sort=')
    const invalid = engine.buildRequests('vue 3', { sort: 'forks' })
    expect(invalid[0]?.url).not.toContain('sort=')
  })

  it('buildRequests: encodes the query and pins the API base', () => {
    const [req] = engine.buildRequests('vue 3 组合式 API', { perPage: 5 })
    expect(req?.url).toMatch(
      /^https:\/\/api\.github\.com\/search\/repositories\?q=vue%203%20%E7%BB%84%E5%90%88%E5%BC%8F%20API&per_page=5$/,
    )
  })

  it('parseMany: repositories page → rich metadata snippets', () => {
    const body = JSON.stringify({
      total_count: 2,
      incomplete_results: false,
      items: [
        {
          full_name: 'vuejs/core',
          html_url: 'https://github.com/vuejs/core',
          description: 'Vue.js core library',
          stargazers_count: 47000,
          language: 'TypeScript',
          pushed_at: '2026-08-01T00:00:00Z',
          fork: false,
        },
        {
          full_name: 'x/y',
          html_url: 'https://github.com/x/y',
          description: null,
          stargazers_count: 12,
          language: null,
          pushed_at: null,
          fork: true,
        },
      ],
    })
    const res = engine.parseMany([{ key: 'repositories', body, status: 200, headers: {} }], 10)
    expect(res.items.length).toBe(2)
    expect(res.items[0]?.title).toBe('[repo] vuejs/core')
    expect(res.items[0]?.snippet).toContain('⭐47.0k')
    expect(res.items[0]?.snippet).toContain('TypeScript')
    expect(res.items[0]?.snippet).toContain('updated 2026-08-01')
    expect(res.items[1]?.snippet).toContain('fork')
  })

  it('parseMany: code hits use text_matches fragments', () => {
    const body = JSON.stringify({
      items: [
        {
          path: 'src/x.ts',
          html_url: 'https://github.com/a/b/blob/main/src/x.ts',
          repository: { full_name: 'a/b' },
          text_matches: [{ fragment: 'const engine = new GitHubSearchEngine()' }],
        },
      ],
    })
    const res = engine.parseMany([{ key: 'code', body, status: 200, headers: {} }], 10)
    expect(res.items[0]?.title).toBe('[code] src/x.ts @ a/b')
    expect(res.items[0]?.snippet).toContain('const engine')
  })

  it('parseMany: synthetic 401 (no token) → warning, zero items', () => {
    const res = engine.parseMany([{ key: 'code', body: '', status: 401, headers: {} }], 10)
    expect(res.items).toEqual([])
    expect(res.warnings?.join(' ')).toContain('authentication required')
  })

  it('parseMany: rate limit 403 → warning with reset timestamp', () => {
    const res = engine.parseMany(
      [
        {
          key: 'repositories',
          body: JSON.stringify({ message: 'API rate limit exceeded for 1.2.3.4' }),
          status: 403,
          headers: { 'x-ratelimit-reset': '1787391199' },
        },
      ],
      10,
    )
    expect(res.items).toEqual([])
    expect(res.warnings?.[0]).toContain('rate limit')
    expect(res.warnings?.[0]).toContain('2026-08-22')
  })

  it('parseMany: transport failure lands in warnings', () => {
    const res = engine.parseMany([{ key: 'repositories', body: '', status: 0, error: 'Request timed out' }], 10)
    expect(res.items).toEqual([])
    expect(res.warnings?.[0]).toContain('timed out')
  })

  it('parseMany: fuses indexes with weighted RRF, dedupes, prefixes', () => {
    const repos = JSON.stringify({
      items: [
        { full_name: 'a/alpha', html_url: 'https://github.com/a/alpha', description: 'alpha', stargazers_count: 10 },
        { full_name: 'b/beta', html_url: 'https://github.com/b/beta', description: 'beta', stargazers_count: 5 },
      ],
    })
    // Duplicate URL on purpose: the repo hit (weight 1.0, rank 0) must
    // beat the issue hit (weight 0.9, rank 0) for the same URL.
    const issues = JSON.stringify({
      items: [
        { number: 1, title: 'alpha broken', html_url: 'https://github.com/a/alpha', state: 'open' },
        { number: 2, title: 'gamma issue', html_url: 'https://github.com/g/gamma/issues/2', state: 'closed' },
      ],
    })
    const res = engine.parseMany(
      [
        { key: 'repositories', body: repos, status: 200, headers: {} },
        { key: 'issues', body: issues, status: 200, headers: {} },
      ],
      10,
    )
    // scores: a/alpha repo 1/(60+1) > b/beta repo 1/(60+2) > gamma issue 0.9/(60+1)
    expect(res.items.map((i) => i.title)).toEqual([
      '[repo] a/alpha',
      '[repo] b/beta',
      '[issue] #2 gamma issue',
    ])
    expect(res.items.map((i) => i.url)).not.toContain('[issue] #1') // deduped by URL
  })

  it('parseMany: caps fused output at max', () => {
    const repos = JSON.stringify({
      items: [1, 2, 3, 4, 5].map((n) => ({
        full_name: `o/r${n}`,
        html_url: `https://github.com/o/r${n}`,
        description: `repo ${n}`,
      })),
    })
    const res = engine.parseMany([{ key: 'repositories', body: repos, status: 200, headers: {} }], 3)
    expect(res.items.length).toBe(3)
  })

  it('parse: single-body compatibility path', () => {
    const body = JSON.stringify({
      items: [
        {
          full_name: 'vuejs/core',
          html_url: 'https://github.com/vuejs/core',
          description: 'Vue.js core',
          stargazers_count: 47000,
          language: 'TypeScript',
        },
      ],
    })
    const items = engine.parse(body, 10)
    expect(items[0]?.title).toBe('[repo] vuejs/core')
  })

  it('is registered in the default registry as chain tail', () => {
    registerDefaultEngines(defaultRegistry)
    const all = defaultRegistry.all().map((e) => e.id)
    expect(all).toEqual(['bing', 'duckduckgo', 'baidu', 'so360', 'github', 'searxng', 'brave', 'mojeek-free', 'mojeek', 'tavily'])
  })
})

// ─────────────────────────── so360 engine ────────────────────────────
describe('So360SearchEngine', () => {
  // Trimmed from the live 2026-10 SERP — keeps the shapes the parser
  // keys on: heading attribute wobble, data-mdurl, both snippet layouts,
  // rich-card containers, and the g-title heading the mohe cards use.
  const SERP =
    '<li class="res-list"><div id="mohe-360shoutiao_onlineAI" class="g-mohe ">' +
    '<h3 class="g-title "><a href="https://image.so.com/i?q=x" data-md=\'{"p":"title"}\'>图片卡片</a></h3></div>' +
    '<h3   class="res-title"><a href="https://www.so.com/link?m=aaa" data-mdurl="https://real.example/1"' +
    " data-res='{\"tp\":21,\"pos\":1}' target=\"_blank\">大模型<em>推理</em>框架</a></h3>" +
    '<p class="res-desc"><span class="gray g-c-gray">2024年10月11日&nbsp;-&nbsp;</span>加速推理&nbsp;的<em>用处</em></p>' +
    '<p class="g-linkinfo"><cite><a class="g-linkinfo-a">real.example</a></cite></p></li>' +
    '<li class="res-list"><h3 class="res-title " >' +
    '<a  href="https://www.so.com/link?m=bbb" data-mdurl="https://real.example/2"  target="_blank">缩略图结果</a></h3>' +
    '<div class="res-comm-con"><span class="res-list-summary">errorTS2345:Argumentof<em>type</em>&#039;Buffer&#039;' +
    'is not assignable to parameter</span></div></li>' +
    // `lianmeng-ad` is an empty JS-filled sidebar slot outside the flow;
    // kept so a parser keyed on `<li>` nesting would trip over it.
    '<div id="lm-rightbottom" class="lianmeng-ad"></div>' +
    '<div class="g-mohe " data-mohe-type="360pic_new"><h3 class="g-title ">' +
    '<a href="https://image.so.com/i?q=y" data-md=\'{"p":"title"}\'>图片卡片</a></h3></div>'

  const engineOf = () => new So360SearchEngine()

  it('composes the SERP URL and validates the only option, pn', () => {
    expect(buildSo360Url('大模型')).toBe('https://www.so.com/s?q=%E5%A4%A7%E6%A8%A1%E5%9E%8B')
    expect(buildSo360Url('x', { pn: 2 })).toBe('https://www.so.com/s?q=x&pn=2')
    // Out-of-range, non-integer and unknown keys are dropped rather than
    // forwarded: a typo in the settings textarea must not reach the host.
    expect(buildSo360Url('x', { pn: 1 })).toBe('https://www.so.com/s?q=x')
    expect(buildSo360Url('x', { pn: 101 })).toBe('https://www.so.com/s?q=x')
    expect(buildSo360Url('x', { pn: 'two' })).toBe('https://www.so.com/s?q=x')
    expect(buildSo360Url('x', { src: 'evil', foo: 1 })).toBe('https://www.so.com/s?q=x')
  })

  it('is keyless: no auth block, so the dialog never offers a key field', () => {
    const e = engineOf()
    expect(e.id).toBe(SO360_ENGINE_ID)
    expect(e.endpoint).toBe('https://www.so.com/s')
    expect(e.displayName).toBe('360搜索')
    expect(e.auth).toBeUndefined()
  })

  it('prefers data-mdurl over the so.com/link redirect', () => {
    const [first] = parseSo360Results(SERP, 10)
    expect(first?.url).toBe('https://real.example/1')
  })

  it('falls back to href when a card carries no data-mdurl', () => {
    const hits = parseSo360Results('<h3 class="res-title"><a href="https://fallback.example/9">T</a></h3>', 10)
    expect(hits[0]?.url).toBe('https://fallback.example/9')
  })

  it('decodes entities and strips highlight markup in both snippet layouts', () => {
    const [plain, thumbed] = parseSo360Results(SERP, 10)
    expect(plain?.title).toBe('大模型推理框架')
    // `&nbsp;-&nbsp;` around the date becomes ` - `; the `&nbsp;` before 的
    // becomes a plain space (the whitespace pass runs even with no `&`).
    expect(plain?.snippet).toBe('2024年10月11日 - 加速推理 的用处')
    // The thumbnail layout is a `<span>`; a naive `([\s\S]*?)<\//` stops at
    // the first `</em>` and shreds the snippet. The tempered matcher keeps it.
    expect(thumbed?.snippet).toBe("errorTS2345:Argumentoftype'Buffer'is not assignable to parameter")
  })

  it('excludes rich cards, which carry g-title instead of res-title', () => {
    const urls = parseSo360Results(SERP, 10).map((h) => h.url)
    expect(urls).toEqual(['https://real.example/1', 'https://real.example/2'])
    expect(urls.some((u) => u.includes('image.so.com'))).toBe(false)
    expect(urls.some((u) => u.includes('ad.example'))).toBe(false)
  })

  it('decodes entity-escaped ampersands in data-mdurl', () => {
    const [hit] = parseSo360Results(
      '<h3 class="res-title"><a href="/l" data-mdurl="https://e.example/s?a=1&amp;src=n">T</a></h3>',
      10,
    )
    expect(hit?.url).toBe('https://e.example/s?a=1&src=n')
  })

  it('counts the rich cards that displace organic results', () => {
    expect(countSo360RichCards(SERP)).toBe(2)
    expect(countSo360RichCards('<h3 class="res-title"><a href="https://e.org/1">T</a></h3>')).toBe(0)
  })

  describe('the anti-automation CAPTCHA (served with HTTP 200)', () => {
    // The two marker strings (title + first line of body) come from the
    // real block page; a parser that only looked for result headings would
    // read this as "no results".
    const BLOCKED =
      '<!DOCTYPE html><html><head><title>访问异常页面</title></head><body>' +
      '<div id="warper"><p class="warn">请输入验证码以便正常访问: 看不清，换一个</p>' +
      '<p>您的IP是： 117.136.35.2</p></div></body></html>'

    it('matches the marker on the block page and not on a real SERP', () => {
      expect(SO360_BLOCKED_MARKER.test(BLOCKED)).toBe(true)
      expect(SO360_BLOCKED_MARKER.test(SERP)).toBe(false)
    })

    it('reports the wall instead of parsing it as an empty index', () => {
      // HTTP 200 + this body is NOT "360 found nothing".
      const res = engineOf().parseMany([{ key: SO360_ENGINE_ID, body: BLOCKED, status: 200, headers: {} }], 10)
      expect(res.items).toEqual([])
      const warning = res.warnings?.join('\n') ?? ''
      expect(warning).toMatch(/CAPTCHA/)
      // The remedy names the URL and the manual step — "wait and hope" strands
      // the user on a failed search.
      expect(warning).toContain('https://www.so.com')
      expect(warning).toMatch(/browser/i)
      expect(res.uncertainty).toBeUndefined()
    })

    it('never asserts an uncertainty on a blocked page', () => {
      // An uncertainty note would tell the caller to fetch MORE pages off an
      // IP that is already walled.
      const res = engineOf().parseMany([{ key: SO360_ENGINE_ID, body: BLOCKED, status: 200, headers: {} }], 10)
      expect(res.uncertainty).toBeUndefined()
    })

    it('keeps the single-body path from mistaking it for an empty result set', () => {
      expect(engineOf().parse(BLOCKED, 10)).toEqual([])
    })

    it('classifies a real 429 separately from the CAPTCHA wall', () => {
      const res = engineOf().parseMany(
        [{ key: SO360_ENGINE_ID, body: '', status: 429, headers: {} }],
        10,
      )
      expect(res.warnings?.join('\n')).toMatch(/429/)
    })
  })

  it('says a short list was displaced rather than exhausted', () => {
    const res = engineOf().parseMany([{ key: SO360_ENGINE_ID, body: SERP, status: 200, headers: {} }], 10)
    expect(res.items.length).toBe(2)
    expect(res.uncertainty?.join('\n')).toMatch(/rich-media card/)
    expect(res.uncertainty?.join('\n')).toMatch(/pn=2/)
  })

  it('stays quiet when the caller took everything the page had', () => {
    const res = engineOf().parseMany([{ key: SO360_ENGINE_ID, body: SERP, status: 200, headers: {} }], 2)
    expect(res.items.length).toBe(2)
    expect(res.uncertainty).toBeUndefined()
  })

  it('builds no request for a blank query', () => {
    expect(engineOf().buildRequests('   ')).toEqual([])
    expect(engineOf().buildRequests('q')?.map((r) => r.key)).toEqual([SO360_ENGINE_ID])
  })
})

// ─────────────────────────── searxng engine ──────────────────────────
describe('SearxngSearchEngine', () => {
  // The engine reads DSH_NETWORK_SEARXNG_URL at construction; pin the env
  // for the whole suite so tests never depend on the caller's environment.
  const savedEnv = process.env[SEARXNG_ENV]
  beforeAll(() => {
    delete process.env[SEARXNG_ENV]
  })
  afterAll(() => {
    if (savedEnv === undefined) delete process.env[SEARXNG_ENV]
    else process.env[SEARXNG_ENV] = savedEnv
  })

  it('defaults to the loopback endpoint and builds format=json URLs', () => {
    const engine = new SearxngSearchEngine()
    expect(engine.endpoint).toBe('http://127.0.0.1:8888')
    expect(engine.displayName).toBe('SearXNG')
    const [req] = engine.buildRequests('rust vs go', {})
    expect(req?.key).toBe('searxng')
    expect(req?.url).toBe('http://127.0.0.1:8888/search?q=rust%20vs%20go&format=json')
  })

  it('reads DSH_NETWORK_SEARXNG_URL and strips trailing slashes', () => {
    process.env[SEARXNG_ENV] = 'http://192.168.1.50:8080/'
    try {
      const engine = new SearxngSearchEngine()
      expect(engine.endpoint).toBe('http://192.168.1.50:8080')
      expect(engine.buildUrl('x')).toBe('http://192.168.1.50:8080/search?q=x&format=json')
    } finally {
      delete process.env[SEARXNG_ENV]
    }
  })

  it('buildSearxngUrl: passes through supported options only', () => {
    const url = buildSearxngUrl('http://127.0.0.1:8888', 'vue 3', {
      language: 'zh-CN',
      safesearch: 1,
      timeRange: 'month',
      categories: 'general,it',
      pageno: 2,
    })
    expect(url).toBe(
      'http://127.0.0.1:8888/search?q=vue%203&format=json&language=zh-CN&safesearch=1&time_range=month&categories=general%2Cit&pageno=2',
    )
    const minimal = buildSearxngUrl('http://127.0.0.1:8888', 'q', {
      safesearch: 3, // invalid → dropped
      timeRange: 'all', // invalid → dropped
      pageno: 1, // default → dropped
      junk: 'x', // unknown → dropped
    })
    expect(minimal).toBe('http://127.0.0.1:8888/search?q=q&format=json')
  })

  it('normalizeSearxngEndpoint: valid URLs kept, garbage falls back', () => {
    expect(normalizeSearxngEndpoint('https://searx.example.org')).toBe('https://searx.example.org')
    expect(normalizeSearxngEndpoint('http://10.0.0.2:9999/')).toBe('http://10.0.0.2:9999')
    expect(normalizeSearxngEndpoint('')).toBe(SEARXNG_DEFAULT_ENDPOINT)
    expect(normalizeSearxngEndpoint(undefined)).toBe(SEARXNG_DEFAULT_ENDPOINT)
    expect(normalizeSearxngEndpoint('not a url')).toBe(SEARXNG_DEFAULT_ENDPOINT)
    expect(normalizeSearxngEndpoint('ftp://127.0.0.1')).toBe(SEARXNG_DEFAULT_ENDPOINT)
  })

  it('parseMany: maps results to SearchSource and caps at max', () => {
    const body = JSON.stringify({
      query: 'rust vs go',
      results: [
        { url: 'https://a.example/1', title: 'Rust vs Go', content: '  A  comparison   of both.  ', engine: 'google', score: 1.0 },
        { url: 'https://a.example/2', title: '', content: '', engine: 'bing' },
        { url: '', title: 'no url', content: 'skipped' },
        { url: 'https://a.example/3', title: 'Third', content: null },
      ],
      unresponsive_engines: [],
    })
    const res = new SearxngSearchEngine().parseMany([{ key: 'searxng', body, status: 200, headers: {} }], 10)
    expect(res.items.length).toBe(3)
    expect(res.items[0]).toEqual({ url: 'https://a.example/1', title: 'Rust vs Go', snippet: 'A comparison of both.' })
    expect(res.items[1]?.title).toBe('https://a.example/2') // empty title falls back to the URL
    expect(res.items[2]?.snippet).toBeUndefined()
    expect(res.warnings).toBeUndefined()
    const capped = new SearxngSearchEngine().parseMany([{ key: 'searxng', body, status: 200, headers: {} }], 2)
    expect(capped.items.length).toBe(2)
  })

  it('parseMany: 403 (json format disabled) surfaces a fixable warning', () => {
    const res = new SearxngSearchEngine().parseMany([{ key: 'searxng', body: '', status: 403, headers: {} }], 10)
    expect(res.items).toEqual([])
    expect(res.warnings?.[0]).toContain('403')
    expect(res.warnings?.[0]).toContain('search.formats')
  })

  it('parseMany: JSON error bodies and non-JSON responses warn', () => {
    const err400 = new SearxngSearchEngine().parseMany(
      [{ key: 'searxng', body: JSON.stringify({ error: 'No query' }), status: 400, headers: {} }],
      10,
    )
    expect(err400.items).toEqual([])
    expect(err400.warnings?.[0]).toContain('No query')
    const notJson = new SearxngSearchEngine().parseMany(
      [{ key: 'searxng', body: '<html>503</html>', status: 503, headers: {} }],
      10,
    )
    expect(notJson.warnings?.[0]).toContain('unexpected HTTP 503')
    const html200 = new SearxngSearchEngine().parseMany(
      [{ key: 'searxng', body: '<html></html>', status: 200, headers: {} }],
      10,
    )
    expect(html200.warnings?.[0]).toContain('not JSON')
  })

  it('parseMany: unresponsive upstream engines become uncertainty', () => {
    const body = JSON.stringify({
      query: 'x',
      results: [{ url: 'https://ok.example', title: 'OK', content: 'fine' }],
      unresponsive_engines: [['google', 'HTTP error'], ['bing', 'timeout']],
    })
    const res = new SearxngSearchEngine().parseMany([{ key: 'searxng', body, status: 200, headers: {} }], 10)
    expect(res.items.length).toBe(1)
    expect(res.uncertainty?.[0]).toContain('2 upstream engine(s)')
    expect(res.uncertainty?.[0]).toContain('google, bing')
  })

  it('parseMany: transport failure and missing body land in warnings', () => {
    const res = new SearxngSearchEngine().parseMany(
      [{ key: 'searxng', body: '', status: 0, error: 'connection refused: 127.0.0.1:8888' }],
      10,
    )
    expect(res.items).toEqual([])
    expect(res.warnings?.[0]).toContain('connection refused')
  })

  it('parse: single-body compatibility path', () => {
    const body = JSON.stringify({
      results: [{ url: 'https://a.example/1', title: 'T', content: 'S' }],
    })
    const items = new SearxngSearchEngine().parse(body, 10)
    expect(items.length).toBe(1)
    expect(items[0]?.snippet).toBe('S')
  })
})

// ─────────────────────────── brave engine ──────────────────────────
describe('BraveSearchEngine', () => {
  // The engine reads DSH_NETWORK_ENGINE_OPTIONS per request; pin it so the
  // suite never depends on the caller's environment.
  const savedOptions = process.env.DSH_NETWORK_ENGINE_OPTIONS
  const savedKey = process.env[BRAVE_API_KEY_ENV]
  beforeAll(() => {
    delete process.env.DSH_NETWORK_ENGINE_OPTIONS
    delete process.env[BRAVE_API_KEY_ENV]
  })
  afterAll(() => {
    if (savedOptions === undefined) delete process.env.DSH_NETWORK_ENGINE_OPTIONS
    else process.env.DSH_NETWORK_ENGINE_OPTIONS = savedOptions
    if (savedKey === undefined) delete process.env[BRAVE_API_KEY_ENV]
    else process.env[BRAVE_API_KEY_ENV] = savedKey
  })

  it('pins the API endpoint and declares the credential header', () => {
    const engine = new BraveSearchEngine()
    expect(engine.endpoint).toBe('https://api.search.brave.com/res/v1/web/search')
    expect(engine.displayName).toBe('Brave Search')
    // The auth block is what the CLI injects from — a wrong header name here
    // would make every keyed call 401 with no other symptom.
    expect(engine.auth?.header).toBe('X-Subscription-Token')
    expect(engine.auth?.scheme).toBe('raw')
    expect(engine.auth?.apiKeyEnv).toBe(BRAVE_API_KEY_ENV)
  })

  it('builds the documented default query (count + extra_snippets)', () => {
    expect(buildBraveUrl('rust vs go', { max: 10 })).toBe(
      'https://api.search.brave.com/res/v1/web/search?q=rust%20vs%20go&count=10&extra_snippets=true',
    )
  })

  it('clamps count to Brave’s 20 cap and the offset to 0-9', () => {
    expect(buildBraveUrl('q', { max: 99 })).toContain('count=20')
    expect(buildBraveUrl('q', { max: 0 })).toContain('count=1')
    expect(buildBraveUrl('q', { max: 10, offset: 9 })).toContain('offset=9')
    expect(buildBraveUrl('q', { max: 10, offset: 10 })).not.toContain('offset=')
    expect(buildBraveUrl('q', { max: 10, offset: 0 })).not.toContain('offset=')
  })

  it('prefers the call’s perPage over the standalone max', () => {
    // The CLI always passes the call's result cap as `perPage`; `max` is the
    // standalone spelling. Server-provided wins so a per-call count argument
    // is honored, and a missing/odd perPage falls back to `max`.
    expect(buildBraveUrl('q', { perPage: 3, max: 10 })).toContain('count=3')
    expect(buildBraveUrl('q', { max: 7 })).toContain('count=7')
    expect(buildBraveUrl('q', { perPage: undefined, max: 7 })).toContain('count=7')
    expect(buildBraveUrl('q', {})).toContain('count=20')
  })

  it('passes through only the documented option vocabulary', () => {
    const url = buildBraveUrl('vue 3', {
      max: 5,
      country: 'de',
      searchLang: 'de',
      uiLang: 'de-DE',
      freshness: 'pw',
      safesearch: 'strict',
      goggles: 'https://goggles.example/rank.json',
    })
    expect(url).toBe(
      'https://api.search.brave.com/res/v1/web/search?q=vue%203&count=5&extra_snippets=true' +
        '&country=DE&search_lang=de&ui_lang=de-DE&freshness=pw&safesearch=strict' +
        '&goggles=https%3A%2F%2Fgoggles.example%2Frank.json',
    )
    const minimal = buildBraveUrl('q', {
      max: 10,
      country: 'DEU', // not a 2-letter code → dropped
      freshness: 'all', // not pd|pw|pm|py nor a range → dropped
      safesearch: 'maybe', // not off|moderate|strict → dropped
      goggles: 'not a url', // dropped rather than sent as free text
      junk: 'x', // unknown → dropped
    })
    expect(minimal).toBe('https://api.search.brave.com/res/v1/web/search?q=q&count=10&extra_snippets=true')
    // A custom date range is a documented freshness value.
    expect(buildBraveUrl('q', { max: 10, freshness: '2024-01-01to2024-06-30' })).toContain(
      'freshness=2024-01-01to2024-06-30',
    )
  })

  it('reads per-engine options out of DSH_NETWORK_ENGINE_OPTIONS', () => {
    process.env.DSH_NETWORK_ENGINE_OPTIONS = JSON.stringify({ brave: { country: 'JP' }, other: { x: 'y' } })
    try {
      const [req] = new BraveSearchEngine().buildRequests('q', { perPage: 3 })
      expect(req?.key).toBe('brave')
      expect(req?.url).toContain('country=JP')
      // The call's result cap wins over the engine default.
      expect(req?.url).toContain('count=3')
      // A single-engine env var of a DIFFERENT engine must not leak in.
      expect(req?.url).not.toContain('x=y')
    } finally {
      delete process.env.DSH_NETWORK_ENGINE_OPTIONS
    }
  })

  it('parseMany: maps web.results, keeps page_age, merges one extra snippet', () => {
    const body = JSON.stringify({
      query: { original: 'x', more_results_available: false },
      web: {
        results: [
          {
            title: 'Rust vs Go',
            url: 'https://bench.example/rust-go',
            description: 'Main excerpt.',
            page_age: '2026-02-01T00:00:00',
            extra_snippets: ['Second excerpt.', 'Third excerpt.'],
          },
          { title: '', url: 'https://no-title.example/x' },
          { title: 'no url', url: '' },
        ],
      },
    })
    const res = new BraveSearchEngine().parseMany([{ key: 'brave', body, status: 200, headers: {} }], 10)
    expect(res.items.length).toBe(2)
    expect(res.items[0]?.title).toBe('Rust vs Go')
    // Exactly one extra snippet rides along: main text, ellipsis, first extra.
    expect(res.items[0]?.snippet).toBe('Main excerpt. … Second excerpt.')
    // page_age lands in published_at — the field the search card renders.
    expect(res.items[0]?.published_at).toBe('2026-02-01T00:00:00')
    // A hit with no title falls back to its URL, and the url-less hit is dropped.
    expect(res.items[1]?.title).toBe('https://no-title.example/x')
  })

  it('parseMany: drops implausible page_age values instead of showing a wrong date', () => {
    // Live responses carry broken page_age values: one real query returned
    // `1970-01-19T20:35:52` for a modern page (an epoch-seconds field read as
    // ms), and Brave also documents relative shapes. A wrong date in the
    // evidence is worse than no date, so both are dropped.
    const body = JSON.stringify({
      web: {
        results: [
          { url: 'https://a.example/epoch', title: 'Epoch garbage', page_age: '1970-01-19T20:35:52' },
          { url: 'https://b.example/relative', title: 'Relative', page_age: '3 days ago' },
          { url: 'https://c.example/future', title: 'Far future', page_age: '2999-01-01T00:00:00' },
          { url: 'https://d.example/ok', title: 'Fine', page_age: '2026-09-12T19:05:25' },
          { url: 'https://e.example/none', title: 'No date' },
        ],
      },
    })
    const res = new BraveSearchEngine().parseMany([{ key: 'brave', body, status: 200, headers: {} }], 10)
    expect(res.items.map((i) => i.published_at)).toEqual([undefined, undefined, undefined, '2026-09-12T19:05:25', undefined])
  })

  it('parseMany: caps at max', () => {
    const results = Array.from({ length: 5 }, (_, i) => ({ url: `https://e.example/${i}`, title: `T${i}` }))
    const body = JSON.stringify({ web: { results } })
    const res = new BraveSearchEngine().parseMany([{ key: 'brave', body, status: 200, headers: {} }], 2)
    expect(res.items.length).toBe(2)
  })

  it('parseMany: an empty web.results page is zero hits, not an error', () => {
    const res = new BraveSearchEngine().parseMany(
      [{ key: 'brave', body: JSON.stringify({ web: { results: [] } }), status: 200, headers: {} }],
      10,
    )
    expect(res.items).toEqual([])
    expect(res.warnings).toBeUndefined()
  })

  it('parseMany: more_results_available surfaces as uncertainty at the cap', () => {
    const results = Array.from({ length: 2 }, (_, i) => ({ url: `https://e.example/${i}`, title: `T${i}` }))
    const body = JSON.stringify({ query: { more_results_available: true }, web: { results } })
    const res = new BraveSearchEngine().parseMany([{ key: 'brave', body, status: 200, headers: {} }], 2)
    expect(res.uncertainty?.[0]).toContain('more results are available')
  })

  it('parseMany: synthetic 401 (no key) names the fix', () => {
    const res = new BraveSearchEngine().parseMany([{ key: 'brave', body: '', status: 401, headers: {} }], 10)
    expect(res.items).toEqual([])
    expect(res.warnings?.[0]).toContain('authentication failed')
    expect(res.warnings?.[0]).toContain('DSH_NETWORK_BRAVE_API_KEY')
  })

  it('parseMany: 429 / 422 / non-JSON bodies become actionable warnings', () => {
    const engine = new BraveSearchEngine()
    const rate = engine.parseMany(
      [
        {
          key: 'brave',
          body: JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'quota exceeded' } }),
          status: 429,
          headers: {},
        },
      ],
      10,
    )
    expect(rate.warnings?.[0]).toContain('rate limited')
    expect(rate.warnings?.[0]).toContain('quota exceeded')

    const rejected = engine.parseMany([{ key: 'brave', body: '', status: 422, headers: {} }], 10)
    expect(rejected.warnings?.[0]).toContain('query rejected (422)')

    const html = engine.parseMany([{ key: 'brave', body: '<html>502</html>', status: 502, headers: {} }], 10)
    expect(html.warnings?.[0]).toContain('unexpected HTTP 502')

    const garbage = engine.parseMany([{ key: 'brave', body: '<html></html>', status: 200, headers: {} }], 10)
    expect(garbage.warnings?.[0]).toContain('was not JSON')

    const foreign = engine.parseMany(
      [{ key: 'brave', body: JSON.stringify({ results: [] }), status: 200, headers: {} }],
      10,
    )
    expect(foreign.warnings?.[0]).toContain('no `web.results`')
  })

  it('parseMany: a 422 about the credential is reported as auth, not as a bad query', () => {
    // The live API answers 422 (not 401) when `x-subscription-token` is
    // missing, with the field name inside error.meta.errors[].loc. Reporting
    // that as "check your query" would send the user down the wrong path.
    const body = JSON.stringify({
      error: {
        code: 'VALIDATION',
        detail: 'Unable to validate request parameter(s)',
        meta: {
          errors: [
            { input: null, loc: ['header', 'x-subscription-token'], msg: 'Field required', type: 'missing' },
          ],
        },
        status: 422,
      },
      type: 'ErrorResponse',
    })
    const res = new BraveSearchEngine().parseMany([{ key: 'brave', body, status: 422, headers: {} }], 10)
    expect(res.items).toEqual([])
    expect(res.warnings?.[0]).toContain('authentication failed')
    // The actionable half of the error body survives into the warning.
    expect(res.warnings?.[0]).toContain('header.x-subscription-token: Field required')

    // A BOGUS key is also a 422, with a different message (captured live):
    // { "error": { "detail": "The provided API key is invalid.", "status": 422 } }
    const bogus = JSON.stringify({
      error: { code: 'VALIDATION', detail: 'The provided API key is invalid.', status: 422 },
      type: 'ErrorResponse',
    })
    const bad = new BraveSearchEngine().parseMany([{ key: 'brave', body: bogus, status: 422, headers: {} }], 10)
    expect(bad.warnings?.[0]).toContain('authentication failed')
    expect(bad.warnings?.[0]).toContain('The provided API key is invalid.')
  })

  it('parseMany: a 422 about the query keeps the query advice', () => {
    const body = JSON.stringify({ error: { detail: 'Invalid value for parameter q', status: 422 } })
    const res = new BraveSearchEngine().parseMany([{ key: 'brave', body, status: 422, headers: {} }], 10)
    expect(res.warnings?.[0]).toContain('query rejected (422 ')
    expect(res.warnings?.[0]).toContain('Invalid value for parameter q')
  })

  it('parseMany: transport failure lands in warnings', () => {
    const res = new BraveSearchEngine().parseMany(
      [{ key: 'brave', body: '', status: 0, error: 'getaddrinfo ENOTFOUND api.search.brave.com' }],
      10,
    )
    expect(res.warnings?.[0]).toContain('ENOTFOUND')
  })

  it('parse: single-body compatibility path', () => {
    const body = JSON.stringify({ web: { results: [{ url: 'https://a.example/1', title: 'T', description: 'S' }] } })
    const items = new BraveSearchEngine().parse(body, 10)
    expect(items.length).toBe(1)
    expect(items[0]?.snippet).toBe('S')
  })
})

// ─────────────────────────── mojeek (Search API) engine ───────────────────────────
// Mojeek's official billed Search API. Distinct from `mojeek-free` — same host,
// different credential (api_key rides in the URL, not a header / cookie), JSON
// response (`fmt=json` is hard-coded into buildMojeekApiUrl).
describe('MojeekSearchEngine', () => {
  const savedOptions = process.env.DSH_NETWORK_ENGINE_OPTIONS
  const savedKey = process.env[MOJEEK_API_KEY_ENV]
  beforeAll(() => {
    delete process.env.DSH_NETWORK_ENGINE_OPTIONS
    delete process.env[MOJEEK_API_KEY_ENV]
  })
  afterAll(() => {
    if (savedOptions === undefined) delete process.env.DSH_NETWORK_ENGINE_OPTIONS
    else process.env.DSH_NETWORK_ENGINE_OPTIONS = savedOptions
    if (savedKey === undefined) delete process.env[MOJEEK_API_KEY_ENV]
    else process.env[MOJEEK_API_KEY_ENV] = savedKey
  })

  it('declares the url-keyed credential and never sets a header name', () => {
    // The auth block tells the CLI to put the secret in the URL via
    // ?api_key=… (`in === 'query'`), the opposite of Brave's header mode.
    // A mis-spelled `in` would either strip the key (every call rejected) or
    // silently smuggle it into a header Mojeek ignores (every call metered,
    // key in the host's logs); both are silent defects this guard catches.
    const engine = new MojeekSearchEngine()
    expect(engine.id).toBe(MOJEEK_ENGINE_ID)
    expect(engine.displayName).toBe('Mojeek (API)')
    expect(engine.endpoint).toBe('https://www.mojeek.com/search')
    expect(engine.auth?.in).toBe('query')
    expect(engine.auth?.queryName).toBe('api_key')
    expect(engine.auth?.apiKeyEnv).toBe(MOJEEK_API_KEY_ENV)
    // Header-mode engines carry `auth.header`; a query-mode engine doesn't
    // need one and the CLI never reads it, so omitting it is the contract.
    expect(engine.auth?.header).toBeUndefined()
  })

  it('pins api_key= and fmt=json on every request, with t capped to 100', () => {
    expect(buildMojeekApiUrl('rust vs go', { perPage: 10 }, 'secret-key')).toBe(
      'https://www.mojeek.com/search?q=rust%20vs%20go&fmt=json&api_key=secret-key&t=10',
    )
    // The standalone-CLI `max` spelling maps to `t` too.
    expect(buildMojeekApiUrl('q', { max: 25 }, 'k')).toContain('t=25')
    // The per-page cap is 100, mirroring Mojeek's documented envelope.
    expect(buildMojeekApiUrl('q', { max: 999 }, 'k')).toContain('t=100')
    expect(buildMojeekApiUrl('q', { max: 0 }, 'k')).toContain('t=1')
    // The `perPage` argument wins over `max`, the same precedence Brave uses.
    expect(buildMojeekApiUrl('q', { perPage: 3, max: 10 }, 'k')).toContain('t=3')
    // A zero/negative page offset is dropped rather than rewritten — typos
    // don't burn billed calls.
    expect(buildMojeekApiUrl('q', { s: 0 }, 'k')).not.toContain('s=')
    expect(buildMojeekApiUrl('q', { s: -1 }, 'k')).not.toContain('s=')
    expect(buildMojeekApiUrl('q', { s: 11 }, 'k')).toContain('s=11')
  })

  it('passes through only the documented option vocabulary', () => {
    // Valid enum + numeric options survive; unknown keys, malformed values
    // and out-of-range boosts are dropped so a typo can't reach Mojeek.
    const url = buildMojeekApiUrl(
      'vue 3',
      {
        perPage: 5,
        since: '20260201',
        before: 'year',
        rb: 'gb',
        rbb: 10,
        lb: 'en',
        lbb: 100,
        lr: 'en,fr',
        safe: 1,
        date: 1,
        cdate: 0,
        size: 1,
        site: 'mojeek.com',
        fi: '.example.com,foo.com',
        fe: 'spam.com',
        tlen: 80,
        dlen: 200,
        datewr: 100,
        qm: 'spam ads',
      },
      'k',
    )
    expect(url).toBe(
      'https://www.mojeek.com/search?q=vue%203&fmt=json&api_key=k&t=5' +
        '&since=20260201&before=year&rb=GB&rbb=10&lb=EN&lbb=100' +
        '&lr=EN%2CFR&safe=1&date=1&cdate=0&size=1&datewr=100&tlen=80&dlen=200' +
        '&fi=.example.com%2Cfoo.com&fe=spam.com&site=mojeek.com&qm=spam%20ads',
    )
    // `s=0` is dropped (the documented start range is 1..1000); the rest of
    // the keys follow the order in `EXTRA_KEYS` so a future engine author
    // can reason about it without an alphabetization surprise.
    const dropped = buildMojeekApiUrl('q', {
      since: '2026-02-01', // wrong shape → dropped
      rb: 'England', // not 2 letters → dropped
      rbb: 200, // out of range → dropped
      lb: '', // empty → dropped
      lbb: 'lots', // not an integer → dropped
      lr: 'foo,bar', // bad ISO codes → dropped
      safe: 2, // not 0|1 → dropped
      date: 'yes', // not an integer → dropped
      // A typed-string of `'1'` reads back as `1` (an integer, in {0,1}) and
      // passes the option gate — every other engine is the same and the
      // settings dialog is the defense, not the URL builder. Use a string
      // that does NOT coerce to a valid integer to prove the gate works:
      cdate: 'maybe', // not an integer → dropped
      size: 1.5, // not an integer → dropped
      tlen: 200, // out of 0..127 → dropped
      dlen: 700, // out of 0..511 → dropped
      datewr: 50, // not 0|100 → dropped
      qm: '', // empty → dropped
      junk: 'x', // unknown key → dropped
    }, 'k')
    expect(dropped).toBe('https://www.mojeek.com/search?q=q&fmt=json&api_key=k&t=10')
  })

  it('omits api_key entirely when no key is provided (callers compose what they have)', () => {
    // The key is optional at the buildUrl level: a shell that forgot to pass
    // one still gets a URL — the request just won't authenticate. The CLI's
    // short-circuit (synthesized 401 for a missing key) sits upstream of this.
    expect(buildMojeekApiUrl('q', { max: 10 }, '')).not.toContain('api_key=')
    expect(buildMojeekApiUrl('q', { max: 10 })).not.toContain('api_key=')
  })

  it('reads per-engine options out of DSH_NETWORK_ENGINE_OPTIONS', () => {
    process.env.DSH_NETWORK_ENGINE_OPTIONS = JSON.stringify({
      mojeek: { date: 1, since: '20260101' },
      other: { x: 'y' },
    })
    try {
      const [req] = new MojeekSearchEngine().buildRequests('q', { perPage: 3, apiKey: 'k' })
      expect(req?.key).toBe(MOJEEK_ENGINE_ID)
      expect(req?.url).toContain('date=1')
      expect(req?.url).toContain('since=20260101')
      // A different engine's options must not leak into this one.
      expect(req?.url).not.toContain('x=y')
    } finally {
      delete process.env.DSH_NETWORK_ENGINE_OPTIONS
    }
  })

  it('parseMojeekApiResults: maps url/title/desc and clamps to max', () => {
    const body = JSON.stringify({
      response: {
        status: 'OK',
        head: { results: 2, exact: true },
        results: [
          {
            url: 'https://a.example/1',
            title: 'Rust vs Go',
            desc: 'Benchmarks.',
          },
          { url: 'https://b.example/2', title: 'Go is fine', desc: 'Performance notes.' },
          { url: 'https://c.example/3', title: 'Dropped' }, // over max
        ],
      },
    })
    const items = parseMojeekApiResults(body, 2)
    expect(items.length).toBe(2)
    expect(items[0]?.title).toBe('Rust vs Go')
    expect(items[0]?.snippet).toBe('Benchmarks.')
  })

  it('parseMojeekApiResults: titles fall back to the URL, malformed URLs are dropped', () => {
    const items = parseMojeekApiResults(
      JSON.stringify({
        response: {
          status: 'OK',
          results: [
            { url: 'https://a.example/1', title: '' },
            { url: '/relative', title: 'Bad URL' },
            { url: '', title: 'Missing URL' },
          ],
        },
      }),
      10,
    )
    expect(items.length).toBe(1)
    expect(items[0]?.title).toBe('https://a.example/1')
  })

  it('parseMojeekApiResults: published_at comes from the formatted `date` field', () => {
    const items = parseMojeekApiResults(
      JSON.stringify({
        response: {
          status: 'OK',
          results: [
            { url: 'https://a.example/1', title: 'T', date: 'Tue Jul 10 05:19:00 2007' },
            { url: 'https://b.example/2', title: 'No date' },
            { url: 'https://c.example/3', title: 'Bad shape', date: '2026-01-01T00:00:00' },
          ],
        },
      }),
      10,
    )
    expect(items[0]?.published_at).toBe('Tue Jul 10 05:19:00 2007')
    expect(items[1]?.published_at).toBeUndefined()
    // A field that doesn't look like Mojeek's formatted date is silently
    // dropped — wrong dates in the evidence are worse than no dates.
    expect(items[2]?.published_at).toBeUndefined()
  })

  it('parseMojeekApiResults: empty / non-JSON / shape-less bodies return []', () => {
    expect(parseMojeekApiResults('', 10)).toEqual([])
    expect(parseMojeekApiResults('not json', 10)).toEqual([])
    expect(parseMojeekApiResults(JSON.stringify({ results: [] }), 10)).toEqual([])
    // A `response: { status: 'OK' }` body with no `results` array returns [].
    expect(parseMojeekApiResults(JSON.stringify({ response: { status: 'OK' } }), 10)).toEqual([])
  })

  it('parseMany: a 200 OK body with `response.status` not "OK" surfaces the error', () => {
    // Mojeek answers 200 + `response.status === "ERROR: Daily Limit Reached"`
    // when the day's quota runs out. The parser would otherwise read this
    // as a successful zero-hit answer.
    const body = JSON.stringify({
      response: { status: 'ERROR: Daily Limit Reached' },
    })
    const res = new MojeekSearchEngine().parseMany([{ key: MOJEEK_ENGINE_ID, body, status: 200, headers: {} }], 10)
    expect(res.items).toEqual([])
    expect(res.warnings?.[0]).toContain('Daily Limit Reached')
  })

  it('parseMany: 401 / 403 are auth failures; 429 is rate limit; 4xx otherwise', () => {
    const engine = new MojeekSearchEngine()
    const auth = engine.parseMany([{ key: MOJEEK_ENGINE_ID, body: '', status: 401, headers: {} }], 10)
    expect(auth.warnings?.[0]).toContain('authentication failed')
    expect(auth.warnings?.[0]).toContain(MOJEEK_API_KEY_ENV)

    const rejected = engine.parseMany([{ key: MOJEEK_ENGINE_ID, body: '', status: 403, headers: {} }], 10)
    expect(rejected.warnings?.[0]).toContain('authentication failed')

    const limited = engine.parseMany([{ key: MOJEEK_ENGINE_ID, body: '', status: 429, headers: {} }], 10)
    expect(limited.warnings?.[0]).toContain('rate limited')

    const other = engine.parseMany([{ key: MOJEEK_ENGINE_ID, body: '', status: 418, headers: {} }], 10)
    expect(other.warnings?.[0]).toContain('unexpected HTTP 418')
  })

  it('parseMany: synthetic 401 (no key) names the fix and names the env var', () => {
    // Same shape Brave tests; the only thing that differs is the env var
    // name the warning points the user at. Verify it by name so a future
    // rename of DSH_NETWORK_MOJEEK_API_KEY is caught here.
    const res = new MojeekSearchEngine().parseMany([{ key: MOJEEK_ENGINE_ID, body: '', status: 401, headers: {} }], 10)
    expect(res.warnings?.[0]).toContain(MOJEEK_API_KEY_ENV)
  })

  it('parseMany: a non-JSON body is reported, not parsed as zero hits', () => {
    const res = new MojeekSearchEngine().parseMany(
      [{ key: MOJEEK_ENGINE_ID, body: '<html>unexpected</html>', status: 200, headers: {} }],
      10,
    )
    expect(res.warnings?.[0]).toContain('not JSON')
  })

  it('parseMany: transport failure lands in warnings, not in items', () => {
    const res = new MojeekSearchEngine().parseMany(
      [{ key: MOJEEK_ENGINE_ID, body: '', status: 0, error: 'getaddrinfo ENOTFOUND www.mojeek.com' }],
      10,
    )
    expect(res.items).toEqual([])
    expect(res.warnings?.[0]).toContain('ENOTFOUND')
  })

  it('parseMany: a 200 with `response.status === "ERROR"` still parses results when present', () => {
    // Defect class: the daily-limit message and a non-empty result list
    // shouldn't co-exist, but if Mojeek ever answers both ways (e.g. a
    // soft quota warning) the parser should surface the warning AND pass
    // the rows through.
    const body = JSON.stringify({
      response: {
        status: 'ERROR: Soft warning',
        results: [{ url: 'https://a.example/1', title: 'T' }],
      },
    })
    const res = new MojeekSearchEngine().parseMany([{ key: MOJEEK_ENGINE_ID, body, status: 200, headers: {} }], 10)
    expect(res.items.length).toBe(1)
    expect(res.warnings?.[0]).toContain('Soft warning')
  })

  it('parse: single-body compatibility path mirrors parseMany', () => {
    const body = JSON.stringify({
      response: { status: 'OK', results: [{ url: 'https://a.example/1', title: 'T', desc: 'S' }] },
    })
    const items = new MojeekSearchEngine().parse(body, 10)
    expect(items.length).toBe(1)
    expect(items[0]?.snippet).toBe('S')
  })
})

describe('TavilySearchEngine', () => {
  const savedOptions = process.env.DSH_NETWORK_ENGINE_OPTIONS
  const savedKey = process.env[TAVILY_API_KEY_ENV]
  beforeAll(() => {
    delete process.env.DSH_NETWORK_ENGINE_OPTIONS
    delete process.env[TAVILY_API_KEY_ENV]
  })
  afterAll(() => {
    if (savedOptions === undefined) delete process.env.DSH_NETWORK_ENGINE_OPTIONS
    else process.env.DSH_NETWORK_ENGINE_OPTIONS = savedOptions
    if (savedKey === undefined) delete process.env[TAVILY_API_KEY_ENV]
    else process.env[TAVILY_API_KEY_ENV] = savedKey
  })

  it('declares the bearer credential and the documented keyless fallback header', () => {
    // The two halves of Tavily's unique auth story: `auth.optional: true`
    // bypasses the synthetic-401 gate (verified below), and `fallbackHeader`
    // is what `authFor` sends when no key is configured. Wrong spelling on
    // either would silently rate-limit the user without explanation.
    const engine = new TavilySearchEngine()
    expect(engine.id).toBe(TAVILY_ENGINE_ID)
    expect(engine.displayName).toBe('Tavily Search')
    expect(engine.endpoint).toBe('https://api.tavily.com/search')
    expect(engine.auth?.header).toBe(TAVILY_AUTH_HEADER)
    expect(engine.auth?.scheme).toBe('bearer')
    expect(engine.auth?.apiKeyEnv).toBe(TAVILY_API_KEY_ENV)
    expect(engine.auth?.optional).toBe(true)
    expect(engine.auth?.fallbackHeader).toEqual({
      name: TAVILY_KEYLESS_HEADER,
      value: 'keyless',
    })
  })

  it('buildRequests pins POST + JSON body + content-type, max_results clamped 1..20', () => {
    const req = buildTavilyRequest('rust vs go', {})
    expect(req?.method).toBe('POST')
    expect(req?.url).toBe('https://api.tavily.com/search')
    expect(req?.contentType).toBe('application/json')
    const body = JSON.parse(String(req?.body))
    expect(body.query).toBe('rust vs go')
    // Default 10 when neither perPage nor max is supplied.
    expect(body.max_results).toBe(10)
    // The call's result cap (perPage) wins over the single-shot fallback.
    const upper = buildTavilyRequest('q', { perPage: 25 })
    expect(upper?.body && JSON.parse(upper.body).max_results).toBe(20)
    const lower = buildTavilyRequest('q', { perPage: 0 })
    expect(lower?.body && JSON.parse(lower.body).max_results).toBe(1)
    // Standalone-CLI `max` spelling maps to the same field.
    const standalone = buildTavilyRequest('q', { max: 8 })
    expect(standalone?.body && JSON.parse(standalone.body).max_results).toBe(8)
  })

  it('passes through only the documented option vocabulary', () => {
    // Valid enum / numeric options survive; unknown keys and out-of-range
    // values are dropped so a typo cannot burn a credit on a 422.
    const req = buildTavilyRequest('vue 3', {
      searchDepth: 'advanced',
      topic: 'news',
      timeRange: 'pw', // not in vocabulary → dropped
      includeAnswer: 'basic',
      includeRawContent: 'text', // not in vocabulary → dropped
      excludeDomains: 'spam.com,ads.com',
      includeFavicon: true,
      exactMatch: true,
      safeSearch: false,
      includeImages: true,
      includeImageDescriptions: true,
      chunksPerSource: 4, // out of range → dropped
      country: 'Germany',
      language: 'en',
      includeDomains: 'docs.example.com',
      includeDomainsMode: 'prefer',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      bogus: 'unknown key',
    })
    const body = JSON.parse(String(req?.body))
    // `timeRange: 'pw'` and `chunksPerSource: 4` and `includeRawContent: 'text'` are out of vocab.
    expect(body.search_depth).toBe('advanced')
    expect(body.topic).toBe('news')
    expect(body.time_range).toBeUndefined()
    expect(body.include_answer).toBe('basic')
    expect(body.include_raw_content).toBeUndefined()
    expect(body.exclude_domains).toEqual(['spam.com', 'ads.com'])
    expect(body.include_domains).toEqual(['docs.example.com'])
    expect(body.include_domains_mode).toBe('prefer')
    expect(body.include_favicon).toBe(true)
    expect(body.exact_match).toBe(true)
    expect(body.safe_search).toBe(false)
    expect(body.include_images).toBe(true)
    expect(body.include_image_descriptions).toBe(true)
    expect(body.chunks_per_source).toBeUndefined()
    expect(body.country).toBe('germany')
    expect(body.language).toBe('en')
    expect(body).not.toHaveProperty('bogus')
    expect(body).not.toHaveProperty('start_date')
  })

  it('include_domains_mode is only emitted alongside an include_domains list', () => {
    // Tavily answers 400 for `include_domains_mode` on its own, and a
    // 400 on a billed engine is exactly what the option gate exists to
    // prevent. The mode is therefore subordinate to the list.
    const modeAlone = JSON.parse(String(buildTavilyRequest('q', { includeDomainsMode: 'prefer' })?.body))
    expect(modeAlone).not.toHaveProperty('include_domains_mode')
    expect(modeAlone).not.toHaveProperty('include_domains')
    // An invalid list (empty after trim) must not resurrect the mode.
    const emptyList = JSON.parse(String(buildTavilyRequest('q', { includeDomains: ' , ', includeDomainsMode: 'prefer' })?.body))
    expect(emptyList).not.toHaveProperty('include_domains')
    expect(emptyList).not.toHaveProperty('include_domains_mode')
  })

  it('include_image_descriptions is gated on include_images', () => {
    // Upstream renders descriptions INSIDE each image entry, so the flag
    // alone does nothing. Dropping it keeps the recorded request honest
    // about what the billed call actually used.
    const withoutImages = JSON.parse(String(buildTavilyRequest('q', { includeImageDescriptions: true })?.body))
    expect(withoutImages).not.toHaveProperty('include_image_descriptions')
    const withImages = JSON.parse(String(buildTavilyRequest('q', { includeImages: true, includeImageDescriptions: true })?.body))
    expect(withImages.include_image_descriptions).toBe(true)
    // An explicit `includeImages=false` is still an explicit value, and the
    // gate reads `=== true`, so the description is dropped with it.
    const imagesOff = JSON.parse(String(buildTavilyRequest('q', { includeImages: false, includeImageDescriptions: true })?.body))
    expect(imagesOff.include_images).toBe(false)
    expect(imagesOff).not.toHaveProperty('include_image_descriptions')
  })

  it('country is locked to the OpenAPI enum; language has a permissive shape check', () => {
    const bad = buildTavilyRequest('q', { country: 'Middle-earth' })
    expect(JSON.parse(String(bad?.body))).not.toHaveProperty('country')
    const good = buildTavilyRequest('q', { country: 'united states' })
    expect(JSON.parse(String(good?.body)).country).toBe('united states')
    // Language must be a short token; a stray newline wouldn't work.
    const broken = buildTavilyRequest('q', { language: 'en\nUS' })
    expect(JSON.parse(String(broken?.body))).not.toHaveProperty('language')
  })

  it('parseTavilyResults: happy path with published_date round-trips', () => {
    const body = JSON.stringify({
      query: 'rust vs go',
      results: [
        {
          url: 'https://a.example/1',
          title: 'Rust vs Go benchmarks',
          content: 'A comparison of Rust and Go performance.',
          score: 0.81,
          published_date: 'Tue, 11 Mar 2025 17:00:00 GMT',
        },
        {
          url: 'https://b.example/2',
          title: 'Go is fine',
          content: 'Notes.',
        },
      ],
      response_time: 1.67,
    })
    const items = parseTavilyResults(body, 10)
    expect(items.length).toBe(2)
    expect(items[0]?.published_at).toBe('Tue, 11 Mar 2025 17:00:00 GMT')
    expect(items[0]?.snippet).toContain('Rust and Go performance')
    expect(items[1]?.published_at).toBeUndefined()
  })

  it('parseTavilyResults: bad URLs / relative URLs / missing titles degrade silently', () => {
    const body = JSON.stringify({
      results: [
        { url: '/relative', title: 'Bad URL' },
        { url: '', title: 'Missing URL' },
        { url: 'https://a.example/1', title: '' },
        { url: 'https://a.example/1', title: 'Duplicate' },
      ],
    })
    const items = parseTavilyResults(body, 10)
    expect(items.length).toBe(1) // only the absolute-URL + dedup'd entry
    expect(items[0]?.url).toBe('https://a.example/1')
    expect(items[0]?.title).toBe('https://a.example/1')
  })

  it('parseTavilyResults: empty / non-JSON / shape-less bodies return []', () => {
    expect(parseTavilyResults('', 10)).toEqual([])
    expect(parseTavilyResults('not json', 10)).toEqual([])
    expect(parseTavilyResults(JSON.stringify({ results: [] }), 10)).toEqual([])
    // A `{}` body with no `results` array returns [].
    expect(parseTavilyResults(JSON.stringify({ query: 'x' }), 10)).toEqual([])
  })

  it('parseMany: a 401 / 403 surfaces the credential fix and names the env var', () => {
    const engine = new TavilySearchEngine()
    const auth = engine.parseMany([{ key: TAVILY_ENGINE_ID, body: '{"detail":{"error":"missing api key"}}', status: 401, headers: {} }], 10)
    expect(auth.warnings?.[0]).toContain('authentication failed')
    expect(auth.warnings?.[0]).toContain(TAVILY_API_KEY_ENV)
    expect(auth.warnings?.[0]).toContain('keyless mode')
    const forbidden = engine.parseMany([{ key: TAVILY_ENGINE_ID, body: '', status: 403, headers: {} }], 10)
    expect(forbidden.warnings?.[0]).toContain('authentication failed')
  })

  it('parseMany: 422 distinguishes auth-shaped rejection from query rejection', () => {
    // Tavily answers 422 for both auth-shape problems and query-validation
    // problems; the body sniff is what separates them so the wrong
    // suggestion is never printed.
    const engine = new TavilySearchEngine()
    const authBody = JSON.stringify({ detail: [{ loc: ['body', 'api_key'], msg: 'missing api key' }] })
    const authSniff = engine.parseMany([{ key: TAVILY_ENGINE_ID, body: authBody, status: 422, headers: {} }], 10)
    expect(authSniff.warnings?.[0]).toContain('authentication')
    const query = engine.parseMany([{ key: TAVILY_ENGINE_ID, body: '{"detail":[{"msg":"invalid search_depth"}]}', status: 422, headers: {} }], 10)
    expect(query.warnings?.[0]).toContain('query rejected')
    expect(query.warnings?.[0]).not.toContain('network → 搜索引擎')
  })

  it('parseMany: 429 / 432 / 433 each land in their own bucket', () => {
    const engine = new TavilySearchEngine()
    const limited = engine.parseMany([{ key: TAVILY_ENGINE_ID, body: '', status: 429, headers: {} }], 10)
    expect(limited.warnings?.[0]).toContain('rate limited')
    expect(limited.warnings?.[0]).toContain('keyless')
    const plan = engine.parseMany([{ key: TAVILY_ENGINE_ID, body: '', status: 432, headers: {} }], 10)
    expect(plan.warnings?.[0]).toContain('plan / key limit')
    const paygo = engine.parseMany([{ key: TAVILY_ENGINE_ID, body: '', status: 433, headers: {} }], 10)
    expect(paygo.warnings?.[0]).toContain('pay-as-you-go limit')
  })

  it('parseMany: a non-JSON 200 body is reported, not parsed as zero hits', () => {
    // Two-body race: 200 with a wrong-shape body still classifies as an
    // unexpected response, never a silent zero. The chain falls through,
    // and the user gets the actionable warning rather than a confusing
    // "no results" line.
    const engine = new TavilySearchEngine()
    const res = engine.parseMany(
      [{ key: TAVILY_ENGINE_ID, body: '<html>unexpected</html>', status: 200, headers: {} }],
      10,
    )
    expect(res.items).toEqual([])
    expect(res.warnings?.[0]).toContain('not JSON')
  })

  it('parseMany: a slow response_time surfaces an uncertainty hint', () => {
    const body = JSON.stringify({
      query: 'q',
      results: [{ url: 'https://a.example/1', title: 'T' }],
      response_time: 31.4,
    })
    const res = new TavilySearchEngine().parseMany(
      [{ key: TAVILY_ENGINE_ID, body, status: 200, headers: {} }],
      10,
    )
    expect(res.uncertainty?.[0]).toContain('31.4s')
  })

  it('parseMany: transport failure lands in warnings, items stay empty', () => {
    const res = new TavilySearchEngine().parseMany(
      [{ key: TAVILY_ENGINE_ID, body: '', status: 0, error: 'getaddrinfo ENOTFOUND api.tavily.com' }],
      10,
    )
    expect(res.items).toEqual([])
    expect(res.warnings?.[0]).toContain('ENOTFOUND')
  })

  it('parse: single-body compatibility path mirrors parseMany', () => {
    const body = JSON.stringify({
      results: [{ url: 'https://a.example/1', title: 'T', content: 'S' }],
    })
    const items = new TavilySearchEngine().parse(body, 10)
    expect(items.length).toBe(1)
    expect(items[0]?.snippet).toBe('S')
  })

  it('buildRequests returns [] on an empty query (no POST issued)', () => {
    // The auth-blocked gate in cli.ts would catch this downstream, but the
    // engine itself is supposed to short-circuit before the wire.
    expect(buildTavilyRequest('')).toBeNull()
    expect(buildTavilyRequest('   ')).toBeNull()
  })
})

// ─────────────────────────── html.ts ──────────────────────────
describe('htmlToMarkdown', () => {
  it('htmlToMarkdown: basic document', () => {
    const md = htmlToMarkdown(
      '<html><head><title>t</title></head><body><h1>Hi</h1><p>Hello <strong>world</strong> <a href="https://x.example/a">link</a></p><ul><li>one</li><li>two</li></ul><pre><code>const a = 1</code></pre></body></html>',
    )
    expect(md).toContain('# Hi')
    expect(md).toContain('Hello **world** [link](https://x.example/a)')
    expect(md).toContain('- one')
    expect(md).toContain('```')
    expect(md).toContain('const a = 1')
  })
  it('htmlToMarkdown: strips script/style/nav', () => {
    const md = htmlToMarkdown('<nav>Menu</nav><script>alert(1)</script><style>.x{}</style><p>Keep</p>')
    expect(md).not.toContain('alert')
    expect(md).not.toContain('Menu')
    expect(md).toContain('Keep')
  })
  it('htmlToMarkdown: decodes entities in prose, links, headings and table cells', () => {
    const md = htmlToMarkdown(
      '<h2>R&amp;D &mdash; Index</h2>' +
        '<p>1&nbsp;000&nbsp;records &#8212; see <a href="https://x.example/q?a=1&amp;b=2">Q&amp;A</a></p>' +
        '<table><tr><td>a&nbsp;b</td><td>&lt;tag&gt;</td></tr></table>',
    )
    expect(md).toContain('## R&D — Index')
    expect(md).toContain('1 000 records — see')
    expect(md).toContain('[Q&A](https://x.example/q?a=1&b=2)')
    expect(md).toContain('| a b | <tag> |')
  })
  it('htmlToMarkdown: a decoded entity cannot re-enter as markup', () => {
    // The page ESCAPED the literal text "&lt;script&gt;": the marker must
    // survive as visible text, never be re-decoded into a tag.
    const md = htmlToMarkdown('<p>&amp;lt;script&amp;gt; is escaped</p>')
    expect(md).toBe('&lt;script&gt; is escaped')
  })
  it('htmlToMarkdown: decodes entities inside code fences (pages escape them there)', () => {
    const md = htmlToMarkdown('<pre>&lt;div class=&quot;x&quot;&gt;&amp;nbsp;&lt;/div&gt;</pre>')
    expect(md).toContain('<div class="x">')
    // `&amp;nbsp;` renders as the five visible characters "&nbsp;".
    expect(md).toContain('&nbsp;</div>')
  })
})

// ─────────────────────────── config.ts ──────────────────────────
describe('config normalization', () => {
  it('applySchema defaults', () => {
    const cfg = normalizeConfig({})
    expect(cfg.enabled).toBe(true)
    expect(cfg.ssrfProtection).toBe(true)
    expect(cfg.redirectProtection).toBe(true)
    expect(cfg.protocolLock).toBe(true)
    expect(cfg.httpTimeoutMs).toBe(25_000)
    expect(cfg.maxRedirects).toBe(3)
    expect(cfg.searchEngines).toEqual(['bing', 'duckduckgo', 'baidu'])
    expect(cfg.httpMethods).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
  })
  it('protection toggles: explicit values override the ON defaults', () => {
    const off = normalizeConfig({ ssrfProtection: false, redirectProtection: false, protocolLock: false })
    expect(off.ssrfProtection).toBe(false)
    expect(off.redirectProtection).toBe(false)
    expect(off.protocolLock).toBe(false)
    const mixed = normalizeConfig({ ssrfProtection: true, protocolLock: false })
    expect(mixed.ssrfProtection).toBe(true)
    expect(mixed.redirectProtection).toBe(true)
    expect(mixed.protocolLock).toBe(false)
  })
  it('lowercase methods normalize to uppercase', () => {
    const cfg = normalizeConfig({ httpMethods: ['get', 'post', 'delete'] })
    expect(cfg.httpMethods).toEqual(['GET', 'POST', 'DELETE'])
  })
  it('rejects invalid methods, engines, and zero timeouts', () => {
    expect(() => normalizeConfig({ httpMethods: ['G ET'] })).toThrow(/invalid HTTP method/)
    expect(() => normalizeConfig({ httpMethods: ['TRACE;'] })).toThrow(/invalid HTTP method/)
    expect(() => normalizeConfig({ searchEngines: ['yahoo'] })).toThrow(/unknown search engine/)
    expect(() => normalizeConfig({ fetchTimeoutMs: 0 })).toThrow(/positive integer/)
    expect(normalizeConfig({ searchEngines: ['searxng'] }).searchEngines).toEqual(['searxng'])
  })
  it('github settings: defaults and validation', () => {
    const cfg = normalizeConfig({})
    expect(cfg.githubToken).toBe('')
    expect(cfg.githubIndexes).toEqual([])
    expect(cfg.githubSort).toBe('best')
    expect(normalizeConfig({ githubIndexes: ['code', 'users'], githubSort: 'stars' }).githubIndexes).toEqual(['code', 'users'])
    expect(normalizeConfig({ githubIndexes: ['code'], githubSort: 'stars' }).githubSort).toBe('stars')
    expect(() => normalizeConfig({ githubIndexes: ['forks'] })).toThrow(/unknown github index/)
    expect(() => normalizeConfig({ githubSort: 'forks' })).toThrow()
  })
})

// ─────────────────────────── document.ts ──────────────────────────
describe('document.ts', () => {
  it('inferFileType: PDF', () => {
    expect(inferFileType('application/pdf')).toBe('pdf')
    expect(inferFileType('application/pdf; charset=binary')).toBe('pdf')
  })

  it('inferFileType: OOXML family', () => {
    expect(inferFileType('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('docx')
    expect(inferFileType('application/vnd.openxmlformats-officedocument.presentationml.presentation')).toBe('pptx')
    expect(inferFileType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('xlsx')
    // Charset suffix must not break the lookup.
    expect(inferFileType('application/vnd.openxmlformats-officedocument.wordprocessingml.document; charset=binary')).toBe('docx')
  })

  it('inferFileType: ODF family', () => {
    expect(inferFileType('application/vnd.oasis.opendocument.text')).toBe('odt')
    expect(inferFileType('application/vnd.oasis.opendocument.presentation')).toBe('odp')
    expect(inferFileType('application/vnd.oasis.opendocument.spreadsheet')).toBe('ods')
  })

  it('inferFileType: EPUB', () => {
    expect(inferFileType('application/epub+zip')).toBe('epub')
  })

  it('inferFileType: non-document types return null', () => {
    expect(inferFileType('text/html')).toBeNull()
    expect(inferFileType('text/html; charset=utf-8')).toBeNull()
    expect(inferFileType('application/json')).toBeNull()
    expect(inferFileType('text/plain')).toBeNull()
    expect(inferFileType('application/octet-stream')).toBeNull()
    expect(inferFileType('image/png')).toBeNull()
    // Defensive: empty / malformed inputs collapse to null instead of throwing.
    expect(inferFileType('')).toBeNull()
    expect(inferFileType('   ')).toBeNull()
  })

  it('parseDocument: refuses non-document content-type with a clear error', async () => {
    await expect(parseDocument(new Uint8Array(), 'text/html')).rejects.toThrow(/unsupported content-type/)
    await expect(parseDocument(new Uint8Array(), 'application/json')).rejects.toThrow(/unsupported content-type/)
    await expect(parseDocument(new Uint8Array(), '')).rejects.toThrow(/unsupported content-type/)
  })

  it('parseDocument: PDF content-type reaches officeparser (parse fails on garbage bytes, not on the dispatch)', async () => {
    // We can't ship a real PDF fixture inside an offline unit suite; just
    // prove the dispatch is wired by feeding 8 random bytes and expecting
    // officeparser's own corrupt-input error (not our dispatch gate).
    await expect(parseDocument(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 'application/pdf')).rejects.toThrow()
  })

  it('parseDocument: real in-memory DOCX → Markdown with content', async () => {
    // End-to-end smoke for the officeparser dispatch: build a minimal
    // valid DOCX with `fflate` (a transitive dep officeparser already
    // pulls in), run it through parseDocument, and assert the Markdown
    // body contains the text we wrote.
    const { zipSync, strToU8 } = await import('fflate')
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
    const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
    const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Hello dsh-network from DOCX</w:t></w:r></w:p>
    <w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p>
  </w:body>
</w:document>`
    const zip = zipSync({
      '[Content_Types].xml': strToU8(contentTypes),
      '_rels/.rels': strToU8(rels),
      'word/document.xml': strToU8(document),
    })
    const result = await parseDocument(
      new Uint8Array(zip),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    expect(result.content).toContain('Hello dsh-network from DOCX')
    expect(result.content).toContain('Second paragraph')
    expect(result.warnings).toEqual([])
  })
})

// ─────────────────────────── module imports ──────────────────────────
// The two `import … from` lines at the top of this file are compile-time
// checks that the modules exported from `src/` resolve and stay
// dependency-clean. If the runtime ever pulls in a heavy package here, this
// file would suddenly become expensive to load — failing the discipline.
describe('import hygiene', () => {
  it('parses http_request.ts', () => {
    expect(buildRequestUrl('https://x.example', { a: 1 })).toBe('https://x.example?a=1')
    expect(buildRequestUrl('https://x.example/path', { a: 1 })).toBe('https://x.example/path?a=1')
  })
  it('parses tools.ts (compile-time)', () => {
    expect(typeof normalizeConfig).toBe('function')
    expect(typeof buildRequestUrl).toBe('function')
  })
})

// ───────────────────────────── web_sitemap ───────────────────────────
// Pure module: no I/O, no clock. The table itself is frozen so the
// suite catches mutations during runs.
describe('web_sitemap table', () => {
  it('is frozen at the array level', () => {
    expect(Object.isFrozen(WEB_SITEMAP)).toBe(true)
  })
  it('has entries with the documented fields', () => {
    expect(WEB_SITEMAP.length).toBeGreaterThan(20)
    for (const e of WEB_SITEMAP) {
      expect(e.domain).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/)
      expect(e.priority).toBeGreaterThanOrEqual(1)
      expect(e.priority).toBeLessThanOrEqual(10)
      expect(categoriesInUse()).toContain(e.category)
      expect(typeof e.description).toBe('string')
      expect(e.description.length).toBeGreaterThan(0)
      if (e.searchUrl) expect(e.searchUrl).toContain('{query}')
    }
  })
  it('has no duplicate domains', () => {
    const seen = new Set<string>()
    for (const e of WEB_SITEMAP) {
      expect(seen.has(e.domain)).toBe(false)
      seen.add(e.domain)
    }
  })

  it('canonicalHost strips www. and parses https URLs', () => {
    expect(canonicalHost('github.com')).toBe('github.com')
    expect(canonicalHost('www.github.com')).toBe('github.com')
    expect(canonicalHost('https://github.com/torvalds/linux')).toBe('github.com')
    expect(canonicalHost('  GITHUB.com/x ')).toBe('github.com')
  })
  it('canonicalHost rejects garbage', () => {
    expect(canonicalHost('')).toBe(null)
    expect(canonicalHost('   ')).toBe(null)
    expect(canonicalHost('not a host at all')).toBe(null)
  })

  it('findByDomain exact + canonicalisation', () => {
    expect(findByDomain('github.com')?.category).toBe('code-repos')
    expect(findByDomain('www.GitHub.com')?.domain).toBe('github.com')
    expect(findByDomain('https://arxiv.org/abs/2401')?.category).toBe('academic')
    expect(findByDomain('does-not-exist.example')).toBeUndefined()
  })
  it('findByKey is the strict version (no host parsing)', () => {
    expect(findByKey('github.com')?.domain).toBe('github.com')
    // findByKey is exact — it does NOT strip schemes / paths, unlike findByDomain.
    expect(findByKey('https://github.com')).toBeUndefined()
  })

  it('listByCategory returns ordered entries', () => {
    const ai = listByCategory('ai-platforms')
    expect(ai.length).toBeGreaterThan(0)
    for (let i = 1; i < ai.length; i++) {
      expect(ai[i - 1]!.priority).toBeGreaterThanOrEqual(ai[i]!.priority)
    }
  })

  it('searchSitemap ranks a clearly-relevant site first', () => {
    const matches = searchSitemap('rust 包管理 crate', { limit: 5 })
    expect(matches[0]?.domain).toBe('crates.io')
  })
  it('searchSitemap handles English-only queries', () => {
    const matches = searchSitemap('arxiv preprint', { limit: 5 })
    expect(matches[0]?.domain).toBe('arxiv.org')
  })
  it('searchSitemap handles Chinese-only queries', () => {
    const matches = searchSitemap('中文 问答 社区', { limit: 5 })
    // Should surface zhihu.com and v2ex.com in the top results.
    const domains = matches.map((m) => m.domain)
    expect(domains.some((d) => d === 'zhihu.com' || d === 'v2ex.com')).toBe(true)
  })
  it('searchSitemap returns top-N by priority when query is empty', () => {
    const matches = searchSitemap('', { limit: 3 })
    expect(matches.length).toBe(3)
    expect(matches[0]!.priority).toBeGreaterThanOrEqual(matches[2]!.priority)
  })
  it('searchSitemap honors category + minPriority filters', () => {
    const matches = searchSitemap('', { category: 'ai-platforms', minPriority: 9, limit: 50 })
    for (const m of matches) {
      expect(m.category).toBe('ai-platforms')
      expect(m.priority).toBeGreaterThanOrEqual(9)
    }
  })

  it('buildSearchUrl fills the {query} placeholder exactly once', () => {
    expect(buildSearchUrl('github.com', 'rust lang')).toBe('https://github.com/search?q=rust%20lang&type=repositories')
    expect(buildSearchUrl('crates.io', 'serde')).toBe('https://crates.io/search?q=serde')
    expect(buildSearchUrl('arxiv.org', 'attention is all you need')).toContain('attention%20is')
    expect(buildSearchUrl('not.in.table.example', 'foo')).toBe(null)
    // Empty query is allowed; the template just stays unfilled.
    expect(buildSearchUrl('crates.io', '')).toBe('https://crates.io/search?q=')
  })

  it('snapshot honors filters and always exposes categoriesInUse', () => {
    const all = snapshot()
    expect(all.total).toBe(WEB_SITEMAP.length)
    expect(all.categories.length).toBeGreaterThan(0)

    const aiOnly = snapshot({ category: 'ai-platforms' })
    for (const e of aiOnly.entries) expect(e.category).toBe('ai-platforms')

    const highPriority = snapshot({ minPriority: 9 })
    for (const e of highPriority.entries) expect(e.priority).toBeGreaterThanOrEqual(9)
  })

  it('summarize keeps only the documented fields', () => {
    const s = summarize(WEB_SITEMAP[0]!)
    expect(Object.keys(s).sort()).toEqual([
      'category',
      'description',
      'domain',
      'hasSearchUrl',
      'language',
      'priority',
      'region',
      'tags',
    ])
    expect(s.hasSearchUrl).toBe(typeof WEB_SITEMAP[0]!.searchUrl === 'string')
  })

  it('renderPromptDigest groups by category and emits Markdown', () => {
    const md = renderPromptDigest({ minPriority: 9 })
    expect(md).toMatch(/^# /m)
    expect(md.split('\n').filter((l) => l.startsWith('- ')).length).toBeGreaterThan(5)
  })
})
