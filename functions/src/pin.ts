/**
 * The security arithmetic behind the Admin PIN: hashing, and the counters that stop it being
 * guessed.
 *
 * Pure apart from `node:crypto` — no Firestore, no clock (every function that needs the time
 * is handed it) — so the rules that matter most can be tested exhaustively without an
 * emulator, the same split the app uses for cart.ts, payments.ts and voids.ts.
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

/** Exactly six digits. Nothing else is ever hashed, compared or stored. */
export const PIN_PATTERN = /^\d{6}$/

export function isValidPin(value: unknown): value is string {
  return typeof value === 'string' && PIN_PATTERN.test(value)
}

// ---- Hashing -----------------------------------------------------------------------------

/**
 * scrypt, deliberately slow (~100 ms per comparison). A six-digit PIN has only a million
 * values, so the cost per guess is what makes the stored hash useless to anyone who obtained
 * it — and the hash is only ever readable by this server code in the first place.
 *
 * The parameters are stored WITH each hash rather than assumed, so they can be raised later
 * without invalidating PINs set under the old ones.
 */
export const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, keyLength: 32 } as const

export type ScryptParams = { N: number; r: number; p: number; keyLength: number }

export interface StoredPin {
  algorithm: 'scrypt'
  /** base64 */
  hash: string
  /** base64, 16 random bytes, unique to every PIN set. */
  salt: string
  params: ScryptParams
}

function derive(pin: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      pin,
      salt,
      params.keyLength,
      // 128 * N * r bytes is exactly the memory scrypt needs; Node's default ceiling equals it
      // at these settings and refuses, so the ceiling is stated with headroom.
      { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r },
      (error, key) => (error ? reject(error) : resolve(key)),
    )
  })
}

export async function hashPin(pin: string): Promise<StoredPin> {
  const salt = randomBytes(16)
  const hash = await derive(pin, salt, SCRYPT_PARAMS)
  return {
    algorithm: 'scrypt',
    hash: hash.toString('base64'),
    salt: salt.toString('base64'),
    params: { ...SCRYPT_PARAMS },
  }
}

/** Reads a stored PIN back, refusing anything malformed rather than guessing at it. */
export function parseStoredPin(data: Record<string, unknown> | undefined): StoredPin | null {
  if (!data || data.algorithm !== 'scrypt') return null
  const { hash, salt, params } = data
  if (typeof hash !== 'string' || typeof salt !== 'string') return null
  if (typeof params !== 'object' || params === null) return null
  const { N, r, p, keyLength } = params as Record<string, unknown>
  if (![N, r, p, keyLength].every((value) => Number.isInteger(value) && (value as number) > 0)) {
    return null
  }
  return {
    algorithm: 'scrypt',
    hash,
    salt,
    params: { N: N as number, r: r as number, p: p as number, keyLength: keyLength as number },
  }
}

/** Constant-time comparison, so how long a refusal takes says nothing about how close it was. */
export async function verifyPin(pin: string, stored: StoredPin): Promise<boolean> {
  const expected = Buffer.from(stored.hash, 'base64')
  const actual = await derive(pin, Buffer.from(stored.salt, 'base64'), stored.params)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

// ---- Per-account lockout ------------------------------------------------------------------

/** Five wrong PINs from one signed-in account... */
export const MAX_FAILURES = 5
/** ...within this long of the first... */
export const FAILURE_WINDOW_MS = 15 * 60_000
/** ...lock that account's PIN attempts for this long. */
export const LOCK_MS = 15 * 60_000

/** All times are epoch milliseconds. */
export interface AttemptState {
  failures: number
  windowStart: number | null
  lockedUntil: number | null
}

export const NO_ATTEMPTS: AttemptState = { failures: 0, windowStart: null, lockedUntil: null }

/** How much longer this account is locked out, or 0 if it is not. */
export function lockRemainingMs(state: AttemptState, now: number): number {
  return state.lockedUntil !== null && state.lockedUntil > now ? state.lockedUntil - now : 0
}

/**
 * The state after one more attempt is spent.
 *
 * Called BEFORE the PIN is checked, not after it fails. Counting up front is what stops a
 * burst of simultaneous requests all passing the lock check before any of them has been
 * recorded as a failure; each request takes its attempt atomically, so at most five are ever
 * in flight. A correct PIN then clears the count (see `NO_ATTEMPTS`).
 *
 * An expired lock, or a window that has run out, starts the count afresh — four wrong PINs
 * last week do not leave the till one slip from a lockout today.
 */
export function spendAttempt(state: AttemptState, now: number): AttemptState {
  const fresh =
    state.windowStart === null ||
    now - state.windowStart >= FAILURE_WINDOW_MS ||
    (state.lockedUntil !== null && state.lockedUntil <= now)
  const base = fresh ? { failures: 0, windowStart: now } : state
  const failures = base.failures + 1

  if (failures >= MAX_FAILURES) {
    return { failures: 0, windowStart: null, lockedUntil: now + LOCK_MS }
  }
  return { failures, windowStart: base.windowStart, lockedUntil: null }
}

// ---- Global monitoring (never locks) -------------------------------------------------------

/**
 * Wrong PINs across EVERY account, counted so a guessing attempt spread over several logins
 * is visible. It only ever raises a warning in the logs: a global lock would let any one
 * staff member switch PIN authorisation off for the whole business.
 */
export const GLOBAL_WINDOW_MS = 60 * 60_000
export const GLOBAL_ALERT_THRESHOLD = 15

export interface WindowCount {
  count: number
  windowStart: number | null
}

export const EMPTY_WINDOW: WindowCount = { count: 0, windowStart: null }

function countInWindow(state: WindowCount, now: number, windowMs: number): WindowCount {
  const fresh = state.windowStart === null || now - state.windowStart >= windowMs
  return fresh
    ? { count: 1, windowStart: now }
    : { count: state.count + 1, windowStart: state.windowStart }
}

export function recordGlobalFailure(
  state: WindowCount,
  now: number,
): { state: WindowCount; alert: boolean } {
  const next = countInWindow(state, now, GLOBAL_WINDOW_MS)
  return { state: next, alert: next.count >= GLOBAL_ALERT_THRESHOLD }
}

// ---- PIN setup limit -----------------------------------------------------------------------

/**
 * How often an admin may try to set a PIN. Setting one compares it against every other
 * admin's, so without a limit the "choose a different PIN" answer could be used to search
 * for a colleague's PIN.
 */
export const SETUP_MAX_PER_WINDOW = 5
export const SETUP_WINDOW_MS = 15 * 60_000

export function recordSetupAttempt(
  state: WindowCount,
  now: number,
): { state: WindowCount; allowed: boolean } {
  const next = countInWindow(state, now, SETUP_WINDOW_MS)
  return { state: next, allowed: next.count <= SETUP_MAX_PER_WINDOW }
}

// ---- Recent sign-in ------------------------------------------------------------------------

/** How recently an admin must have proved their password before setting a PIN. */
export const RECENT_SIGN_IN_MS = 5 * 60_000
/** Tolerance for the token being minted a moment "in the future" by a skewed clock. */
const CLOCK_SKEW_MS = 60_000

/** `authTimeSeconds` is the ID token's `auth_time` claim, in seconds as Firebase issues it. */
export function isRecentSignIn(authTimeSeconds: unknown, now: number): boolean {
  if (typeof authTimeSeconds !== 'number' || !Number.isFinite(authTimeSeconds)) return false
  const signedInAt = authTimeSeconds * 1000
  return signedInAt >= now - RECENT_SIGN_IN_MS && signedInAt <= now + CLOCK_SKEW_MS
}
