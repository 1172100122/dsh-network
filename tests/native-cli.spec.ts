import { describe, expect, it, vi } from 'vitest'
import { runOnce } from '../src/cli.ts'
import { runClientFetch } from '../src/client.ts'

vi.mock('../src/client.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/client.ts')>(),
  runClientFetch: vi.fn(() => { throw new Error('No network allowed in this test') }),
}))

describe('standalone CLI native search boundary', () => {
  it.each([
    { argv: ['search', '-q', 'fixture', '--engine', 'deepseek-official'], env: {} },
    { argv: ['search', '-q', 'fixture'], env: { DSH_NETWORK_SEARCH_ENGINES: 'deepseek-official,bing' } },
    { argv: ['search', '-q', 'fixture'], env: { DSH_NETWORK_SEARCH_ENGINES: 'deepseek-official' } },
  ])('reports host-only rather than silently replacing native search', async ({ argv, env }) => {
    const result = await runOnce(argv, { env })
    expect(result.ok).toBe(false)
    expect(result.results[0]).toMatchObject({ engine: 'deepseek-official', status: 'unavailable', items: [] })
    expect(result.results[0]?.summary).toContain('host-only')
    expect(runClientFetch).not.toHaveBeenCalled()
  })
})
