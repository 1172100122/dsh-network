/**
 * Opt-in integration smoke against actual installed DSH packages.
 * DSH_HOST_INSTALL_ANCHOR=/absolute/path/to/dsh/package.json \
 *   node --expose-internals tests/native-host-smoke.mjs
 *
 * Uses a temporary profile and the host's own runtime resolver. All fetches,
 * credentials, account tokens, environment and settings are controlled fakes.
 * Does not start DSH, read a real profile, or make network requests.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, symlink, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const anchor = process.env.DSH_HOST_INSTALL_ANCHOR
if (!anchor) {
  console.log('SKIP native host smoke: set DSH_HOST_INSTALL_ANCHOR to the host package.json')
  process.exit(0)
}
const hostRequire = createRequire(resolve(anchor))
const hostImport = (name) => import(pathToFileURL(hostRequire.resolve(name)).href)
const [{ Context }, { PluginPackages, createRuntimeResolution }, { default: WebRuntime }] = await Promise.all([
  hostImport('@deepseek-ai/cordis'),
  hostImport('@deepseek-ai/dsh-app-boot'),
  hostImport('@deepseek-ai/dsh-web'),
])
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'dsh-network-native-smoke-'))
const home = join(temporary, 'home')
const profileDir = join(home, 'profiles', 'test')
const profileModules = join(profileDir, 'node_modules', '@naivg')
const originalFetch = globalThis.fetch
const calls = []
const audits = []
const updates = []
const pending = new Map()
const credentialCalls = []
const accountCalls = []
let credential = 'FAKE_KEY_INITIAL'
let accountRoute = false
let accountToken = 'FAKE_ACCOUNT_TOKEN'
let credentialBlock
let nativeConfig = {
  apiKeyEnv: 'FAKE_CREDENTIAL_REF',
  baseURL: 'https://native.invalid/anthropic/v1',
  model: 'fixture-model-one',
  maxTokens: 100,
  maxUses: 2,
  ignoredField: 'not passed to the provider',
}
const root = new Context()
let adapter
let passed = 0

function deferred() {
  let resolvePromise
  let rejectPromise
  const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

async function until(predicate, label) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function response(query) {
  return new Response(JSON.stringify({ content: [
    { type: 'text', text: 'untrusted answer must not escape', citations: [{ url: 'https://result.invalid/a', cited_text: `snippet:${query}` }] },
    { type: 'web_search_tool_result', content: [
      { type: 'web_search_result', url: 'https://result.invalid/a', title: `first:${query}` },
      { type: 'web_search_result', url: 'https://result.invalid/b', title: `second:${query}` },
    ] },
  ] }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function pass(name) {
  passed++
  console.log(`PASS ${name}`)
}

async function filesBelow(path) {
  const result = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name)
    if (entry.isDirectory()) result.push(...await filesBelow(file))
    else if (entry.isFile()) result.push([file, await readFile(file, 'utf8')])
    // Do not follow the repository link or inspect any real host data.
  }
  return result.sort(([a], [b]) => a.localeCompare(b))
}

globalThis.fetch = async (url, init) => {
  assert.match(String(url), /^https:\/\/(?:native|changed)\.invalid\//)
  assert.equal(init.method, 'POST')
  assert.equal(init.redirect, 'error')
  const body = JSON.parse(init.body)
  const query = body.messages[0].content[0].text.replace('Perform a web search for the query: ', '')
  calls.push({ url: String(url), init, body, query })
  const hold = pending.get(query)
  if (hold) {
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    init.signal?.addEventListener('abort', () => hold.reject(new DOMException('Aborted', 'AbortError')), { once: true })
    await hold.promise
  }
  return response(query)
}

try {
  await mkdir(profileModules, { recursive: true })
  await symlink(repository, join(profileModules, 'dsh-network'), process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({
    name: 'native-smoke-profile', private: true,
    dependencies: { '@naivg/dsh-network': `link:${repository}` },
    dsh: { profile: { bundles: [] } },
  }))
  const profile = { name: 'test', dir: profileDir, layers: [], patches: [], skippedBundles: [], patchPath: join(profileDir, 'cordis.patch.yml') }
  const resolution = await createRuntimeResolution({ installAnchor: resolve(anchor), home, profile })
  await root.plugin(PluginPackages, { resolution })
  const { createNativeSearch } = await import(pathToFileURL(join(repository, 'dsh', 'native-search.js')).href)

  root.provide('launchEnvironment', { get: () => undefined, getFrom: () => undefined })
  root.provide('settings', { describe: () => [{ ns: 'web-search-deepseek', value: nativeConfig }] })
  root.provide('credentials', { resolve: async (ref) => {
    credentialCalls.push(ref)
    const value = credential
    if (credentialBlock) await credentialBlock.promise
    return value === undefined ? undefined : { value }
  } })
  root.provide('agents', { currentInitiator: () => ({ session: {
    requestContext: () => ({ provider: accountRoute ? 'deepseek-account' : 'fixture-api-key' }),
    append: (event, payload) => audits.push({ event, payload }),
  } }) })
  root.provide('deepseekAccount', { resolveToken: async (endpoint) => {
    accountCalls.push(endpoint)
    return accountToken
  } })
  root.on('internal/update', function (config, noSave, next) {
    updates.push({ noSave, config })
    return next()
  }, { global: true })
  await root.plugin(WebRuntime, { searchProvider: 'dsh-network', fetchProvider: 'parent-fetch' })
  const parentWeb = root.web
  parentWeb.registerSearchProvider({ id: 'dsh-network', available: () => true, search: async () => ({ sources: [], content: 'parent sentinel', truncated: false }) })
  parentWeb.registerFetchProvider({ id: 'parent-fetch', available: () => true, fetch: async ({ url }) => ({ url, statusCode: 200, body: { kind: 'text', content: 'parent fetch sentinel' }, truncated: false }) })
  // Real injected context reproduces the host plugin's cached `.web` service.
  await root.plugin({ name: 'native-smoke-owner', inject: ['web'], apply(ctx) { adapter = createNativeSearch(ctx) } })
  assert.ok(adapter)
  const beforeFiles = await filesBelow(home)

  pending.set('basic', deferred())
  pending.set('parallel-initialization', deferred())
  const firstPending = adapter.search({ query: 'basic', maxResults: 1 })
  const parallelInitialization = adapter.search({ query: 'parallel-initialization' })
  await until(() => calls.some(call => call.query === 'basic') && calls.some(call => call.query === 'parallel-initialization'), 'concurrent first-use initialization')
  pending.get('basic').resolve()
  pending.get('parallel-initialization').resolve()
  const first = await firstPending
  await parallelInitialization
  assert.equal(first.sources.length, 1)
  assert.equal(first.sources[0].snippet, 'snippet:basic')
  assert.equal(first.truncated, true)
  assert.equal(first.content, undefined)
  assert.equal(calls[0].init.headers['x-api-key'], 'FAKE_KEY_INITIAL')
  assert.equal(calls[0].body.model, 'fixture-model-one')
  assert.equal(calls[0].body.max_tokens, 100)
  assert.equal(calls[0].body.tools[0].max_uses, 2)
  assert.ok(root.get('web') instanceof WebRuntime)
  assert.equal((await parentWeb.search({ query: 'parent' })).content, 'parent sentinel')
  assert.equal((await parentWeb.fetch({ url: 'https://parent.invalid' })).body.content, 'parent fetch sentinel')
  pass('ordinary host imports, concurrent initialization, isolated official provider and untouched parent providers')

  const [{ createSearchRunner }, { makeSearchProvider }] = await Promise.all([
    import('../dsh/search.js'), import('../dsh/providers.js'),
  ])
  const chainConfig = { searchEngines: ['deepseek-official', 'bing'], searchMaxResults: 1 }
  let cliCalls = 0
  const runner = createSearchRunner(chainConfig, {
    nativeSearch: adapter.search,
    runCli: async () => { cliCalls++; throw new Error('Unexpected CLI fallback') },
  })
  const provider = makeSearchProvider(chainConfig, runner)
  const wired = await provider.search({ query: 'full-native-chain', maxResults: 1 })
  assert.equal(cliCalls, 0)
  assert.equal(wired.sources.length, 1)
  assert.equal(wired.sources[0].title, 'first:full-native-chain')
  assert.equal(wired.sources[0].snippet, 'snippet:full-native-chain')
  assert.equal(wired.truncated, true)
  assert.match(wired.content, /1 sources from deepseek-official/)
  assert.match(wired.content, /first:full-native-chain/)
  assert.ok(!wired.content.includes('untrusted answer must not escape'))
  pass('actual adapter to search runner to network provider succeeds without native content or CLI fallback')

  pending.set('parallel-one', deferred())
  pending.set('parallel-two', deferred())
  const parallelOne = adapter.search({ query: 'parallel-one' })
  const parallelTwo = adapter.search({ query: 'parallel-two' })
  await until(() => calls.some(call => call.query === 'parallel-one') && calls.some(call => call.query === 'parallel-two'), 'two concurrent dispatches')
  pending.get('parallel-two').resolve()
  assert.equal((await parallelTwo).sources[0].title, 'first:parallel-two')
  pending.get('parallel-one').resolve()
  await parallelOne
  pass('concurrent requests dispatch without holding the configuration queue')

  credentialBlock = deferred()
  const blockedCredentials = credentialBlock
  const beforeCredentials = credentialCalls.length
  const oldRequest = adapter.search({ query: 'old-config' })
  await until(() => credentialCalls.length > beforeCredentials, 'old request snapshots before awaiting credentials')
  nativeConfig = { ...nativeConfig, baseURL: 'https://changed.invalid/anthropic/v1', model: 'fixture-model-two', maxTokens: 200, maxUses: 3 }
  credential = 'FAKE_KEY_ROTATED'
  credentialBlock = undefined
  await adapter.search({ query: 'new-config' })
  blockedCredentials.resolve()
  await oldRequest
  const oldCall = calls.find(call => call.query === 'old-config')
  const newCall = calls.find(call => call.query === 'new-config')
  assert.equal(oldCall.url, 'https://native.invalid/anthropic/v1/messages')
  assert.equal(oldCall.body.model, 'fixture-model-one')
  assert.equal(oldCall.init.headers['x-api-key'], 'FAKE_KEY_INITIAL')
  assert.equal(newCall.url, 'https://changed.invalid/anthropic/v1/messages')
  assert.equal(newCall.body.model, 'fixture-model-two')
  assert.equal(newCall.body.max_tokens, 200)
  assert.equal(newCall.body.tools[0].max_uses, 3)
  assert.equal(newCall.init.headers['x-api-key'], 'FAKE_KEY_ROTATED')
  assert.ok(updates.length > 0)
  assert.ok(updates.every(update => update.noSave === true))
  assert.deepEqual(await filesBelow(home), beforeFiles)
  pass('live settings, per-request config snapshots, credential rotation and noSave without profile writes')

  accountRoute = true
  const credentialsBeforeAccount = credentialCalls.length
  await adapter.search({ query: 'account-auth' })
  const accountCall = calls.at(-1)
  assert.equal(accountCall.init.headers['x-dsh-auth-token'], 'FAKE_ACCOUNT_TOKEN')
  assert.equal(accountCall.init.headers['x-api-key'], undefined)
  assert.equal(accountCall.init.headers.authorization, undefined)
  assert.equal(credentialCalls.length, credentialsBeforeAccount)
  assert.equal(accountCalls.at(-1), accountCall.url)
  assert.equal(audits.length, calls.length)
  assert.ok(audits.every(event => event.event === 'web/deepseek-search-llm-request'))
  assert.deepEqual(audits.map(event => event.payload), calls.map(call => ({
    endpoint: call.url, apiVersion: call.init.headers['anthropic-version'], body: call.body,
  })))
  assert.ok(!JSON.stringify(audits).includes('FAKE_KEY'))
  assert.ok(!JSON.stringify(audits).includes('FAKE_ACCOUNT_TOKEN'))
  accountRoute = false
  pass('account-route authentication and host audit callback contain no secret headers')

  const cancel = new AbortController()
  pending.set('cancel-fetch', deferred())
  const cancelled = adapter.search({ query: 'cancel-fetch' }, cancel.signal)
  const cancellationCheck = assert.rejects(cancelled, error => error.code === 'WEB_ABORTED')
  await until(() => calls.some(call => call.query === 'cancel-fetch'), 'cancellable fetch dispatch')
  cancel.abort()
  await cancellationCheck
  const callsBeforePreAbort = calls.length
  await assert.rejects(adapter.search({ query: 'already-cancelled' }, AbortSignal.abort()))
  assert.equal(calls.length, callsBeforePreAbort)
  pass('in-flight fetch and already-aborted request cancellation')

  credentialBlock = deferred()
  const blockedDuringAbort = credentialBlock
  const credentialCancel = new AbortController()
  const credentialsBeforeAbort = credentialCalls.length
  const callsBeforeCredentialAbort = calls.length
  const duringCredential = adapter.search({ query: 'cancel-credential' }, credentialCancel.signal)
  const duringCredentialCheck = assert.rejects(duringCredential, error => error.code === 'WEB_ABORTED')
  await until(() => credentialCalls.length > credentialsBeforeAbort, 'credential resolution to cancel')
  credentialCancel.abort()
  await duringCredentialCheck
  credentialBlock = undefined
  blockedDuringAbort.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.length, callsBeforeCredentialAbort)
  pass('cancellation during credential resolution prevents dispatch')

  const goodConfig = nativeConfig
  nativeConfig = { ...goodConfig, maxTokens: 0 }
  const callsBeforeInvalid = calls.length
  await assert.rejects(adapter.search({ query: 'invalid-config' }), error => error.code === 'NATIVE_CONFIG_INVALID')
  assert.equal(calls.length, callsBeforeInvalid)
  nativeConfig = goodConfig
  await adapter.search({ query: 'recovered-config' })
  credential = undefined
  const callsBeforeMissingKey = calls.length
  await assert.rejects(adapter.search({ query: 'missing-fake-key' }), error => error.code === 'WEB_PROVIDER_CREDENTIAL_MISSING')
  assert.equal(calls.length, callsBeforeMissingKey)
  credential = 'FAKE_KEY_ROTATED'
  pass('invalid settings and absent credentials fail without dispatch; valid configuration recovers')

  await adapter.dispose()
  await adapter.dispose()
  await assert.rejects(adapter.search({ query: 'after-disposal' }), error => error.code === 'NATIVE_DISPOSED')
  assert.ok(root.get('web') instanceof WebRuntime)
  assert.equal((await parentWeb.search({ query: 'parent-after-dispose' })).content, 'parent sentinel')
  assert.deepEqual(await filesBelow(home), beforeFiles)
  pass('idempotent disposal rejects future requests and leaves parent providers intact')

  // A fresh process with the real adapter but no host packages tests the default
  // import failure, rather than replacing loadModules with a test double.
  const missingDir = join(temporary, 'missing-host')
  await mkdir(missingDir)
  await writeFile(join(missingDir, 'native-search.mjs'), await readFile(join(repository, 'dsh', 'native-search.js')))
  await writeFile(join(missingDir, 'check.mjs'), `
    import assert from 'node:assert/strict';
    import { createNativeSearch } from './native-search.mjs';
    globalThis.fetch = () => { throw new Error('Unexpected network access'); };
    const adapter = createNativeSearch({ isolate() {}, get() {}, plugin() {} });
    await assert.rejects(adapter.search({ query: 'missing-host' }), error =>
      error.code === 'NATIVE_DEPENDENCY_MISSING' && !error.message.includes('node_modules'));
    await adapter.dispose();
  `)
  const missing = spawnSync(process.execPath, [join(missingDir, 'check.mjs')], {
    cwd: missingDir, env: {}, encoding: 'utf8', timeout: 10000,
  })
  assert.equal(missing.status, 0, missing.stderr || String(missing.error))
  pass('missing host dependencies produce a sanitized actionable error')
  console.log(`Native host smoke: ${passed} checks passed; ${calls.length} mocked requests; zero real network requests`)
} finally {
  await adapter?.dispose()
  await root.fiber.dispose()
  globalThis.fetch = originalFetch
  await rm(temporary, { recursive: true, force: true })
}
