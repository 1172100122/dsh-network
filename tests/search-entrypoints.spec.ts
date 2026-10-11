import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { makeSearchProvider } from '../dsh/providers.js'
import { registerWebSearchTool } from '../dsh/tools.js'
import { registerSearchRoute } from '../dsh/routes.js'
import { defaultConfig } from '../dsh/config-summary.js'

const entry = {
  status: 'ok', engine: 'deepseek-official', summary: 'native result', truncated: true,
  items: [{ url: 'https://example.test', title: 'Fixture', published_at: '2026-10-11' }],
  warnings: [], uncertainty: [], attempts: [],
}

describe('one host search path for every entrypoint', () => {
  it('preserves official truncation and dates through the web seam', async () => {
    const search = vi.fn().mockResolvedValue(entry)
    const signal = new AbortController().signal
    const provider = makeSearchProvider(defaultConfig({}), search)
    const result = await provider.search({ query: 'fixture', maxResults: 2 }, signal)
    expect(search).toHaveBeenCalledWith({ query: 'fixture', count: 2 }, signal)
    expect(result).toMatchObject({ truncated: true, sources: [{ url: 'https://example.test', publishedAt: '2026-10-11' }] })
  })

  it('lets tools pin native even when it was added after startup', async () => {
    let tool: any
    const config = defaultConfig({ searchEngines: ['bing'] })
    const search = vi.fn().mockResolvedValue(entry)
    registerWebSearchTool({ tools: { register(value: any) { tool = value } }, systemPrompt: { section() {} } }, config, search)
    expect(tool.parameters.properties.engine.enum).toContain('deepseek-official')
    const signal = new AbortController().signal
    const output = await tool.execute({ query: 'fixture', count: 2, engine: 'deepseek-official' }, { signal })
    expect(search).toHaveBeenCalledWith({ query: 'fixture', count: 2, engine: 'deepseek-official' }, signal)
    expect(tool.output.presentationMeta({}, output)).toMatchObject({ truncated: true, sources: [{ publishedAt: '2026-10-11' }] })
    config.webSearchTool = false
    await expect(tool.execute({ query: 'fixture' }, { signal })).rejects.toThrow('disabled')
  })

  it('uses the shared path in the side panel and aborts on disconnect', async () => {
    let route: any
    let receivedSignal: AbortSignal | undefined
    let finish!: (entry: unknown) => void
    const search = vi.fn((_args, signal) => {
      receivedSignal = signal
      return new Promise(resolve => { finish = resolve })
    })
    registerSearchRoute({ inject(_names: string[], fn: any) { fn({ webServer: { register(value: any) { route = value } } }) } }, defaultConfig({}), search)
    const req: any = new EventEmitter()
    req.method = 'GET'; req.url = '/dsh-network/search?q=fixture&count=2&engine=deepseek-official'
    req.headers = { host: '127.0.0.1:3080' }
    const res: any = new EventEmitter()
    res.writeHead = vi.fn(() => res)
    res.end = vi.fn(() => { res.writableEnded = true })
    const pending = route.handler(req, res)
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1))
    expect(search.mock.calls[0]?.[0]).toEqual({ query: 'fixture', count: 2, engine: 'deepseek-official' })
    res.emit('close')
    expect(receivedSignal?.aborted).toBe(true)
    finish(entry)
    await pending
    expect(req.listenerCount('aborted')).toBe(0)
    expect(res.listenerCount('close')).toBe(0)
  })
})
