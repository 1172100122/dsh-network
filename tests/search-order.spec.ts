/** Settings → persistent snapshot → host env → actual CLI fallback order. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyCardSettings, defaultConfig, summarize } from '../dsh/config-summary.js'
import { snapshotForPersist } from '../dsh/persist.js'
import { configToEnv } from '../dsh/serverClient.js'
import { runOnce } from '../src/cli.ts'
import { runClientFetch } from '../src/client.ts'

vi.mock('../src/client.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/client.ts')>(),
  runClientFetch: vi.fn(),
}))

beforeEach(() => {
  vi.mocked(runClientFetch).mockReset()
  // No real engine traffic. A deterministic failure forces every fallback.
  vi.mocked(runClientFetch).mockRejectedValue(new Error('fixture unavailable'))
})

describe('saved engine order', () => {
  it.each([
    ['baidu', 'bing', 'duckduckgo'],
    ['duckduckgo', 'baidu', 'bing'],
  ])('executes the saved chain %j after a restart-shaped reload', async (...order) => {
    const config = defaultConfig({ searchEngines: ['bing', 'duckduckgo', 'baidu'] })
    expect(applyCardSettings(config, { searchEngines: order })).toEqual({ ok: true })
    const restored = defaultConfig(JSON.parse(JSON.stringify(snapshotForPersist(config))))
    expect(summarize(restored).searchEngines).toEqual(order)
    const env = configToEnv(restored)
    expect(env.DSH_NETWORK_SEARCH_ENGINES).toBe(order.join(','))
    const result = await runOnce(['search', '-q', 'fixture'], { env })
    expect(result.results[0]).toMatchObject({
      status: 'unavailable',
      attempts: order.map(engine => ({ engine, error: 'fixture unavailable' })),
    })
    expect(runClientFetch).toHaveBeenCalledTimes(order.length)
  })

  it('retains an existing chain when a different setting is edited', () => {
    const config = defaultConfig({ searchEngines: ['duckduckgo', 'bing'] })
    applyCardSettings(config, { searchMaxResults: 5 })
    expect(config.searchEngines).toEqual(['duckduckgo', 'bing'])
  })
})
