<div align="center">

![social-preview](assets/social-preview.png)

# dsh-network

Let DeepSeek Harness access the internet seamlessly.

**English** | [简体中文](README.ZH.md)

[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@naivg/dsh-network?logo=npm&color=cb3837)](https://www.npmjs.com/package/@naivg/dsh-network)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A5_0.1.0.rc2-4D6BFE?logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-darkblue)](https://github.com/topics/dsh-plugin)
[![Listed on DSH Market](https://raw.githubusercontent.com/2BingLing/dsh-market/master/assets/readme/badge-listed-en.svg)](https://dsh.market/)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/naivg/dsh-network)

</div>

`dsh-network` gives DeepSeek Harness a full web toolkit: five model-facing tools
(plus an opt-in downloader), a **Network** settings section, a sidebar
web-search panel, and tool cards that render like first-party ones. It replaces
the official `tool-web` `web_search` / `web_fetch` with a long-lived loopback
Node process. It's also ready to use right out of the box.

Requires `dsh 0.1.0.rc2` or later. See [One thing to know](#one-thing-to-know).

## Quick Install

```bash
dsh plugin --profile web add @naivg/dsh-network
```

See [Installation](#Install).

## Why this plugin

DeepSeek Harness ships `web_search` and `web_fetch`, and they cover the ground
until a long page returns cut off at the inline limit; a link to a `.pdf` or
`.docx` hands the model binary bytes; a feed URL arrives as a wall of XML
instead of a list of posts; a task that needs a raw `POST`, an authoritative
portal lookup, or a file on disk has no tool at all. If the model needs to perform 
specific tasks, it can only use external tools such as `curl` or `wget`, or write a 
`tmp_xxx.py` script first(and there's no guarantee it will work right the first time).

The usual workaround is install a browser-automation plugin(e.g.`browser-use`): open 
the page, snapshot the DOM or a screenshot, click, scroll, repeat. That is the 
right instrument for a page that only works through interaction, and an **expensive**(really) 
one for reading text. Every step pays for a fresh page snapshot plus the tokens 
to read it, and the loop only moves as fast as the page renders, so one article 
can cost many times the context of its own prose while most of those tokens go to
navigation, banners and markup the reader never needed.

`dsh-network` was born to fill this gap. Documents and feeds arrive as
parsed Markdown, one entry per feed item, and a body over the inline cap lands
in a server-side cache the model can page through, so a long page is read in
full rather than losing its tail. Search runs an engine chain (Bing →
DuckDuckGo → Baidu by default, keyless) that can be pinned to one engine per
call, and every hit carries a title, link, snippet and date; when the engines
disagree, the answer says so instead of looking empty. `http_request`,
`web_sitemap` and `web_config` cover the jobs the official pair had no tool
for, the settings section and sidebar panel make all of it editable and usable
by hand, and every request — including the opt-in downloader — goes through one
fenced transport: per-redirect SSRF validation, IP pinning, private-range
blocking and a protocol lock. The only cost is one extra Node process, owned by the
plugin, and the `web` seam stays claimed until you uninstall it.

## What you get

| Tool | What it does |
|---|---|
| `web_search` | Searches through the configured engine chain (default **Bing → DuckDuckGo → Baidu**) and returns citeable sources (title, link, snippet, date), a summary, a status flag, and uncertainty notes. An `engine` argument pins one engine for the call. |
| `web_fetch` | Fetches one HTTP(S) URL, returning Markdown by default or the raw body on request, with outgoing links and warnings. PDF, OOXML (`docx`/`pptx`/`xlsx`), ODF (`odt`/`odp`/`ods`) and EPUB responses are converted to Markdown. Feeds are recognized by their root element — `<rss>`, `<feed>`, `<rdf:RDF>` — and rendered item by item, so RSS 2.0, RSS 1.0 (RDF) and Atom 1.0 read as entries ([details](docs/cli.md#feeds)). |
| `http_request` | Issues a low-level HTTP(S) request with full method, header and body control. |
| `web_sitemap` | Looks up a curated table of **178** authoritative portals in 23 categories (arxiv, MDN, package registries, Q&A, government, news, video…) by domain, category, priority or free text, optionally returning a paste-able digest. |
| `web_config` | Reads the live dsh-network configuration, or applies a partial patch once you enable the safety toggle (see [Settings](#settings)). Full behaviour: [configuration.md](docs/configuration.md#web_config-tool-and-the-safety-toggle). |
| `web_download` | **Off by default.** Saves a binary file (image, archive, media, font) to disk and returns its path, on the same transport as every other tool rather than a socket of its own. See [Safety](#safety) for the fences. |

`web_fetch` and `http_request` bodies over the inline cap (about 20 KB) return
a preview plus a `cacheId`; the model pages the rest with one more call, and an
oversized feed preview always stops on a whole entry boundary, so it can jump
straight to entry 40 without re-fetching the URL. See
[CLI and cache paging](docs/cli.md#cache-paging).

### Tool cards

Every tool renders as a first-party-style dsh card — a borderless disclosure
row over the result body:

<div align="center" class="toolview">

<img src="assets/search-tool.png" width="600" alt="web_search card"/>

`web_search` tool

<img src="assets/sitemap-tool.png" width="600" alt="web_sitemap card"/>

`web_sitemap` tool

<img src="assets/httprequest-tool.png" width="600" alt="http_request card"/>

`http_request` tool

<img src="assets/config-tool.png" width="600" alt="web_config card"/>

`web_config` tool

</div>

`web_config` uses the same card. A read collapses to
`Network config · Read config · N engines`; a write expands and lists each
changed field **with the value that was stored**, so a field the host clamped
(ask for `searchMaxResults: 50`, get `20`) reads as a clamp rather than as the
request, and a write the safety toggle refused shows as an amber *refused*
block instead of a silent no-op. The live config sits underneath in labelled
groups (engine chain with key chips, timeouts, protections, allowlist, caps,
tool switches, GitHub) above the raw JSON.

### Support search engines

| Engine id | Credential |
|---|---|
| `deepseek-official`(HOST ONLY) | DSH native account/credentials (optional; usage may be billed) |
| `bing` | none |
| `duckduckgo` | none |
| `baidu` | none |
| `so360` | none (IP rate limit) |
| `github` | token optional |
| `searxng` | none (your own instance) |
| `brave` | **keyed, billed** |
| `mojeek` | none (Altcha-gated) / **keyed, billed** |
| `tavily` | keyless (rate-limited) / **keyed, billed** |

Bing → DuckDuckGo → Baidu is the default chain; the other are opt-in.
See [Search engines](docs/search-engines.md) for more details.

### Optional native DeepSeek search

Add **DeepSeek (native)** in Settings → Network → Search engines, then use the move controls to choose its fallback position. Existing chains remain unchanged. The plugin runs the official provider in an isolated Cordis scope using DSH-managed native settings and credentials. Verified with DSH **0.2.0-rc.2**; no host patch or duplicate Cordis installation is needed. Native failures fall back, valid empty results stop, and cancellation terminates the chain. Standalone CLI native searches report that a DSH host is required. See [native search](docs/native-search.md) for configuration and test details.

### Sidebar web search

The dsh web UI gains a **Web Search** entry in the sidebar, after Plugins and
Schedules. The panel runs the same search path as the `web_search` tool and is
gated by the same toggle.

## Install

```bash
# from npm:
dsh plugin --profile web add @naivg/dsh-network

# or from GitHub (builds the CLI bundle during install):
dsh plugin --profile web add github:NaivG/dsh-network --allow-build=@naivg/dsh-network

# or from a local checkout:
dsh plugin --profile web add link:<path-to-this-checkout>
cd <path-to-checkout>      # link installs only
pnpm install
pnpm build

dsh web
```

The loader then applies `cordis.patch.yml` for you: the `web` seam providers
switch to dsh-network, the legacy `tool-web` `web_search` / `web_fetch` get
disabled, and the plugin row is inserted with default settings.

> **Why `--allow-build`?** The CLI bundle (`dist/cli.cjs`) is built during
> install by the package's `prepare` script, and pnpm 12 blocks build scripts
> of git-hosted dependencies unless you allow them. If tool calls fail with
> `dsh-network CLI bundle is missing`, see
> [Troubleshooting](#troubleshooting).

## Quick start

1. `dsh web`, then open **Settings → Network**. Everything this
   plugin does is configured there.
2. Ask something that needs the live web — "search for the latest TypeScript
   release notes and cite the sources". The `web_search` card shows the
   engines' answer with the sources underneath.
3. Prefer clicking to typing? Open **Web Search** in the sidebar and run the
   same query from there.
4. Add engines, paste a GitHub token, or tune timeouts in the same settings
   section — edits apply to the next tool call, no restart.

Nothing needs configuring on a fresh install: the default chain is keyless,
and an engine that would cost you something (or need a server of yours) is
never enabled behind your back.

## Settings

Everything lives in **Settings → Network** and takes effect on the next tool call:

- **Search engines** — the live chain (default Bing → DuckDuckGo → Baidu),
  with a per-engine **Edit** dialog for endpoint, **API Key**, and custom
  `key=value` options. See [search engines](docs/search-engines.md).
- **Tool switches** — `webSearchTool`, `webFetchTool`, `httpRequestTool`,
  `webSitemapTool`, and `downloadTool` (**off by default**: it is the only tool
  here that writes to disk, and the model can neither read nor flip that
  switch, exactly like `allowConfigEdit`). Flipping a switch off makes the
  matching tool fail fast and answers 403 on the sidebar route; restarting dsh
  unregisters the tool entirely.
- **Safety** — the toggles for the protections listed under [Safety](#safety),
  next to **Allow the model to modify settings**, which governs `web_config`
  writes.
- Timeouts, User-Agent, result cap, redirect budget, allowed HTTP methods and
  the host allowlist all sit in the same section.

Settings persist to `~/.dsh/dsh-network.json`; delete that file to reset.
Secrets (GitHub token, engine API keys) are stored there too — the browser only
ever shows whether a key is configured, never the key itself. The full field
reference, including the loopback routes, is in
[configuration.md](docs/configuration.md).

## Safety

- All traffic goes through `undici`. The plugin never shells out to
  `curl.exe`, `nslookup.exe`, or any other external binary.
- Per-redirect SSRF validation, IP pinning, and private/reserved range blocking
  are on by default; the allowlist is empty (unrestricted) until you set one.
- The transport refuses true binary content (image, audio, video, font,
  archive, generic octet-stream). Only a fixed allowlist of document MIME types
  is parsed to Markdown. The one exception is `web_download`, and it takes the
  same transport rather than opening its own socket.
- The loopback server binds to `127.0.0.1` only, and request bodies are capped.
- `web_config`'s `set` action is gated by a toggle the model can neither read
  nor write, so a bad patch can never lock the model out of its own write path.
- `web_download` adds three more fences. The filename cannot escape its
  destination root (separators, `..` and Windows device names are neutralized,
  and the resolved path is re-checked before the write). Executable extensions
  (`.exe`/`.ps1`/`.sh`/`.js`/`.bat`/…) are refused under both the declared and
  the sniffed name. And a body over the byte cap **fails** instead of
  truncating, with an atomic `.part` → rename write, so a file that exists is a
  whole file.

## One thing to know

We officially support `dsh 0.1.0.rc2` and later. That's because the API has become 
more stable since this version.

But there is one exception: native deepseek search API function use API 
(DEEPSEEK_PROVIDER_ID, namespace, Config, apply all present), which is manully verified 
with **DSH 0.0.1.rc3** and later, so it might be compatible with older
DSH versions. But we do not declare support for any versions prior to 0.1.0.rc2.

## Troubleshooting

- **`npx @naivg/dsh-network doctor`** prints the resolved configuration —
  engine chain, timeouts, which API keys are configured — without contacting
  anything. Safe offline, and the first thing to check.
- **`dsh-network CLI bundle is missing`** — the CLI build was skipped, which can
  only happen on a git or link install (the published tarball ships `dist/`).
  Reinstall the GitHub route with `--allow-build=@naivg/dsh-network`, or run
  `pnpm install && pnpm build` in the checkout (link installs). See
  [development.md](docs/development.md#the-git-route-and-allowbuilds).
- **A keyed engine says "no credential"** — paste the key in that engine's
  **Edit** dialog and save; the row badge turns green only when a key is really
  stored. See [search engines](docs/search-engines.md#credentials) for the
  credential rules.
- **SearXNG answers 403** — enable `json` under `search.formats` in your
  instance's `settings.yml`. See
  [search engines](docs/search-engines.md#searxng).
- **The sidebar search panel is missing** — it only mounts when the plugin is
  present and the Web search toggle is on.
- **Want to reset everything?** Delete `~/.dsh/dsh-network.json`
  (`DSH_NETWORK_CONFIG_FILE` overrides the path) and restart dsh.

## Documentation

- [Search engines](docs/search-engines.md) — chain, pinning, and every engine's
  credential and options.
- [CLI and cache paging](docs/cli.md) — the standalone CLI, the result
  envelope, and how the cache is paged.
- [Configuration](docs/configuration.md) — every field, every environment
  variable, the loopback routes.
- [Architecture](docs/architecture.md) — process model, transport, engine
  registry, browser half.
- [Development](docs/development.md) — building, testing, code layout.

## Thanks

- [Deepseek Harness](https://github.com/deepseek-ai/deepseek-harness) - Plugin Design, Implementation, and References.
- [Deepseek](https://deepseek.com) - Reference images of deepseek for our Social preview. 

## License

MIT. See [LICENSE](LICENSE).
