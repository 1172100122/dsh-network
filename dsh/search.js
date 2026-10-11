/**
 * Host-owned search chain. The official provider runs inside the harness;
 * every other engine still uses the persistent CLI server and its existing
 * credential/SSRF boundary. Never register the official engine in the CLI.
 */
import { runCli as defaultRunCli } from './cli-runner.js'

const NATIVE_ENGINE_ID = 'deepseek-official'
// Keep the legacy one-invoke path only for a wholly known CLI chain. The
// CLI's chain resolver otherwise drops unknown IDs and can select a default.
const CLI_ENGINE_IDS = ['bing', 'duckduckgo', 'baidu', 'github', 'searxng', 'brave']
const DEFAULT_CHAIN = ['bing', 'duckduckgo', 'baidu']

function codedError(code, message) {
  return Object.assign(new Error(message), { code })
}

function abortedError() {
  return codedError('WEB_ABORTED', 'Web search was cancelled')
}

function throwIfAborted(signal, error) {
  if (signal?.aborted || error?.code === 'WEB_ABORTED' || error?.name === 'AbortError') {
    throw abortedError()
  }
}

/** Race even a non-cooperative adapter, and always remove listeners/timers. */
async function runAttempt(run, signal, timeoutMs, timeoutError) {
  throwIfAborted(signal)
  const controller = new AbortController()
  let timer
  let onAbort
  try {
    return await new Promise((resolve, reject) => {
      onAbort = () => {
        const error = abortedError()
        reject(error)
        controller.abort(error)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          const error = timeoutError ?? codedError('WEB_TIMEOUT', 'Search engine timed out')
          // Reject before aborting: the adapter may synchronously turn its
          // abort into WEB_ABORTED, but this is an engine timeout/fallback.
          reject(error)
          controller.abort(error)
        }, timeoutMs)
      }
      Promise.resolve().then(() => {
        throwIfAborted(signal)
        return run(controller.signal)
      }).then(resolve, reject)
    })
  } finally {
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}

function strings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
}

function itemsFrom(value, native = false) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => item && typeof item.url === 'string' && item.url.trim() !== '')
    .map((item) => {
      const date = native ? item.publishedAt : item.published_at
      return {
        url: item.url,
        ...(typeof item.title === 'string' ? { title: item.title } : {}),
        ...(typeof item.snippet === 'string' ? { snippet: item.snippet } : {}),
        ...(typeof date === 'string' && date !== '' ? { published_at: date } : {}),
      }
    })
}

function attemptsFrom(value, engine) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => item && typeof item.error === 'string').map((item) => ({
    engine: typeof item.engine === 'string' ? item.engine : engine,
    error: item.error,
  }))
}

function nativeFailure(error) {
  // Never forward an arbitrary native exception message, response body,
  // request URL, or credential. These are diagnostic codes, not evidence.
  switch (error?.code) {
    case 'NATIVE_DEPENDENCY_MISSING': return 'NATIVE_DEPENDENCY_MISSING: official search dependency is not installed'
    case 'NATIVE_HOST_UNSUPPORTED': return 'NATIVE_HOST_UNSUPPORTED: this harness does not support official search'
    case 'NATIVE_CONFIG_UNAVAILABLE': return 'NATIVE_CONFIG_UNAVAILABLE: official search configuration is unavailable'
    case 'NATIVE_CONFIG_INVALID': return 'NATIVE_CONFIG_INVALID: official search configuration is invalid'
    case 'NATIVE_DISPOSED': return 'NATIVE_DISPOSED: official search has been disposed'
    case 'WEB_PROVIDER_CREDENTIAL_MISSING': return 'WEB_PROVIDER_CREDENTIAL_MISSING: official search credentials are missing'
    case 'WEB_TIMEOUT': return 'WEB_TIMEOUT: official search timed out'
    case 'WEB_UNAVAILABLE': return 'WEB_UNAVAILABLE: official search is unavailable'
    case 'WEB_INVALID_RESPONSE': return 'WEB_INVALID_RESPONSE: official search returned an invalid result'
    case 'WEB_UPSTREAM_FAILURE': return 'WEB_UPSTREAM_FAILURE: official search failed'
    default: return 'Official search failed'
  }
}

function unavailable(engine, attempts, warnings = [], uncertainty = []) {
  return {
    status: 'unavailable', engine,
    summary: `All search engines failed: ${attempts.map((a) => `${a.engine}: ${a.error}`).join('; ')}`,
    items: [], uncertainty, warnings, attempts,
  }
}

function cliEntry(entry, engine, count, attempts = [], warnings = [], uncertainty = []) {
  const items = itemsFrom(entry.items)
  return {
    status: entry.status,
    engine: typeof entry.engine === 'string' ? entry.engine : engine,
    summary: typeof entry.summary === 'string' ? entry.summary : `${items.length} sources from ${engine}`,
    items: items.slice(0, count),
    uncertainty: [...uncertainty, ...strings(entry.uncertainty)],
    warnings: [...warnings, ...strings(entry.warnings)],
    attempts: [...attempts, ...attemptsFrom(entry.attempts, engine)],
    ...(typeof entry.truncated === 'boolean' || items.length > count
      ? { truncated: entry.truncated === true || items.length > count } : {}),
  }
}

/**
 * nativeSearch(request, signal) returns the official WebSearchResult shape:
 * { content?, sources: [{ url, title?, snippet?, publishedAt? }], truncated }.
 * Dependencies are injectable so tests never need a harness or network.
 */
function createSearchRunner(config, { nativeSearch, runCli = defaultRunCli, totalTimeoutMs = 55_000 } = {}) {
  async function searchChain({ query, count, engine }, snapshot, signal) {
    throwIfAborted(signal)
    query = String(query ?? '').trim()
    if (!query) throw new Error('web_search: query must be a non-empty string')
    const explicit = typeof engine === 'string' && engine.trim() !== ''
      ? engine.trim().toLowerCase() : undefined
    const chain = explicit ? [explicit] : snapshot.searchEngines
    count = count === undefined ? snapshot.searchMaxResults ?? 10 : count
    if (!Number.isInteger(count) || count < 1 || count > 20) {
      throw new Error('web_search: count must be an integer in [1, 20]')
    }
    const timeoutMs = Number.isInteger(snapshot.searchTimeoutMs) && snapshot.searchTimeoutMs > 0
      ? Math.min(snapshot.searchTimeoutMs, 2_147_483_647) : 15_000
    const args = ['search', '-q', query, '--max-results', String(count), '-t', '55000']

    if (!explicit && chain.every((id) => CLI_ENGINE_IDS.includes(id))) {
      // Preserve the old transport and CLI's existing per-engine timeouts
      // for legacy configurations that have not opted into native search.
      try {
        const entry = await runAttempt((attemptSignal) => runCli(args, attemptSignal, snapshot), signal)
        throwIfAborted(signal)
        return cliEntry(entry, 'chain', count)
      } catch (error) {
        throwIfAborted(signal, error)
        throw error
      }
    }

    const attempts = []
    const warnings = []
    const uncertainty = []
    for (const id of chain) {
      throwIfAborted(signal)
      if (id !== NATIVE_ENGINE_ID && !CLI_ENGINE_IDS.includes(id)) {
        attempts.push({ engine: String(id), error: 'Unknown search engine id' })
        continue
      }
      try {
        if (id === NATIVE_ENGINE_ID) {
          if (typeof nativeSearch !== 'function') {
            throw codedError('WEB_UNAVAILABLE', 'Official search is unavailable')
          }
          const result = await runAttempt(
            (attemptSignal) => nativeSearch({ query, maxResults: count }, attemptSignal), signal, timeoutMs,
          )
          throwIfAborted(signal)
          if (!result || !Array.isArray(result.sources)) {
            throw codedError('WEB_INVALID_RESPONSE', 'Invalid official search result')
          }
          const items = itemsFrom(result.sources, true)
          if (result.sources.length > 0 && items.length === 0) {
            throw codedError('WEB_INVALID_RESPONSE', 'Invalid official search sources')
          }
          // A successful empty official response is authoritative no-hits,
          // unlike a scraper failing to find any results in an HTML body.
          return {
            status: 'ok', engine: id,
            summary: typeof result.content === 'string' && result.content !== ''
              ? result.content : `${Math.min(items.length, count)} sources from ${id}`,
            items: items.slice(0, count), uncertainty, warnings, attempts,
            truncated: result.truncated === true || items.length > count,
          }
        }
        // Pin both arguments and the env snapshot. The CLI must never get
        // to resolve/skip a host-only engine or rerun another chain segment.
        const entry = await runAttempt(
          (attemptSignal) => runCli([...args, '--engine', id], attemptSignal, { ...snapshot, searchEngines: [id] }),
          signal, timeoutMs,
        )
        throwIfAborted(signal)
        if (entry && (entry.status === 'ok' || entry.status === 'degraded')) {
          return cliEntry(entry, id, count, attempts, warnings, uncertainty)
        }
        warnings.push(...strings(entry?.warnings))
        uncertainty.push(...strings(entry?.uncertainty))
        const failures = attemptsFrom(entry?.attempts, id)
        attempts.push(...(failures.length ? failures : [{
          engine: id,
          error: typeof entry?.summary === 'string' ? entry.summary : 'Search engine returned no usable result',
        }]))
      } catch (error) {
        throwIfAborted(signal, error)
        attempts.push({
          engine: id,
          error: id === NATIVE_ENGINE_ID ? nativeFailure(error)
            : error?.code === 'WEB_TIMEOUT' ? 'WEB_TIMEOUT: search engine timed out'
              : typeof error?.message === 'string' ? error.message : 'Search engine failed',
        })
      }
    }
    return unavailable(explicit || 'chain', attempts, warnings, uncertainty)
  }

  return async function search(request = {}, signal) {
    throwIfAborted(signal)
    const live = config && typeof config === 'object' ? config : {}
    // Snapshot before the first await: settings edits affect the next call,
    // never replace/reorder the tail of a search already in progress.
    const configured = Array.isArray(live.searchEngines) && live.searchEngines.length
      ? live.searchEngines.map((id) => typeof id === 'string' ? id.trim().toLowerCase() : id)
      : [...DEFAULT_CHAIN]
    const snapshot = { ...live, searchEngines: configured }
    const requestSnapshot = { ...request }
    const budget = Number.isInteger(totalTimeoutMs) && totalTimeoutMs > 0
      ? Math.min(totalTimeoutMs, 2_147_483_647) : 55_000
    // The seam does not always supply a signal. Give the WHOLE chain one
    // deadline so N fallbacks cannot each spend an independent full budget.
    // The outer race owns this timeout; aborting the inner signal prevents
    // another fallback and cannot misclassify it as an engine-local failure.
    return runAttempt(
      (overallSignal) => searchChain(requestSnapshot, snapshot, overallSignal),
      signal, budget, codedError('WEB_TIMEOUT', 'Web search timed out'),
    )
  }
}

export { createSearchRunner }
