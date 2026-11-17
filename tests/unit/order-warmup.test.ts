/**
 * The till's order warm-up (src/features/pos/order-warmup.ts).
 *
 * It must send exactly `{ warmup: true }`, only for the account Firebase Auth is signed in as,
 * one at a time, and not again for five minutes after one succeeds. A failure may be retried at
 * the next trigger. It returns at once, never throws, and touches no storage — which is what keeps
 * it out of an order's way.
 */
import { FirebaseError } from 'firebase/app'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const session = vi.hoisted(() => ({ currentUser: { uid: 'till-uid' } as { uid: string } | null }))
const callable = vi.hoisted(() => vi.fn())
const httpsCallable = vi.hoisted(() => vi.fn(() => callable))

vi.mock('@/lib/firebase', () => ({
  app: {},
  db: {},
  auth: {
    get currentUser() {
      return session.currentUser
    },
  },
}))
vi.mock('@/lib/functions', () => ({ appFunctions: () => ({ __functions: true }) }))
vi.mock('firebase/functions', () => ({ httpsCallable }))

import {
  ORDER_WARMUP_INTERVAL_MS,
  ORDER_WARMUP_TIMEOUT_MS,
  resetOrderWarmup,
  warmUpOrders,
} from '@/features/pos/order-warmup'

const T0 = 1_800_000_000_000

/** Lets the warm-up's promise callbacks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A promise the test settles by hand, for a warm-up still in flight. */
function deferred() {
  let resolve!: (value: unknown) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

let storage: {
  getItem: ReturnType<typeof vi.fn>
  setItem: ReturnType<typeof vi.fn>
  removeItem: ReturnType<typeof vi.fn>
}

beforeEach(() => {
  resetOrderWarmup()
  session.currentUser = { uid: 'till-uid' }
  callable.mockReset()
  callable.mockResolvedValue({ data: { warm: true } })
  httpsCallable.mockClear()
  storage = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() }
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('navigator', { onLine: true })
  vi.stubGlobal('document', { visibilityState: 'visible' })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('what is sent', () => {
  it('calls placeOrder with exactly { warmup: true }, and its own timeout', async () => {
    warmUpOrders('till-uid', T0)
    await settle()

    expect(httpsCallable).toHaveBeenCalledWith({ __functions: true }, 'placeOrder', {
      timeout: ORDER_WARMUP_TIMEOUT_MS,
    })
    expect(callable).toHaveBeenCalledOnce()
    expect(callable).toHaveBeenCalledWith({ warmup: true })
  })

  it('returns at once, without waiting for the answer', () => {
    callable.mockReturnValue(new Promise(() => undefined))

    expect(warmUpOrders('till-uid', T0)).toBeUndefined()
    expect(callable).toHaveBeenCalledOnce()
  })

  it('touches no storage — no pending order, no remembered state', async () => {
    warmUpOrders('till-uid', T0)
    await settle()

    expect(storage.getItem).not.toHaveBeenCalled()
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(storage.removeItem).not.toHaveBeenCalled()
  })
})

describe('whose session', () => {
  it('sends nothing when nobody is signed in', () => {
    session.currentUser = null
    warmUpOrders('till-uid', T0)
    expect(callable).not.toHaveBeenCalled()
  })

  it('sends nothing when the signed-in account is not the one the till believes it has', () => {
    // Mid-way through switching accounts: the page still holds the old profile.
    session.currentUser = { uid: 'someone-else' }
    warmUpOrders('till-uid', T0)
    expect(callable).not.toHaveBeenCalled()
  })

  it('sends nothing without an account at all', () => {
    warmUpOrders('', T0)
    expect(callable).not.toHaveBeenCalled()
  })
})

describe('how often', () => {
  it('does not send another within five minutes of one that succeeded', async () => {
    warmUpOrders('till-uid', T0)
    await settle()
    warmUpOrders('till-uid', T0 + ORDER_WARMUP_INTERVAL_MS - 1)
    await settle()

    expect(callable).toHaveBeenCalledOnce()
  })

  it('sends again once five minutes have passed', async () => {
    warmUpOrders('till-uid', T0)
    await settle()
    warmUpOrders('till-uid', T0 + ORDER_WARMUP_INTERVAL_MS)
    await settle()

    expect(callable).toHaveBeenCalledTimes(2)
  })

  it('never has two in flight, however many triggers arrive', async () => {
    const pending = deferred()
    callable.mockReturnValueOnce(pending.promise)

    // Opening, coming into view, an operator chosen and a first item, all at once.
    for (let i = 0; i < 4; i += 1) warmUpOrders('till-uid', T0 + i)
    expect(callable).toHaveBeenCalledOnce()

    pending.resolve({ data: { warm: true } })
    await settle()
    warmUpOrders('till-uid', T0 + 10)
    expect(callable).toHaveBeenCalledOnce()
  })

  it('may try again at the next trigger after a failure', async () => {
    callable.mockRejectedValueOnce(new FirebaseError('functions/unavailable', 'offline'))

    warmUpOrders('till-uid', T0)
    await settle()
    warmUpOrders('till-uid', T0 + 1)
    await settle()

    expect(callable).toHaveBeenCalledTimes(2)
  })

  it('treats a timeout as a failure, not a success', async () => {
    callable.mockRejectedValueOnce(new FirebaseError('functions/deadline-exceeded', 'timeout'))

    warmUpOrders('till-uid', T0)
    await settle()
    warmUpOrders('till-uid', T0 + 1)
    await settle()

    expect(callable).toHaveBeenCalledTimes(2)
  })

  it('does not count a refusal as a success either', async () => {
    callable.mockRejectedValueOnce(
      Object.assign(new FirebaseError('functions/permission-denied', 'not-allowed'), {
        details: { reason: 'not-allowed' },
      }),
    )

    warmUpOrders('till-uid', T0)
    await settle()
    warmUpOrders('till-uid', T0 + 1)
    await settle()

    expect(callable).toHaveBeenCalledTimes(2)
  })
})

describe('when it is not worth sending', () => {
  it('sends nothing while the browser says it is offline', () => {
    vi.stubGlobal('navigator', { onLine: false })
    warmUpOrders('till-uid', T0)
    expect(callable).not.toHaveBeenCalled()
  })

  it('sends nothing while the page is hidden', () => {
    vi.stubGlobal('document', { visibilityState: 'hidden' })
    warmUpOrders('till-uid', T0)
    expect(callable).not.toHaveBeenCalled()
  })
})

describe('never in the way', () => {
  it('does not throw when the SDK throws while building the call', () => {
    httpsCallable.mockImplementationOnce(() => {
      throw new Error('no functions instance')
    })

    expect(() => warmUpOrders('till-uid', T0)).not.toThrow()
    // And it is not stuck as "in flight" afterwards.
    warmUpOrders('till-uid', T0 + 1)
    expect(callable).toHaveBeenCalledOnce()
  })

  it('does not throw when the call itself throws synchronously', () => {
    callable.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    expect(() => warmUpOrders('till-uid', T0)).not.toThrow()
  })

  it('does not throw when reading the session fails', () => {
    session.currentUser = new Proxy({} as { uid: string }, {
      get() {
        throw new Error('auth not ready')
      },
    })
    expect(() => warmUpOrders('till-uid', T0)).not.toThrow()
    expect(callable).not.toHaveBeenCalled()
  })

  it('swallows a rejected warm-up without an unhandled rejection', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    callable.mockRejectedValueOnce(new Error('server error'))

    warmUpOrders('till-uid', T0)
    await settle()
    await settle()

    process.off('unhandledRejection', unhandled)
    expect(unhandled).not.toHaveBeenCalled()
  })
})
