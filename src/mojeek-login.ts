/**
 * dsh-network — Mojeek login: solve the Altcha proof-of-work ONCE, trade it
 * for the one-month `chllg` cookie, hand the cookie back as a string.
 *
 * Everything goes through `runClientFetch`, so the challenge and the verify
 * POST inherit the plugin's SSRF fence — allowlist, private/reserved-IP
 * rejection, DNS pinning, redirect lock. No socket is opened here.
 */
import { pbkdf2 as pbkdf2Callback } from 'node:crypto'
import { runClientFetch } from './client.ts'
import { FIREFOX_MOJEEK } from './engines/header-profiles.ts'
import { MOJEEK_FREE_CHALLENGE_URL, MOJEEK_FREE_VERIFY_URL } from './engines/mojeek-free.ts'

/** Worker count for the counter search (libuv threadpool is 4 by default). */
const DEFAULT_CONCURRENCY = 4

/** Wall-clock budget for the whole PoW. The observed worst case is ~300 counters ≈ 2 s. */
const DEFAULT_SOLVE_BUDGET_MS = 20_000

/** Hard cap on counters tried, independent of the clock. */
const DEFAULT_MAX_ATTEMPTS = 200_000

/** Altcha's `algorithm` field → Node digest name. */
const DIGESTS: Readonly<Record<string, string>> = {
  'PBKDF2/SHA-256': 'sha256',
  'PBKDF2/SHA-384': 'sha384',
  'PBKDF2/SHA-512': 'sha512',
}

export interface MojeekLoginOptions {
  /** Per-request timeout (challenge GET / verify POST). */
  timeoutMs?: number
  /** Wall-clock budget for the PoW itself. */
  solveBudgetMs?: number
  /** Counter ceiling, so a wrong password layout cannot spin forever. */
  maxAttempts?: number
  /** Parallel PBKDF2 workers. */
  concurrency?: number
  /** SSRF knobs, threaded from the CLI's live config. */
  allowlist?: readonly string[]
  allowPrivateNetwork?: boolean
  redirectProtection?: boolean
  protocolLock?: boolean
  maxRedirects?: number
}

export interface MojeekLoginOutcome {
  ok: boolean
  /** The `chllg=…` pair, ready to paste as the engine credential. */
  cookie: string
  /** Cookie expiry (ISO-8601) read out of the cookie payload, or ''. */
  expiresAt: string
  /** The counter the PoW landed on. */
  counter: number
  /** How long the PoW took, in milliseconds. */
  solveMs: number
  /** Counters tried before the key prefix matched. */
  attempts: number
  warnings: string[]
  /** Filled when `ok` is false. */
  error: string
}

interface ChallengeParameters {
  algorithm: string
  cost: number
  keyLength: number
  keyPrefix: string
  nonce: string
  salt: string
  expiresAt?: number
}

interface Challenge {
  parameters: ChallengeParameters
  signature?: string
}

/** Promise wrapper over the async (threadpool) PBKDF2 — never pbkdf2Sync. */
function pbkdf2(
  password: Buffer,
  salt: Buffer,
  iterations: number,
  keyLength: number,
  digest: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    pbkdf2Callback(password, salt, iterations, keyLength, digest, (error, key) => {
      if (error) reject(error)
      else resolve(key as Buffer)
    })
  })
}

/** altcha's default counter mode: `nonce || uint32 big-endian counter`. */
function passwordFor(nonce: Buffer, counter: number): Buffer {
  const buffer = Buffer.alloc(nonce.length + 4)
  nonce.copy(buffer, 0)
  buffer.writeUInt32BE(counter >>> 0, nonce.length)
  return buffer
}

/** Hex → Buffer, or null when the field is not even-length hex. */
function hexToBuffer(value: unknown): Buffer | null {
  const text = String(value ?? '').trim()
  if (text === '' || text.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(text)) return null
  return Buffer.from(text, 'hex')
}

/** Normalize `PBKDF2/SHA256` and `PBKDF2/SHA-256` to one lookup key. */
function digestFor(algorithm: string): string {
  const key = String(algorithm ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (key === 'PBKDF2SHA256') return DIGESTS['PBKDF2/SHA-256'] ?? ''
  if (key === 'PBKDF2SHA384') return DIGESTS['PBKDF2/SHA-384'] ?? ''
  if (key === 'PBKDF2SHA512') return DIGESTS['PBKDF2/SHA-512'] ?? ''
  return ''
}

/**
 * Brute-force the counter whose derived key starts with the published
 * prefix. Counters are handed out from a shared cursor, so the workers
 * interleave instead of each re-walking the same range.
 */
async function solveChallenge(
  params: ChallengeParameters,
  options: { digest: string; budgetMs: number; maxAttempts: number; concurrency: number },
): Promise<{ counter: number; derivedKey: string; attempts: number; solveMs: number } | null> {
  const nonce = hexToBuffer(params.nonce)
  const salt = hexToBuffer(params.salt)
  const prefix = hexToBuffer(params.keyPrefix)
  if (!nonce || !salt || !prefix) return null

  const started = Date.now()
  const deadline = started + options.budgetMs
  let cursor = 0
  let attempts = 0
  let found: { counter: number; derivedKey: string } | null = null

  const worker = async (): Promise<void> => {
    while (found === null && cursor < options.maxAttempts && Date.now() < deadline) {
      const counter = cursor++
      attempts++
      const key = await pbkdf2(passwordFor(nonce, counter), salt, params.cost, params.keyLength, options.digest)
      if (found === null && key.subarray(0, prefix.length).equals(prefix)) {
        found = { counter, derivedKey: key.toString('hex') }
      }
    }
  }

  const workers: Array<Promise<void>> = []
  for (let i = 0; i < Math.max(1, options.concurrency); i++) workers.push(worker())
  await Promise.all(workers)

  if (found === null) return null
  const solution = found as { counter: number; derivedKey: string }
  return { ...solution, attempts, solveMs: Date.now() - started }
}

/**
 * The altcha v2 solution payload the widget posts: the WHOLE challenge plus
 * the solution, base64-encoded, in a multipart field named `altcha`.
 */
function multipartBody(field: string, value: string, boundary: string): string {
  return [
    `--${boundary}`,
    `Content-Disposition: form-data; name="${field}"`,
    '',
    value,
    `--${boundary}--`,
    '',
  ].join('\r\n')
}

/**
 * Pull the `chllg` pair out of a Set-Cookie header. The header is matched by
 * cookie NAME rather than split on `,`/`;` because the `expires=` attribute
 * contains both (`expires=Wed, 11-Nov-2026 11:43:40 GMT`).
 */
function extractCookie(setCookie: string): string {
  const match = /(?:^|[\s,;])(chllg=[^;,\s]+)/.exec(String(setCookie ?? ''))
  return match?.[1] ?? ''
}

/**
 * Read `{"ok":true,"exp":…}` out of the cookie value (segment 1 of
 * `base64url(JSON).signature`), so the report can say when the cookie dies
 * instead of leaving the user to discover it.
 */
function cookieExpiry(cookie: string, setCookie: string): string {
  const value = cookie.slice(cookie.indexOf('=') + 1)
  const payload = value.split('.')[0] ?? ''
  try {
    const json = Buffer.from(decodeURIComponent(payload), 'base64').toString('utf8')
    const exp = Number((JSON.parse(json) as { exp?: unknown }).exp)
    if (Number.isFinite(exp) && exp > 0) return new Date(exp * 1000).toISOString()
  } catch {
    // Fall through to the attribute form.
  }
  const maxAge = /max-age=(\d+)/i.exec(setCookie)
  if (maxAge) return new Date(Date.now() + Number(maxAge[1]) * 1000).toISOString()
  return ''
}

/** JSON body → challenge, with the fields the solver needs validated. */
function readChallenge(body: string): { challenge: Challenge; params: ChallengeParameters } | string {
  let parsed: unknown
  try {
    parsed = JSON.parse(String(body ?? '').replace(/^\uFEFF/, '').trim())
  } catch {
    return 'the challenge endpoint did not answer JSON (a proxy or an interstitial page?)'
  }
  if (!parsed || typeof parsed !== 'object') return 'the challenge response was not an object'
  const challenge = parsed as Challenge
  const params = challenge.parameters
  if (!params || typeof params !== 'object') return 'the challenge response has no `parameters`'
  if (!digestFor(params.algorithm)) return `unsupported Altcha algorithm "${params.algorithm}"`
  if (!Number.isInteger(params.cost) || params.cost <= 0) return 'the challenge has no usable `cost`'
  if (!Number.isInteger(params.keyLength) || params.keyLength <= 0 || params.keyLength > 1024) {
    return 'the challenge has no usable `keyLength`'
  }
  return { challenge, params }
}

/**
 * Run the whole login: challenge → PoW → verify → cookie.
 *
 * Never throws for an expected failure (network, HTTP status, unsolvable
 * challenge): the caller gets `ok: false` plus an `error` string, because
 * this runs behind a CLI verb whose contract is one JSON envelope.
 */
export async function mojeekLogin(options: MojeekLoginOptions = {}): Promise<MojeekLoginOutcome> {
  const timeoutMs = options.timeoutMs ?? 20_000
  const warnings: string[] = []
  const base = {
    ok: false,
    cookie: '',
    expiresAt: '',
    counter: -1,
    solveMs: 0,
    attempts: 0,
    warnings,
    error: '',
  }

  // ── 1. challenge ──────────────────────────────────────────────────────────
  let challengeBody = ''
  let challengeStatus = 0
  try {
    const fetched = await runClientFetch({
      url: MOJEEK_FREE_CHALLENGE_URL,
      timeoutMs,
      maxRedirects: options.maxRedirects,
      headers: { ...FIREFOX_MOJEEK, accept: 'application/json' },
      allowlist: options.allowlist,
      allowPrivateNetwork: options.allowPrivateNetwork,
      redirectProtection: options.redirectProtection,
      protocolLock: options.protocolLock,
    })
    challengeBody = fetched.body
    challengeStatus = fetched.status
  } catch (error) {
    return { ...base, error: `challenge request failed: ${(error as Error).message}` }
  }
  if (challengeStatus !== 200) {
    return { ...base, error: `challenge request returned HTTP ${challengeStatus}` }
  }

  const read = readChallenge(challengeBody)
  if (typeof read === 'string') return { ...base, error: read }
  const { challenge, params } = read

  // ── 2. proof of work ──────────────────────────────────────────────────────
  const digest = digestFor(params.algorithm)
  const solved = await solveChallenge(params, {
    digest,
    budgetMs: options.solveBudgetMs ?? DEFAULT_SOLVE_BUDGET_MS,
    maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
  })
  if (!solved) {
    return {
      ...base,
      error:
        'the Altcha challenge could not be solved inside the attempt budget — Mojeek may have raised ' +
        'the difficulty (a longer key prefix or a bigger counter range)',
    }
  }

  // ── 3. verify ─────────────────────────────────────────────────────────────
  const boundary = `----dshnetmojeek${Date.now().toString(36)}`
  const payload = Buffer.from(
    JSON.stringify({
      challenge,
      solution: { counter: solved.counter, derivedKey: solved.derivedKey, time: solved.solveMs },
    }),
  ).toString('base64')

  let setCookie = ''
  let verifyBody = ''
  let verifyStatus = 0
  try {
    const fetched = await runClientFetch({
      url: MOJEEK_FREE_VERIFY_URL,
      method: 'POST',
      timeoutMs,
      maxRedirects: options.maxRedirects,
      headers: { ...FIREFOX_MOJEEK, accept: 'application/json' },
      body: multipartBody('altcha', payload, boundary),
      contentType: `multipart/form-data; boundary=${boundary}`,
      allowlist: options.allowlist,
      allowPrivateNetwork: options.allowPrivateNetwork,
      redirectProtection: options.redirectProtection,
      protocolLock: options.protocolLock,
    })
    setCookie = fetched.headers['set-cookie'] ?? ''
    verifyBody = fetched.body
    verifyStatus = fetched.status
  } catch (error) {
    return {
      ...base,
      counter: solved.counter,
      solveMs: solved.solveMs,
      attempts: solved.attempts,
      error: `verify request failed: ${(error as Error).message}`,
    }
  }

  const cookie = extractCookie(setCookie)
  const common = {
    ...base,
    counter: solved.counter,
    solveMs: solved.solveMs,
    attempts: solved.attempts,
    cookie,
  }

  if (verifyStatus !== 200) {
    return { ...common, cookie: '', error: `verify returned HTTP ${verifyStatus}${verifyBody ? ` —${verifyBody.slice(0, 120)}` : ''}` }
  }
  if (cookie === '') {
    return { ...common, error: 'verify succeeded but no chllg cookie came back' }
  }
  // `{"ok":true,"verified":true}` is Mojeek's own success claim; a body that
  // says otherwise while still setting a cookie is worth a warning.
  if (!/"verified"\s*:\s*true/.test(verifyBody)) {
    warnings.push(`verify answered without "verified": true (${verifyBody.slice(0, 120) || 'empty body'})`)
  }

  const expiresAt = cookieExpiry(cookie, setCookie)
  if (expiresAt === '') warnings.push('the cookie expiry could not be read; the engine will report a stale cookie when it lapses')

  return { ...common, ok: true, expiresAt }
}
