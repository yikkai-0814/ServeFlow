/**
 * The order page's void warm-up (src/features/pos/void-warmup.ts).
 *
 * It must send exactly `{ warmup: true }` to `voidOrderWithAdminPin` — never a PIN, a reason or an
 * order — only for the account Firebase Auth is signed in as, one at a time, and not again for five
 * minutes after one succeeds. A failure may be retried at the next trigger. It returns at once,
 * never throws and touches no storage, and its state is its own: the order warm-up's does not
 * affect it.
 */
import { FirebaseError } from 'firebase/app'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const session = vi.hoisted(() => ({ currentUser: { uid: 'till-uid' } as { uid: string } | null }))
const callable = vi.hoisted(() => vi.fn())
const httpsCallable = vi.hoisted(() => vi.fn((..._args: unknown[]) => callable))

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

import { resetOrderWarmup, warmUpOrders } from '@/features/pos/order-warmup'
import {
  resetVoidWarmup,
  VOID_WARMUP_INTERVAL_MS,
  VOID_WARMUP_TIMEOUT_MS,
  warmUpVoids,
} from '@/features/pos/void-warmup'

const T0 = 1_800_000_000_000

/** Lets the warm-up's promise callbacks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function deferred() {
  let resolve!: (value: unknown) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** The function each call was made to, in order. */
const calledFunctions = () => httpsCallable.mock.calls.map((call) => call[1])

let storage: {
  getItem: ReturnType<typeof vi.fn>
  setItem: ReturnType<typeof vi.fn>
  removeItem: ReturnType<typeof vi.fn>
}

beforeEach(() => {
  resetVoidWarmup()
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
  it('calls voidOrderWithAdminPin with exactly { warmup: true }, and its own timeout', async () => {
    warmUpVoids('till-uid', T0)
    await settle()

    expect(httpsCallable).toHaveBeenCalledWith({ __functions: true }, 'voidOrderWithAdminPin', {
      timeout: VOID_WARMUP_TIMEOUT_MS,
    })
    expect(callable).toHaveBeenCalledOnce()
    expect(callable.mock.calls[0]).toEqual([{ warmup: true }])
  })

  it('never carries a PIN, a reason or an order', async () => {
    warmUpVoids('till-uid', T0)
    await settle()

    const [payload] = callable.mock.calls[0] as [Record<string, unknown>]
    expect(Object.keys(payload)).toEqual(['warmup'])
    for (const key of ['pin', 'reason', 'orderId', 'operatorId']) {
      expect(payload).not.toHaveProperty(key)
    }
  })

  it('returns at once, without waiting for the answer', () => {
    callable.mockReturnValue(new Promise(() => undefined))

    expect(warmUpVoids('till-uid', T0)).toBeUndefined()
    expect(callable).toHaveBeenCalledOnce()
  })

  it('touches no storage', async () => {
    warmUpVoids('till-uid', T0)
    await settle()

    expect(storage.getItem).not.toHaveBeenCalled()
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(storage.removeItem).not.toHaveBeenCalled()
  })
})

describe('whose session', () => {
  it('sends nothing when nobody is signed in', () => {
    session.currentUser = null
    warmUpVoids('till-uid', T0)
    expect(callable).not.toHaveBeenCalled()
  })

  it('sends nothing when the signed-in account is not the one the page believes it has', () => {
    session.currentUser = { uid: 'someone-else' }
    warmUpVoids('till-uid', T0)
    expect(callable).not.toHaveBeenCalled()
  })

  it('sends nothing without an account at all', () => {
    warmUpVoids('', T0)
    expect(callable).not.toHaveBeenCalled()
  })
})

describe('how often', () => {
  it('does not send another within five minutes of one that succeeded', async () => {
    warmUpVoids('till-uid', T0)
    await settle()
    warmUpVoids('till-uid', T0 + VOID_WARMUP_INTERVAL_MS - 1)
    await settle()

    expect(callable).toHaveBeenCalledOnce()
  })

  it('sends again once five minutes have passed', async () => {
    warmUpVoids('till-uid', T0)
    await settle()
    warmUpVoids('till-uid', T0 + VOID_WARMUP_INTERVAL_MS)
    await settle()

    expect(callable).toHaveBeenCalledTimes(2)
  })

  it('never has two in flight, however many triggers arrive', async () => {
    const pending = deferred()
    callable.mockReturnValueOnce(pending.promise)

    // The order opening, the page coming back into view and the dialog opening, all at once.
    for (let i = 0; i < 3; i += 1) warmUpVoids('till-uid', T0 + i)
    expect(callable).toHaveBeenCalledOnce()

    pending.resolve({ data: { warm: true } })
    await settle()
    warmUpVoids('till-uid', T0 + 10)
    expect(callable).toHaveBeenCalledOnce()
  })

  it.each([
    ['a network failure', new FirebaseError('functions/unavailable', 'offline')],
    ['a timeout', new FirebaseError('functions/deadline-exceeded', 'timeout')],
    [
      'a refusal',
      Object.assign(new FirebaseError('functions/permission-denied', 'not-allowed'), {
        details: { reason: 'not-allowed' },
      }),
    ],
  ])('may try again at the next trigger after %s', async (_label, failure) => {
    callable.mockRejectedValueOnce(failure)

    warmUpVoids('till-uid', T0)
    await settle()
    warmUpVoids('till-uid', T0 + 1)
    await settle()

    expect(callable).toHaveBeenCalledTimes(2)
  })
})

describe('separate from the order warm-up', () => {
  it('keeps its own throttle: a recent order warm-up does not hold back a void warm-up', async () => {
    warmUpOrders('till-uid', T0)
    await settle()
    warmUpVoids('till-uid', T0 + 1)
    await settle()

    expect(calledFunctions()).toEqual(['placeOrder', 'voidOrderWithAdminPin'])
  })

  it('keeps its own in-flight state: an order warm-up still running does not block it', () => {
    callable.mockReturnValue(new Promise(() => undefined))
    warmUpOrders('till-uid', T0)
    warmUpVoids('till-uid', T0)

    expect(calledFunctions()).toEqual(['placeOrder', 'voidOrderWithAdminPin'])
  })
})

describe('when it is not worth sending', () => {
  it('sends nothing while the browser says it is offline', () => {
    vi.stubGlobal('navigator', { onLine: false })
    warmUpVoids('till-uid', T0)
    expect(callable).not.toHaveBeenCalled()
  })

  it('sends nothing while the page is hidden', () => {
    vi.stubGlobal('document', { visibilityState: 'hidden' })
    warmUpVoids('till-uid', T0)
    expect(callable).not.toHaveBeenCalled()
  })
})

describe('never in the way', () => {
  it('does not throw when the SDK throws while building the call, and is not left in flight', () => {
    httpsCallable.mockImplementationOnce(() => {
      throw new Error('no functions instance')
    })

    expect(() => warmUpVoids('till-uid', T0)).not.toThrow()
    warmUpVoids('till-uid', T0 + 1)
    expect(callable).toHaveBeenCalledOnce()
  })

  it('does not throw when the call itself throws synchronously, and is not left in flight', () => {
    callable.mockImplementationOnce(() => {
      throw new Error('boom')
    })

    expect(() => warmUpVoids('till-uid', T0)).not.toThrow()
    warmUpVoids('till-uid', T0 + 1)
    expect(callable).toHaveBeenCalledTimes(2)
  })

  it('does not throw when reading the session fails', () => {
    session.currentUser = new Proxy({} as { uid: string }, {
      get() {
        throw new Error('auth not ready')
      },
    })
    expect(() => warmUpVoids('till-uid', T0)).not.toThrow()
    expect(callable).not.toHaveBeenCalled()
  })

  it('swallows a rejected warm-up without an unhandled rejection', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    callable.mockRejectedValueOnce(new Error('server error'))

    warmUpVoids('till-uid', T0)
    await settle()
    await settle()

    process.off('unhandledRejection', unhandled)
    expect(unhandled).not.toHaveBeenCalled()
  })
})
