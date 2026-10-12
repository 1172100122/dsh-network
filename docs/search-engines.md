# Search engines

`web_search` and the sidebar panel run against a chain of engines. This guide
covers the chain, per-call pinning, every engine's credential and options, and
the fields that shape search as a whole. For the rest of the settings see
[configuration.md](configuration.md); for the internal registry see
[architecture.md](architecture.md#search-engine-registry).

## The chain

Ten engines ship with the plugin. The chain is tried **in order**, and the
first engine that returns hits wins:

| Engine id | Source | Default chain | Credential |
|---|---|---|---|
| `bing` | HTML scrape of `www.bing.com/search` | ✅ #1 | none |
| `duckduckgo` | HTML scrape of `html.duckduckgo.com/html` | ✅ #2 | none |
| `baidu` | HTML scrape of `www.baidu.com/s` | ✅ #3 | none |
| `so360` | HTML scrape of `www.so.com/s` | opt-in | none (IP rate limit) |
| `github` | hybrid REST `/search/{index}`, RRF-fused | opt-in | token optional |
| `searxng` | self-hosted SearXNG JSON API | opt-in | none (endpoint-scoped) |
| `brave` | Brave Search JSON API | opt-in | **keyed, billed** |
| `mojeek-free` | HTML scrape of `www.mojeek.com/search` (personal study purposes) | opt-in | none |
| `mojeek` | Mojeek official Search API (`fmt=json`) | opt-in | **keyed, billed** |
| `tavily` | Tavily Search JSON API (`POST /search`) | opt-in | keyed (billed; keyless fallback) |

The three scrapers are always reachable; the other seven need something to be
worth adding — a token, a hostname, a subscription, an index of their own, or
an IP budget you are willing to spend — so they are never enabled behind your
back. Default chain order is `['bing', 'duckduckgo', 'baidu']`.

> **Two engines share the host `www.mojeek.com`.** `mojeek-free` is the
> free, cookie-gated web SERP (Altcha proof-of-work). `mojeek` is Mojeek's
> official billed Search API (`fmt=json`, `?api_key=…`). The id is the
> product, not the host: each chain row points at one engine and the engine
> decides what kind of answer to expect.
>
> **`tavily` is the only engine that ALSO ships a documented keyless mode.**
> Tavily's `/search` answers `X-Tavily-Access-Mode: keyless` with a
> rate-limited free tier, while `Authorization: Bearer <key>` removes the
> throttle. The credential hop still treats the key as write-only, but the
> engine never short-circuits on a missing key — the fallback header is the
> load-bearing half.

A **pin** bypasses the chain and queries one engine directly:

- the `web_search` tool takes an `engine` argument;
- the sidebar panel's engine picker carries the same choice;
- the CLI takes `--engine <id>`.

When an engine fails, search keeps going: every attempt lands in the result's
`attempts` array (`{ engine, error }`), and a chain that produced nothing still
returns warnings and uncertainty notes instead of a bare "no results".

## Managing the chain

Open **设置 → 网络 → 搜索引擎**, or edit `searchEngines` directly:

- Engine rows appear in chain order; the **Edit** dialog changes one engine.
- **Add search engine** picks a category from the engine list and appends it.
- At least one engine must stay in the chain — the last one cannot be removed.

An engine that is configured but not in the chain still reports its settings
(the real order of operations is *paste the key first, then add the engine*),
so a saved key is never invisible while you decide about the chain.

## The engine dialog

Each engine row opens an **Edit** dialog with up to three parts:

| Part | What it is |
|---|---|
| **Endpoint** | The engine's base URL. Locked for the built-ins that have a fixed endpoint; editable for SearXNG. |
| **API Key** | The engine credential, **where the engine has one to give** — `brave` and nothing else. Write-only: the host stores it, the browser only ever reads back `hasApiKey`, and saving with the field empty keeps the key you already stored. |
| **Custom options** | Free-form parameters, one `key=value` per line, appended to the request. |

An engine with no key to configure has no **API Key** field at all — not a
disabled one, and not a "missing" badge on its chain row.

Custom options are validated by the engine *before* the request is built: an
unknown key or an out-of-vocabulary value is dropped, so a typo can never burn
a call on a 422.

## Built-in scrapers

`bing`, `duckduckgo`, and `baidu` have locked endpoints, take no options, and
need no credential. Baidu remains the best of the three for Chinese-language
queries; DuckDuckGo is the privacy-first fallback. They exist because a keyless
chain is what makes the plugin work on a fresh install. `so360` is a fourth
scraper of the same shape, but it is opt-in for the reason below.

## 360搜索 (so360)

A keyless Chinese index at `https://www.so.com/s` — no account, no API key, no
proof-of-work. The first request from a cold address returns a full result
page, and the real target URL is pre-rendered in each result's `data-mdurl`
attribute, so the engine returns clean links instead of `so.com/link?m=…`
redirects.

It is **opt-in** because 360 rate-limits by source IP.

### The rate limit, and how to clear it

After a burst of unspaced requests, 360 answers with a **graphical CAPTCHA page
— served with HTTP 200**, titled `访问异常页面` and roughly 6-9 KB.

To clear it: **open `https://www.so.com` in a browser and complete the
verification once.** The engine never retries, since a retry here extends the
cooldown rather than clearing it.

Two more things worth knowing before you put it in the chain:

- **A page yields only 5-7 organic results, not ten.** 360 interleaves "mohe"
  rich cards (AI 答案 / 图片 / 短视频 / 百科) that take up result slots without
  being results, so the engine reports the displacement in `uncertainty` rather
  than letting a low number read as "that's everything".
- **The index is Chinese-first.** English queries do return hits, but they
  skew Chinese. Baidu is the better default for mixed-language work; add 360
  when you want a second Chinese opinion, not in place of Baidu.

Optionally set `options` (one `key=value` per line): `pn=<page number>` for
paging (`pn=2` is the next page). Everything else is dropped before it
reaches the host.

## GitHub

Hybrid REST search over **repositories / code / issues / users**, fused by
weighted RRF. Anonymous search is limited to **10 req/min per IP**; a token
raises the quota to 30/min and enables the `code` index — without one, that
request is never sent and the engine reports the missing credential instead.

| Setting | Values | Default | Effect |
|---|---|---|---|
| **Token (optional)** | a fine-grained PAT | empty | raises the quota and enables code search; stored write-only |
| **Indexes** | `repositories` `code` `issues` `users` | empty = auto | pins the indexes to ask |
| **Repository sort** | Best match / Stars / Recently updated | `best` | repository ordering |

The token lives in its own **GitHub-specific settings** group rather than in an
engine dialog, because it is shared by every GitHub index. It is write-only
like the engine keys, and a **Clear** button removes it.

A pinned index list overrides the automatic intent routing. Automatic routing
reads the query: a `@handle` or `user:` targets **users**, a qualifier such as
`repo:` or `language:` targets **repositories**, "how to" / "usage" intent adds
**code**, and bug or error intent adds **issues**.

## SearXNG

A self-hosted metasearch instance reached through its **JSON API** — so the
engine is only as good as the instance you point it at.

1. Add `searxng` to the chain, then set its **Endpoint** in the dialog (default
   `http://127.0.0.1:8888`), or set `DSH_NETWORK_SEARXNG_URL` for a CLI run.
2. Enable `json` under `search.formats` in the instance's `settings.yml`.
   Without it every request gets a **403**.
3. Optionally add parameters:

| Parameter | Accepted values | Default | Effect |
|---|---|---|---|
| `language` | e.g. `en`, `zh-CN` | instance default | result language |
| `safesearch` | `0` `1` `2` | instance default | 0 off, 1 moderate, 2 strict |
| `timeRange` | `day` `month` `year` | unset | recency filter |
| `categories` | e.g. `general`, `news`, `it` | instance default | category selector |
| `pageno` | integer > 1 | unset | result paging |

Private-network access is granted for this engine **only when the configured
endpoint is itself loopback/private**; SSRF guards stay on for everything else.
A 403, a non-JSON body, and a JSON error body all surface as warnings rather
than a silent "no results".

## Brave

The Brave Search API — the only engine here that costs money, because its free
tier was removed (Feb 2026). It is never part of the default chain and never
sends a request until a key exists: with no key the engine short-circuits and
reports the missing credential.

1. Add `brave` to the chain (or pin it per call with `engine: "brave"`).
2. Paste the subscription token into the dialog's **API Key** field. It is the
   `X-Subscription-Token` header; the browser never reads it back.
3. Optionally add parameters:

| Parameter | Accepted values | Default | Effect |
|---|---|---|---|
| `country` | `DE`, `US`, … (two letters) | unset | country targeting |
| `searchLang` | `de`, `de-DE`, … | unset | content language |
| `uiLang` | `de`, `de-DE`, … | unset | response-metadata language |
| `freshness` | `pd` `pw` `pm` `py`, or `2024-01-01to2024-06-30` | unset | recency filter |
| `safesearch` | `off` `moderate` `strict` | unset | adult-content filter |
| `goggles` | an `http(s)` URL | unset | custom re-ranking |
| `offset` | `0`-`9` | unset | result paging |

`count` follows the call's result cap (max 20) and `extra_snippets=true` is
always on, so extra excerpts reach the snippet. `page_age` becomes the hit's
date — but only after a plausibility gate that drops anything outside
`[1990, next year]`, because a wrong date in the evidence is worse than no
date.

Check the credential state without spending anything:
`npx @naivg/dsh-network doctor` prints `apiKeys=[brave=no key]`, and probing the
endpoint with no credential is free too.

## Mojeek (free)

Mojeek runs its own crawler and its own index — the only independent index in
this chain besides GitHub. It is reached through its **HTML** search page, and
the page is behind an [Altcha](https://altcha.org/) proof-of-work.

This is **not** Mojeek's official Search API — that is a separate, billed
product this plugin has not implemented.

The engine therefore does **not** solve the challenge while searching. There
are two ways to get the cookie:

### Inside the persistent server (the default)

The server creates one `MojeekSession` (`src/mojeek-session.ts`) at startup
and threads it onto every search. The first time `mojeek-free` lands in a
chain, the session lazy-solves Altcha, caches the `chllg` cookie for ~30 days,
and returns it. On a hit with a stale cookie, the session invalidates and
re-solves inside the same search — the user never sees a stale-cookie
warning. Cost: one ~1-2 s Altcha solve on the first search after a fresh
install, and again only when Mojeek revokes the cookie (rare). The
`dsh-network mojeek-login` verb is not needed, and the settings dialog shows
**no** key field for this engine: the cookie is the server's to manage, so
there is nothing to paste and nothing to nag about.

### Outside the persistent server (single-shot CLI)

Standalone `dsh-network search` does not carry a `MojeekSession`, so the auto
path does not fire there. The login is a separate, explicit step:

1. Run the solver on the CLI:

   ```bash
   npx @naivg/dsh-network mojeek-login
   ```

   It fetches `/captcha/challenge`, brute-forces the published key prefix with
   parallel PBKDF2 workers (measured: ~1–2 s, counter lands around 200–300),
   posts the solution to `/captcha/verify` and prints the `chllg=…` cookie
   plus its expiry.

2. Export it for the run:

   ```bash
   export DSH_NETWORK_MOJEEK_COOKIE='chllg=…'
   ```

   A host that would rather store it can put the same string in
   `searchEngineApiKeys["mojeek-free"]` in `~/.dsh/dsh-network.json`; it wins
   over the session's cookie and is re-solved automatically if it goes stale.

3. The cookie lasts ~30 days. When it lapses — or when Mojeek revokes it — the
   search page comes back and the engine says so (`the verification page came
   back instead of results — the chllg cookie is stale`), which means
   *run `mojeek-login` again*.

Three limits are worth knowing before you put it in the chain:

- **It is rate-gated by IP, on top of the challenge.** A burst of about six
  cookie-authenticated queries gets the whole egress IP answered with
  `403 Sorry your network appears to be sending automated queries`; the wall
  lifted after ~3.5 minutes of silence in testing, and a paced 1 query / 8 s
  stream passed. The engine reports the 403 as a warning and never retries, so
  the chain falls through — but the block is on the *network*, not just on this
  plugin, so it can also affect the same Mojeek in your browser. Keep it at the
  tail of the chain (`searchEngines`), not at the head.
- **English-heavy index.** A Chinese query (`深度学习`, `中文网站`) returns
  200 with no result list at all. Baidu is the engine that answers those.
- **10 results per page.** The engine fetches one page and says so in
  `uncertainty` when you asked for more; option `s=11` / `s=21` fetches the
  next page (one extra request, so page deliberately instead of polling).

Optionally set `options` (one `key=value` per line): `s=<1-based start index>`
for paging. Everything else is dropped before it reaches the host.

## Mojeek (Search API)

Mojeek's official Search API — the same index, reached by the
`api_key`-authenticated JSON endpoint at `https://www.mojeek.com/search`.

1. Subscribe to a Mojeek plan and copy the API key from your account page
   (the official sign-up is on the Mojeek website; the docs are at
   <https://www.mojeek.com/support/api/search/>).
2. Add `mojeek` to the chain (or pin it per call with `engine: "mojeek"`).
3. Paste the key into the dialog's **API Key** field — it rides in the URL
   itself as `?api_key=…`, never in a header. The browser never reads it
   back; only the green *API key configured* badge is returned.

Without a key the engine sends **no request** (the CLI synthesizes a 401 so
"missing key" and "rejected key" classify on one code path, the same way
Brave does).

The engine option `s=<1-based start index>` pages through results; `t`
follows the call's result cap and is the only option that scales with `max`.
Everything else is documented below.

| Parameter | Accepted values | Effect |
|---|---|---|
| `s` | `1`-`1000` (integer) | 1-based start index for paging (`s=11` is page 2 with `t=10`). |
| `t` | `1`-`100` (integer) | Results per page; default 10. |
| `since` | `YYYYMMDD` / `day` / `month` / `year` | Recency filter; `YYYYMMDD` values must be exactly 8 digits. |
| `before` | same as `since` | Upper-bound date; results are returned *before* this value. |
| `rb` | 2-letter ISO 3166-1 (e.g. `GB`) | Prefer pages from this country/region. |
| `rbb` | `1`-`100` (integer) | Boost strength, paired with `rb`; recommended 10. |
| `lb` | 2-letter ISO 639-1 (e.g. `EN`) | Prefer pages in this language. |
| `lbb` | `1`-`100` (integer) | Boost strength, paired with `lb`; recommended 100. |
| `lr` | `EN`,`FR` (β) | Beta: restrict to specific language. |
| `safe` | `0` / `1` | Safe search on/off. |
| `date` | `0` / `1` | Include last-modified date as the hit's `published_at`. |
| `cdate` | `0` / `1` | Include the date the page was crawled. |
| `size` | `0` / `1` | Include the document's size. |
| `site` | domain (e.g. `mojeek.com`) | Restrict to one site. |
| `fi` / `fe` | comma-separated domains | Include / exclude (max 25 each; prefix with `.` for subdomains). |
| `tlen` | `0`-`127` (integer, default 56) | Result title length. |
| `dlen` | `0`-`511` (integer, default 160) | Snippet length. |
| `datewr` | `0` / `100` | Rank by date when set to 100. |
| `qm` | excluded words | URL-encoded list of words to discard. |

Unknown keys and out-of-vocabulary values are dropped before the URL is
composed, so a typo in the settings textarea burns **no** call.

## Tavily

The Tavily Search API — billed per query. 

It is the only keyed engine that also supports a documented keyless mode (rate-limited).

1. Add `tavily` to the chain (or pin it per call with `engine: "tavily"`).
2. Paste the API key into the dialog's **API Key** field. Skipping
   this step still works — the engine sends the keyless header and serves
   whatever Tavily's free tier returns.
3. Optionally add parameters:

| Parameter | Accepted values | Effect |
|---|---|---|
| `searchDepth` | `advanced` `basic` `fast` `ultra-fast` | Result precision vs. latency trade-off. Default `basic`. |
| `topic` | `general` `news` `finance` | Index category. Default `general`. `news` auto-enables `published_date`. |
| `timeRange` | `day` `week` `month` `year` `d` `w` `m` `y` | Recency filter (publish / last-update date). |
| `includeAnswer` | `true` `false` `basic` `advanced` | Include an LLM-generated answer alongside results. |
| `includeRawContent` | `false` `markdown` | Include the cleaned HTML/markdown body per hit (text mode skipped on purpose). |
| `excludeDomains` | comma-separated, ≤150 hosts | Drop results from these domains. |
| `includeDomains` | comma-separated, ≤300 hosts | Restrict (or boost) results to these domains. |
| `includeDomainsMode` | `restrict` `prefer` | How `includeDomains` applies. Only emitted alongside `includeDomains`. |
| `country` | an English name from the OpenAPI country list | Boost results from one country. **Only valid when `topic=general`.** |
| `language` | `en` `fr` `zh-cn` … (ISO 639-1 or English name) | Boost results in one language. |
| `exactMatch` | `true` `false` | Force quoted-phrase matching inside the query. |
| `safeSearch` | `true` `false` | Adult-content filter. |
| `includeImages` | `true` `false` | Include query-related images. |
| `includeImageDescriptions` | `true` `false` | Add a description per image. Only emitted when `includeImages=true`. |
| `includeFavicon` | `true` `false` | Include favicon URL per hit. |
| `chunksPerSource` | `1`-`3` (integer) | Chunks per result (basic / fast). |

Unknown keys and out-of-vocabulary values are dropped before the body is
built, so a typo in the settings textarea burns **no** call.

`max_results` follows the call's result cap (max 20). `Tavily
Search` and `Authentication verified` are the user's "ready" gate (a
live `tvly search "..." --json` from the CLI; or, within dsh, a confirmed
key in the dialog).

## Credentials

Engine credentials live in `~/.dsh/dsh-network.json`, next to the rest of the
settings, and the browser only ever reads back *whether* a key is set:

- **Write-only.** After a save lands, the plaintext key is dropped from the UI
  draft, so later saves never re-send it.
- **One truth.** The green *API key configured* badge is a view of the stored
  key map, not a separate flag — a badge that says configured really means the
  engine will send its auth header.
- **Resolution order** (CLI side): the host's per-engine key map →
  the engine's own single-engine variable → the legacy GitHub token channel.
  `mojeek-free`'s "key" is the `chllg` cookie and rides the same chain, but
  the persistent server fills it in first from its session, so the host
  normally has nothing stored.

Without a usable credential the CLI sends **no request at all** for a keyed
engine: it synthesizes an auth failure so "no credential" and "rejected
credential" are reported on one code path instead of a mystery 401.

**Tavily is the one exception.** Its `auth.optional` declaration makes the
CLI fall back to `X-Tavily-Access-Mode: keyless` instead of short-circuiting,
so a missing key still produces a request — the user's chain stays intact
even without a Tavily account. The fallback's rate limit is documented and
the engine surfaces the 429 it generates; nothing else in this plugin
expects a request to ship without a credential.

## Engine-level settings

These fields shape the whole chain. See
[configuration.md](configuration.md#field-reference) for the complete list.

| Field | Meaning | Default |
|---|---|---|
| `searchEngines` | Ordered engine chain. Ids are trimmed and lowercased on load, duplicates dropped. | `['bing','duckduckgo','baidu']` |
| `searchMaxResults` | Result cap handed to engines (hard cap 20). | `10` |
| `searchTimeoutMs` | Per-engine search timeout. | `15000` |
| `searchEngineConfigs` | Per-engine rows: endpoint, `hasApiKey` (a derived view), options. | `{}` |
| `searchEngineApiKeys` | The actual engine credentials. Write-only via the UI. | `{}` |
| `githubToken` | GitHub credential; stored, never echoed to the browser. | `""` |
| `githubIndexes` | Pinned GitHub indexes; empty = automatic intent routing. | `[]` |
| `githubSort` | GitHub result ordering. | `"best"` |

For headless and CLI runs the equivalents are `DSH_NETWORK_SEARXNG_URL`,
`DSH_NETWORK_GITHUB_TOKEN` (legacy channel, still honored),
`DSH_NETWORK_BRAVE_API_KEY`, `DSH_NETWORK_MOJEEK_COOKIE`, and
`DSH_NETWORK_TAVILY_API_KEY` (single-engine runs), and the two maps the
host packs into every call — `DSH_NETWORK_SEARCH_ENGINE_API_KEYS` and
`DSH_NETWORK_ENGINE_OPTIONS`. The maps are JSON and are not meant to be
set by hand; see [configuration.md](configuration.md#environment-variables).
Tavily is also reachable without any of these (keyless mode).

---

See also: [README](../README.md) · [CLI and cache paging](cli.md) ·
[Configuration](configuration.md) · [Architecture](architecture.md)
