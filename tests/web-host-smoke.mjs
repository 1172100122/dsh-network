/** Actual DSH tool + web-service contracts; synthetic search and loopback fetch only. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { defaultConfig } from '../dsh/config-summary.js'
import { makeSearchProvider, makeFetchProvider } from '../dsh/providers.js'
import { registerWebFetchTool, registerHttpRequestTool } from '../dsh/tools.js'
import { getNetworkClient, releaseNetworkClient } from '../dsh/cli-runner.js'

const anchor = process.env.DSH_HOST_INSTALL_ANCHOR
if (!anchor) {
  console.log('SKIP web host smoke: set DSH_HOST_INSTALL_ANCHOR to the host package.json')
  process.exit(0)
}
const hostRequire = createRequire(resolve(anchor))
const hostImport = name => import(pathToFileURL(hostRequire.resolve(name)).href)
const [{ Context }, { default: WebRuntime }, toolWeb] = await Promise.all([
  hostImport('@deepseek-ai/cordis'), hostImport('@deepseek-ai/dsh-web'), hostImport('@deepseek-ai/dsh-tool-web'),
])
const root = new Context()
const body = 'fixture line '.repeat(2500).trim()
let requests = 0
const server = createServer((_req, res) => {
  requests++
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(body)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/fixture`
// The opt-out is confined to this synthetic loopback origin. No real user config is read.
const config = defaultConfig({ ssrfProtection: false, searchEngines: ['bing'] })
const calls = []
const search = async (request, signal) => {
  signal?.throwIfAborted()
  calls.push({ request, signal })
  return {
    status: 'ok', engine: 'fixture', summary: `results:${request.query}`, truncated: false,
    items: [0, 1].map(i => ({ url: `https://fixture.invalid/${request.query}/${i}`, title: `${request.query}:${i}` })),
    uncertainty: [], warnings: [], attempts: [],
  }
}
try {
  await root.plugin(WebRuntime, { searchProvider: 'dsh-network', fetchProvider: 'dsh-network' })
  const web = root.get('web')
  web.registerSearchProvider(makeSearchProvider(config, search))
  web.registerFetchProvider(makeFetchProvider(config))
  const tools = new Map()
  const context = { web, tools: { register: tool => tools.set(tool.name, tool) }, systemPrompt: { section() {}, getSectionOrder() { return 110 } } }
  toolWeb.applyWebSearchTool(context, 2, 4, 60000, true)
  toolWeb.applyWebFetchTool(context, 60000, 200000)
  const signal = new AbortController().signal
  const officialSearch = tools.get('web_search')
  const result = await officialSearch.execute({ queries: ['alpha', 'beta'] }, { signal })
  assert.equal(calls.length, 2)
  assert.ok(calls.every(call => call.request.count === 2 && call.signal instanceof AbortSignal))
  assert.equal(result.sources.length, 2)
  assert.equal(result.truncated, true)
  for (const query of ['alpha', 'beta']) {
    assert.ok(result.content.includes(`### ${query}`))
    for (const i of [0, 1]) assert.ok(result.content.includes(`https://fixture.invalid/${query}/${i}`))
  }
  console.log('PASS official queries[] search retains each query section despite the pooled source cap')

  const officialFetch = tools.get('web_fetch')
  const fetched = await officialFetch.execute({ url }, { signal })
  assert.equal(fetched.statusCode, 200)
  assert.equal(fetched.body.kind, 'text')
  assert.equal(fetched.truncated, true)
  const cacheId = fetched.body.content.match(/cacheId="([^"]+)"/)?.[1]
  assert.ok(cacheId, 'official fetch must retain the paging hint from the provider')
  assert.ok(officialFetch.output.render({ url }, fetched)[0].text.includes(cacheId))
  console.log('PASS official url-only fetch preserves the Markdown/text body, truncation and paging hint')

  registerHttpRequestTool(context, config)
  const http = tools.get('http_request')
  const paged = await http.execute({ cacheId, offset: 20000, limit: 1000 }, { signal })
  assert.equal(paged.body, body.slice(20000, 21000))
  assert.equal(requests, 1, 'paging must not download the origin again')
  console.log('PASS official fetch preview can be continued through the plugin http_request cache')

  registerWebFetchTool(context, config)
  const ownFetch = tools.get('web_fetch')
  const ownResult = await ownFetch.execute({ url }, { signal })
  assert.equal(ownResult.cacheId, cacheId)
  const beforePaging = requests
  const ownPage = await ownFetch.execute({ cacheId, offset: 20000, limit: 1000 }, { signal })
  assert.equal(ownPage.content, body.slice(20000, 21000))
  assert.equal(requests, beforePaging)
  console.log('PASS standalone plugin fetch and official preset fetch share the same paging cache')

  const before = calls.length
  await assert.rejects(officialSearch.execute({ queries: ['cancelled'] }, { signal: AbortSignal.abort() }))
  assert.equal(calls.length, before)
  console.log('PASS pre-aborted official tool call never dispatches a search')
  console.log('Web host smoke: 5 checks passed; zero external network requests')
} finally {
  const client = getNetworkClient()
  await client.dispose()
  releaseNetworkClient(client)
  await root.fiber.dispose()
  await new Promise(resolve => server.close(resolve))
}
