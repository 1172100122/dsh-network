# Native DeepSeek search

`deepseek-official` is an optional **host-only** search engine. Add it in
Settings → Network → Search engines and move it to the desired position.
The default and every existing saved chain are unchanged. Native search uses
an auxiliary model request and may be billed under the user's DeepSeek plan.

## Supported installation

The integration was originally verified against **DSH 0.2.0-rc.2**, official Git tag
`dsh-v0.2.0-rc.2` (`639ed015397290b3745d163aafe02ffee4aa3f84`). It also passes
the native-host integration smoke against the installed **Windows Desktop
0.2.1-rc.2** packages. The package declares optional peers for
`@deepseek-ai/dsh-web` and `@deepseek-ai/dsh-web-search-deepseek` with the range
`>=0.0.1-rc.3`; that range is not a claim that every host version was tested. They are **not**
bundled dependencies. DSH's runtime package resolver supplies its own copies,
including Cordis 4.0.4, to installed and linked plugins. Do not install a
second Cordis or native provider into the profile to satisfy these peers.
An already-polluted profile can take precedence over host fallback and needs
its dependency conflicts resolved separately.

This function use API (DEEPSEEK_PROVIDER_ID, namespace, Config, apply all present),
which is verified with **DSH 0.0.1.rc3** and later, so it might be compatible with older
DSH versions. But we do not declare support for any versions prior to 0.1.0.rc2.

Optional peers do not waive DSH's version compatibility checks. Lazy loading
keeps native dependencies out of CLI startup; unsupported or missing native
capabilities return a diagnostic and can fall back to another engine.

## Architecture and configuration

`dsh/native-search.js` creates a public `ctx.isolate('web')` scope and mounts
the official WebRuntime and DeepSeek plugin there. The parent web provider
selection never changes. Credentials, account routing and request audit
remain the official plugin's responsibility; account tokens are not read
from disk or copied into this plugin's configuration. The child web service
is obtained with `scope.get('web')`, avoiding the parent injection cache.

Each search reads the active `web-search-deepseek` settings entry using the
public Settings API. Changed fields are validated by the official schema and
synchronized with the isolated child using Cordis's `noSave` update. This
does not write another credential/configuration file. A missing entry in a
host with Settings produces an explicit error instead of guessing another
endpoint. Headless hosts without Settings use official defaults and the host
credential/environment services. Custom profile entry IDs currently need
the standard `web-search-deepseek` entry ID to reuse their configuration.

The official account route requires a current agent initiator using
`deepseek-account`. The standalone sidebar has no agent initiator, so its
native search uses the host's API-key/credential route rather than assuming
that a signed-in account permits arbitrary background searches. Its missing
credential diagnostic is preserved in the attempt trail.

Native endpoint/model/key-reference settings belong in DSH's native search
settings, not the dsh-network engine dialog. That dialog is informational and
never collects another key. Native searches use the official provider's
transport/policy; dsh-network's HTTP allowlist and fetch-specific SSRF flags
apply to the CLI transports, not the official auxiliary search endpoint.

## Search semantics

`dsh/search.js` supplies one runner to the model tool, sidebar route, and web
seam. It snapshots the saved order at call start. A pinned `engine` attempts
only that engine. A native operational failure proceeds to the next engine;
its error is sanitized to a fixed diagnostic, never an upstream body or key.
A valid native result with zero sources is a successful **no-results** answer
and stops. It is not treated as a transport failure. Sources, publication
dates, and truncation are retained.

The existing per-engine search timeout applies, with a 55-second total budget.
A node timeout may fall back; external cancellation or total-budget expiry
terminates the chain immediately. Disconnecting a sidebar request cancels
its search. A standalone CLI has no host/account context: selecting the native
engine, or an unpinned chain containing it, reports host-only unavailability
instead of silently substituting Bing. Explicitly select a CLI engine if
running outside DSH.

## Keyless verification

Ordinary unit tests use mocks and require no DSH installation:

```sh
pnpm test
pnpm build
pnpm test:all
```

An optional integration smoke uses **real installed DSH packages**, the real
runtime resolver, a temporary profile, and mocked network/credentials/settings:

```sh
DSH_HOST_INSTALL_ANCHOR=/absolute/path/to/dsh/package.json pnpm test:native
```

It never starts the user's DSH session, reads a real profile, or sends a real
search. It covers package identity, isolated service lifetime, official result
mapping, configuration updates, concurrency, account/credential routing,
audit, cancellation, and missing dependencies. Without the anchor it reports
a skip. A real logged-in DSH/browser session and billing were not tested.

For the official model-facing search/fetch tools over the dsh-network providers,
see [Web tool compatibility](web-tool-compatibility.md) and run `pnpm test:web-host`
with the same install anchor.
