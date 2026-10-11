/** Host-only native/CLI dispatch; every transport and credential is mocked. */
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSearchRunner } from '../dsh/search.js'
import { defaultConfig } from '../dsh/config-summary.js'
import { snapshotForPersist } from '../dsh/persist.js'
import { SearchEngineRegistry, registerDefaultEngines } from '../src/engines/index.ts'

const nativeId = 'deepseek-official'
const hit = { url: 'https://example.com/a', title: 'A', snippet: 'Example' }
const nativeResult = { content: 'Official summary', sources: [hit], truncated: false }
const cliResult = (engine = 'bing', extra = {}) => ({
  kind: 'search', status: 'ok', engine, summary: `1 sources from ${engine}`,
  items: [hit], uncertainty: [], warnings: [], attempts: [], ...extra,
})
const failure = (engine: string, error = 'fixture unavailable') => cliResult(engine, {
  status: 'unavailable', summary: error, items: [], attempts: [{ engine, error }],
})
const pinned = (args: string[]) => args[args.indexOf('--engine') + 1]
const never = () => new Promise<never>(() => {})

afterEach(() => vi.useRealTimers())

describe('host search dispatcher', () => {
  it('maps the official source contract without losing summary, date, or truncation', async () => {
    const nativeSearch = vi.fn().mockResolvedValue({
      ...nativeResult, sources: [{ ...hit, snippet: '&amp; is literal', publishedAt: '2026-10-01' }], truncated: true,
    })
    const runCli = vi.fn()
    const search = createSearchRunner({ searchEngines: [nativeId, 'bing'] }, { nativeSearch, runCli })
    const result = await search({ query: '  fixture  ', count: 3 })
    expect(nativeSearch).toHaveBeenCalledWith({ query: 'fixture', maxResults: 3 }, expect.any(AbortSignal))
    expect(runCli).not.toHaveBeenCalled()
    expect(result).toEqual({
      status: 'ok', engine: nativeId, summary: 'Official summary',
      items: [{ ...hit, snippet: '&amp; is literal', published_at: '2026-10-01' }],
      uncertainty: [], warnings: [], attempts: [], truncated: true,
    })
    expect(JSON.parse(JSON.stringify(result))).toEqual(result)
  })

  it('caps native results and marks its own truncation', async () => {
    const nativeSearch = vi.fn().mockResolvedValue({ ...nativeResult, sources: [hit, { url: 'https://example.com/b' }] })
    const search = createSearchRunner({ searchEngines: [nativeId], searchMaxResults: 1 }, { nativeSearch })
    const result = await search({ query: 'fixture' })
    expect(nativeSearch.mock.calls[0]?.[0]).toEqual({ query: 'fixture', maxResults: 1 })
    expect(result.items).toEqual([hit])
    expect(result.truncated).toBe(true)
  })

  it('treats successful zero hits as authoritative and does not fall back', async () => {
    const nativeSearch = vi.fn().mockResolvedValue({ content: 'No matching sources', sources: [], truncated: false })
    const runCli = vi.fn()
    const search = createSearchRunner({ searchEngines: [nativeId, 'bing'] }, { nativeSearch, runCli })
    expect(await search({ query: 'fixture' })).toEqual({
      status: 'ok', engine: nativeId, summary: 'No matching sources', items: [],
      attempts: [], warnings: [], uncertainty: [], truncated: false,
    })
    expect(runCli).not.toHaveBeenCalled()
  })

  it.each([{ items: [hit] }, { items: [] }])('accepts official results with no optional content field: %j', async ({ items }) => {
    const nativeSearch = vi.fn().mockResolvedValue({ sources: items, truncated: false })
    const runCli = vi.fn()
    const search = createSearchRunner({ searchEngines: [nativeId, 'bing'] }, { nativeSearch, runCli })
    expect(await search({ query: 'fixture' })).toMatchObject({
      status: 'ok', engine: nativeId, items, summary: `${items.length} sources from ${nativeId}`,
    })
    expect(runCli).not.toHaveBeenCalled()
  })

  it('executes CLI and native in their precise configured positions', async () => {
    const order: string[] = []
    const nativeSearch = vi.fn(async () => {
      order.push(nativeId)
      throw Object.assign(new Error('private native endpoint?token=secret'), { code: 'WEB_UPSTREAM_FAILURE' })
    })
    const runCli = vi.fn(async (args: string[], _signal: AbortSignal, config: any) => {
      const id = pinned(args)!
      order.push(id)
      expect(config.searchEngines).toEqual([id])
      return id === 'brave' ? cliResult(id) : failure(id)
    })
    const search = createSearchRunner({ searchEngines: ['bing', nativeId, 'brave', 'duckduckgo'] }, { nativeSearch, runCli })
    const result = await search({ query: 'fixture', count: 2 })
    expect(order).toEqual(['bing', nativeId, 'brave'])
    expect(result).toMatchObject({ status: 'ok', engine: 'brave', attempts: [
      { engine: 'bing', error: 'fixture unavailable' },
      { engine: nativeId, error: 'WEB_UPSTREAM_FAILURE: official search failed' },
    ] })
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('stops at a CLI success before reaching native search', async () => {
    const nativeSearch = vi.fn()
    const runCli = vi.fn().mockResolvedValue(cliResult('bing'))
    const search = createSearchRunner({ searchEngines: ['bing', nativeId, 'baidu'] }, { nativeSearch, runCli })
    expect(await search({ query: 'fixture' })).toMatchObject({ engine: 'bing', attempts: [] })
    expect(runCli).toHaveBeenCalledTimes(1)
    expect(nativeSearch).not.toHaveBeenCalled()
  })

  it('reads edits on the next call without changing an in-flight snapshot', async () => {
    const config = { searchEngines: ['bing', nativeId, 'baidu'] }
    const order: string[] = []
    const nativeSearch = vi.fn(async () => { order.push(nativeId); throw new Error('fixture') })
    const runCli = vi.fn(async (args: string[]) => {
      const id = pinned(args)!
      order.push(id)
      if (id === 'bing') config.searchEngines.splice(0, 3, 'baidu', nativeId, 'bing')
      return failure(id)
    })
    const search = createSearchRunner(config, { nativeSearch, runCli })
    await search({ query: 'first' })
    expect(order).toEqual(['bing', nativeId, 'baidu'])
    order.length = 0
    await search({ query: 'second' })
    expect(order).toEqual(['baidu', nativeId, 'bing'])
    expect(config.searchEngines).toEqual(['baidu', nativeId, 'bing'])
  })

  it('pins an explicitly selected native engine even outside the saved chain', async () => {
    const nativeSearch = vi.fn().mockResolvedValue(nativeResult)
    const runCli = vi.fn()
    const config = { searchEngines: ['bing', 'baidu'] }
    const search = createSearchRunner(config, { nativeSearch, runCli })
    expect(await search({ query: 'fixture', engine: ' DEEPSEEK-OFFICIAL ' })).toMatchObject({ engine: nativeId })
    expect(runCli).not.toHaveBeenCalled()
    expect(config.searchEngines).toEqual(['bing', 'baidu'])
  })

  it('pins one CLI engine without using native or the rest of the chain', async () => {
    const nativeSearch = vi.fn()
    const runCli = vi.fn().mockResolvedValue(failure('github', 'missing token'))
    const search = createSearchRunner({ searchEngines: [nativeId, 'bing'] }, { nativeSearch, runCli })
    expect(await search({ query: 'fixture', engine: 'github' })).toMatchObject({
      status: 'unavailable', engine: 'github', attempts: [{ engine: 'github', error: 'missing token' }],
    })
    expect(runCli).toHaveBeenCalledTimes(1)
    expect(runCli.mock.calls[0]?.[0]).toContain('--engine')
    expect(pinned(runCli.mock.calls[0]?.[0])).toBe('github')
    expect(nativeSearch).not.toHaveBeenCalled()
  })

  it.each(['unavailable', 'error'])('falls back on CLI status %s and preserves diagnostics', async (status) => {
    const runCli = vi.fn().mockResolvedValue(failure('bing', 'rate limited'))
    runCli.mockResolvedValue({ ...failure('bing', 'rate limited'), status, warnings: ['quota warning'], uncertainty: ['coverage incomplete'] })
    const nativeSearch = vi.fn().mockResolvedValue(nativeResult)
    const search = createSearchRunner({ searchEngines: ['bing', nativeId] }, { nativeSearch, runCli })
    expect(await search({ query: 'fixture' })).toMatchObject({
      engine: nativeId, attempts: [{ engine: 'bing', error: 'rate limited' }],
      warnings: ['quota warning'], uncertainty: ['coverage incomplete'],
    })
  })

  it.each([
    'NATIVE_DEPENDENCY_MISSING', 'NATIVE_HOST_UNSUPPORTED', 'NATIVE_CONFIG_UNAVAILABLE',
    'NATIVE_CONFIG_INVALID', 'NATIVE_DISPOSED', 'WEB_PROVIDER_CREDENTIAL_MISSING',
    'WEB_TIMEOUT', 'WEB_UPSTREAM_FAILURE', 'WEB_UNAVAILABLE', 'WEB_INVALID_RESPONSE',
  ])('preserves safe %s diagnostics without native exception details', async (code) => {
    const nativeSearch = vi.fn().mockRejectedValue(Object.assign(new Error('token=private-secret'), { code }))
    const search = createSearchRunner({ searchEngines: [nativeId] }, { nativeSearch })
    const result = await search({ query: 'fixture' })
    expect(result.status).toBe('unavailable')
    expect(result.attempts[0]?.error).toContain(`${code}:`)
    expect(JSON.stringify(result)).not.toContain('private-secret')
  })

  it('does not expose arbitrary native error codes or messages', async () => {
    const nativeSearch = vi.fn().mockRejectedValue(Object.assign(new Error('secret message'), { code: 'secret-code' }))
    const search = createSearchRunner({ searchEngines: [nativeId] }, { nativeSearch })
    expect((await search({ query: 'fixture' })).attempts).toEqual([{ engine: nativeId, error: 'Official search failed' }])
  })

  it('falls back safely when the official adapter is unavailable', async () => {
    const runCli = vi.fn().mockResolvedValue(cliResult('baidu'))
    const search = createSearchRunner({ searchEngines: [nativeId, 'baidu'] }, { runCli })
    expect(await search({ query: 'fixture' })).toMatchObject({
      engine: 'baidu', attempts: [{ engine: nativeId, error: 'WEB_UNAVAILABLE: official search is unavailable' }],
    })
  })

  it.each([null, {}, { content: 'broken', sources: null }, { content: 'broken', sources: [{ title: 'no URL' }] }])(
    'distinguishes malformed official responses from legitimate zero hits: %j', async (badResult) => {
      const nativeSearch = vi.fn().mockResolvedValue(badResult)
      const runCli = vi.fn().mockResolvedValue(cliResult('bing'))
      const search = createSearchRunner({ searchEngines: [nativeId, 'bing'] }, { nativeSearch, runCli })
      expect(await search({ query: 'fixture' })).toMatchObject({
        engine: 'bing', attempts: [{ engine: nativeId, error: 'WEB_INVALID_RESPONSE: official search returned an invalid result' }],
      })
    },
  )

  it('returns every failed attempt in order after exhausting a mixed chain', async () => {
    const nativeSearch = vi.fn().mockRejectedValue(new Error('secret'))
    const runCli = vi.fn(async (args: string[]) => failure(pinned(args)!))
    const search = createSearchRunner({ searchEngines: ['bing', nativeId, 'baidu'] }, { nativeSearch, runCli })
    const result = await search({ query: 'fixture' })
    expect(result).toMatchObject({ status: 'unavailable', engine: 'chain', items: [], warnings: [], uncertainty: [] })
    expect(result.attempts.map((attempt: any) => attempt.engine)).toEqual(['bing', nativeId, 'baidu'])
    expect(result.summary).toContain('All search engines failed:')
    expect(JSON.stringify(result)).not.toContain('secret')
  })
})

describe('search cancellation and engine timeouts', () => {
  it('does no work when the caller is already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const nativeSearch = vi.fn()
    const runCli = vi.fn()
    const search = createSearchRunner({ searchEngines: [nativeId, 'bing'] }, { nativeSearch, runCli })
    await expect(search({ query: 'fixture' }, controller.signal)).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    expect(nativeSearch).not.toHaveBeenCalled()
    expect(runCli).not.toHaveBeenCalled()
  })

  it('immediately cancels an adapter that ignores its signal, without fallback', async () => {
    const controller = new AbortController()
    const nativeSearch = vi.fn(never)
    const runCli = vi.fn()
    const search = createSearchRunner({ searchEngines: [nativeId, 'bing'] }, { nativeSearch, runCli })
    const pending = search({ query: 'fixture' }, controller.signal)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    await rejected
    expect((nativeSearch.mock.calls[0] as any)?.[1].aborted).toBe(true)
    expect(runCli).not.toHaveBeenCalled()
  })

  it.each(['native', 'cli'])('propagates %s WEB_ABORTED without trying another engine', async (source) => {
    const error = Object.assign(new Error('cancelled'), { code: 'WEB_ABORTED' })
    const nativeSearch = vi.fn().mockRejectedValue(error)
    const runCli = vi.fn().mockRejectedValue(error)
    const search = createSearchRunner({ searchEngines: source === 'native' ? [nativeId, 'bing'] : ['bing', nativeId] }, { nativeSearch, runCli })
    await expect(search({ query: 'fixture' })).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    expect(source === 'native' ? runCli : nativeSearch).not.toHaveBeenCalled()
  })

  it('times out native search, aborts its signal, and falls back', async () => {
    vi.useFakeTimers()
    const nativeSearch = vi.fn(never)
    const runCli = vi.fn().mockResolvedValue(cliResult('bing'))
    const search = createSearchRunner({ searchEngines: [nativeId, 'bing'], searchTimeoutMs: 25 }, { nativeSearch, runCli })
    const pending = search({ query: 'fixture' })
    await vi.advanceTimersByTimeAsync(25)
    expect(await pending).toMatchObject({
      engine: 'bing', attempts: [{ engine: nativeId, error: 'WEB_TIMEOUT: official search timed out' }],
    })
    expect((nativeSearch.mock.calls[0] as any)?.[1].aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('treats abort triggered by its own timeout as timeout, rather than external cancellation', async () => {
    vi.useFakeTimers()
    const nativeSearch = vi.fn((_request, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('native abort'), { code: 'WEB_ABORTED' })), { once: true })
    }))
    const runCli = vi.fn().mockResolvedValue(cliResult('bing'))
    const search = createSearchRunner({ searchEngines: [nativeId, 'bing'], searchTimeoutMs: 25 }, { nativeSearch, runCli })
    const pending = search({ query: 'fixture' })
    await vi.advanceTimersByTimeAsync(25)
    expect((await pending).engine).toBe('bing')
  })

  it('applies the same per-engine timeout to a CLI attempt in a mixed chain', async () => {
    vi.useFakeTimers()
    const nativeSearch = vi.fn().mockResolvedValue(nativeResult)
    const runCli = vi.fn(never)
    const search = createSearchRunner({ searchEngines: ['bing', nativeId], searchTimeoutMs: 10 }, { nativeSearch, runCli })
    const pending = search({ query: 'fixture' })
    await vi.advanceTimersByTimeAsync(10)
    expect(await pending).toMatchObject({
      engine: nativeId, attempts: [{ engine: 'bing', error: 'WEB_TIMEOUT: search engine timed out' }],
    })
    expect((runCli.mock.calls[0] as any)?.[1].aborted).toBe(true)
  })

  it('lets the caller deadline stop the chain before the engine timeout', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const nativeSearch = vi.fn(never)
    const runCli = vi.fn()
    const search = createSearchRunner({ searchEngines: [nativeId, 'bing'], searchTimeoutMs: 100 }, { nativeSearch, runCli })
    const pending = search({ query: 'fixture' }, controller.signal)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    setTimeout(() => controller.abort(), 10)
    await vi.advanceTimersByTimeAsync(10)
    await rejected
    expect(runCli).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds the whole chain even without an external signal and never falls back after the deadline', async () => {
    vi.useFakeTimers()
    const nativeSearch = vi.fn(never)
    const runCli = vi.fn(never)
    const search = createSearchRunner(
      { searchEngines: [nativeId, 'bing', 'baidu'], searchTimeoutMs: 40 },
      { nativeSearch, runCli, totalTimeoutMs: 55 },
    )
    const pending = search({ query: 'fixture' })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'WEB_TIMEOUT', message: 'Web search timed out' })
    await vi.advanceTimersByTimeAsync(40)
    expect(runCli).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15)
    await rejected
    expect(runCli).toHaveBeenCalledTimes(1)
    expect((runCli.mock.calls[0] as any)?.[1].aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('defaults the whole-chain budget to 55 seconds', async () => {
    vi.useFakeTimers()
    const nativeSearch = vi.fn(never)
    const runCli = vi.fn()
    const search = createSearchRunner({ searchEngines: [nativeId, 'bing'], searchTimeoutMs: 60_000 }, { nativeSearch, runCli })
    const pending = search({ query: 'fixture' })
    const rejected = expect(pending).rejects.toMatchObject({ code: 'WEB_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(55_000)
    await rejected
    expect(runCli).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleans up the caller listener and engine timer after success', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const search = createSearchRunner({ searchEngines: [nativeId] }, { nativeSearch: vi.fn().mockResolvedValue(nativeResult) })
    await search({ query: 'fixture' }, controller.signal)
    expect(add).toHaveBeenCalledTimes(1)
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]?.[1])
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('legacy configurations and unknown IDs', () => {
  it('keeps old saved configs and the unchanged default chain on one CLI invoke', async () => {
    const config = defaultConfig({ searchEngines: ['duckduckgo', 'bing', 'baidu'] })
    const saved = JSON.stringify(snapshotForPersist(config))
    const nativeSearch = vi.fn()
    const runCli = vi.fn().mockResolvedValue(cliResult('duckduckgo'))
    const search = createSearchRunner(config, { nativeSearch, runCli })
    expect((await search({ query: 'fixture', count: 4 })).engine).toBe('duckduckgo')
    expect(runCli).toHaveBeenCalledTimes(1)
    expect(runCli.mock.calls[0]?.[0]).toEqual(['search', '-q', 'fixture', '--max-results', '4', '-t', '55000'])
    expect(runCli.mock.calls[0]?.[2].searchEngines).toEqual(['duckduckgo', 'bing', 'baidu'])
    expect(JSON.stringify(snapshotForPersist(config))).toBe(saved)
    expect(defaultConfig({}).searchEngines).toEqual(['bing', 'duckduckgo', 'baidu'])
    expect(nativeSearch).not.toHaveBeenCalled()
  })

  it('retains the legacy CLI error behavior while converting cancellation to WEB_ABORTED', async () => {
    const runCli = vi.fn().mockRejectedValue(new Error('legacy unavailable diagnostics'))
    const search = createSearchRunner({}, { runCli })
    await expect(search({ query: 'fixture' })).rejects.toThrow('legacy unavailable diagnostics')
    runCli.mockRejectedValue(Object.assign(new Error('cancelled'), { code: 'WEB_ABORTED' }))
    await expect(search({ query: 'fixture' })).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('keeps the CLI case/whitespace normalization without rewriting the saved array', async () => {
    const config = { searchEngines: [' BING ', 'DuckDuckGo'] }
    const runCli = vi.fn().mockResolvedValue(cliResult('bing'))
    const search = createSearchRunner(config, { runCli })
    await search({ query: 'fixture' })
    expect(runCli.mock.calls[0]?.[2].searchEngines).toEqual(['bing', 'duckduckgo'])
    expect(config.searchEngines).toEqual([' BING ', 'DuckDuckGo'])
  })

  it('snapshots request and chain before returning control to its caller', async () => {
    const config = { searchEngines: [nativeId, 'bing'] }
    const request = { query: 'original' }
    const nativeSearch = vi.fn().mockResolvedValue(nativeResult)
    const runCli = vi.fn()
    const search = createSearchRunner(config, { nativeSearch, runCli })
    const pending = search(request)
    config.searchEngines.splice(0, 2, 'baidu')
    request.query = 'changed'
    await pending
    expect(nativeSearch.mock.calls[0]?.[0]).toEqual({ query: 'original', maxResults: 10 })
    expect(runCli).not.toHaveBeenCalled()
  })

  it('keeps the private known-CLI list exactly aligned with the registered CLI engines', () => {
    const source = readFileSync(new URL('../dsh/search.js', import.meta.url), 'utf8')
    const declaration = source.match(/const CLI_ENGINE_IDS = (\[[^\n]+\])/)
    expect(declaration).not.toBeNull()
    const ids = JSON.parse(declaration![1]!.replaceAll("'", '"'))
    const registry = new SearchEngineRegistry()
    expect(ids.sort()).toEqual(registerDefaultEngines(registry).map((engine) => engine.id).sort())
  })

  it('does not let an unknown explicit override reach any backend or default engine', async () => {
    const nativeSearch = vi.fn()
    const runCli = vi.fn()
    const search = createSearchRunner({ searchEngines: ['bing', nativeId] }, { nativeSearch, runCli })
    expect(await search({ query: 'fixture', engine: 'does-not-exist' })).toMatchObject({
      status: 'unavailable', engine: 'does-not-exist', attempts: [{ engine: 'does-not-exist', error: 'Unknown search engine id' }],
    })
    expect(nativeSearch).not.toHaveBeenCalled()
    expect(runCli).not.toHaveBeenCalled()
  })

  it('does not silently replace an unknown-only chain with a default', async () => {
    const runCli = vi.fn()
    const search = createSearchRunner({ searchEngines: ['typo'] }, { runCli })
    expect(await search({ query: 'fixture' })).toMatchObject({
      status: 'unavailable', attempts: [{ engine: 'typo', error: 'Unknown search engine id' }],
    })
    expect(runCli).not.toHaveBeenCalled()
  })

  it('records unknown chain IDs and explicitly pins the following CLI attempt', async () => {
    const runCli = vi.fn().mockResolvedValue(cliResult('bing'))
    const search = createSearchRunner({ searchEngines: ['typo', 'bing'] }, { runCli })
    expect(await search({ query: 'fixture' })).toMatchObject({
      engine: 'bing', attempts: [{ engine: 'typo', error: 'Unknown search engine id' }],
    })
    expect(pinned(runCli.mock.calls[0]?.[0])).toBe('bing')
  })
})
