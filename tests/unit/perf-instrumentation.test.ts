/**
 * The timed calls behave exactly as they did before timing existed, whether it is on or off.
 *
 * The order and void calls are where telemetry sits closest to money, so each is run both ways
 * against the same replaced callable: the same request goes out, the same answer or error comes
 * back, and with timing on, nothing that identifies a person, a sale or a secret is printed.
 */
import { FirebaseError } from 'firebase/app'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import { isMessageError } from '@/features/i18n/messages'
import { addToCart, EMPTY_CART, StaleCartError } from '@/features/pos/cart'
import { PERF_STORAGE_KEY, resetPerf } from '@/lib/perf'

const callable = vi.hoisted(() => vi.fn())

vi.mock('firebase/functions', () => ({ httpsCallable: () => callable }))
vi.mock('@/lib/functions', () => ({ appFunctions: () => ({}) }))

import { createOrder } from '@/features/pos/pos-api'
import { fetchAdminPinStatus, voidOrderWithAdminPin } from '@/features/pos/void-pin-api'

const store = new Map<string, string>()
const storage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
}

/**
 * Values that must never appear in what timing prints. (The table number is not listed: as two
 * digits it could match a duration by chance; no field that could carry it exists anyway.)
 */
const PRIVATE = ['till-uid-42', 'Alice Tan', 'alice-op', 'Teh Tarik Special', '482913']

const cart = addToCart(EMPTY_CART, {
  menuItemId: 'teh',
  name: 'Teh Tarik Special',
  basePrice: 450,
  modifiers: [],
})

const params = {
  cart,
  placement: { orderType: 'dine_in' as const, tableNumber: '  12 ' },
  staff: { id: 'alice-op', name: 'Alice Tan' },
  language: 'en' as const,
  uid: 'till-uid-42',
}

let info: MockInstance<typeof console.info>

function timing(on: boolean) {
  resetPerf()
  if (on) store.set(PERF_STORAGE_KEY, '1')
  else store.delete(PERF_STORAGE_KEY)
}

/** What went to the server, minus the request id, which is random per attempt. */
function sentWithoutId(call = 0) {
  const { requestId: _id, ...rest } = callable.mock.calls[call]![0] as Record<string, unknown>
  return rest
}

function printed() {
  return JSON.stringify(info.mock.calls)
}

function refusal(reason: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new FirebaseError('functions/failed-precondition', reason), {
    details: { reason, ...extra },
  })
}

beforeEach(() => {
  store.clear()
  vi.stubGlobal('localStorage', storage)
  callable.mockReset()
  info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetPerf()
})

describe('placing an order', () => {
  it('sends the same request and returns the same order with timing on as off', async () => {
    callable.mockResolvedValue({ data: { id: 'order-1', number: 7 } })

    timing(false)
    const off = await createOrder(params)
    timing(true)
    const on = await createOrder(params)

    expect(on).toEqual(off)
    expect(sentWithoutId(1)).toEqual(sentWithoutId(0))
    expect(info.mock.calls.map((call) => call[1])).toEqual(['order.prepare', 'order.call'])
    expect(info.mock.calls[1]![3]).toEqual({ outcome: 'ok' })
    for (const value of PRIVATE) expect(printed()).not.toContain(value.trim())
    expect(printed()).not.toContain(String(callable.mock.calls[1]![0].requestId))
  })

  it('refuses a stale cart with the same error, and records only the reason code', async () => {
    const current = { total: 500, lines: [] }
    callable.mockRejectedValue(refusal('price-changed', current))

    timing(false)
    const off = await createOrder(params).catch((error: unknown) => error)
    timing(true)
    const on = await createOrder(params).catch((error: unknown) => error)

    expect(off).toBeInstanceOf(StaleCartError)
    expect(on).toBeInstanceOf(StaleCartError)
    expect((on as StaleCartError).detail).toEqual((off as StaleCartError).detail)
    expect(info.mock.calls.at(-1)![3]).toEqual({ outcome: 'price-changed' })
  })

  it('records nothing at all with timing off', async () => {
    callable.mockResolvedValue({ data: { id: 'order-1', number: 7 } })
    timing(false)

    await createOrder(params)

    expect(info).not.toHaveBeenCalled()
  })
})

describe('voiding with a PIN', () => {
  const voidParams = { reason: 'Customer changed mind', pin: '482913', operatorId: 'alice-op' }

  it('sends the same request and succeeds the same way with timing on as off', async () => {
    callable.mockResolvedValue({ data: { ok: true } })

    timing(false)
    await voidOrderWithAdminPin('order-1', voidParams)
    timing(true)
    await voidOrderWithAdminPin('order-1', voidParams)

    expect(callable.mock.calls[1]).toEqual(callable.mock.calls[0])
    expect(info.mock.calls.map((call) => call[1])).toEqual(['void.call'])
    expect(info.mock.calls[0]![3]).toEqual({ outcome: 'ok' })
    expect(printed()).not.toMatch(/482913|Customer changed mind|alice-op|order-1/)
  })

  it('reports a wrong PIN with the same sentence, and records only the reason code', async () => {
    callable.mockRejectedValue(
      Object.assign(new FirebaseError('functions/permission-denied', 'incorrect-pin'), {
        details: { reason: 'incorrect-pin' },
      }),
    )

    timing(false)
    const off = await voidOrderWithAdminPin('order-1', voidParams).catch((error: unknown) => error)
    timing(true)
    const on = await voidOrderWithAdminPin('order-1', voidParams).catch((error: unknown) => error)

    expect(isMessageError(on) && isMessageError(off)).toBe(true)
    expect((on as { detail: unknown }).detail).toEqual((off as { detail: unknown }).detail)
    expect(info.mock.calls[0]![3]).toEqual({ outcome: 'incorrect-pin' })
    expect(printed()).not.toContain('482913')
  })

  it('answers the PIN status question the same way, and passes a failure straight through', async () => {
    callable.mockResolvedValue({ data: { pinAvailable: true } })
    timing(true)
    await expect(fetchAdminPinStatus()).resolves.toEqual({ pinAvailable: true })

    const failure = new FirebaseError('functions/unavailable', 'offline')
    callable.mockRejectedValue(failure)
    await expect(fetchAdminPinStatus()).rejects.toBe(failure)

    expect(info.mock.calls.map((call) => call[3])).toEqual([
      { outcome: 'ok' },
      { outcome: 'unavailable' },
    ])
  })
})
