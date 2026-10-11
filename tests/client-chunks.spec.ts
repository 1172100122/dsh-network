/**
 * Regression test: the browser half is a SET of files that only work together
 * through the module loader's chunk contract.
 *
 * The defect this pins: after `dsh/client.js` was split into package-local
 * chunks (`client.settings.js` / `client.toolviews.js` /
 * `client.searchpanel.js`), the "网络" settings page stopped rendering
 * entirely. The cause was NOT the loader — the chunk still read the entry's
 * file scope: `ENGINE_LABELS` is declared in `dsh/client.js`, but a chunk is a
 * separate script whose only view of the entry is `require('@naivg/dsh-network')`.
 * A free variable in a chunk is not a syntax error, not a load error, and not
 * a console warning: the chunk registers, materializes, and exports happily,
 * and then `EnginesSection` throws `ReferenceError: ENGINE_LABELS is not
 * defined` inside React's render — which took down the WHOLE section, because
 * the throw happens below the section root.
 *
 * Two guards, because each catches a different half of that failure:
 *
 *   1. STATIC — a TypeScript `checkJs` program over the four client files
 *      reports unresolved names (`Cannot find name`) per file. This is the
 *      guard that would have failed on the split's very first commit, before
 *      any render path was even taken.
 *   2. DYNAMIC — a faithful mini-loader (chunk-aware ids, owner-relative
 *      `require.async`, factory return value = record exports — the real
 *      `@deepseek-ai/dsh-client-modules` semantics, not the looser
 *      id-or-chunk keying the toolview spec uses) materializes every real
 *      chunk and renders each surface with `react-dom/server`.
 *
 * Both run with `react` / `react-dom` / `typescript` only: no dsh install.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import react from 'react'
import serverRenderer from 'react-dom/server'
import { beforeAll, describe, expect, it, vi } from 'vitest'

const { renderToStaticMarkup } = serverRenderer
const nodeRequire = createRequire(import.meta.url)

/** The browser half, entry first (the host's combo executes it). */
const ENTRY_FILE = 'client.js'
const CHUNK_FILES = ['client.settings.js', 'client.toolviews.js', 'client.searchpanel.js']
const CLIENT_FILES = [ENTRY_FILE, ...CHUNK_FILES]
const PACKAGE_ID = '@naivg/dsh-network'

const read = (file: string) => readFileSync(fileURLToPath(new URL(`../dsh/${file}`, import.meta.url)), 'utf8')

/** The chunk-name rule the loader enforces (`CLIENT_CHUNK` in dsh-client-modules). */
const CLIENT_CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/

// ───────────────────────── 1. static free-variable guard ─────────────────────

describe('browser-half chunk hygiene', () => {
  it('leaves no unresolved identifier in any client file', () => {
    const ts = nodeRequire('typescript') as typeof import('typescript')
    const options: import('typescript').CompilerOptions = {
      allowJs: true,
      checkJs: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2020,
      // The real globals (`window` / `document` / `fetch` / `Symbol`) come from
      // the DOM + ES libs, so anything the compiler still cannot resolve is a
      // name that used to live in a sibling file — exactly the split defect.
      lib: ['lib.dom.d.ts', 'lib.es2020.d.ts'],
      skipLibCheck: true,
    }
    const sources = new Map(CLIENT_FILES.map((file) => [file, read(file)]))
    const host = ts.createCompilerHost(options)
    const defaultGetSourceFile = host.getSourceFile.bind(host)
    host.getSourceFile = (name, languageVersion) =>
      sources.has(name)
        ? ts.createSourceFile(name, sources.get(name) as string, languageVersion, true)
        : defaultGetSourceFile(name, languageVersion)
    host.fileExists = (name) => sources.has(name) || ts.sys.fileExists(name)
    host.readFile = (name) => sources.get(name) ?? ts.sys.readFile(name)

    const program = ts.createProgram([...CLIENT_FILES], options, host)
    const unresolved: string[] = []
    for (const file of CLIENT_FILES) {
      const sourceFile = program.getSourceFile(file)
      expect(sourceFile, `${file} missing from the program`).toBeTruthy()
      if (!sourceFile) continue
      const diagnostics = [
        ...program.getSemanticDiagnostics(sourceFile),
        ...program.getSyntacticDiagnostics(sourceFile),
      ]
        // 2304 `Cannot find name` / 2552 the "did you mean" variant / 2580
        // `Cannot find name. Do you need to change your target library?`.
        .filter((diagnostic) => diagnostic.code === 2304 || diagnostic.code === 2552 || diagnostic.code === 2580)
      for (const diagnostic of diagnostics) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
        unresolved.push(`${file}:${line + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`)
      }
    }

    expect(
      unresolved.join('\n'),
      'a client file reads a name that is not in its own scope — a chunk sees the entry ONLY through require("@naivg/dsh-network")',
    ).toBe('')
  }, 30_000)

  it('declares each chunk with the loader-approved name', () => {
    for (const file of CHUNK_FILES) {
      expect(CLIENT_CHUNK.test(file), `${file} is not a client.<name>.js chunk`).toBe(true)
      expect(read(file)).toContain(`chunk: '${file}'`)
      // A chunk must re-bind what it needs from the entry, never assume it.
      expect(read(file)).toContain(`require('${PACKAGE_ID}')`)
    }
  })

  it('only reads STYLES keys the entry actually exports', async () => {
    const { entry } = await createChunkLoader().load()
    const styles = entry.STYLES as Record<string, unknown>
    const missing = new Set<string>()
    for (const file of CHUNK_FILES) {
      for (const match of read(file).matchAll(/STYLES\.([A-Za-z_]\w*)/g)) {
        if (!(match[1] in styles)) missing.add(`${file}: STYLES.${match[1]}`)
      }
    }
    // A missing fragment is a silently unstyled row, not a crash — the same
    // class of split damage as a free variable, without the loud failure.
    expect([...missing].join('\n')).toBe('')
  })

  it('sends every field the host accepts, from BOTH save payloads', () => {
    // The auto-save builds an EXPLICIT whitelist inside `flushSave` rather than
    // posting the draft, so a field the UI edits can simply be left out of it.
    const LEGACY_ALIASES = new Set(['allowPrivateNetwork']) // superseded by ssrfProtection at the same hop
    const accepted = new Set<string>()
    for (const match of read('config-summary.js').matchAll(/\bpatch\.(\w+)/g)) {
      if (!LEGACY_ALIASES.has(match[1])) accepted.add(match[1])
    }
    expect(accepted.size).toBeGreaterThan(10)

    const settings = read('client.settings.js')
    // Keys that reach the payload through `...githubSettingsPatch(next)`.
    const helper = /function githubSettingsPatch\([\s\S]*?\n {4}\}/.exec(settings)?.[0] ?? ''
    const helperKeys = new Set([...helper.matchAll(/patch\.(\w+)\s*=/g)].map((m) => m[1]))

    // The dedicated 网络 section AND the legacy Plugins-tab card each carry
    // their own copy of flushSave — a fix in one left the other broken.
    const payloads = [...settings.matchAll(/putConfig\(\{([\s\S]*?)\n\s*\}, lastRevision/g)].map((m) => m[1])
    expect(payloads.length).toBeGreaterThanOrEqual(2)
    const missing = payloads.flatMap((body, index) => {
      const sent = new Set([...body.matchAll(/^\s*([A-Za-z_]\w*):/gm)].map((m) => m[1]))
      for (const key of helperKeys) sent.add(key)
      return [...accepted].filter((key) => !sent.has(key)).map((key) => `payload #${index} omits "${key}"`)
    })
    expect(missing.join('\n')).toBe('')
  })
})

// ───────────── 2. dynamic: materialize the real chunks and render ────────────

/**
 * A faithful stand-in for `ClientModuleSystem`: registrations are keyed
 * `<owner>/<chunk>` (never the bare chunk name), `require.async('./x')` is
 * owner-relative, and a factory's RETURN value becomes the record exports.
 */
function createChunkLoader() {
  globalThis.window = globalThis as unknown as Window & typeof globalThis
  globalThis.document = {
    documentElement: { lang: 'zh-CN' },
    head: { appendChild() {}, append() {} },
    createElement: () => ({ setAttribute() {}, style: {}, content: '', dataset: {} }),
    createElementNS: () => ({ setAttribute() {}, style: {}, appendChild() {} }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    body: null,
  } as unknown as Document
  if (typeof globalThis.navigator === 'undefined') {
    Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
  }

  const factories = new Map<string, (require: unknown) => unknown>()
  const records = new Map<string, unknown>()
  const seed = new Map<string, unknown>([
    ['react', nodeRequire('react')],
    ['react/jsx-runtime', nodeRequire('react/jsx-runtime')],
  ])
  const chunkKey = (owner: string, chunk: string) => `${owner.replace(/\/client$/, '')}/${chunk}`

  ;(globalThis as Record<string, unknown>).__ModuleLoader__ = {
    load(registration: { id: string; chunk?: string; factory: (require: unknown) => unknown }) {
      if (registration.chunk !== undefined && !CLIENT_CHUNK.test(registration.chunk)) {
        throw new Error(`invalid package-local chunk ${JSON.stringify(registration.chunk)}`)
      }
      const key = registration.chunk === undefined
        ? registration.id.replace(/\/client$/, '')
        : chunkKey(registration.id, registration.chunk)
      if (factories.has(key)) throw new Error(`duplicate factory registration for "${key}"`)
      factories.set(key, registration.factory)
    },
  }

  function makeRequire(ownerId: string) {
    const require = (spec: string) => {
      if (seed.has(spec)) return seed.get(spec)
      const id = spec.replace(/\/client$/, '')
      if (records.has(id)) return records.get(id)
      if (factories.has(id)) return materialize(id, ownerId)
      throw new Error(`chunk harness: require("${spec}") missed the module table`)
    }
    ;(require as unknown as { async: (spec: string) => Promise<unknown> }).async = async (spec: string) => {
      if (!spec.startsWith('./')) throw new Error(`chunk harness: only relative chunk requests (got ${spec})`)
      const fileName = spec.slice(2)
      if (!CLIENT_CHUNK.test(fileName)) throw new Error(`invalid relative chunk request ${JSON.stringify(spec)}`)
      return await importChunk(ownerId, fileName)
    }
    return require
  }

  function materialize(id: string, ownerId = id) {
    if (records.has(id)) return records.get(id)
    const factory = factories.get(id)
    if (factory === undefined) throw new Error(`chunk harness: no registered factory for "${id}"`)
    const value = factory(makeRequire(ownerId))
    records.set(id, value)
    return value
  }

  async function importChunk(ownerId: string, fileName: string) {
    const id = chunkKey(ownerId, fileName)
    if (records.has(id)) return records.get(id)
    if (!factories.has(id)) throw new Error(`chunk harness: ${fileName} did not register "${id}"`)
    return materialize(id, ownerId)
  }

  /** Execute one bundle script exactly as the browser does (a classic script). */
  function run(file: string) {
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'console', read(file))(globalThis, globalThis.document, console)
  }

  return {
    async load() {
      run(ENTRY_FILE)
      const entry = materialize(PACKAGE_ID) as Record<string, unknown>
      const chunks: Record<string, Record<string, unknown>> = {}
      for (const file of CHUNK_FILES) {
        run(file)
        chunks[file] = (await importChunk(PACKAGE_ID, file)) as Record<string, unknown>
      }
      return { entry, chunks }
    },
  }
}

/** The primitives surface the surfaces read, with memo-wrapped atoms. */
const ui = {
  MarkdownText: { $$typeof: Symbol.for('react.memo'), type: (props: { text: string }) => react.createElement('div', null, props.text), compare: null },
  TextShimmer: { $$typeof: Symbol.for('react.memo'), type: (props: { children?: unknown }) => react.createElement('span', null, props.children), compare: null },
}

const localeRef = { current: null }

/** Render a component type (the builders return one). */
function renderComponent(component: unknown, props?: Record<string, unknown>) {
  return renderToStaticMarkup(react.createElement(component as never, props as never))
}

/** Render an already-built element (EngineDialog and friends return one). */
function renderNode(node: unknown) {
  return renderToStaticMarkup(node as never)
}

/** The locale dictionary the surfaces label from (document.documentElement.lang is zh-CN). */
function labelsFrom(entry: Record<string, unknown>) {
  return (entry.labelText as (ref: unknown, fallback: string) => Record<string, string>)(localeRef, 'zh')
}

/** A realistic `/dsh-network/config` body, built by the host's own projector. */
async function configBody(overrides: Record<string, unknown> = {}) {
  const { defaultConfig, summarize } = await import('../dsh/config-summary.js')
  const value = summarize(defaultConfig(overrides))
  return { value, revision: 1 }
}

/** Drive stateful settings and their actual debounce without a browser DOM.
 * Like the dialog spy below, this preserves handlers that SSR drops. Hooks
 * retain their slots between explicitly requested paints, and effects run
 * after each paint, so both settings surfaces exercise their real save code. */
function settingsHarness(builder: (...args: unknown[]) => () => unknown) {
  const slots: Array<Record<string, any>> = []
  let cursor = 0
  let captured: Array<Record<string, any>> = []
  let effects: Array<() => void> = []
  const spy = {
    ...react,
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => {
      const element = react.createElement(type as never, props as never, ...(children as never[]))
      captured.push(element as unknown as Record<string, any>)
      return element
    },
    useState: (initial: unknown) => {
      const index = cursor++
      const slot = slots[index] ??= { value: initial }
      return [slot.value, (next: any) => { slot.value = typeof next === 'function' ? next(slot.value) : next }]
    },
    useRef: (initial: unknown) => slots[cursor++] ??= { current: initial },
    useEffect: (effect: () => (() => void) | void, deps: unknown[]) => {
      const index = cursor++
      const previous = slots[index]
      if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return
      const slot = slots[index] = { deps }
      effects.push(() => {
        previous?.cleanup?.()
        slot.cleanup = effect()
      })
    },
  }
  const Component = builder(spy, ui, localeRef)
  return {
    paint() {
      cursor = 0
      captured = []
      renderNode(Component())
      const pending = effects
      effects = []
      pending.forEach((effect) => effect())
      return captured
    },
    dispose() { slots.forEach((slot) => slot.cleanup?.()) },
  }
}

describe('browser-half chunks render through the loader contract', () => {
  beforeAll(() => {
    // The entry and the settings section probe the host's config route; a 404
    // means "headless profile, stay silent" and keeps this test host-free.
    vi.stubGlobal('fetch', async () => ({ status: 404, ok: false, json: async () => ({}) }))
  })

  it('materializes every chunk and its documented exports', async () => {
    const { entry, chunks } = await createChunkLoader().load()

    expect(typeof entry.apply).toBe('function')
    expect(Object.keys(chunks['client.settings.js']).sort()).toEqual([
      'AddEngineDialog',
      'ConfigCard',
      'EngineDialog',
      'NetworkSection',
      'RenderNetworkPage',
    ])
    expect(typeof chunks['client.toolviews.js'].SearchToolview).toBe('function')
    expect(typeof chunks['client.toolviews.js'].HttpRequestToolview).toBe('function')
    expect(typeof chunks['client.toolviews.js'].WebFetchToolview).toBe('function')
    expect(typeof chunks['client.toolviews.js'].WebSitemapToolview).toBe('function')
    expect(typeof chunks['client.toolviews.js'].WebConfigToolview).toBe('function')
    expect(typeof chunks['client.searchpanel.js'].SearchPanelPage).toBe('function')
  })

  it('renders the 网络 settings section (the page that went blank)', async () => {
    const { chunks } = await createChunkLoader().load()
    const settings = chunks['client.settings.js']
    const Section = (settings.NetworkSection as (...args: unknown[]) => unknown)(react, ui, localeRef)

    const html = renderComponent(Section)
    // The section renders its whole body, not just its header: the engines
    // group is where the split's free `ENGINE_LABELS` blew up on the FIRST
    // paint (before any config arrives), and a throw there unmounts everything
    // below the section root — an empty 网络 page, no visible error.
    expect(html).toContain('网络 (dsh-network)')
    expect(html).toContain('工具')
    expect(html).toContain('搜索引擎')
    expect(html).toContain('添加到链')
    expect(html).toContain('安全')
    expect(html.length).toBeGreaterThan(4000)
  })

  it('renders the loaded page, engine rows and both engine dialogs', async () => {
    const { entry, chunks } = await createChunkLoader().load()
    const settings = chunks['client.settings.js']
    const t = labelsFrom(entry)
    const body = await configBody({ searchEngines: ['bing', 'baidu', 'github'], githubToken: 'ghp_secret' })
    const renderPage = settings.RenderNetworkPage as (props: Record<string, unknown>) => unknown
    const noop = () => {}
    const pageProps = {
      react,
      t,
      draft: { ...body.value },
      summary: body,
      note: t.synced,
      setKey: noop,
      setKeys: noop,
      testState: [{ status: 'idle', message: '' }, noop],
      runLoopbackTest: noop,
      loaded: true,
    }

    // The loaded paint: one row per engine, labelled from the entry's
    // ENGINE_LABELS map, plus the GitHub token badge.
    const loaded = renderNode(renderPage({ ...pageProps, dialogState: [null, noop], addDialogState: [null, noop] }))
    expect(loaded).toContain('bing')
    expect(loaded).toContain('github')
    // `hasGithubToken` arrives nested under `value` in the route body.
    expect(loaded).toContain(t.githubTokenRowOn)

    // The edit dialog reads ENGINE_LABELS for the (locked) category field.
    const editing = renderNode(renderPage({
      ...pageProps,
      dialogState: [{ id: 'baidu', endpoint: '', hasApiKey: false, options: {} }, noop],
      addDialogState: [null, noop],
    }))
    expect(editing).toContain(t.enginesEdit)
    expect(editing).toContain('Baidu')

    // …and the add dialog labels every engine it offers. The chain already
    // holds bing/baidu/github, so the free categories are the other two — and
    // their PRINTED names come from the entry's ENGINE_LABELS map, not from
    // the category ids.
    const adding = renderNode(renderPage({
      ...pageProps,
      dialogState: [null, noop],
      addDialogState: [{ id: '' }, noop],
    }))
    expect(adding).toContain(t.enginesAddTitle)
    expect(adding).toContain('DuckDuckGo')
    expect(adding).toContain('SearXNG')
  })

  it('lists native DeepSeek without changing the default or an existing engine chain', async () => {
    const { entry } = await createChunkLoader().load()
    const { defaultConfig } = await import('../dsh/config-summary.js')
    expect(entry.ENGINES).toContain('deepseek-official')
    expect(entry.ENGINE_LABELS).toMatchObject({ 'deepseek-official': 'DeepSeek (native)' })
    expect(defaultConfig({}).searchEngines).toEqual(['bing', 'duckduckgo', 'baidu'])
    expect(defaultConfig({ searchEngines: ['github', 'bing'] }).searchEngines).toEqual(['github', 'bing'])
  })

  it.each(['zh-CN', 'en'])('renders native information without credential or ineffective controls in %s', async (lang) => {
    const { entry, chunks } = await createChunkLoader().load()
    document.documentElement.lang = lang
    const t = labelsFrom(entry)
    const captured: Array<Record<string, any>> = []
    const spy = {
      ...react,
      createElement: (type: unknown, props: unknown, ...children: unknown[]) => {
        const element = react.createElement(type as never, props as never, ...(children as never[]))
        captured.push(element as unknown as Record<string, any>)
        return element
      },
    }
    const onChange = vi.fn(), onSave = vi.fn(), onCancel = vi.fn()
    const Dialog = chunks['client.settings.js'].EngineDialog as (props: Record<string, unknown>) => unknown
    // Even stale/injected generic configuration cannot appear as native
    // settings or imply that a plugin-owned key controls DSH's account.
    const html = renderNode(Dialog({
      react: spy, t,
      value: {
        id: 'deepseek-official', endpoint: 'https://unused-endpoint.example',
        apiKey: 'native-secret-must-not-render', hasApiKey: true,
        options: { token: 'unused-option-must-not-render' },
      },
      onChange, onSave, onCancel,
    }))
    expect(html).toContain('DeepSeek (native)')
    expect(html).toContain(t.enginesInfo)
    expect(html).toContain(t.deepseekNativeHint)
    expect(t.deepseekNativeHint).toContain('DEEPSEEK_API_KEY')
    expect(t.deepseekNativeHint).toContain('0.2.0-rc.2')
    expect(t.deepseekNativeHint).toContain(lang === 'en' ? 'may be billed' : '可能计费')
    expect(t.deepseekNativeHint).toContain(lang === 'en' ? 'managed by DSH' : '由 DSH 管理')
    expect(html).not.toContain('native-secret-must-not-render')
    expect(html).not.toContain('unused-endpoint.example')
    expect(html).not.toContain('unused-option-must-not-render')
    expect(captured.filter((node) => ['input', 'textarea', 'select'].includes(node.type))).toHaveLength(0)
    const buttons = captured.filter((node) => node.type === 'button')
    expect(buttons.length).toBeGreaterThan(0)
    for (const button of buttons) {
      expect(button.props.children).toBe(t.enginesEditClose)
      button.props.onClick()
    }
    expect(onCancel).toHaveBeenCalledTimes(buttons.length)
    expect(onChange).not.toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
  })

  it.each(['NetworkSection', 'ConfigCard'])('adds and reorders native DeepSeek only after opt-in in %s', async (surface) => {
    const { entry, chunks } = await createChunkLoader().load()
    const { defaultConfig, summarize, applyCardSettings } = await import('../dsh/config-summary.js')
    const t = labelsFrom(entry)
    const native = 'deepseek-official'
    const config = defaultConfig({
      searchEngines: ['bing', 'brave'],
      searchEngineApiKeys: { brave: 'existing-brave-secret' },
      searchEngineConfigs: { brave: { options: { country: 'DE' } } },
    })
    const writes: Array<Record<string, any>> = []
    let revision = 1
    const originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: Record<string, any>) => {
      expect(url).toBe('/dsh-network/config')
      if (options?.method === 'PUT') {
        expect(options.headers['if-match']).toBe(String(revision))
        const patch = JSON.parse(options.body)
        writes.push(patch)
        applyCardSettings(config, patch)
        revision++
      }
      return { ok: true, status: 200, json: async () => ({ value: summarize(config), revision }) }
    }))
    vi.useFakeTimers()
    const harness = settingsHarness(chunks['client.settings.js'][surface] as (...args: unknown[]) => () => unknown)
    try {
      let nodes = harness.paint()
      if (surface === 'ConfigCard') {
        nodes.find((node) => node.props?.['aria-expanded'] === false)!.props.onClick()
        harness.paint()
      }
      await vi.advanceTimersByTimeAsync(0)
      nodes = harness.paint()
      const order = () => nodes.filter((node) => node.type === 'button' && node.props?.title === t.enginesMoveUp)
        .map((node) => node.props['aria-label'].slice(t.enginesMoveUp.length + 2))
      const addButton = () => nodes.find((node) => node.type === 'button'
        && react.Children.toArray(node.props.children).some((child: any) => child?.props?.children === t.enginesAdd))!
      expect(order()).toEqual(['bing', 'brave'])
      await vi.advanceTimersByTimeAsync(500)
      expect(writes).toHaveLength(0)

      addButton().props.onClick()
      nodes = harness.paint()
      const category = nodes.find((node) => node.type === 'button' && node.key === native)
      expect(category, 'native engine is offered in the add catalog').toBeTruthy()
      expect(renderNode(category)).toContain('DeepSeek (native)')
      category!.props.onClick()
      nodes = harness.paint()
      expect(nodes.some((node) => node.props?.children === t.deepseekNativeHint)).toBe(true)
      // Selection alone must not alter the active chain or bill a query.
      expect(order()).toEqual(['bing', 'brave'])
      await vi.advanceTimersByTimeAsync(500)
      expect(writes).toHaveLength(0)
      nodes.find((node) => node.type === 'button' && node.props?.children === t.enginesAddConfirm)!.props.onClick()
      nodes = harness.paint()
      expect(order()).toEqual(['bing', 'brave', native])
      expect(nodes.some((node) => node.type === 'span' && node.props.children === 'DeepSeek (native)')).toBe(true)
      nodes.find((node) => node.props?.['aria-label'] === t.enginesMoveUp + ': ' + native)!.props.onClick()
      nodes = harness.paint()
      expect(order()).toEqual(['bing', native, 'brave'])
      await vi.advanceTimersByTimeAsync(500)
      expect(writes).toHaveLength(1)
      expect(config.searchEngines).toEqual(['bing', native, 'brave'])
      expect(writes[0].searchEngineConfigs).not.toHaveProperty(native)
      expect(JSON.stringify(writes[0])).not.toContain('existing-brave-secret')
      expect(config.searchEngineApiKeys.brave).toBe('existing-brave-secret')
      expect(config.searchEngineConfigs.brave.options).toEqual({ country: 'DE' })

      nodes = harness.paint()
      nodes.find((node) => node.props?.['aria-label'] === t.enginesInfo + ': ' + native)!.props.onClick()
      nodes = harness.paint()
      const dialog = nodes.find((node) => node.type === chunks['client.settings.js'].EngineDialog)!
      expect(dialog.props.value).toEqual({ id: native })
      expect(nodes.some((node) => node.type === 'button' && node.props.children === t.enginesEditSave)).toBe(false)
      // The handler also rejects native saves if called directly; there is
      // never a synthetic searchEngineConfigs entry for native credentials.
      dialog.props.onSave()
      nodes = harness.paint()
      expect(nodes.some((node) => node.props?.role === 'dialog')).toBe(false)
      await vi.advanceTimersByTimeAsync(500)
      expect(writes).toHaveLength(1)
      expect(config.searchEngineConfigs).not.toHaveProperty(native)
      addButton().props.onClick()
      nodes = harness.paint()
      expect(nodes.some((node) => node.type === 'button' && node.key === native)).toBe(false)
    } finally {
      harness.dispose()
      vi.useRealTimers()
      vi.stubGlobal('fetch', originalFetch)
    }
  })

  it.each(['NetworkSection', 'ConfigCard'])('reorders engines and autosaves the latest chain in %s', async (surface) => {
    const { entry, chunks } = await createChunkLoader().load()
    const { defaultConfig, summarize, applyCardSettings } = await import('../dsh/config-summary.js')
    const t = labelsFrom(entry)
    // An existing string-array config needs no migration. A stored engine
    // key and its options must survive changing only the chain's order.
    const config = defaultConfig({
      searchEngines: ['bing', 'brave', 'github'],
      searchEngineApiKeys: { brave: 'stored-secret' },
      searchEngineConfigs: { brave: { options: { country: 'DE' } } },
      githubToken: 'stored-github-token',
    })
    const originalOrder = config.searchEngines.slice()
    let revision = 1
    const writes: Array<Record<string, any>> = []
    const originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (url: string, options?: Record<string, any>) => {
      expect(url).toBe('/dsh-network/config')
      if (options?.method === 'PUT') {
        expect(options.headers['if-match']).toBe(String(revision))
        const patch = JSON.parse(options.body)
        writes.push(patch)
        applyCardSettings(config, patch)
        revision++
      }
      return { ok: true, status: 200, json: async () => ({ value: summarize(config), revision }) }
    }))
    vi.useFakeTimers()
    const harness = settingsHarness(chunks['client.settings.js'][surface] as (...args: unknown[]) => () => unknown)
    try {
      let nodes = harness.paint()
      if (surface === 'ConfigCard') {
        nodes.find((node) => node.props?.['aria-expanded'] === false)!.props.onClick()
        harness.paint()
      }
      await vi.advanceTimersByTimeAsync(0)

      const button = (direction: 'up' | 'down', id: string) => {
        const label = direction === 'up' ? t.enginesMoveUp : t.enginesMoveDown
        const found = nodes.find((node) => node.type === 'button' && node.props?.['aria-label'] === label + ': ' + id)
        expect(found, `${direction} control for ${id}`).toBeTruthy()
        return found!.props
      }
      const order = () => nodes.filter((node) => node.type === 'button' && node.props?.title === t.enginesMoveUp)
        .map((node) => node.props['aria-label'].slice(t.enginesMoveUp.length + 2))
      nodes = harness.paint()
      expect(order()).toEqual(originalOrder)
      expect(button('up', 'bing').disabled).toBe(true)
      expect(button('down', 'github').disabled).toBe(true)
      expect(button('down', 'bing').disabled).toBe(false)
      expect(button('up', 'github').disabled).toBe(false)
      // Guard the handlers too: bypassing the native disabled button must
      // not mutate the chain or schedule a redundant save at either end.
      button('up', 'bing').onClick()
      button('down', 'github').onClick()
      await vi.advanceTimersByTimeAsync(500)
      expect(writes).toHaveLength(0)

      button('up', 'brave').onClick()
      nodes = harness.paint()
      expect(order()).toEqual(['brave', 'bing', 'github'])
      expect(button('up', 'brave').disabled).toBe(true)
      button('down', 'bing').onClick()
      nodes = harness.paint()
      expect(order()).toEqual(['brave', 'github', 'bing'])
      expect(button('down', 'bing').disabled).toBe(true)
      // Repeated moves before the debounce must save the latest paint.
      expect(config.searchEngines).toEqual(originalOrder)
      await vi.advanceTimersByTimeAsync(499)
      expect(writes).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1)
      expect(writes).toHaveLength(1)
      expect(writes[0].searchEngines).toEqual(['brave', 'github', 'bing'])
      expect(config.searchEngines).toEqual(['brave', 'github', 'bing'])
      expect(config.searchEngineApiKeys.brave).toBe('stored-secret')
      expect(config.searchEngineConfigs.brave.options).toEqual({ country: 'DE' })
      expect(config.githubToken).toBe('stored-github-token')

      // Another move after save must keep working with the new revision.
      nodes = harness.paint()
      button('down', 'brave').onClick()
      nodes = harness.paint()
      expect(order()).toEqual(['github', 'brave', 'bing'])
      await vi.advanceTimersByTimeAsync(500)
      expect(writes).toHaveLength(2)
      expect(config.searchEngines).toEqual(['github', 'brave', 'bing'])
      // Removing rows leaves a single engine with both controls disabled.
      for (const id of ['brave', 'bing']) {
        nodes = harness.paint()
        nodes.find((node) => node.props?.['aria-label'] === t.enginesDelete + ': ' + id)!.props.onClick()
      }
      nodes = harness.paint()
      expect(order()).toEqual(['github'])
      expect(button('up', 'github').disabled).toBe(true)
      expect(button('down', 'github').disabled).toBe(true)
      button('up', 'github').onClick()
      button('down', 'github').onClick()
      await vi.advanceTimersByTimeAsync(500)
      expect(config.searchEngines).toEqual(['github'])
      expect(writes).toHaveLength(3)
    } finally {
      harness.dispose()
      vi.useRealTimers()
      vi.stubGlobal('fetch', originalFetch)
    }
  })

  /**
   * The credential hop, driven through the REAL dialog.
   *
   * Defect this pins: the engine dialog collected the typed API key into its
   * own state, and the commit built the patch from `endpoint` / `hasApiKey` /
   * `options` only — `apiKey` was dropped on the floor. The host therefore
   * stored "a key is configured" and never a key: `config.searchEngineApiKeys`
   * stayed empty, `configToEnv()` shipped an empty
   * DSH_NETWORK_SEARCH_ENGINE_API_KEYS, and Brave could never authenticate no
   * matter what the user pasted. Nothing in the UI showed an error — the
   * status dot was green the whole time.
   *
   * `react-dom/server` drops event handlers, so this drives the components
   * the way a click does: `createElement` is wrapped in a recording spy (the
   * surfaces take `react` as a PROP, so the chunk uses ours), the recorded
   * password input's `onChange` produces the next dialog state exactly as the
   * typing would, the page re-renders with it, and the recorded save button's
   * `onClick` produces the patch the host receives.
   */
  it('commits the typed engine API key into the saved patch', async () => {
    const { entry, chunks } = await createChunkLoader().load()
    const settings = chunks['client.settings.js']
    const t = labelsFrom(entry)
    const renderPage = settings.RenderNetworkPage as (props: Record<string, unknown>) => unknown
    const body = await configBody({ searchEngines: ['bing', 'brave'] })

    /** Render one paint with a recording createElement and return the elements. */
    function paint(props: Record<string, unknown>) {
      const captured: Array<Record<string, any>> = []
      const spy = {
        ...react,
        createElement: (type: unknown, elementProps: unknown, ...children: unknown[]) => {
          const element = react.createElement(type as never, elementProps as never, ...(children as never[]))
          captured.push(element as unknown as Record<string, any>)
          return element
        },
      }
      renderNode(renderPage({
        react: spy,
        t,
        draft: { ...body.value },
        summary: body,
        note: t.synced,
        setKey: () => {},
        setKeys: () => {},
        testState: [{ status: 'idle', message: '' }, () => {}],
        runLoopbackTest: () => {},
        loaded: true,
        addDialogState: [null, () => {}],
        ...props,
      }))
      return captured
    }

    const noop = () => {}
    let dialog: Record<string, any> | null = null
    const setDlg = (next: Record<string, any>) => { dialog = next }

    // Pass 1 — open the Brave dialog and "type" the subscription token.
    const open = paint({ dialogState: [{ id: 'brave', endpoint: '', hasApiKey: false, options: {} }, setDlg] })
    const keyInput = open.find((el) => el.props?.type === 'password')
    expect(keyInput, 'the keyed engine dialog must render an API key field').toBeTruthy()
    keyInput!.props.onChange({ target: { value: 'bsa-secret' } })
    expect(dialog, 'typing must produce the next dialog state').toMatchObject({
      apiKey: 'bsa-secret',
      hasApiKey: true,
    })

    // Pass 2 — re-render with the typed state and click 保存.
    let patch: Record<string, any> | null = null
    const saved = paint({
      dialogState: [dialog, noop],
      setKeys: (next: Record<string, any>) => { patch = next },
    })
    const saveButton = saved.find((el) => el.props?.children === t.enginesEditSave)
    expect(saveButton, 'the engine dialog must render its save button').toBeTruthy()
    saveButton!.props.onClick()

    expect(patch).toBeTruthy()
    const entryForBrave = patch!.searchEngineConfigs.brave
    // THE assertion: the secret rides the patch. `hasApiKey: true` alone left
    // the CLI with an empty key map and no way to authenticate.
    expect(entryForBrave.apiKey).toBe('bsa-secret')
    expect(entryForBrave.hasApiKey).toBe(true)
    // …and the map is merged, not replaced: an engine the dialog never
    // touched keeps its own settings.
    expect(patch!.searchEngineConfigs.searxng.endpoint).toBe('http://127.0.0.1:8888')
  })

  it('omits apiKey entirely when the dialog was saved without typing', async () => {
    const { entry, chunks } = await createChunkLoader().load()
    const settings = chunks['client.settings.js']
    const t = labelsFrom(entry)
    const renderPage = settings.RenderNetworkPage as (props: Record<string, unknown>) => unknown
    const body = await configBody({ searchEngines: ['bing', 'brave'] })
    const captured: Array<Record<string, any>> = []
    const spy = {
      ...react,
      createElement: (type: unknown, elementProps: unknown, ...children: unknown[]) => {
        const element = react.createElement(type as never, elementProps as never, ...(children as never[]))
        captured.push(element as unknown as Record<string, any>)
        return element
      },
    }
    let patch: Record<string, any> | null = null
    renderNode(renderPage({
      react: spy,
      t,
      draft: { ...body.value },
      summary: body,
      note: t.synced,
      setKey: () => {},
      // Saving without typing must NOT ship an empty `apiKey: ''`: the host
      // reads "non-empty string" as "store this key" and "absent" as "keep
      // whatever you had", so an empty string is ambiguous by design and the
      // field has to stay absent.
      setKeys: (next: Record<string, any>) => { patch = next },
      testState: [{ status: 'idle', message: '' }, () => {}],
      runLoopbackTest: () => {},
      loaded: true,
      // A stored key already exists on the host; the row badge shows it.
      dialogState: [{ id: 'brave', endpoint: '', hasApiKey: true, options: {} }, () => {}],
      addDialogState: [null, () => {}],
    }))
    const saveButton = captured.find((el) => el.props?.children === t.enginesEditSave)
    saveButton!.props.onClick()
    expect(patch!.searchEngineConfigs.brave.hasApiKey).toBe(true)
    expect('apiKey' in patch!.searchEngineConfigs.brave).toBe(false)
  })

  it('renders the legacy Plugins-tab card', async () => {
    const { chunks } = await createChunkLoader().load()
    const Card = (chunks['client.settings.js'].ConfigCard as (...args: unknown[]) => unknown)(react, ui, localeRef)

    expect(renderComponent(Card)).toContain('网络 (dsh-network)')
  })

  it('renders the sidebar search panel', async () => {
    const { chunks } = await createChunkLoader().load()
    const panel = chunks['client.searchpanel.js']
    const Page = (panel.SearchPanelPage as (...args: unknown[]) => unknown)(react, ui, localeRef)

    const html = renderComponent(Page)
    expect(html).toContain('网络搜索')
    expect(html.length).toBeGreaterThan(500)
  })

  it('renders the toolview rows', async () => {
    const { chunks } = await createChunkLoader().load()
    const views = chunks['client.toolviews.js']
    const Row = (views.SearchToolview as (...args: unknown[]) => unknown)(react, ui, localeRef)

    const html = renderComponent(Row, {
      block: {
        kind: 'tool-result',
        call: { name: 'web_search', argsRaw: JSON.stringify({ queries: ['dsh-network plugin github'] }) },
        meta: { answer: '### dsh-network plugin github', sources: [] },
      },
    })
    expect(html).toContain('dsh-network plugin github')
  })

  it('renders the web_config row from the meta the host persists', async () => {
    const { chunks, entry } = await createChunkLoader().load()
    const views = chunks['client.toolviews.js']
    const t = labelsFrom(entry)
    const Row = (views.WebConfigToolview as (...args: unknown[]) => unknown)(react, ui, localeRef)

    const html = renderComponent(Row, {
      block: {
        kind: 'tool-result',
        call: { name: 'web_config', argsRaw: JSON.stringify({ action: 'set' }) },
        meta: {
          status: 'ok',
          action: 'set',
          persisted: true,
          changes: ['searchMaxResults'],
          config: {
            searchEngines: ['bing', 'brave'],
            searchEngineConfigs: { brave: { hasApiKey: true, options: {} } },
            searchMaxResults: 20,
            allowlist: [],
            ssrfProtection: true,
            webSearchTool: true,
            githubIndexes: [],
            githubSort: 'best',
            hasGithubToken: false,
          },
        },
      },
    })
    // The labels come from the entry's DICTS (a key missing there renders as
    // nothing at all, which is how a half-wired row would look).
    expect(html).toContain(t.configToolTitle)
    expect(html).toContain(t.configToolSet)
    expect(html).toContain(t.configToolPersisted)
    // The change list shows the STORED value, and the chain carries the keyed
    // engine chip — the two reasons this row exists at all.
    expect(html).toContain(t.configToolChangeTitle)
    expect(html).toContain('dshn-cfgname">searchMaxResults</span><span class="dshn-cfgvalue">20')
    expect(html).toContain('brave')
    expect(html).toContain(t.configToolKey)
  })

  it('renders the web_fetch row with the page and its outgoing links', async () => {
    const { chunks, entry } = await createChunkLoader().load()
    const views = chunks['client.toolviews.js']
    const t = labelsFrom(entry)
    const Row = (views.WebFetchToolview as (...args: unknown[]) => unknown)(react, ui, localeRef)

    const html = renderComponent(Row, {
      block: {
        kind: 'tool-result',
        call: { name: 'web_fetch', argsRaw: JSON.stringify({ url: 'https://example.com/docs' }) },
        meta: {
          url: 'https://example.com/docs',
          statusCode: 200,
          contentType: 'text/html; charset=utf-8',
          format: 'markdown',
          contentPreview: '# Release notes\n\nbody',
          linksCount: 1,
          links: [{ text: 'Guide', url: 'https://example.com/guide' }],
        },
      },
    })
    expect(html).toContain(t.fetchToolTitle)
    expect(html).toContain('https://example.com/docs')
    // The page itself must survive as rendered markdown, and the outgoing
    // link list must be present — that is the whole point of the row.
    expect(html).toContain('# Release notes')
    expect(html).toContain('href="https://example.com/guide"')
  })
})
