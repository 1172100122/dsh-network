# Web tool compatibility with DSH 0.2.1-rc.2

The Windows Desktop 0.2.1-rc.2 packages were inspected and tested against
dsh-network v1.4.0. No web provider interface migration is required for this
version. Keep adapting through the public `ctx.web` service instead of copying
the official search transport or replacing the official tools' schemas.

## Two tool layers

| Layer | Search arguments | Fetch arguments | Result path |
| --- | --- | --- | --- |
| Official `@deepseek-ai/dsh-tool-web` in Desktop/Web agent presets | `queries: string[]` | `url` | The selected `ctx.web` provider |
| dsh-network's own tools, when visible in the host composition | `query`, optional `count` and `engine` | `url` or `cacheId`, optional `offset`/`limit` | The plugin search runner or persistent CLI server |

The stock Web app disables the root `tool-web` row and registers official
tools inside its agent presets. A root patch does not rewrite nested preset
plugin lists. The scoped official tools can therefore shadow the plugin's
root tools. The `web` provider selection remains important: keep both
`searchProvider: dsh-network` and `fetchProvider: dsh-network`.

Do not rename the plugin's `query` parameter to `queries` merely because the
official tool changed. The official tool splits its queries into individual
`web.search({ query, maxResults }, signal)` calls. `makeSearchProvider()` already
implements that contract. It retains each query's full source list inside its
content section, even when the official tool caps the combined `sources` list.
Choose the engine chain in Network settings when the visible official tool has
no per-call `engine` argument.

The fetch seam remains `{ url, statusCode, body: { kind, content }, truncated }`.
It has no structured cache descriptor. `makeFetchProvider()` returns Markdown
as `kind: 'text'`; a large result includes a preview, `truncated: true`, and an
inline `http_request` paging hint. With the official URL-only `web_fetch`, read
the continuation through `http_request({ cacheId, offset, limit })`. Keep the
plugin's HTTP request tool enabled for that continuation. When the plugin's own
`web_fetch` is visible, its structured cache paging remains available directly.

Native DeepSeek search continues to use the official provider in an isolated
web scope. The host still owns authentication, the Messages API request and
audit events. See [Native DeepSeek search](native-search.md). New fetch rendering
in the official tool does not require a separate DeepSeek fetch provider; the
host's built-in retrieval provider is `web-fetch-http`.

## Verification

Build first, then point both optional integration tests at the installed host:

```sh
pnpm build
DSH_HOST_INSTALL_ANCHOR=/absolute/path/to/dsh/package.json pnpm test:native
DSH_HOST_INSTALL_ANCHOR=/absolute/path/to/dsh/package.json pnpm test:web-host
```

For a packaged Electron installation, use the installation's executable with
`ELECTRON_RUN_AS_NODE=1` and `--expose-internals` to run the test files, so it can
read its ASAR packages. The anchor is the `@deepseek-ai/dsh/package.json` inside
that installation. Do not install another host runtime into the plugin to make
the tests resolve packages.

The Windows 0.2.1-rc.2 verification passed 414 unit tests, the schema validator
from the actual host, server/persistence/download smokes, 10 native-host checks
and 5 web-host checks. Native network and credentials are mocked; web-host
fetches use only a synthetic loopback server. The web-host smoke covers official
multi-query search, pooled result caps, official fetch rendering, shared paging
through `http_request` and the plugin's fetch tool, and search cancellation. It
does not launch Desktop, test browser cards, or make billed/search-engine calls.

The `unknown prompt variable "{{cwd}}"` error is separate: old user preset
overrides may still contain a persona suffix referring to an unregistered
variable. Update that user override after backing it up; do not change
dsh-network or the host's installed packages to register a fake variable.
