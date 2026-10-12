/**
 * dsh-network — Mojeek cookie session.
 *
 * `mojeekLogin()` is the slow part: solving Mojeek's Altcha proof-of-work costs
 * a wall-clock 1–2 s and three HTTP requests (challenge → verify → search).
 *
 * One `MojeekSession` is created by the persistent server and threaded onto
 * every `RunContext`; the single-shot CLI gets nothing here, so the standalone
 * `dsh-network search` keeps its existing "no cookie → synthesized 401"
 * behavior and routes anyone who wants Mojeek to `mojeek-login` once.
 *
 * A pre-emptive expiry check (`now >= expiresAt - 1 day`) is intentionally
 * OFF by default — Mojeek's `expires=` is generous (~30 d) and we'd rather
 * keep a known-good cookie than re-solve when the user opens dsh after the
 * server has been idle for a month. The user-supplied cookie (read out of
 * the env snapshot) never reaches this cache; only what we solved ourselves
 * lives here.
 */
import { mojeekLogin, type MojeekLoginOptions, type MojeekLoginOutcome } from './mojeek-login.ts'

/** One-day safety margin so a soon-to-expire cookie triggers a refresh. */
const REFRESH_SAFETY_MS = 86_400_000

export interface MojeekSessionSnapshot {
  /** Current `chllg=…` cookie, or `''` if `ensure()` has not yet succeeded. */
  readonly cookie: string
  /** ISO-8601 expiry string read out of the cookie payload, or `''` if unknown. */
  readonly expiresAt: string
  /** Last solve's wall-clock cost in milliseconds (`0` until the first solve). */
  readonly lastSolveMs: number
  /** Outcome of the last `ensure()` attempt — useful for telemetry / logging. */
  readonly lastOutcome: MojeekLoginOutcome | null
}

export interface MojeekSession extends MojeekSessionSnapshot {
  /**
   * Return a usable cookie, solving the Altcha PoW on first call. Concurrent
   * callers share a single in-flight solve; later callers reuse its result.
   * Returns `''` if the solve failed (the search path then falls through to
   * the synthesized 401 — the user can inspect `lastOutcome` for why).
   */
  ensure(options: MojeekLoginOptions): Promise<string>
  /** Drop the cached cookie. Next `ensure()` re-solves. */
  invalidate(): void
}

interface MutableState {
  cookie: string
  expiresAt: string
  lastSolveMs: number
  lastOutcome: MojeekLoginOutcome | null
  inflight: Promise<string> | null
}

/**
 * Create a fresh session. Typically called once, at server startup.
 * Each instance is independent — two servers have two cookies.
 */
export function createMojeekSession(): MojeekSession {
  const state: MutableState = {
    cookie: '',
    expiresAt: '',
    lastSolveMs: 0,
    lastOutcome: null,
    inflight: null,
  }

  /**
   * Decide whether the cached cookie is still fresh enough to skip the
   * `mojeekLogin()` round-trip. A missing expiry (`''`) means we have no
   * clue when it dies, so the cache is trusted — the search path will
   * `invalidate()` us the moment Mojeek serves the challenge page.
   */
  const isFresh = (): boolean => {
    if (state.cookie === '') return false
    if (state.expiresAt === '') return true
    const exp = Date.parse(state.expiresAt)
    if (!Number.isFinite(exp)) return true
    return Date.now() < exp - REFRESH_SAFETY_MS
  }

  return {
    get cookie() {
      return state.cookie
    },
    get expiresAt() {
      return state.expiresAt
    },
    get lastSolveMs() {
      return state.lastSolveMs
    },
    get lastOutcome() {
      return state.lastOutcome
    },

    async ensure(options: MojeekLoginOptions): Promise<string> {
      if (isFresh()) return state.cookie
      if (state.inflight) return state.inflight
      const run = (async () => {
        const outcome = await mojeekLogin(options)
        state.lastOutcome = outcome
        state.lastSolveMs = outcome.solveMs
        if (outcome.ok && outcome.cookie !== '') {
          state.cookie = outcome.cookie
          state.expiresAt = outcome.expiresAt
          return outcome.cookie
        }
        return ''
      })()
      state.inflight = run
      try {
        return await run
      } finally {
        state.inflight = null
      }
    },

    invalidate(): void {
      state.cookie = ''
      state.expiresAt = ''
    },
  }
}
