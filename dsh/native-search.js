/**
 * DeepSeek's official search plugin in its own PUBLIC Cordis web scope.
 * No private registry access, global provider switching or credential store.
 * Official peers are supplied by the DSH installation, never bundled here.
 */
const NATIVE_FIELDS = ['apiKey', 'apiKeyEnv', 'baseURL', 'model', 'apiVersion', 'maxTokens', 'maxUses']

function unavailable(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

async function loadOfficialModules() {
  try {
    const [webModule, nativeModule] = await Promise.all([
      import('@deepseek-ai/dsh-web'),
      import('@deepseek-ai/dsh-web-search-deepseek'),
    ])
    return { WebRuntime: webModule.default ?? webModule.WebRuntime, nativeModule }
  } catch {
    // Never expose a resolver stack, config or credentials through an error.
    throw unavailable('NATIVE_DEPENDENCY_MISSING', 'DeepSeek native search requires compatible DSH host packages (tested with 0.2.0-rc.2).')
  }
}

function readNativeConfig(ctx, namespace) {
  const settings = ctx.get('settings')
  // Headless hosts without Settings still have the official environment /
  // credentials defaults. A present settings service must identify its row.
  if (!settings || typeof settings.describe !== 'function') return {}
  const rows = settings.describe()
  const value = Array.isArray(rows) ? rows.find((row) => row.ns === namespace)?.value : undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw unavailable('NATIVE_CONFIG_UNAVAILABLE', 'The native DeepSeek settings entry is not available; enable the host web-search-deepseek plugin.')
  }
  const config = {}
  for (const key of NATIVE_FIELDS) {
    if (value[key] !== undefined) config[key] = value[key]
  }
  return config
}

function sameConfig(left, right) {
  return left !== undefined && NATIVE_FIELDS.every((key) => left[key] === right[key])
}

/**
 * Lazily create an isolated official provider. Configuration synchronization
 * is serialized, but searches are not: each official operation snapshots its
 * options before awaiting credentials, so in-flight calls retain their config.
 * `loadModules` is injectable for keyless tests only.
 */
export function createNativeSearch(ctx, { loadModules = loadOfficialModules } = {}) {
  let closed = false
  let queue = Promise.resolve()
  let scope
  let webFiber
  let nativeFiber
  let loaded
  let lastConfig

  async function prepare() {
    if (closed) throw unavailable('NATIVE_DISPOSED', 'DeepSeek native search has been disposed.')
    if (typeof ctx.isolate !== 'function' || typeof ctx.get !== 'function' || typeof ctx.plugin !== 'function') {
      throw unavailable('NATIVE_HOST_UNSUPPORTED', 'This DSH host does not provide public isolated plugin scopes.')
    }
    loaded ??= await loadModules()
    if (closed) throw unavailable('NATIVE_DISPOSED', 'DeepSeek native search has been disposed.')
    const { WebRuntime, nativeModule } = loaded
    if (typeof WebRuntime !== 'function' || typeof nativeModule?.apply !== 'function' || typeof nativeModule?.Config !== 'function') {
      throw unavailable('NATIVE_HOST_UNSUPPORTED', 'The installed DSH native search API is not compatible.')
    }
    const namespace = nativeModule.WEB_SEARCH_DEEPSEEK_SETTINGS_NAMESPACE ?? 'web-search-deepseek'
    const config = readNativeConfig(ctx, namespace)
    try {
      // Validate with the official schema before changing a working instance.
      nativeModule.Config(config)
    } catch {
      throw unavailable('NATIVE_CONFIG_INVALID', 'The host native DeepSeek search configuration is invalid.')
    }
    if (!scope) {
      scope = ctx.isolate('web')
      try {
        // Keep the thenable before awaiting: a startup failure still owns a
        // fiber that must be disposed before a later retry.
        webFiber = scope.plugin(WebRuntime, { searchProvider: 'deepseek-official' })
        webFiber = await webFiber
        nativeFiber = scope.plugin(nativeModule, config)
        nativeFiber = await nativeFiber
        lastConfig = config
      } catch {
        await nativeFiber?.dispose?.()
        await webFiber?.dispose?.()
        scope = undefined
        nativeFiber = undefined
        webFiber = undefined
        throw unavailable('NATIVE_HOST_UNSUPPORTED', 'Could not initialize the official DeepSeek search plugin in an isolated scope.')
      }
    } else if (!sameConfig(lastConfig, config)) {
      // true is Cordis's public noSave hint. This child is NOT a profile row;
      // never persist its copied native settings in dsh-network's JSON file.
      nativeFiber.update(config, true)
      await nativeFiber.await()
      lastConfig = config
    }
    if (closed) throw unavailable('NATIVE_DISPOSED', 'DeepSeek native search has been disposed.')
    // .web can resolve the parent fiber's injected-service cache after isolate.
    // get() deliberately resolves the PUBLIC service in this isolated scope.
    const web = scope.get('web')
    if (!web || typeof web.search !== 'function') {
      throw unavailable('NATIVE_HOST_UNSUPPORTED', 'The isolated native search service is not available.')
    }
    return web
  }

  async function search(request, signal) {
    signal?.throwIfAborted()
    const task = queue.then(async () => {
      signal?.throwIfAborted()
      const web = await prepare()
      signal?.throwIfAborted()
      // Do not await the request while holding the configuration queue.
      return { result: web.search(request, signal) }
    })
    queue = task.then(() => undefined, () => undefined)
    return task.then(({ result }) => result)
  }

  async function dispose() {
    closed = true
    await queue
    await nativeFiber?.dispose?.()
    await webFiber?.dispose?.()
    nativeFiber = undefined
    webFiber = undefined
    lastConfig = undefined
    loaded = undefined
    scope = undefined
  }

  return { search, dispose }
}
