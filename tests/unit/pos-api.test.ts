/**
 * What the till sends to `placeOrder`, and what it makes of the answer.
 *
 * The callable is replaced, so these prove the till's side of the bargain: it sends choices, with
 * prices and names only as a quote to compare, it retries under the same request id, and each
 * refusal comes back as something the counter can read. tests/functions runs the same code against
 * the real function.
 */
import { FirebaseError } from 'firebase/app'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { isMessageError, MessageError } from '@/features/i18n/messages'
import { addToCart, EMPTY_CART, refreshCart, StaleCartError } from '@/features/pos/cart'
import {
  fingerprintOf,
  forgetRequest,
  PENDING_ORDER_SEND_LIMIT_MS,
  PENDING_ORDER_STORAGE_KEY,
  PENDING_ORDER_TTL_MS,
  requestIdFor,
} from '@/features/pos/pending-order'

const callable = vi.hoisted(() => vi.fn())

vi.mock('firebase/functions', () => ({ httpsCallable: () => callable }))
vi.mock('@/lib/functions', () => ({ appFunctions: () => ({}) }))

import { createOrder } from '@/features/pos/pos-api'

const modifier = {
  groupId: 'g',
  groupName: 'Add-ons',
  optionId: 'egg',
  optionName: 'Egg',
  priceAdjustment: 150,
}

const cart = addToCart(
  addToCart(EMPTY_CART, {
    menuItemId: 'nasi',
    name: 'Nasi Lemak',
    basePrice: 800,
    modifiers: [modifier],
  }),
  { menuItemId: 'nasi', name: 'Nasi Lemak', basePrice: 800, modifiers: [modifier] },
)

const params = {
  cart,
  placement: { orderType: 'dine_in' as const, tableNumber: ' 5 ' },
  staff: { id: 'alice', name: 'Alice' },
  language: 'ms' as const,
  uid: 'till-uid',
}

const sent = (call = 0) => callable.mock.calls[call]?.[0]

function refusal(details: unknown, code = 'functions/failed-precondition') {
  return Object.assign(new FirebaseError(code, 'refused'), { details })
}

const store = new Map<string, string>()

const storage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
}

const storedAs = (uid: string) => store.get(`${PENDING_ORDER_STORAGE_KEY}.${uid}`)

/** A fresh copy of the client: everything in memory is gone, and only storage remains. */
async function reloaded() {
  vi.resetModules()
  return (await import('@/features/pos/pos-api')).createOrder
}

beforeEach(async () => {
  store.clear()
  vi.stubGlobal('localStorage', storage)
  callable.mockReset()
  // Clears any attempt a previous test left unanswered in memory.
  callable.mockResolvedValueOnce({ data: { id: 'x', number: 0 } })
  await createOrder(params)
  callable.mockReset()
  callable.mockResolvedValue({ data: { id: 'order-1', number: 7 } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The line in `cart`, as a server would send it back. */
const shownAsIs = {
  name: 'Nasi Lemak',
  basePrice: 800,
  unitPrice: 950,
  adjustments: [150],
  groupNames: ['Add-ons'],
  optionNames: ['Egg'],
}

/** The same line, after the menu moved on in both price and wording. */
const current = {
  name: 'Nasi Lemak Special',
  basePrice: 900,
  unitPrice: 1100,
  adjustments: [200],
  groupNames: ['Extras'],
  optionNames: ['Fried Egg'],
}

describe('what the till sends', () => {
  it('describes the order by id and quantity', async () => {
    await createOrder(params)

    expect(sent()).toMatchObject({
      lines: [
        {
          menuItemId: 'nasi',
          quantity: 2,
          selections: [{ groupId: 'g', optionId: 'egg' }],
          expected: {
            name: 'Nasi Lemak',
            basePrice: 800,
            unitPrice: 950,
            adjustments: [150],
            groupNames: ['Add-ons'],
            optionNames: ['Egg'],
          },
        },
      ],
      orderType: 'dine_in',
      tableNumber: '5',
      operatorId: 'alice',
      language: 'ms',
      expectedTotal: 1900,
    })
  })

  it('sends no total to record and no account, and a name only inside the quote', async () => {
    await createOrder(params)

    const { lines, ...rest } = sent()
    const unquoted = lines.map(({ expected: _quote, ...line }: Record<string, unknown>) => line)
    const text = JSON.stringify({ ...rest, lines: unquoted })
    for (const word of ['Nasi Lemak', 'Egg', 'Add-ons']) expect(text).not.toContain(word)

    const whole = JSON.stringify(sent())
    for (const word of ['priceAdjustment', '"total"', 'Alice', 'till-uid']) {
      expect(whole).not.toContain(word)
    }
  })

  it('quotes prices and names only where they are compared, never as the line’s own', async () => {
    await createOrder(params)

    const [line] = sent().lines
    expect(Object.keys(line).sort()).toEqual(['expected', 'menuItemId', 'quantity', 'selections'])
    expect(Object.keys(line.selections[0]).sort()).toEqual(['groupId', 'optionId'])
  })

  it('returns the order the server made', async () => {
    await expect(createOrder(params)).resolves.toEqual({ id: 'order-1', number: 7 })
  })

  it('still refuses an empty cart and a missing table at the counter', async () => {
    await expect(createOrder({ ...params, cart: EMPTY_CART })).rejects.toBeInstanceOf(MessageError)
    await expect(
      createOrder({ ...params, placement: { orderType: 'dine_in', tableNumber: '' } }),
    ).rejects.toBeInstanceOf(MessageError)
    expect(callable).not.toHaveBeenCalled()
  })
})

describe('the request id', () => {
  it('survives a failure, so trying again cannot ring the order up twice', async () => {
    callable.mockRejectedValueOnce(new Error('network'))
    await expect(createOrder(params)).rejects.toThrow('network')
    await createOrder(params)

    expect(sent(1).requestId).toBe(sent(0).requestId)
  })

  it('is new for the next order, once one has been placed', async () => {
    await createOrder(params)
    await createOrder(params)

    expect(sent(1).requestId).not.toBe(sent(0).requestId)
  })

  it('is new when the order changed after a failure', async () => {
    callable.mockRejectedValueOnce(new Error('network'))
    await expect(createOrder(params)).rejects.toThrow()
    await createOrder({ ...params, placement: { orderType: 'takeaway', tableNumber: '' } })

    expect(sent(1).requestId).not.toBe(sent(0).requestId)
  })

  it('has the form the server accepts', async () => {
    await createOrder(params)
    expect(sent().requestId).toMatch(/^[A-Za-z0-9_-]{16,64}$/)
  })

  it('is new when a refusal sent the cart back at other prices', async () => {
    callable.mockRejectedValueOnce(
      refusal({ reason: 'price-changed', total: 2200, lines: [{ ...current, unitPrice: 1100 }] }),
    )
    const caught = await createOrder(params).catch((error: unknown) => error)
    await createOrder({ ...params, cart: refreshCart(cart, (caught as StaleCartError).current) })

    expect(sent(1).requestId).not.toBe(sent(0).requestId)
  })

  it('is new when a refusal sent the cart back under other names', async () => {
    const lines = [{ ...shownAsIs, name: 'Nasi Lemak Special' }]
    callable.mockRejectedValueOnce(refusal({ reason: 'names-changed', total: 1900, lines }))
    const caught = await createOrder(params).catch((error: unknown) => error)
    await createOrder({ ...params, cart: refreshCart(cart, (caught as StaleCartError).current) })

    expect(sent(1).requestId).not.toBe(sent(0).requestId)
  })
})

describe('the request id across a reload', () => {
  it('is reused when the same order is rung up again', async () => {
    callable.mockRejectedValueOnce(new Error('network'))
    await expect(createOrder(params)).rejects.toThrow('network')

    await (
      await reloaded()
    )(params)
    expect(sent(1).requestId).toBe(sent(0).requestId)
  })

  it('is saved before the call goes out, since a reload can come at any moment', async () => {
    let storedDuringCall: string | undefined
    callable.mockImplementationOnce(async () => {
      storedDuringCall = storedAs('till-uid')
      return { data: { id: 'order-1', number: 7 } }
    })
    await createOrder(params)

    expect(JSON.parse(storedDuringCall ?? '[]')[0].requestId).toBe(sent().requestId)
  })

  it('is cleared by a confirmed order, and only by that', async () => {
    callable.mockRejectedValueOnce(new Error('network'))
    await expect(createOrder(params)).rejects.toThrow()
    expect(storedAs('till-uid')).toBeDefined()

    await createOrder(params)
    expect(storedAs('till-uid')).toBeUndefined()
  })

  it('survives a refusal, which wrote nothing and can be judged again', async () => {
    callable.mockRejectedValueOnce(refusal({ reason: 'item-unavailable', menuItemId: 'nasi' }))
    await expect(createOrder(params)).rejects.toBeInstanceOf(MessageError)

    await createOrder(params)
    expect(sent(1).requestId).toBe(sent(0).requestId)
  })

  it('is not reused for a different order', async () => {
    callable.mockRejectedValueOnce(new Error('network'))
    await expect(createOrder(params)).rejects.toThrow()

    await (
      await reloaded()
    )({ ...params, placement: { orderType: 'takeaway', tableNumber: '' } })
    expect(sent(1).requestId).not.toBe(sent(0).requestId)
  })

  it('is not reused by another account on this device', async () => {
    callable.mockRejectedValueOnce(new Error('network'))
    await expect(createOrder(params)).rejects.toThrow()

    await (
      await reloaded()
    )({ ...params, uid: 'second-till' })
    expect(sent(1).requestId).not.toBe(sent(0).requestId)
    expect(storedAs('till-uid')).toBeDefined()
  })

  it('leaves no trace of the order on the device', async () => {
    callable.mockRejectedValueOnce(new Error('network'))
    await expect(createOrder(params)).rejects.toThrow()

    const stored = JSON.parse(storedAs('till-uid') ?? '[]')
    expect(stored).toHaveLength(1)
    expect(Object.keys(stored[0]).sort()).toEqual(['fingerprint', 'requestId', 'savedAt'])
    for (const word of ['nasi', 'Nasi', 'Egg', 'alice', 'Alice', '950', 'dine_in']) {
      expect(storedAs('till-uid')).not.toContain(word)
    }
  })
})

describe('recognising the same order', () => {
  const line = (menuItemId: string, selections: string[], adjustments: number[]) => ({
    menuItemId,
    quantity: 1,
    selections: selections.map((optionId) => ({ groupId: 'g', optionId })),
    expected: {
      name: 'Item',
      basePrice: 100,
      unitPrice: 100,
      adjustments,
      groupNames: selections.map(() => 'Group'),
      optionNames: selections,
    },
  })
  const submission = (lines: ReturnType<typeof line>[]) => ({
    lines,
    orderType: 'takeaway',
    tableNumber: null,
    operatorId: 'alice',
    language: 'en',
    expectedTotal: 200,
  })

  it('ignores the sequence of lines and of options', async () => {
    const first = submission([line('a', ['x', 'y'], [1, 2]), line('b', [], [])])
    const second = submission([line('b', [], []), line('a', ['y', 'x'], [2, 1])])

    expect(await fingerprintOf(first)).toBe(await fingerprintOf(second))
  })

  it('tells apart anything that makes it a different order', async () => {
    const base = submission([line('a', [], [])])
    const fingerprint = await fingerprintOf(base)

    for (const other of [
      { ...base, operatorId: 'bob' },
      { ...base, tableNumber: '5' },
      { ...base, language: 'ms' },
      { ...base, expectedTotal: 1 },
      submission([{ ...line('a', [], []), quantity: 2 }]),
      submission([line('b', [], [])]),
      submission([line('a', ['x'], [0])]),
    ]) {
      expect(await fingerprintOf(other)).not.toBe(fingerprint)
    }
  })

  it('tells apart the same choices shown under another name', async () => {
    const shown = line('a', ['x'], [0])
    const fingerprint = await fingerprintOf(submission([shown]))

    for (const names of [{ name: 'B' }, { groupNames: ['B'] }, { optionNames: ['B'] }]) {
      const other = { ...shown, expected: { ...shown.expected, ...names } }
      expect(await fingerprintOf(submission([other]))).not.toBe(fingerprint)
    }
  })

  it('stops being the same order once the moment has passed', () => {
    const first = requestIdFor('uid', 'order', 1_000)

    expect(requestIdFor('uid', 'order', 1_000 + PENDING_ORDER_TTL_MS - 1)).toBe(first)
    expect(requestIdFor('uid', 'order', 1_000 + 2 * PENDING_ORDER_TTL_MS - 1)).not.toBe(first)
  })

  it('counts from the last attempt, so a long outage stays covered', () => {
    const first = requestIdFor('uid', 'outage', 0)
    const retried = requestIdFor('uid', 'outage', PENDING_ORDER_TTL_MS - 1)
    expect(retried).toBe(first)
    expect(requestIdFor('uid', 'outage', 2 * PENDING_ORDER_TTL_MS - 2)).toBe(first)
  })

  it.each([
    'not json',
    '"text"',
    '{"requestId":1}',
    'null',
    '{"requestId":"a","fingerprint":"b"}',
    '[1]',
    '[{"requestId":"a"}]',
  ])('ignores what it cannot read: %s', (raw) => {
    store.set(`${PENDING_ORDER_STORAGE_KEY}.damaged`, raw)
    expect(requestIdFor('damaged', 'b')).toMatch(/^[A-Za-z0-9_-]{16,64}$/)
  })

  it('falls back to memory when storage is blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    })

    const first = requestIdFor('blocked', 'order')
    expect(requestIdFor('blocked', 'order')).toBe(first)

    forgetRequest('blocked', first)
    expect(requestIdFor('blocked', 'order')).not.toBe(first)
  })

  it('forgets only the request it is told to', () => {
    const mine = requestIdFor('tabs', 'first')
    const theirs = requestIdFor('tabs', 'second')

    forgetRequest('tabs', mine)
    expect(requestIdFor('tabs', 'second')).toBe(theirs)
  })

  it('keeps one order on one id however often this page sends it', () => {
    const first = requestIdFor('page', 'order')
    expect(requestIdFor('page', 'order')).toBe(first)
  })
})

/**
 * Two tabs share storage and nothing else. A fresh copy of the module is a tab, or a page that has
 * just reloaded: nothing in memory comes with it.
 */
describe('two tabs on one account', () => {
  async function openTab() {
    vi.resetModules()
    return import('@/features/pos/pending-order')
  }

  const entries = (uid: string) => JSON.parse(storedAs(uid) ?? '[]') as Record<string, unknown>[]

  it('1. the same order rung up in both at once is two sales', async () => {
    const a = await openTab()
    const b = await openTab()

    const first = a.requestIdFor('uid', 'same')
    const second = b.requestIdFor('uid', 'same')

    expect(second).not.toBe(first)
    expect(entries('uid').map((entry) => entry.requestId)).toEqual([first, second])
  })

  it('2. a retry after a lost reply keeps its id', async () => {
    const a = await openTab()

    const first = a.requestIdFor('uid', 'same')
    a.releaseRequest('uid', first)

    expect(a.requestIdFor('uid', 'same')).toBe(first)
  })

  it('2. a retry from the other tab recovers it too, once nobody is sending it', async () => {
    const a = await openTab()
    const b = await openTab()

    const first = a.requestIdFor('uid', 'same')
    a.releaseRequest('uid', first)

    expect(b.requestIdFor('uid', 'same')).toBe(first)
  })

  it('2. each of two lost replies is recovered once, never merged into one', async () => {
    const a = await openTab()
    const b = await openTab()
    const first = a.requestIdFor('uid', 'same')
    const second = b.requestIdFor('uid', 'same')
    a.releaseRequest('uid', first)
    b.releaseRequest('uid', second)

    const retried = [a.requestIdFor('uid', 'same'), b.requestIdFor('uid', 'same')]

    expect(retried.sort()).toEqual([first, second].sort())
  })

  it('3. a sale confirmed in one tab is a new sale next time, though another tab was busy', async () => {
    const a = await openTab()
    const b = await openTab()

    const first = a.requestIdFor('uid', 'order-x')
    const second = b.requestIdFor('uid', 'order-y')
    a.forgetRequest('uid', first)
    b.forgetRequest('uid', second)

    expect(a.requestIdFor('uid', 'order-x')).not.toBe(first)
  })

  it('3. whichever order the two replies arrive in', async () => {
    const a = await openTab()
    const b = await openTab()

    const first = a.requestIdFor('uid', 'order-x')
    const second = b.requestIdFor('uid', 'order-y')
    b.forgetRequest('uid', second)
    a.forgetRequest('uid', first)

    expect(a.requestIdFor('uid', 'order-x')).not.toBe(first)
    expect(b.requestIdFor('uid', 'order-y')).not.toBe(second)
  })

  it('3. an identical sale after a confirmation is new in either tab', async () => {
    const a = await openTab()
    const b = await openTab()

    const first = a.requestIdFor('uid', 'same')
    a.forgetRequest('uid', first)

    expect(a.requestIdFor('uid', 'same')).not.toBe(first)
    expect(b.requestIdFor('uid', 'same')).not.toBe(first)
  })

  it('3. another tab writing afterwards cannot bring a confirmed sale back', async () => {
    const a = await openTab()
    const b = await openTab()

    const confirmed = a.requestIdFor('uid', 'order-x')
    const unanswered = b.requestIdFor('uid', 'order-y')
    a.forgetRequest('uid', confirmed)
    b.releaseRequest('uid', unanswered)

    expect(entries('uid').map((entry) => entry.requestId)).toEqual([unanswered])
  })

  it('4. one tab confirming its sale cannot clear another’s unanswered order', async () => {
    const a = await openTab()
    const b = await openTab()

    const mine = a.requestIdFor('uid', 'order-x')
    const theirs = b.requestIdFor('uid', 'order-y')
    b.forgetRequest('uid', theirs)
    a.releaseRequest('uid', mine)

    expect((await openTab()).requestIdFor('uid', 'order-x')).toBe(mine)
  })

  it('4. nor can a sale of the very same thing', async () => {
    const a = await openTab()
    const b = await openTab()

    const mine = a.requestIdFor('uid', 'same')
    const theirs = b.requestIdFor('uid', 'same')
    b.forgetRequest('uid', theirs)
    a.releaseRequest('uid', mine)

    expect(a.requestIdFor('uid', 'same')).toBe(mine)
  })

  it('4. nor can a tab forgetting an id it never held', async () => {
    const a = await openTab()
    const b = await openTab()

    const mine = a.requestIdFor('uid', 'order-x')
    b.forgetRequest('uid', 'somebody-elses-id')

    expect(entries('uid').map((entry) => entry.requestId)).toEqual([mine])
  })

  it('4. another tab’s new order does not push out an unanswered one', async () => {
    const a = await openTab()
    const b = await openTab()

    const mine = a.requestIdFor('uid', 'order-x')
    a.releaseRequest('uid', mine)
    b.requestIdFor('uid', 'order-y')

    expect((await openTab()).requestIdFor('uid', 'order-x')).toBe(mine)
  })

  it('5. a reload after the call failed recovers the order', async () => {
    const a = await openTab()
    const first = a.requestIdFor('uid', 'same')
    a.releaseRequest('uid', first)

    expect((await openTab()).requestIdFor('uid', 'same')).toBe(first)
  })

  it('5. a reload while the call is out recovers the order, as the page leaving says so', async () => {
    const page = new EventTarget()
    vi.stubGlobal('window', page)
    const a = await openTab()
    const first = a.requestIdFor('uid', 'same')

    page.dispatchEvent(new Event('pagehide'))

    expect(entries('uid')[0]).not.toHaveProperty('sendingUntil')
    expect((await openTab()).requestIdFor('uid', 'same')).toBe(first)
  })

  it('5. a page that crashed mid-call is recovered once the call must be over', async () => {
    const a = await openTab()
    const first = a.requestIdFor('uid', 'same', 1_000)
    const after = 1_000 + PENDING_ORDER_SEND_LIMIT_MS

    const reloaded = await openTab()
    expect(reloaded.requestIdFor('uid', 'same', after - 1)).not.toBe(first)
    expect(reloaded.requestIdFor('uid', 'same', after)).toBe(first)
  })

  it('5. the limit on a call outlasts the Firebase client’s own 70 seconds', () => {
    expect(PENDING_ORDER_SEND_LIMIT_MS).toBeGreaterThan(70_000)
    expect(PENDING_ORDER_SEND_LIMIT_MS).toBeLessThan(PENDING_ORDER_TTL_MS)
  })

  it('6. a different order never picks up an open id', async () => {
    const a = await openTab()
    const b = await openTab()
    const first = a.requestIdFor('uid', 'order-x')
    a.releaseRequest('uid', first)

    expect(b.requestIdFor('uid', 'order-y')).not.toBe(first)
    expect(a.requestIdFor('uid', 'order-z')).not.toBe(first)
  })

  it('6. neither does another account on this device', async () => {
    const a = await openTab()
    const first = a.requestIdFor('uid', 'same')
    a.releaseRequest('uid', first)

    expect(a.requestIdFor('other-uid', 'same')).not.toBe(first)
    expect(storedAs('uid')).toBeDefined()
    expect(storedAs('other-uid')).toBeDefined()
  })

  it('stores only ids, hashes and times, whatever is open', async () => {
    const a = await openTab()
    const b = await openTab()
    a.requestIdFor('uid', 'order-x')
    b.requestIdFor('uid', 'order-y')

    for (const entry of entries('uid')) {
      expect(Object.keys(entry).sort()).toEqual([
        'fingerprint',
        'requestId',
        'savedAt',
        'sendingUntil',
      ])
    }
  })

  it('drops an attempt once its 30 minutes have passed', async () => {
    const a = await openTab()
    const first = a.requestIdFor('uid', 'order-x', 0)
    a.releaseRequest('uid', first)

    a.requestIdFor('uid', 'order-y', PENDING_ORDER_TTL_MS)

    expect(entries('uid').map((entry) => entry.requestId)).not.toContain(first)
  })
})

describe('a refusal, in the counter’s words', () => {
  async function refusedWith(details: unknown) {
    callable.mockRejectedValueOnce(refusal(details))
    return createOrder(params).catch((caught: unknown) => caught)
  }

  it('price-changed carries the new total and what to show', async () => {
    const lines = [current]
    const caught = await refusedWith({ reason: 'price-changed', total: 2200, lines })

    expect(caught).toBeInstanceOf(StaleCartError)
    expect((caught as StaleCartError).detail).toEqual({
      key: 'terminal.pricesChanged',
      params: { total: 'RM 22.00' },
    })
    expect((caught as StaleCartError).current).toEqual(lines)
  })

  it('names-changed says the menu moved, not that a price did, and carries what to show', async () => {
    const lines = [{ ...shownAsIs, name: 'Nasi Lemak Special' }]
    const caught = await refusedWith({ reason: 'names-changed', total: 1900, lines })

    expect(caught).toBeInstanceOf(StaleCartError)
    expect((caught as StaleCartError).detail).toEqual({ key: 'terminal.namesChanged' })
    expect((caught as StaleCartError).current).toEqual(lines)
  })

  it('names an item that has gone, using what the cart showed', async () => {
    const caught = await refusedWith({ reason: 'item-unavailable', menuItemId: 'nasi' })
    expect((caught as MessageError).detail).toEqual({
      key: 'terminal.itemUnavailable',
      params: { name: 'Nasi Lemak' },
    })
  })

  it.each([
    ['selection-required', 'validation.chooseGroup'],
    ['single-choice', 'validation.chooseOnlyOne'],
    ['option-withdrawn', 'validation.optionWithdrawn'],
  ])('%s reuses the message the dialog already gives', async (reason, key) => {
    const caught = await refusedWith({ reason, group: 'Add-ons' })
    expect((caught as MessageError).detail).toEqual({ key, params: { group: 'Add-ons' } })
  })

  it('option-unknown says so', async () => {
    const caught = await refusedWith({ reason: 'option-unknown' })
    expect((caught as MessageError).detail).toEqual({ key: 'validation.optionUnknown' })
  })

  it('order-too-large says so', async () => {
    const caught = await refusedWith({ reason: 'order-too-large' })
    expect((caught as MessageError).detail).toEqual({ key: 'terminal.orderTooLarge' })
  })

  it.each(['not-allowed', 'invalid-operator', 'invalid-request', 'request-reused'])(
    '%s stays the till’s general failure, explaining nothing to a tamperer',
    async (reason) => {
      const caught = await refusedWith({ reason })
      expect(isMessageError(caught)).toBe(false)
    },
  )

  it('passes on a failure that is not a refusal', async () => {
    const failure = new Error('network')
    callable.mockRejectedValueOnce(failure)
    await expect(createOrder(params)).rejects.toBe(failure)
  })
})

describe('refreshCart', () => {
  it('takes on the current prices and names and keeps everything else', () => {
    const [line] = refreshCart(cart, [current])

    expect(line).toMatchObject({
      basePrice: 900,
      unitPrice: 1100,
      quantity: 2,
      name: 'Nasi Lemak Special',
    })
    expect(line?.modifiers[0]).toEqual({
      ...modifier,
      groupName: 'Extras',
      optionName: 'Fried Egg',
      priceAdjustment: 200,
    })
    expect(line?.lineId).toBe(cart[0]?.lineId)
  })

  it('leaves a cart that has since changed', () => {
    expect(refreshCart(cart, [current, current])).toBe(cart)
  })

  it('leaves a line whose options no longer correspond', () => {
    const [line] = refreshCart(cart, [
      { ...current, adjustments: [], groupNames: [], optionNames: [] },
    ])
    expect(line).toBe(cart[0])
  })
})
