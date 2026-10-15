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

describe('web_sitemap standalone CLI', () => {
  it('--digest scopes to the query, not the whole catalog (regression)', async () => {
    const result = await runOnce(['sitemap', '-q', 'github', '--digest'])
    const entry = result.results[0]
    expect(entry?.kind).toBe('sitemap')
    if (entry?.kind !== 'sitemap') return
    expect(entry.entries.length).toBeGreaterThan(0)
    expect(entry.entries.length).toBeLessThan(178) // sanity: catalog is larger than a focused query

    // The digest MUST share the same scope as `entries`; otherwise the
    // 178-row catalog would land in the model's context over a focused
    // "github" question.
    expect(typeof entry.digest).toBe('string')
    expect(entry.digest).not.toBe('')
    const digestDomains = (entry.digest as string)
      .split('\n')
      .filter((l) => l.startsWith('- '))
      .map((l) => l.split(' ')[1]!)
    expect(digestDomains.length).toBe(entry.entries.length)
    expect(digestDomains.every((d) => entry.entries.some((e) => e.domain === d))).toBe(true)
    // Focused: github / gitlab / related, NOT wikipedia / baidu / …
    expect(digestDomains.some((d) => /github|gitlab|gitee|bitbucket/.test(d))).toBe(true)
    expect(digestDomains.some((d) => /wikipedia|baidu/i.test(d))).toBe(false)
  })

  it('--digest alone dumps the whole catalog (legacy behavior preserved)', async () => {
    const result = await runOnce(['sitemap', '--digest'])
    const entry = result.results[0]
    if (entry?.kind !== 'sitemap') throw new Error('expected sitemap entry')
    const digestRows = entry.digest!.split('\n').filter((l) => l.startsWith('- '))
    expect(digestRows.length).toBeGreaterThan(50) // catalog has 178 portals
  })

  it('--digest with --limit mirrors the entry cap', async () => {
    const result = await runOnce(['sitemap', '-q', 'rust', '--digest', '--limit', '3'])
    const entry = result.results[0]
    if (entry?.kind !== 'sitemap') throw new Error('expected sitemap entry')
    expect(entry.entries.length).toBeLessThanOrEqual(3)
    const digestRows = entry.digest!.split('\n').filter((l) => l.startsWith('- '))
    expect(digestRows.length).toBeLessThanOrEqual(3)
    expect(digestRows.length).toBe(entry.entries.length)
    // Same set — cap applies to entries AND digest, not just one of them.
    const digestDomains = new Set(digestRows.map((l) => l.split(' ')[1]!))
    const entryDomains = new Set(entry.entries.map((e) => e.domain))
    expect(digestDomains).toEqual(entryDomains)
  })

  it('--digest over a query with no matches produces an empty digest (not the whole catalog)', async () => {
    // The OLD bug dumped all 178 entries into the digest even with a
    // narrow lookup; the fix scopes the digest to the query, and an
    // unmatched query produces an empty digest (a soft signal, not noise).
    const result = await runOnce(['sitemap', '-q', 'xyzzyqq-nonexistent', '--digest'])
    const entry = result.results[0]
    if (entry?.kind !== 'sitemap') throw new Error('expected sitemap entry')
    expect(entry.entries.length).toBe(0)
    expect(entry.digest).toBe('')
    expect(entry.uncertainty).toContain('no entries matched the requested filter')
  })
})
