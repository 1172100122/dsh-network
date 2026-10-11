import { describe, expect, it, vi } from 'vitest'
import { createNativeSearch } from '../dsh/native-search.js'

function bench() {
  let config: Record<string, unknown> = { apiKeyEnv: 'DEEPSEEK_API_KEY', model: 'first' }
  const result = { sources: [{ url: 'https://example.test' }], truncated: false }
  const search = vi.fn().mockResolvedValue(result)
  const web = { search }
  const nativeModule = { apply() {}, Config: vi.fn(), WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE: 'web-search-deepseek' }
  const webFiber = { dispose: vi.fn() }
  const nativeFiber = { update: vi.fn(), await: vi.fn(), dispose: vi.fn() }
  const scope = { plugin: vi.fn().mockResolvedValueOnce(webFiber).mockResolvedValueOnce(nativeFiber), get: vi.fn(() => web) }
  const settings = { describe: vi.fn(() => [{ ns: 'web-search-deepseek', value: config }]) }
  const ctx = { plugin() {}, isolate: vi.fn(() => scope), get: vi.fn(() => settings) }
  const loadModules = vi.fn().mockResolvedValue({ WebRuntime: class {}, nativeModule })
  const adapter = createNativeSearch(ctx, { loadModules })
  return { adapter, ctx, scope, loadModules, nativeModule, webFiber, nativeFiber, settings, search, result,
    setConfig(value: Record<string, unknown>) { config = value } }
}

describe('official native adapter', () => {
  it('lazily loads optional peers and creates only one isolated provider', async () => {
    const b = bench()
    expect(b.loadModules).not.toHaveBeenCalled()
    const answers = await Promise.all([b.adapter.search({ query: 'a' }), b.adapter.search({ query: 'b' })])
    expect(answers).toEqual([b.result, b.result])
    expect(b.ctx.isolate).toHaveBeenCalledWith('web')
    expect(b.loadModules).toHaveBeenCalledTimes(1)
    expect(b.scope.plugin).toHaveBeenCalledTimes(2)
    expect(b.scope.plugin.mock.calls[0]?.[1]).toEqual({ searchProvider: 'deepseek-official' })
    expect(b.scope.get).toHaveBeenCalledWith('web')
  })

  it('synchronizes changed native settings with noSave and avoids unchanged restarts', async () => {
    const b = bench()
    await b.adapter.search({ query: 'before' })
    b.setConfig({ apiKeyEnv: 'DEEPSEEK_API_KEY', model: 'after', unrelated: 'do not copy' })
    await b.adapter.search({ query: 'after' })
    expect(b.nativeFiber.update).toHaveBeenCalledWith({ apiKeyEnv: 'DEEPSEEK_API_KEY', model: 'after' }, true)
    expect(b.nativeFiber.await).toHaveBeenCalledTimes(1)
    await b.adapter.search({ query: 'unchanged' })
    expect(b.nativeFiber.update).toHaveBeenCalledTimes(1)
  })

  it('does not serialize requests behind slow in-flight network I/O', async () => {
    const b = bench()
    let finish!: (value: unknown) => void
    b.search.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const first = b.adapter.search({ query: 'slow' })
    await vi.waitFor(() => expect(b.search).toHaveBeenCalledTimes(1))
    const second = await b.adapter.search({ query: 'fast' })
    expect(second).toEqual(b.result)
    finish(b.result)
    await first
  })

  it('passes cancellation through and never initializes for pre-cancelled work', async () => {
    const b = bench()
    const controller = new AbortController()
    controller.abort()
    await expect(b.adapter.search({ query: 'cancel' }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(b.loadModules).not.toHaveBeenCalled()
    const active = new AbortController()
    await b.adapter.search({ query: 'active' }, active.signal)
    expect(b.search).toHaveBeenCalledWith({ query: 'active' }, active.signal)
  })

  it('fails clearly on unsupported host or missing dependencies without CLI side effects', async () => {
    await expect(createNativeSearch({}).search({ query: 'x' })).rejects.toMatchObject({ code: 'NATIVE_HOST_UNSUPPORTED' })
    const b = bench()
    const missing = Object.assign(new Error('fixture unavailable'), { code: 'NATIVE_DEPENDENCY_MISSING' })
    b.loadModules.mockRejectedValueOnce(missing)
    await expect(b.adapter.search({ query: 'x' })).rejects.toBe(missing)
    expect(b.scope.plugin).not.toHaveBeenCalled()
    // A temporary load failure does not poison future initialization.
    await expect(b.adapter.search({ query: 'retry' })).resolves.toEqual(b.result)
  })

  it('rejects absent native settings instead of silently using another endpoint', async () => {
    const b = bench()
    b.settings.describe.mockReturnValue([])
    await expect(b.adapter.search({ query: 'x' })).rejects.toMatchObject({ code: 'NATIVE_CONFIG_UNAVAILABLE' })
    expect(b.scope.plugin).not.toHaveBeenCalled()
  })

  it('uses official defaults when a headless host has no settings service', async () => {
    const b = bench()
    b.ctx.get.mockReturnValue(undefined)
    await b.adapter.search({ query: 'x' })
    expect(b.scope.plugin.mock.calls[1]?.[1]).toEqual({})
  })

  it('validates native settings without exposing schema errors or secrets', async () => {
    const b = bench()
    b.nativeModule.Config.mockImplementation(() => { throw new Error('secret fixture must not escape') })
    await expect(b.adapter.search({ query: 'x' })).rejects.toMatchObject({ code: 'NATIVE_CONFIG_INVALID' })
    await expect(b.adapter.search({ query: 'x' })).rejects.not.toThrow('secret fixture')
  })

  it('cleans up partial initialization and allows a later retry', async () => {
    const b = bench()
    b.scope.plugin.mockReset().mockResolvedValueOnce(b.webFiber).mockRejectedValueOnce(new Error('load failure'))
      .mockResolvedValueOnce(b.webFiber).mockResolvedValueOnce(b.nativeFiber)
    await expect(b.adapter.search({ query: 'fail' })).rejects.toMatchObject({ code: 'NATIVE_HOST_UNSUPPORTED' })
    expect(b.webFiber.dispose).toHaveBeenCalledTimes(1)
    await expect(b.adapter.search({ query: 'retry' })).resolves.toEqual(b.result)
  })

  it('disposes a real-style rejected thenable fiber before retrying', async () => {
    const b = bench()
    const failedFiber = { then(_resolve: unknown, reject: (error: Error) => void) { reject(new Error('startup failed')) }, dispose: vi.fn() }
    b.scope.plugin.mockReset().mockReturnValueOnce(failedFiber)
    await expect(b.adapter.search({ query: 'fail' })).rejects.toMatchObject({ code: 'NATIVE_HOST_UNSUPPORTED' })
    expect(failedFiber.dispose).toHaveBeenCalledTimes(1)
    b.scope.plugin.mockResolvedValueOnce(b.webFiber).mockResolvedValueOnce(b.nativeFiber)
    await expect(b.adapter.search({ query: 'retry' })).resolves.toEqual(b.result)
  })

  it('disposes only its two child fibers and refuses later calls', async () => {
    const b = bench()
    await b.adapter.search({ query: 'x' })
    await b.adapter.dispose()
    expect(b.nativeFiber.dispose).toHaveBeenCalledTimes(1)
    expect(b.webFiber.dispose).toHaveBeenCalledTimes(1)
    await expect(b.adapter.search({ query: 'after' })).rejects.toMatchObject({ code: 'NATIVE_DISPOSED' })
  })
})
