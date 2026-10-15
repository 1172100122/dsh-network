# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
as far as the public npm surface (`@naivg/dsh-network`) is concerned.

## [1.4.0] - 2026-10-15

### Added

- **Search engine: Mojeek Free** — `mojeek-free` engine that scrapes
  Mojeek's HTML SERP. The engine stays out of the default chain and is
  never the user's first touch with mojeek.com.
- **Search engine: 360 Search (so360)** — `so360` engine. No credential
  required; the load-bearing detail is that a CAPTCHA wall returns
  HTTP 200 with a ~6–9 KB `访问异常页面` body, and the engine surfaces a
  360-specific warning instead of an empty result.
- **Search engine: Mojeek official API** — billed Mojeek Search API
  support (engine id `mojeek`, separate from the free SERP), with the
  same result-parsing helpers.
- **Search engine: Tavily** — `tavily` engine registered for users with a
  Tavily key.
- **Search engine chain reordering** — settings dialog now exposes
  drag-style reordering of the active engine chain, persisted via the
  usual debounced save.
- **Native DeepSeek search on a dedicated branch** — restores the upstream
  `@deepseek-ai/dsh-web-search-deepseek` plugin alongside this one
  (peer dependency, optional). The plugin is keyed to `deepseek-native-search`
  in `cordis.patch.yml` so the tool registry does not collide.

### Changed

- **DSH version compatibility** — README and install path updated to reflect
  the supported DSH version range (≥ 0.1.0.rc2).
- README rewritten and reorganized; the Chinese mirror
  ([README.ZH.md](README.ZH.md)) is now linked from both the badges row and
  the body, and stale/duplicate descriptions were removed.

## [1.3.0] - 2026-10-10

First tagged release under the npm name **`@naivg/dsh-network`**.

### Added

- **Five model-facing tools + an opt-in downloader**: `web_search`,
  `web_fetch`, `http_request`, `web_sitemap`, `web_config`, and the
  `web_download` writer. Replaces the official `tool-web`
  `web_search` / `web_fetch` and adds a free, keyless `http_request`.
- **Long-lived loopback CLI** (`dsh-network server`) — one persistent
  Node child per dsh session, spoken to over `127.0.0.1:<port>`. Per-call
  env snapshots carry the live browser config (engine order, timeouts,
  allowlist, GitHub token, SearXNG endpoint, engine keys and options,
  `web_download` workspace root) so UI edits land on the next tool call
  with no server restart. Large bodies are server-side cached
  (`cacheId` + `contentLength` + `preview`) and paged on a follow-up
  `GET /content`, dodging the ~20 KB stdout chunking from the original
  handbook #717.
- **Sidebar search panel** — root-scoped `main` + `sidebar.panellist`
  registrations at order 20, posting `{ query, count, engine }` to
  `/dsh-network/search`, gated on `webSearchTool` so one switch disables
  both the model-facing tool and the user-facing panel.
- **Settings section (网络)** with a legacy fallback card for hosts without
  the modern settings surface; engine toggle, chain order, key map,
  free-form per-engine options, safety toggle (`allowConfigEdit`,
  model-blind), `web_download` enable and `webSearchTool` / `webFetchTool`
  / `httpRequestTool` switches.
- **Tool-view rows** — `tool.call.toolview` registrations at priority `-900`
  for `web_search`, `web_fetch`, `http_request`, `web_sitemap`,
  `web_config`, `web_download`. Argument rendering reads
  `block.call.argsRaw` directly (the canonical dsh path), not the older
  parsed `call.args`. `web_config` row is the wide one: whole-config
  snapshot (secrets and `allowConfigEdit` already stripped by
  `summarizeForModel()`) plus the field names a landed `set` forwarded.
- **`web_download`** — `mode: 'bytes'` on the existing pinned-dispatcher
  transport; default `false` (the only field here that does), gated at
  registration time so an unregistered tool is absent from the model
  list rather than throwing when used. Type from BYTES, magic →
  `Content-Type` → filename; executables refused; non-clobbering names
  in `tmp` and `workspace` roots. Deliberately NOT cached.
- **`web_sitemap`** — `web_sitemap` tool backed by a curated table of
  ~178 authoritative portals (academic, code repos, package registries,
  Q&A, etc.), with a separate `web_search` mode against it.
- **Hand-written feed parser** — `web_fetch` auto-detects RSS / Atom /
  RDF roots; otherwise falls through to `htmlToMarkdown` untouched. 8 000
  chars/item clip on a block boundary, 500-item render ceiling,
  preview cuts at the last whole item under the inline cap.
- **Hand-written HTML → Markdown** — real web pages get nav/footer/
  cookie-banner pre-filter and entity decoding (`decodeEntities`) that
  runs ONCE at the CLI boundary; officeparser is reserved for binary
  documents (PDF, OOXML, ODF, EPUB).
- **Search engines**: `brave` (key, billed, last in chain by default),
  `duckduckgo`, plus the engines added in `Unreleased` (Mojeek Free,
  so360, Mojeek API, Tavily).
- **Document parsing** via `officeparser` for `.pdf`, `.docx`, `.xlsx`,
  `.pptx`, `.odt`, `.ods`, `.odp`, `.epub`, loaded via `await import`
  so `tesseract.js` stays out of the cold-start bundle. OCR is
  intentionally off.

### Changed

- **Package name → `@naivg/dsh-network`** — load-bearing in four places
  (`package.json`, `cordis.patch.yml` insert row name, every
  `window.__ModuleLoader__.load({ id })` and the
  `require('@naivg/dsh-network')` re-binds, and `dsh/index.js`
  `export const name`). They moved together; everything else kept the
  SHORT name on purpose.
- **Plugin architecture refactored** — entry owns only contract exports;
  `dsh/schemas.js`, `cli-runner.js`, `evidence.js`, `providers.js`,
  `tools.js`, `routes.js`, `config-summary.js` and `dsh/serverClient.js`
  split by concern. Hand-written, no build, so vite's lib mode cannot
  silently replace `node:*` with browser externals.
- **Browser half split into chunks** — `dsh/client.js` is the entry;
  `client.settings.js` (网络 + legacy card), `client.toolviews.js`
  (block renderers + toolview rows), `client.searchpanel.js`
  (sidebar panel) register via `window.__ModuleLoader__.load(...)`.
  Every shared symbol is re-bound through `require('@naivg/dsh-network')`
  by name; chunks are guarded statically and dynamically by
  `tests/client-chunks.spec.ts`.
- **Markdown rendering in tool rows** uses `ui.MarkdownText` via
  `isRenderable(value)` (functions / memo / forwardRef / lazy tags /
  `render`-carrying objects); the raw-text `<pre>` fallback covers only
  values dsh has degraded.
- **CLI reference** documented in [docs/cli.md](docs/cli.md); web
  architecture, development workflow, search engine catalog and
  configuration field reference under [docs/](docs/README.md).

### Security

- **Pinned undici dispatcher with allowlist + DNS validation** — every
  redirect hop is URL-parsed, allowlist-checked, DNS-resolved and
  pinned to one IP for the socket; private/reserved addresses are
  rejected. No shelling out to `curl.exe` / `nslookup.exe`.
- **TLS ciphers pinned to the Firefox list, NOT TLS version** — the
  fingerprint is the cipher list (works on TLS 1.2 too); the list is
  kept a SUPER-SET of mainstream servers so an RSA-only edge still
  finds a shared suite.
- **`web_download` is fenced four ways**: registration-time enable flag
  the model can neither read nor write, host-resolved destination root,
  magic-byte-sniffed extension with magic → Content-Type → filename
  precedence, `path.relative` containment re-check after
  `sanitizeFileName`, executable denylist on the sniffed name AND the
  declared one, `readBodyWithLimit` THROWS past `maxBytes` (no short
  read), `.part` → `rename` for atomic writes.
- **Engine credentials live only in the CLI process** — engine declares
  `auth = { header, scheme, apiKeyEnv }`; the CLI resolves
  `DSH_NETWORK_SEARCH_ENGINE_API_KEYS[engineId]` and injects the header
  itself. Engines only ever see `hasApiKey`. With no key the CLI sends
  NO request — it synthesizes a 401 body so "no credential" and
  "rejected credential" classify on one code path.
- **`allowConfigEdit` is model-blind** — stripped from
  `summarizeForModel()` and omitted from the `web_config.set` schema
  whitelist (`pickConfigPatch`), so a model cannot widen its own write
  path.
- **`/dsh-network/config` and `/dsh-network/search` behind
  `isTrustedRequest`** — same loopback + `sec-fetch-site: same-origin`
  + Origin == Host fence dsh's `/api` uses.

### Removed

- Private-package restriction on this repo's published npm tarball
  (the `publishConfig.access` is now `public`).

## Initial development

The work accumulated before `1.3.0` was tagged, in reverse-chronological
order. Pre-release versions are not independently tagged.

### 2026-10-08 → 2026-10-09

- Add `web_fetch` / `web_config` tool-card renderers and `web_fetch`
  RSS/Atom parsing. Engine API key passing fix, Brave Search engine +
  API key management. Two batches of new sitemap portal entries (21,
  then 13). HTML entity decoding introduced into the search-result
  pipeline so `&nbsp;`-laden result lines render correctly.
- Several `dsh/client.js` chunk-loading fixes (free-variable references
  inside `react.memo` / `forwardRef`); Markdown rendering detection
  widened from `typeof === 'function'` to `isRenderable(value)`; plugin
  re-architected into the host-entry + concern files shape it still has.
- DuckDuckGo endpoint URL update, `http_request` / `web_sitemap`
  toolview components, language-preference request headers, sidebar
  web-search panel.
- README and `AGENTS.md` rewritten; Chinese mirror linked.
- Build system: `dist/cli.cjs` is built from the `prepare` hook so a
  git install no longer reports success and dies on the first tool
  call; `esbuild` added to the pnpm workspace allow-builds list (pnpm 12
  needs a spec-qualified allowBuilds key).
- Search-tool failure states and error handling in the client.
- Project metadata (`author`, `homepage`, `repository`, `bugs`,
  `keywords`, `license: MIT`) added to `package.json`.

### 2026-09-12

- `Initialize repository` — first commit.

---

[1.3.0]: https://github.com/NaivG/dsh-network/releases/tag/v1.3.0
[1.4.0]: https://github.com/NaivG/dsh-network/releases/tag/v1.4.0
