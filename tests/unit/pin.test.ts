/**
 * The Admin PIN's security arithmetic, without an emulator: hashing, the per-account lockout,
 * the business-wide monitor, the setup limit, the recent-sign-in check, and the void checks
 * the server restates from firestore.rules.
 *
 * The clock is always handed in, so a fifteen-minute lockout is tested in microseconds.
 */
import { describe, expect, it } from 'vitest'

import {
  EMPTY_WINDOW,
  GLOBAL_ALERT_THRESHOLD,
  hashPin,
  isRecentSignIn,
  isValidPin,
  LOCK_MS,
  lockRemainingMs,
  MAX_FAILURES,
  NO_ATTEMPTS,
  parseStoredPin,
  recordGlobalFailure,
  recordSetupAttempt,
  SETUP_MAX_PER_WINDOW,
  spendAttempt,
  verifyPin,
  type AttemptState,
  type WindowCount,
} from '../../functions/src/pin'
import {
  orderTotalOf,
  resolveInitiator,
  validateReason,
  VOID_REASON_MAX,
} from '../../functions/src/void'
import { VOID_REASON_MAX as CLIENT_VOID_REASON_MAX, validateVoidReason } from '@/features/pos/voids'

const MINUTE = 60_000
const T0 = Date.UTC(2026, 10, 3, 9, 0, 0)

describe('PIN format', () => {
  it('accepts exactly six digits', () => {
    expect(isValidPin('012345')).toBe(true)
    expect(isValidPin('999999')).toBe(true)
  })

  it('refuses anything else', () => {
    for (const value of [
      '',
      '12345',
      '1234567',
      '12a456',
      ' 123456',
      '123456 ',
      '１２３４５６',
      123456,
      null,
    ]) {
      expect(isValidPin(value), String(value)).toBe(false)
    }
  })
})

describe('PIN hashing', () => {
  it('verifies the PIN it was made from, and nothing else', async () => {
    const stored = await hashPin('482915')
    expect(await verifyPin('482915', stored)).toBe(true)
    expect(await verifyPin('482916', stored)).toBe(false)
    expect(await verifyPin('000000', stored)).toBe(false)
  })

  it('never stores the PIN, and salts every hash differently', async () => {
    const first = await hashPin('482915')
    const second = await hashPin('482915')
    expect(JSON.stringify(first)).not.toContain('482915')
    expect(first.salt).not.toBe(second.salt)
    expect(first.hash).not.toBe(second.hash)
    expect(first.algorithm).toBe('scrypt')
  })

  it('reads a stored hash back, and refuses a malformed one', async () => {
    const stored = await hashPin('482915')
    expect(parseStoredPin({ ...stored })).toEqual(stored)
    expect(parseStoredPin(undefined)).toBeNull()
    expect(parseStoredPin({ ...stored, algorithm: 'sha1' })).toBeNull()
    expect(parseStoredPin({ ...stored, params: { ...stored.params, N: 0 } })).toBeNull()
  })
})

describe('per-account lockout: five wrong PINs, fifteen minutes', () => {
  /** Spends `count` attempts one minute apart, starting at T0. */
  function spend(count: number, from: AttemptState = NO_ATTEMPTS): AttemptState {
    let state = from
    for (let i = 0; i < count; i += 1) state = spendAttempt(state, T0 + i * MINUTE)
    return state
  }

  it('does not lock before the fifth attempt', () => {
    const state = spend(MAX_FAILURES - 1)
    expect(state.failures).toBe(4)
    expect(lockRemainingMs(state, T0 + 4 * MINUTE)).toBe(0)
  })

  it('locks on the fifth, for fifteen minutes', () => {
    const state = spend(MAX_FAILURES)
    const fifthAt = T0 + 4 * MINUTE
    expect(state.lockedUntil).toBe(fifthAt + LOCK_MS)
    expect(lockRemainingMs(state, fifthAt + 1)).toBeGreaterThan(14 * MINUTE)
    expect(lockRemainingMs(state, fifthAt + LOCK_MS - 1)).toBe(1)
  })

  it('lifts the lock once fifteen minutes have passed, and starts counting afresh', () => {
    const locked = spend(MAX_FAILURES)
    const after = (locked.lockedUntil ?? 0) + 1
    expect(lockRemainingMs(locked, after)).toBe(0)
    const next = spendAttempt(locked, after)
    expect(next).toEqual({ failures: 1, windowStart: after, lockedUntil: null })
  })

  it('forgets failures older than the window', () => {
    const four = spend(4)
    const muchLater = T0 + 60 * MINUTE
    expect(spendAttempt(four, muchLater)).toEqual({
      failures: 1,
      windowStart: muchLater,
      lockedUntil: null,
    })
  })

  it('a correct PIN clears the count back to nothing', () => {
    expect(NO_ATTEMPTS).toEqual({ failures: 0, windowStart: null, lockedUntil: null })
  })
})

describe('business-wide monitor: warns, never locks', () => {
  it('counts failures across a rolling hour and raises an alert at the threshold', () => {
    let state: WindowCount = EMPTY_WINDOW
    const alerts: boolean[] = []
    for (let i = 0; i < GLOBAL_ALERT_THRESHOLD; i += 1) {
      const result = recordGlobalFailure(state, T0 + i * MINUTE)
      state = result.state
      alerts.push(result.alert)
    }
    expect(alerts.slice(0, -1).every((alert) => !alert)).toBe(true)
    expect(alerts.at(-1)).toBe(true)
    // Nothing it returns can lock anybody: it has no lock to set.
    expect(Object.keys(state).sort()).toEqual(['count', 'windowStart'])
  })

  it('starts a new hour afresh', () => {
    const busy = { count: 40, windowStart: T0 }
    expect(recordGlobalFailure(busy, T0 + 61 * MINUTE)).toEqual({
      state: { count: 1, windowStart: T0 + 61 * MINUTE },
      alert: false,
    })
  })
})

describe('PIN setup limit', () => {
  it('allows five setups in fifteen minutes, then refuses until the window passes', () => {
    let state: WindowCount = EMPTY_WINDOW
    const allowed: boolean[] = []
    for (let i = 0; i <= SETUP_MAX_PER_WINDOW; i += 1) {
      const result = recordSetupAttempt(state, T0 + i * MINUTE)
      state = result.state
      allowed.push(result.allowed)
    }
    expect(allowed).toEqual([true, true, true, true, true, false])
    expect(recordSetupAttempt(state, T0 + 16 * MINUTE).allowed).toBe(true)
  })
})

describe('recent sign-in', () => {
  const now = T0
  it('accepts a sign-in within the last five minutes', () => {
    expect(isRecentSignIn((now - 4 * MINUTE) / 1000, now)).toBe(true)
    expect(isRecentSignIn(now / 1000, now)).toBe(true)
  })

  it('refuses an older sign-in, a far-future one, or no claim at all', () => {
    expect(isRecentSignIn((now - 6 * MINUTE) / 1000, now)).toBe(false)
    expect(isRecentSignIn((now + 10 * MINUTE) / 1000, now)).toBe(false)
    expect(isRecentSignIn(undefined, now)).toBe(false)
    expect(isRecentSignIn('1700000000', now)).toBe(false)
  })
})

describe('void checks restated on the server', () => {
  it('validates a reason exactly as the app does', () => {
    expect(VOID_REASON_MAX).toBe(CLIENT_VOID_REASON_MAX)
    const cases = [
      '',
      '   ',
      'Wrong item',
      '  Customer changed mind  ',
      'x'.repeat(200),
      'x'.repeat(201),
    ]
    for (const input of cases) {
      const client = validateVoidReason(input)
      expect(validateReason(input), JSON.stringify(input)).toBe(client.ok ? client.reason : null)
    }
    expect(validateReason(42)).toBeNull()
  })

  it('records the signed-in account when no operator is named', () => {
    const profile = { exists: true, active: true, name: 'Counter Till' }
    expect(resolveInitiator('till', profile, null, null)).toEqual({
      staffId: 'till',
      staffName: 'Counter Till',
    })
    expect(resolveInitiator('till', profile, 'till', null)).toEqual({
      staffId: 'till',
      staffName: 'Counter Till',
    })
  })

  it('records a named operator under the name the roster holds', () => {
    const profile = { exists: true, active: true, name: 'Counter Till' }
    const alice = { exists: true, active: true, name: 'Alice' }
    expect(resolveInitiator('till', profile, 'alice', alice)).toEqual({
      staffId: 'alice',
      staffName: 'Alice',
    })
  })

  it('refuses an operator who is unknown, deactivated or unnamed', () => {
    const profile = { exists: true, active: true, name: 'Counter Till' }
    expect(resolveInitiator('till', profile, 'ghost', { exists: false })).toBeNull()
    expect(resolveInitiator('till', profile, 'ghost', null)).toBeNull()
    expect(
      resolveInitiator('till', profile, 'bob', { exists: true, active: false, name: 'Bob' }),
    ).toBeNull()
    expect(
      resolveInitiator('till', profile, 'bob', { exists: true, active: true, name: '  ' }),
    ).toBeNull()
  })

  it('refuses an inactive or nameless account', () => {
    expect(
      resolveInitiator('till', { exists: true, active: false, name: 'X' }, null, null),
    ).toBeNull()
    expect(resolveInitiator('till', { exists: false }, null, null)).toBeNull()
    expect(
      resolveInitiator('till', { exists: true, active: true, name: '' }, null, null),
    ).toBeNull()
  })

  it('takes an order total only as a whole, non-negative number of sen', () => {
    expect(orderTotalOf(1250)).toBe(1250)
    expect(orderTotalOf(0)).toBe(0)
    expect(orderTotalOf(12.5)).toBeNull()
    expect(orderTotalOf(-1)).toBeNull()
    expect(orderTotalOf('1250')).toBeNull()
  })
})
