/**
 * `placeOrder`, against the real Cloud Function in the Functions emulator, with real Auth accounts
 * and the real firestore.rules loaded.
 *
 * Everything downstream is exercised on the orders it makes: payment through the real rules, a
 * real PIN void, the real report and the real unpaid count. That is what proves the document is
 * the one the rest of the app has always read. queue-compat.test.tsx does the same for the Queue.
 *
 * Run with `npm run test:functions`.
 */
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing'
import { FirebaseError } from 'firebase/app'
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where,
  type Firestore,
} from 'firebase/firestore'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { MessageError } from '@/features/i18n/messages'
import {
  addToCart,
  cartTotal,
  EMPTY_CART,
  refreshCart,
  StaleCartError,
  type Cart,
} from '@/features/pos/cart'
import { buildOrderViews, countUnpaidOrders } from '@/features/pos/orders-view'
import {
  parseOrder,
  parseOrderPayment,
  parseOrderVoid,
  type OrderPayment,
  type OrderVoid,
} from '@/features/pos/types'
import { buildReport } from '@/features/reports/aggregate'

import { businessDateAt, MAX_ORDER_BYTES, storedBytes } from '../../functions/src/order'
import {
  asRulesUser,
  asServer,
  call,
  clientFunctions,
  count,
  createAccount,
  read,
  resetEmulators,
  signInAs,
  signOutAll,
  startHarness,
  stopHarness,
  write,
  type Account,
} from './harness'

/** Held here rather than read from the harness, so it survives a simulated page reload. */
const session = vi.hoisted(() => ({
  db: null as unknown,
  functions: null as unknown,
  /** The next callable reaches the server, but its reply never reaches the till. */
  loseNextReply: false,
}))

vi.mock('@/lib/functions', () => ({ appFunctions: () => session.functions }))

vi.mock('@/lib/firebase', () => ({
  app: {},
  auth: {},
  get db() {
    return session.db
  },
}))

vi.mock('firebase/functions', async (importOriginal) => {
  const real = await importOriginal<typeof import('firebase/functions')>()
  return {
    ...real,
    httpsCallable: (...args: Parameters<typeof real.httpsCallable>) => {
      const callable = real.httpsCallable(...args)
      return async (data: unknown) => {
        const reply = await callable(data)
        if (session.loseNextReply) {
          session.loseNextReply = false
          throw new FirebaseError('functions/internal', 'The connection dropped.')
        }
        return reply
      }
    },
  }
})

import { createOrder } from '@/features/pos/pos-api'
import { PENDING_ORDER_STORAGE_KEY } from '@/features/pos/pending-order'
import { fetchReportData } from '@/features/reports/reports-api'

const PIN = '482915'
const ITEM = 'item-nasi'
const PRICE = 800
const now = new Date()

let admin: Account
let till: Account
let sequence = 0

const requestId = () => `request-${Date.now()}-${(sequence += 1)}`
const today = () => businessDateAt(new Date())

interface Choice {
  groupId: string
  optionId: string
  adjustment: number
  /** The option's name as the cart holds it. */
  optionName: string
  groupName: string
}

const choice = (
  groupId: string,
  optionId: string,
  adjustment: number,
  optionName = `Option ${optionId}`,
  groupName = 'Add-ons',
): Choice => ({ groupId, optionId, adjustment, optionName, groupName })

interface LineOptions {
  menuItemId?: string
  quantity?: number
  /** The item's price as the cart holds it. */
  base?: number
  /** The item's name as the cart holds it. */
  shown?: string
  choices?: Choice[]
  [extra: string]: unknown
}

/** A line as the till sends it, quoting the prices and names its cart shows. */
function line({
  menuItemId = ITEM,
  quantity = 1,
  base = PRICE,
  shown = 'Nasi Lemak',
  choices = [],
  ...extra
}: LineOptions = {}) {
  const adjustments = choices.map(({ adjustment }) => adjustment)
  const unitPrice = Math.max(0, base + adjustments.reduce((sum, value) => sum + value, 0))
  return {
    menuItemId,
    quantity,
    selections: choices.map(({ groupId, optionId }) => ({ groupId, optionId })),
    expected: {
      name: shown,
      basePrice: base,
      unitPrice,
      adjustments,
      groupNames: choices.map(({ groupName }) => groupName),
      optionNames: choices.map(({ optionName }) => optionName),
    },
    ...extra,
  }
}

type SentLine = ReturnType<typeof line>

const quotedTotal = (lines: SentLine[]) =>
  lines.reduce((sum, { expected, quantity }) => sum + expected.unitPrice * quantity, 0)

function request({
  lines = [line()],
  ...over
}: { lines?: SentLine[]; [key: string]: unknown } = {}) {
  return {
    requestId: requestId(),
    lines,
    orderType: 'takeaway',
    tableNumber: null,
    operatorId: 'alice',
    language: 'en',
    expectedTotal: quotedTotal(lines),
    ...over,
  }
}

const place = (data: unknown) => call<{ id: string; number: number }>('placeOrder', data)

interface StoredLine {
  name: string
  unitPrice: number
  modifiers: { priceAdjustment: number; groupName: string; optionName: string }[]
}

const linesOf = async (id: string) => ((await read(`orders/${id}`))?.lines ?? []) as StoredLine[]

/** The refusal's details, failing the test if the call went through. */
async function refusal(data: unknown): Promise<Record<string, unknown> & { reason: string }> {
  try {
    await place(data)
  } catch (caught) {
    const { details, code } = caught as FirebaseError & { details?: Record<string, unknown> }
    if (details) return { reason: '', ...details, code }
    throw caught
  }
  throw new Error('placeOrder was expected to be refused, but succeeded')
}

const item = (over: Record<string, unknown> = {}) => ({
  name: 'Nasi Lemak',
  names: { ms: 'Nasi Lemak Biasa', zh: '椰浆饭' },
  categoryId: 'mains',
  price: PRICE,
  sortOrder: 0,
  active: true,
  modifierGroupIds: [],
  createdAt: now,
  updatedAt: now,
  ...over,
})

const option = (id: string, priceAdjustment: number, over: Record<string, unknown> = {}) => ({
  id,
  name: `Option ${id}`,
  names: {},
  priceAdjustment,
  active: true,
  ...over,
})

const group = (over: Record<string, unknown> = {}) => ({
  name: 'Add-ons',
  selection: 'multiple',
  required: false,
  sortOrder: 0,
  active: true,
  options: [option('egg', 150)],
  createdAt: now,
  updatedAt: now,
  ...over,
})

beforeAll(async () => {
  await startHarness()
  session.functions = clientFunctions()
})

afterAll(async () => {
  await stopHarness()
})

beforeEach(async () => {
  await resetEmulators()
  admin = await createAccount('Ada Admin', 'admin')
  till = await createAccount('Counter Till', 'staff')
  await write('staffMembers/alice', { name: 'Alice', active: true, createdAt: now, updatedAt: now })
  await write('staffMembers/bob', { name: 'Bob', active: false, createdAt: now, updatedAt: now })
  await write('categories/mains', {
    name: 'Mains',
    sortOrder: 0,
    active: true,
    createdAt: now,
    updatedAt: now,
  })
  await write('categories/hidden', {
    name: 'Hidden',
    sortOrder: 1,
    active: false,
    createdAt: now,
    updatedAt: now,
  })
  await write(`menuItems/${ITEM}`, item())
  await signInAs(till)
})

describe('1. a normal order', () => {
  it('writes the order the app has always written', async () => {
    const { id, number } = await place(
      request({
        lines: [line({ shown: 'Nasi Lemak Biasa' })],
        orderType: 'dine_in',
        tableNumber: '5',
        language: 'ms',
      }),
    )

    expect(number).toBe(1)
    const order = await read(`orders/${id}`)
    expect(order).toMatchObject({
      number: 1,
      businessDate: today(),
      total: PRICE,
      orderType: 'dine_in',
      tableNumber: '5',
      createdBy: till.uid,
      createdByName: 'Counter Till',
      staffId: 'alice',
      staffName: 'Alice',
    })
    expect(order?.lines).toEqual([
      {
        menuItemId: ITEM,
        name: 'Nasi Lemak Biasa',
        basePrice: PRICE,
        unitPrice: PRICE,
        modifiers: [],
        quantity: 1,
      },
    ])
    expect(Object.keys(order ?? {}).sort()).toEqual(
      [
        'businessDate',
        'createdAt',
        'createdBy',
        'createdByName',
        'lines',
        'number',
        'orderType',
        'staffId',
        'staffName',
        'tableNumber',
        'total',
      ].sort(),
    )
  })

  it('leaves the table off a takeaway altogether', async () => {
    const { id } = await place(request())
    expect(await read(`orders/${id}`)).not.toHaveProperty('tableNumber')
  })

  it('carries no payment, as an order never has', async () => {
    const { id } = await place(request())
    const order = await read(`orders/${id}`)
    expect(order).not.toHaveProperty('paymentMethod')
    expect(await read(`orderPayments/${id}`)).toBeNull()
  })

  it('stamps the server’s time', async () => {
    const before = Date.now()
    const { id } = await place(request())
    const createdAt = (await read(`orders/${id}`))?.createdAt as { toMillis(): number }
    expect(Math.abs(createdAt.toMillis() - before)).toBeLessThan(60_000)
  })

  it('writes a document the rules themselves would accept, so the two cannot have drifted', async () => {
    const { id } = await place(request({ orderType: 'dine_in', tableNumber: 'A3' }))
    const stored = await read(`orders/${id}`)

    await assertSucceeds(
      setDoc(doc(asRulesUser(till.uid), 'orders', 'copy'), {
        ...stored,
        createdAt: serverTimestamp(),
      }),
    )
  })

  it('is parsed by the app without loss', async () => {
    const { id, number } = await place(request())
    const parsed = parseOrder(id, (await read(`orders/${id}`)) ?? {})
    expect(parsed).toMatchObject({ id, number, total: PRICE, orderType: 'takeaway' })
  })

  it('records the signed-in account when no operator is named', async () => {
    const { id } = await place(request({ operatorId: null }))
    expect(await read(`orders/${id}`)).toMatchObject({
      staffId: till.uid,
      staffName: 'Counter Till',
    })
  })
})

describe('2-4. what a modified client sends is not believed', () => {
  it('ignores prices on the line', async () => {
    const { id } = await place(request({ lines: [line({ unitPrice: 1, basePrice: 1 })] }))
    expect((await read(`orders/${id}`))?.total).toBe(PRICE)
  })

  it('ignores a negative price on the line', async () => {
    const { id } = await place(request({ lines: [line({ unitPrice: -500 })] }))
    expect((await linesOf(id))[0]?.unitPrice).toBe(PRICE)
  })

  it('ignores a total, and refuses a false expected total rather than obeying it', async () => {
    const before = await count('orders')
    const refused = await refusal(request({ total: 1, expectedTotal: 1 }))

    expect(refused.reason).toBe('price-changed')
    expect(refused.total).toBe(PRICE)
    expect(await count('orders')).toBe(before)
  })

  it('ignores names on the line and on the options', async () => {
    await write('modifierGroups/g', group())
    await write(`menuItems/${ITEM}`, item({ modifierGroupIds: ['g'] }))

    const sent = line({ choices: [choice('g', 'egg', 150)], name: 'Air Kosong' })
    const selections = [{ ...sent.selections[0], optionName: 'Free', priceAdjustment: -150 }]

    const { id } = await place(request({ lines: [{ ...sent, selections } as SentLine] }))
    const stored = (await linesOf(id))[0]
    expect(stored?.name).toBe('Nasi Lemak')
    expect(stored?.unitPrice).toBe(PRICE + 150)
    expect(stored?.modifiers[0]).toEqual({
      groupId: 'g',
      groupName: 'Add-ons',
      optionId: 'egg',
      optionName: 'Option egg',
      priceAdjustment: 150,
    })
  })

  it('ignores who the client says it is', async () => {
    const { id } = await place(request({ createdBy: admin.uid, createdByName: 'Ada Admin' }))
    expect(await read(`orders/${id}`)).toMatchObject({ createdBy: till.uid })
  })
})

describe('5. quantities', () => {
  it.each([0, -1, 1.5, 1000])('refuses a quantity of %s', async (quantity) => {
    const refused = await refusal(request({ lines: [line({ quantity })] }))
    expect(refused.reason).toBe('invalid-request')
  })

  it('accepts the limit, and multiplies it exactly', async () => {
    const { id } = await place(request({ lines: [line({ quantity: 999 })] }))
    expect((await read(`orders/${id}`))?.total).toBe(PRICE * 999)
  })
})

describe('6. what cannot be sold', () => {
  it('refuses an archived item', async () => {
    await write(`menuItems/${ITEM}`, item({ active: false }))
    expect(await refusal(request())).toMatchObject({ reason: 'item-unavailable', menuItemId: ITEM })
  })

  it('refuses an item in a hidden category', async () => {
    await write(`menuItems/${ITEM}`, item({ categoryId: 'hidden' }))
    expect((await refusal(request())).reason).toBe('item-unavailable')
  })

  it('refuses an item that does not exist', async () => {
    const refused = await refusal(request({ lines: [line({ menuItemId: 'no-such-item' })] }))
    expect(refused).toMatchObject({ reason: 'item-unavailable', menuItemId: 'no-such-item' })
  })

  it('takes no number for a refused order', async () => {
    await write(`menuItems/${ITEM}`, item({ active: false }))
    await refusal(request())
    expect(await read(`counters/${today()}`)).toBeNull()
  })
})

describe('7-9. customisation rules', () => {
  const withEgg = () => request({ lines: [line({ choices: [choice('g', 'egg', 150)] })] })

  beforeEach(async () => {
    await write(`menuItems/${ITEM}`, item({ modifierGroupIds: ['g'] }))
  })

  it('7. refuses an option withdrawn since it was chosen', async () => {
    await write(
      'modifierGroups/g',
      group({ options: [option('egg', 150, { active: false }), option('rice', 0)] }),
    )
    expect(await refusal(withEgg())).toMatchObject({ reason: 'option-withdrawn', group: 'Add-ons' })
  })

  it('7. refuses an option that was never on offer', async () => {
    await write('modifierGroups/g', group({ options: [option('rice', 0)] }))
    expect((await refusal(withEgg())).reason).toBe('option-withdrawn')
  })

  it('7. refuses a group this item does not offer', async () => {
    await write('modifierGroups/other', group())
    await write('modifierGroups/g', group({ options: [option('rice', 0)] }))
    const refused = await refusal(
      request({ lines: [line({ choices: [choice('other', 'egg', 150)] })] }),
    )
    expect(refused.reason).toBe('option-unknown')
  })

  it('8. refuses a required group left unanswered', async () => {
    await write('modifierGroups/g', group({ required: true }))
    expect(await refusal(request())).toMatchObject({
      reason: 'selection-required',
      group: 'Add-ons',
    })
  })

  it('8. accepts the same group once it is answered', async () => {
    await write('modifierGroups/g', group({ required: true }))
    await expect(place(withEgg())).resolves.toMatchObject({ number: 1 })
  })

  it('9. refuses two answers to a one-choice group', async () => {
    await write(
      'modifierGroups/g',
      group({ selection: 'single', options: [option('egg', 150), option('rice', 0)] }),
    )
    const refused = await refusal(
      request({ lines: [line({ choices: [choice('g', 'egg', 150), choice('g', 'rice', 0)] })] }),
    )
    expect(refused).toMatchObject({ reason: 'single-choice', group: 'Add-ons' })
  })
})

describe('10. legacy groups', () => {
  it('offers a group that names the item, which the item does not list', async () => {
    await write('modifierGroups/legacy', group({ itemId: ITEM, options: [option('egg', 250)] }))

    const { id } = await place(
      request({ lines: [line({ choices: [choice('legacy', 'egg', 250)] })] }),
    )
    expect((await read(`orders/${id}`))?.total).toBe(PRICE + 250)
  })

  it('still insists on a required legacy group', async () => {
    await write('modifierGroups/legacy', group({ itemId: ITEM, required: true }))
    expect((await refusal(request())).reason).toBe('selection-required')
  })

  it('will not let an item borrow a group that belongs to another', async () => {
    await write('menuItems/other', item())
    await write('modifierGroups/owned', group({ itemId: 'other' }))
    await write(`menuItems/${ITEM}`, item({ modifierGroupIds: ['owned'] }))

    const refused = await refusal(
      request({ lines: [line({ choices: [choice('owned', 'egg', 150)] })] }),
    )
    expect(refused.reason).toBe('option-unknown')
  })
})

describe('11. options that cost nothing', () => {
  it('records them, at RM0.00', async () => {
    await write('modifierGroups/g', group({ options: [option('none', 0)] }))
    await write(`menuItems/${ITEM}`, item({ modifierGroupIds: ['g'] }))

    const { id } = await place(request({ lines: [line({ choices: [choice('g', 'none', 0)] })] }))
    const stored = (await linesOf(id))[0]
    expect(stored?.modifiers[0]?.priceAdjustment).toBe(0)
    expect(stored?.unitPrice).toBe(PRICE)
  })
})

describe('12. a price that changed after the cart was built', () => {
  it('refuses, writes nothing, and says what the prices are now', async () => {
    await write('modifierGroups/g', group({ options: [option('egg', 200)] }))
    await write(`menuItems/${ITEM}`, item({ price: 900, modifierGroupIds: ['g'] }))

    const refused = await refusal(
      request({ lines: [line({ quantity: 2, choices: [choice('g', 'egg', 150)] })] }),
    )

    expect(refused).toMatchObject({
      reason: 'price-changed',
      total: 2200,
      lines: [{ basePrice: 900, unitPrice: 1100, adjustments: [200] }],
    })
    expect(await count('orders')).toBe(0)
    expect(await count('orderRequests')).toBe(0)
    expect(await read(`counters/${today()}`)).toBeNull()
  })

  it('goes through the real client: refused, shown, and placed at the new total', async () => {
    const cart = addToCart(EMPTY_CART, {
      menuItemId: ITEM,
      name: 'Nasi Lemak',
      basePrice: PRICE,
    })
    await write(`menuItems/${ITEM}`, item({ price: 950 }))
    const params = {
      placement: { orderType: 'takeaway' as const, tableNumber: '' },
      staff: { id: 'alice', name: 'Alice' },
      language: 'en' as const,
      uid: till.uid,
    }

    const refused = await createOrder({ cart, ...params }).catch((caught: unknown) => caught)
    expect(refused).toBeInstanceOf(StaleCartError)

    const repriced = refreshCart(cart, (refused as StaleCartError).current)
    expect(cartTotal(repriced)).toBe(950)

    const { id } = await createOrder({ cart: repriced, ...params })
    expect((await read(`orders/${id}`))?.total).toBe(950)
    expect(await count('orders')).toBe(1)
  })
})

async function nothingWritten() {
  expect(await count('orders')).toBe(0)
  expect(await count('orderRequests')).toBe(0)
  expect(await read(`counters/${today()}`)).toBeNull()
}

describe('a line that no longer matches the menu', () => {
  const OTHER = 'item-teh'

  beforeEach(async () => {
    await write(`menuItems/${OTHER}`, item({ name: 'Teh', price: 500 }))
  })

  it('1. refuses when one item went up', async () => {
    await write(`menuItems/${ITEM}`, item({ price: 900 }))

    const refused = await refusal(
      request({ lines: [line(), line({ menuItemId: OTHER, base: 500 })] }),
    )
    expect(refused).toMatchObject({
      reason: 'price-changed',
      total: 1400,
      lines: [
        { basePrice: 900, unitPrice: 900, adjustments: [] },
        { basePrice: 500, unitPrice: 500, adjustments: [] },
      ],
    })
    await nothingWritten()
  })

  it('2. refuses when one item came down, which is still not what the till showed', async () => {
    await write(`menuItems/${ITEM}`, item({ price: 700 }))

    const refused = await refusal(request())
    expect(refused).toMatchObject({ reason: 'price-changed', total: 700 })
    await nothingWritten()
  })

  it('3. refuses when an option’s price changed', async () => {
    await write('modifierGroups/g', group({ options: [option('egg', 200)] }))
    await write(`menuItems/${ITEM}`, item({ modifierGroupIds: ['g'] }))

    const refused = await refusal(
      request({ lines: [line({ choices: [choice('g', 'egg', 150)] })] }),
    )
    expect(refused).toMatchObject({
      reason: 'price-changed',
      lines: [{ basePrice: PRICE, unitPrice: PRICE + 200, adjustments: [200] }],
    })
    await nothingWritten()
  })

  it('4. refuses two changes that cancel out, though the total is the same', async () => {
    // The table from the brief: RM5 + RM8 at the till, RM6 + RM7 on the menu, RM13 either way.
    await write(`menuItems/${ITEM}`, item({ price: 600 }))
    await write(`menuItems/${OTHER}`, item({ price: 700 }))

    const sent = [line({ base: 500 }), line({ menuItemId: OTHER, base: 800 })]
    expect(quotedTotal(sent)).toBe(1300)

    const refused = await refusal(request({ lines: sent }))
    expect(refused).toMatchObject({
      reason: 'price-changed',
      total: 1300,
      lines: [{ unitPrice: 600 }, { unitPrice: 700 }],
    })
    await nothingWritten()
  })

  it('4. refuses a change inside one line that leaves its unit price alone', async () => {
    await write('modifierGroups/g', group({ options: [option('egg', 50)] }))
    await write(`menuItems/${ITEM}`, item({ price: 900, modifierGroupIds: ['g'] }))

    // RM8.00 + RM1.50 at the till, RM9.00 + RM0.50 on the menu: RM9.50 both ways.
    const sent = line({ choices: [choice('g', 'egg', 150)] })
    expect(sent.expected.unitPrice).toBe(950)

    const refused = await refusal(request({ lines: [sent] }))
    expect(refused).toMatchObject({
      reason: 'price-changed',
      lines: [{ basePrice: 900, unitPrice: 950, adjustments: [50] }],
    })
    await nothingWritten()
  })

  it('4. notices an option change that the zero floor would hide', async () => {
    await write('modifierGroups/g', group({ options: [option('free', -900)] }))
    await write(`menuItems/${ITEM}`, item({ modifierGroupIds: ['g'] }))

    const sent = line({ choices: [choice('g', 'free', -800)] })
    expect(sent.expected.unitPrice).toBe(0)

    expect((await refusal(request({ lines: [sent] }))).reason).toBe('price-changed')
    await nothingWritten()
  })

  it('4. notices a base price change that the zero floor would hide', async () => {
    await write('modifierGroups/g', group({ options: [option('free', -5000)] }))
    await write(`menuItems/${ITEM}`, item({ price: 900, modifierGroupIds: ['g'] }))

    const sent = line({ choices: [choice('g', 'free', -5000)] })
    expect(sent.expected.unitPrice).toBe(0)

    expect(await refusal(request({ lines: [sent] }))).toMatchObject({
      reason: 'price-changed',
      lines: [{ basePrice: 900, unitPrice: 0, adjustments: [-5000] }],
    })
    await nothingWritten()
  })

  it('5. places the order when nothing changed', async () => {
    await write('modifierGroups/g', group())
    await write(`menuItems/${ITEM}`, item({ modifierGroupIds: ['g'] }))

    const { id } = await place(
      request({
        lines: [
          line({ quantity: 2, choices: [choice('g', 'egg', 150)] }),
          line({ menuItemId: OTHER, base: 500, shown: 'Teh' }),
        ],
      }),
    )
    expect((await read(`orders/${id}`))?.total).toBe(2 * 950 + 500)
  })

  it('6. refuses a line quoted low, and never charges what the client said', async () => {
    const low = line({ base: 1 })
    expect((await refusal(request({ lines: [low], expectedTotal: PRICE }))).reason).toBe(
      'price-changed',
    )
    await nothingWritten()
  })

  it('6. refuses a whole quote made up to agree with itself', async () => {
    const refused = await refusal(request({ lines: [line({ base: 1 })] }))
    expect(refused).toMatchObject({ reason: 'price-changed', total: PRICE })
    await nothingWritten()
  })

  it.each([
    ['a negative price', { basePrice: -1 }],
    ['a fractional price', { unitPrice: 800.5 }],
    ['a price as text', { basePrice: '800' }],
    ['an adjustment for an option not chosen', { adjustments: [0] }],
    ['no adjustments at all', { adjustments: undefined }],
    ['no name', { name: undefined }],
    ['a name that is not text', { name: 7 }],
    ['a group name for an option not chosen', { groupNames: ['Add-ons'] }],
    ['an option name for an option not chosen', { optionNames: ['Egg'] }],
    ['no option names at all', { optionNames: undefined }],
  ])('6. refuses %s as malformed', async (_label, change) => {
    const sent = line()
    const expected = { ...sent.expected, ...change }
    const refused = await refusal(request({ lines: [{ ...sent, expected } as SentLine] }))
    expect(refused.reason).toBe('invalid-request')
    await nothingWritten()
  })

  it('6. refuses a line that quotes nothing, so the check cannot be skipped', async () => {
    const { expected: _expected, ...bare } = line()
    const refused = await refusal({ ...request(), lines: [bare] })
    expect(refused.reason).toBe('invalid-request')
    await nothingWritten()
  })

  it('7. refuses a false total over honest lines', async () => {
    const refused = await refusal(request({ expectedTotal: PRICE - 1 }))
    expect(refused).toMatchObject({ reason: 'price-changed', total: PRICE })
    await nothingWritten()
  })

  it('8. ignores every price and name a client adds, and records the menu’s', async () => {
    const sent = {
      ...line({ name: 'Air Kosong', unitPrice: 1, basePrice: 1, modifiers: [], total: 1 }),
    }
    const { id } = await place({
      ...request({ lines: [sent] }),
      total: 1,
      name: 'Free',
      lines: [sent],
      createdByName: 'Mallory',
      businessDate: '2001-01-01',
      number: 999,
    })

    const order = await read(`orders/${id}`)
    expect(order).toMatchObject({
      number: 1,
      total: PRICE,
      createdByName: 'Counter Till',
      businessDate: today(),
    })
    expect(order?.lines).toEqual([
      {
        menuItemId: ITEM,
        name: 'Nasi Lemak',
        basePrice: PRICE,
        unitPrice: PRICE,
        modifiers: [],
        quantity: 1,
      },
    ])
    expect(order).not.toHaveProperty('expected')
    expect(JSON.stringify(order?.lines)).not.toContain('expected')
  })

  it('leaves the count alone when a later order goes through', async () => {
    await write(`menuItems/${ITEM}`, item({ price: 900 }))
    await refusal(request())
    await refusal(request())

    await expect(place(request({ lines: [line({ base: 900 })] }))).resolves.toMatchObject({
      number: 1,
    })
  })

  it('goes through the real client: same total, new lines, shown and placed again', async () => {
    let cart = addToCart(EMPTY_CART, { menuItemId: ITEM, name: 'Nasi', basePrice: 500 })
    cart = addToCart(cart, { menuItemId: OTHER, name: 'Teh', basePrice: 800 })
    await write(`menuItems/${ITEM}`, item({ price: 600 }))
    await write(`menuItems/${OTHER}`, item({ price: 700 }))
    const params = {
      placement: { orderType: 'takeaway' as const, tableNumber: '' },
      staff: { id: 'alice', name: 'Alice' },
      language: 'en' as const,
      uid: till.uid,
    }

    const refused = await createOrder({ cart, ...params }).catch((caught: unknown) => caught)
    expect(refused).toBeInstanceOf(StaleCartError)
    await nothingWritten()

    const repriced = refreshCart(cart, (refused as StaleCartError).current)
    expect(repriced.map((entry) => entry.unitPrice)).toEqual([600, 700])
    expect(cartTotal(repriced)).toBe(cartTotal(cart))

    const { id, number } = await createOrder({ cart: repriced, ...params })
    expect(number).toBe(1)
    expect((await linesOf(id)).map((entry) => entry.unitPrice)).toEqual([600, 700])
  })
})

describe('a name that changed while the cart was open', () => {
  const params = (language: 'en' | 'ms' = 'en') => ({
    placement: { orderType: 'takeaway' as const, tableNumber: '' },
    staff: { id: 'alice', name: 'Alice' },
    language,
    uid: till.uid,
  })
  const egg = {
    groupId: 'g',
    groupName: 'Add-ons',
    optionId: 'egg',
    optionName: 'Egg',
    priceAdjustment: 150,
  }
  const nasi = (name = 'Nasi Lemak') =>
    addToCart(EMPTY_CART, { menuItemId: ITEM, name, basePrice: PRICE })
  const nasiWithEgg = () =>
    addToCart(EMPTY_CART, {
      menuItemId: ITEM,
      name: 'Nasi Lemak',
      basePrice: PRICE,
      modifiers: [egg],
    })

  async function staleError(cart: Cart, language: 'en' | 'ms' = 'en') {
    const caught = await createOrder({ cart, ...params(language) }).catch((error: unknown) => error)
    expect(caught).toBeInstanceOf(StaleCartError)
    return caught as StaleCartError
  }

  async function withEggOption(over: Record<string, unknown>, groupOver = {}) {
    await write(
      'modifierGroups/g',
      group({ options: [option('egg', 150, { name: 'Egg', ...over })], ...groupOver }),
    )
    await write(`menuItems/${ITEM}`, item({ modifierGroupIds: ['g'] }))
  }

  it('1. an item renamed: refused, shown, and placed under the name then on screen', async () => {
    const cart = nasi()
    await write(`menuItems/${ITEM}`, item({ name: 'Nasi Lemak Special' }))

    const refused = await staleError(cart)
    expect(refused.detail).toEqual({ key: 'terminal.namesChanged' })
    await nothingWritten()

    const shown = refreshCart(cart, refused.current)
    expect(shown[0]?.name).toBe('Nasi Lemak Special')
    expect(shown[0]?.unitPrice).toBe(PRICE)

    const { id, number } = await createOrder({ cart: shown, ...params() })
    expect(number).toBe(1)
    expect((await linesOf(id))[0]?.name).toBe('Nasi Lemak Special')
  })

  it('2. a translation corrected: refused and placed in that language', async () => {
    const cart = nasi('Nasi Lemak Biasa')
    await write(`menuItems/${ITEM}`, item({ names: { ms: 'Nasi Lemak Istimewa', zh: '椰浆饭' } }))

    const refused = await staleError(cart, 'ms')
    await nothingWritten()

    const shown = refreshCart(cart, refused.current)
    expect(shown[0]?.name).toBe('Nasi Lemak Istimewa')
    const { id } = await createOrder({ cart: shown, ...params('ms') })
    expect((await linesOf(id))[0]?.name).toBe('Nasi Lemak Istimewa')
  })

  it('2. a translation in another language does not disturb this till', async () => {
    const cart = nasi()
    await write(`menuItems/${ITEM}`, item({ names: { ms: 'Nasi Lemak Istimewa', zh: '椰浆饭' } }))

    const { id } = await createOrder({ cart, ...params('en') })
    expect((await linesOf(id))[0]?.name).toBe('Nasi Lemak')
  })

  it('3. an option renamed: refused, shown, and placed as then on screen', async () => {
    await withEggOption({ name: 'Fried Egg' })
    const cart = nasiWithEgg()

    const refused = await staleError(cart)
    await nothingWritten()

    const shown = refreshCart(cart, refused.current)
    expect(shown[0]?.modifiers[0]).toEqual({ ...egg, optionName: 'Fried Egg' })
    const { id } = await createOrder({ cart: shown, ...params() })
    expect((await linesOf(id))[0]?.modifiers[0]?.optionName).toBe('Fried Egg')
  })

  it('3. an option’s translation corrected', async () => {
    await withEggOption({ names: { ms: 'Telur Goreng' } })
    const cart = addToCart(EMPTY_CART, {
      menuItemId: ITEM,
      name: 'Nasi Lemak Biasa',
      basePrice: PRICE,
      modifiers: [{ ...egg, optionName: 'Telur' }],
    })

    const refused = await staleError(cart, 'ms')
    expect(refreshCart(cart, refused.current)[0]?.modifiers[0]?.optionName).toBe('Telur Goreng')
    await nothingWritten()
  })

  it('3. a group renamed, which an order records as well', async () => {
    await withEggOption({}, { name: 'Extras' })
    const cart = nasiWithEgg()

    const refused = await staleError(cart)
    await nothingWritten()

    const shown = refreshCart(cart, refused.current)
    expect(shown[0]?.modifiers[0]?.groupName).toBe('Extras')
    const { id } = await createOrder({ cart: shown, ...params() })
    expect((await linesOf(id))[0]?.modifiers[0]?.groupName).toBe('Extras')
  })

  it('4. a modified client cannot have its own name recorded', async () => {
    const refused = await refusal(request({ lines: [line({ shown: 'Air Kosong' })] }))

    expect(refused).toMatchObject({ reason: 'names-changed', lines: [{ name: 'Nasi Lemak' }] })
    await nothingWritten()
  })

  it('4. nor its own option or group name', async () => {
    await withEggOption({})
    const forOption = line({ choices: [choice('g', 'egg', 150, 'Free')] })
    const forGroup = line({ choices: [choice('g', 'egg', 150, 'Egg', 'Mallory')] })

    expect((await refusal(request({ lines: [forOption] }))).reason).toBe('names-changed')
    expect((await refusal(request({ lines: [forGroup] }))).reason).toBe('names-changed')
    await nothingWritten()
  })

  it('4. what is recorded is the menu’s, even when the quote agrees with it', async () => {
    const { id } = await place(request({ lines: [line({ name: 'Air Kosong' })] }))

    expect((await linesOf(id))[0]?.name).toBe('Nasi Lemak')
    expect(JSON.stringify(await read(`orders/${id}`))).not.toContain('Air Kosong')
  })

  it('5. a name and a price changed together: both shown, and the price is what is said', async () => {
    const cart = nasi()
    await write(`menuItems/${ITEM}`, item({ name: 'Nasi Lemak Special', price: 950 }))

    const refused = await staleError(cart)
    expect(refused.detail).toEqual({
      key: 'terminal.pricesChanged',
      params: { total: 'RM 9.50' },
    })
    await nothingWritten()

    const shown = refreshCart(cart, refused.current)
    expect(shown[0]).toMatchObject({ name: 'Nasi Lemak Special', unitPrice: 950 })

    const { id } = await createOrder({ cart: shown, ...params() })
    expect(await read(`orders/${id}`)).toMatchObject({
      total: 950,
      lines: [{ name: 'Nasi Lemak Special', unitPrice: 950 }],
    })
  })

  it('6. takes no order, no request record and no number', async () => {
    await write(`counters/${today()}`, { lastNumber: 41 })
    await write(`menuItems/${ITEM}`, item({ name: 'Nasi Lemak Special' }))

    const refused = await refusal(request())
    expect(refused.reason).toBe('names-changed')
    expect(await count('orders')).toBe(0)
    expect(await count('orderRequests')).toBe(0)
    expect((await read(`counters/${today()}`))?.lastNumber).toBe(41)

    const next = request({ lines: [line({ shown: 'Nasi Lemak Special' })] })
    await expect(place(next)).resolves.toMatchObject({ number: 42 })
  })

  it('refuses a name that differs only in its spacing or case, as nobody saw that either', async () => {
    const lower = await refusal(request({ lines: [line({ shown: 'nasi lemak' })] }))
    const spaced = await refusal(request({ lines: [line({ shown: 'Nasi Lemak ' })] }))

    expect([lower.reason, spaced.reason]).toEqual(['names-changed', 'names-changed'])
    await nothingWritten()
  })

  it('answers a retry with the order it made, whatever the menu calls it now', async () => {
    const data = request()
    const { id } = await place(data)
    await write(`menuItems/${ITEM}`, item({ name: 'Nasi Lemak Special' }))

    await expect(place(data)).resolves.toEqual({ id, number: 1 })
    expect((await linesOf(id))[0]?.name).toBe('Nasi Lemak')
    expect(await count('orders')).toBe(1)
  })

  it('never returns a cost on the way back', async () => {
    await write(`menuItems/${ITEM}`, item({ name: 'Nasi Lemak Special' }))
    await write(`menuItemCosts/${ITEM}`, { itemId: ITEM, cost: 123, updatedAt: now })

    expect(JSON.stringify(await refusal(request()))).not.toContain('123')
  })
})

describe('13-16. a request is placed once', () => {
  it('13. answers a retry with the original order', async () => {
    const data = request()
    const first = await place(data)
    const second = await place(data)

    expect(second).toEqual(first)
    expect(await count('orders')).toBe(1)
    expect((await read(`counters/${today()}`))?.lastNumber).toBe(1)
  })

  it('13. answers it even if the price has since changed, because it was already sold', async () => {
    const data = request()
    const first = await place(data)
    await write(`menuItems/${ITEM}`, item({ price: 950 }))

    await expect(place(data)).resolves.toEqual(first)
  })

  it('14. refuses the same id with a different order', async () => {
    const data = request()
    await place(data)

    const refused = await refusal({
      ...data,
      lines: [line({ quantity: 2 })],
      expectedTotal: PRICE * 2,
    })
    expect(refused).toMatchObject({ reason: 'request-reused', code: 'functions/already-exists' })
    expect(await count('orders')).toBe(1)
  })

  it('14. remembers nothing about a refusal, so the same id can be judged afresh', async () => {
    const data = request({ expectedTotal: 1 })
    expect((await refusal(data)).reason).toBe('price-changed')

    await expect(place({ ...data, expectedTotal: PRICE })).resolves.toMatchObject({ number: 1 })
  })

  it('15. makes one order from simultaneous retries', async () => {
    const data = request()
    const results = await Promise.all(Array.from({ length: 8 }, () => place(data)))

    expect(new Set(results.map((result) => result.id)).size).toBe(1)
    expect(await count('orders')).toBe(1)
    expect((await read(`counters/${today()}`))?.lastNumber).toBe(1)
  })

  it('16. treats the same id from another account as another request', async () => {
    const data = request()
    const mine = await place(data)

    const other = await createAccount('Second Till', 'staff')
    await signInAs(other)
    const theirs = await place(data)

    expect(theirs.id).not.toBe(mine.id)
    expect(await read(`orders/${theirs.id}`)).toMatchObject({ createdBy: other.uid })
    expect(await count('orders')).toBe(2)
  })

  it('16. keeps the record away from every client, admin included', async () => {
    await place(request())
    const records = await asServer(async (db: Firestore) =>
      (await getDocs(collection(db, 'orderRequests'))).docs.map((entry) => entry.id),
    )
    expect(records).toHaveLength(1)

    for (const uid of [till.uid, admin.uid]) {
      const db = asRulesUser(uid)
      await assertFails(getDoc(doc(db, 'orderRequests', records[0]!)))
      await assertFails(getDocs(collection(db, 'orderRequests')))
      await assertFails(setDoc(doc(db, 'orderRequests', records[0]!), { orderId: 'x' }))
    }
  })
})

describe('a page reload after an uncertain reply', () => {
  const store = new Map<string, string>()
  const OTHER = 'item-teh'

  const params = () => ({
    placement: { orderType: 'dine_in' as const, tableNumber: '5' },
    staff: { id: 'alice', name: 'Alice' },
    language: 'en' as const,
    uid: till.uid,
  })

  const egg = {
    groupId: 'g',
    groupName: 'Add-ons',
    optionId: 'egg',
    optionName: 'Option egg',
    priceAdjustment: 150,
  }
  const rice = { ...egg, optionId: 'rice', optionName: 'Option rice', priceAdjustment: 0 }

  const cartOf = (
    ...lines: { menuItemId: string; basePrice: number; modifiers?: (typeof egg)[] }[]
  ) =>
    lines.reduce<Cart>(
      (cart, entry) => addToCart(cart, { name: 'Nasi Lemak', ...entry }),
      EMPTY_CART,
    )

  /** A fresh copy of the client: everything in memory is gone, and only storage remains. */
  async function reloaded() {
    vi.resetModules()
    return (await import('@/features/pos/pos-api')).createOrder
  }

  const storedKeys = () =>
    [...store.keys()].filter((key) => key.startsWith(PENDING_ORDER_STORAGE_KEY))

  beforeEach(async () => {
    store.clear()
    session.loseNextReply = false
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    })
    await write('modifierGroups/g', group({ options: [option('egg', 150), option('rice', 0)] }))
    await write(`menuItems/${ITEM}`, item({ modifierGroupIds: ['g'] }))
    await write(`menuItems/${OTHER}`, item({ price: 500 }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('1. a retry on the same page gets the order the lost reply was for', async () => {
    const cart = cartOf({ menuItemId: OTHER, basePrice: 500 })
    session.loseNextReply = true
    await expect(createOrder({ cart, ...params() })).rejects.toThrow()
    expect(await count('orders')).toBe(1)

    await expect(createOrder({ cart, ...params() })).resolves.toMatchObject({ number: 1 })
    expect(await count('orders')).toBe(1)
  })

  it('2. the order rung up again after a reload is the same order', async () => {
    const cart = cartOf({ menuItemId: OTHER, basePrice: 500 })
    session.loseNextReply = true
    await expect(createOrder({ cart, ...params() })).rejects.toThrow()

    const fresh = await reloaded()
    const again = await fresh({ cart, ...params() })

    expect(again.number).toBe(1)
    expect(await count('orders')).toBe(1)
    expect((await read(`counters/${today()}`))?.lastNumber).toBe(1)
  })

  it('2. whichever order the items and options are tapped in this time', async () => {
    const first = cartOf(
      { menuItemId: ITEM, basePrice: PRICE, modifiers: [egg, rice] },
      { menuItemId: OTHER, basePrice: 500 },
    )
    const second = cartOf(
      { menuItemId: OTHER, basePrice: 500 },
      { menuItemId: ITEM, basePrice: PRICE, modifiers: [rice, egg] },
    )
    session.loseNextReply = true
    await expect(createOrder({ cart: first, ...params() })).rejects.toThrow()

    const fresh = await reloaded()
    await expect(fresh({ cart: second, ...params() })).resolves.toMatchObject({ number: 1 })
    expect(await count('orders')).toBe(1)
  })

  it('2. an order that never reached the server is placed once, by the retry', async () => {
    const cart = cartOf({ menuItemId: OTHER, basePrice: 500 })
    await write(`menuItems/${OTHER}`, item({ price: 500, active: false }))
    await expect(createOrder({ cart, ...params() })).rejects.toBeInstanceOf(MessageError)
    expect(await count('orders')).toBe(0)

    await write(`menuItems/${OTHER}`, item({ price: 500 }))
    const fresh = await reloaded()
    await expect(fresh({ cart, ...params() })).resolves.toMatchObject({ number: 1 })
    expect(await count('orders')).toBe(1)
  })

  it('3. the same submission is one order, and the server sees one id', async () => {
    const cart = cartOf({ menuItemId: OTHER, basePrice: 500 })
    session.loseNextReply = true
    await expect(createOrder({ cart, ...params() })).rejects.toThrow()

    const recorded = await asServer(async (db: Firestore) =>
      (await getDocs(collection(db, 'orderRequests'))).docs.map((entry) => entry.id),
    )
    const fresh = await reloaded()
    await fresh({ cart, ...params() })

    const after = await asServer(async (db: Firestore) =>
      (await getDocs(collection(db, 'orderRequests'))).docs.map((entry) => entry.id),
    )
    expect(after).toEqual(recorded)
  })

  it('4. a different order after a reload is a different sale', async () => {
    session.loseNextReply = true
    await expect(
      createOrder({ cart: cartOf({ menuItemId: OTHER, basePrice: 500 }), ...params() }),
    ).rejects.toThrow()

    const fresh = await reloaded()
    const cart = cartOf({ menuItemId: ITEM, basePrice: PRICE })
    await expect(fresh({ cart, ...params() })).resolves.toMatchObject({ number: 2 })
    expect(await count('orders')).toBe(2)
  })

  it('5. two retries at once make one order', async () => {
    const cart = cartOf({ menuItemId: OTHER, basePrice: 500 })
    session.loseNextReply = true
    await expect(createOrder({ cart, ...params() })).rejects.toThrow()

    const fresh = await reloaded()
    const results = await Promise.all([fresh({ cart, ...params() }), fresh({ cart, ...params() })])

    expect(results.map((result) => result.number)).toEqual([1, 1])
    expect(await count('orders')).toBe(1)
  })

  it('two tabs ringing up the same order at once are two sales', async () => {
    const cart = cartOf({ menuItemId: OTHER, basePrice: 500 })
    const tabA = await reloaded()
    const tabB = await reloaded()

    const results = await Promise.all([tabA({ cart, ...params() }), tabB({ cart, ...params() })])

    expect(results.map((result) => result.number).sort()).toEqual([1, 2])
    expect(new Set(results.map((result) => result.id)).size).toBe(2)
    expect(await count('orders')).toBe(2)
    expect(await count('orderRequests')).toBe(2)
    expect(storedKeys()).toEqual([])
  })

  it('a sale confirmed in a tab is not taken for a retry there later', async () => {
    const cart = cartOf({ menuItemId: OTHER, basePrice: 500 })
    const different = cartOf({ menuItemId: ITEM, basePrice: PRICE })
    const tabA = await reloaded()
    const tabB = await reloaded()

    await Promise.all([tabA({ cart, ...params() }), tabB({ cart: different, ...params() })])
    expect(storedKeys()).toEqual([])

    await expect(tabA({ cart, ...params() })).resolves.toMatchObject({ number: 3 })
    expect(await count('orders')).toBe(3)
  })

  it('one tab’s confirmed sale leaves another tab’s unanswered order to be recovered', async () => {
    const cart = cartOf({ menuItemId: OTHER, basePrice: 500 })
    const tabA = await reloaded()
    const tabB = await reloaded()

    session.loseNextReply = true
    await expect(tabA({ cart, ...params() })).rejects.toThrow()
    const different = cartOf({ menuItemId: ITEM, basePrice: PRICE })
    await expect(tabB({ cart: different, ...params() })).resolves.toMatchObject({ number: 2 })

    await expect((await reloaded())({ cart, ...params() })).resolves.toMatchObject({ number: 1 })
    expect(await count('orders')).toBe(2)
    expect(storedKeys()).toEqual([])
  })

  it('a different order cannot pick up another’s request id', async () => {
    const cart = cartOf({ menuItemId: OTHER, basePrice: 500 })
    session.loseNextReply = true
    await expect(createOrder({ cart, ...params() })).rejects.toThrow()

    const moved = { ...params(), placement: { orderType: 'takeaway' as const, tableNumber: '' } }
    await expect((await reloaded())({ cart, ...moved })).resolves.toMatchObject({ number: 2 })
    expect(await count('orderRequests')).toBe(2)
  })

  it('6. another account on the same device starts its own request', async () => {
    const cart = cartOf({ menuItemId: OTHER, basePrice: 500 })
    session.loseNextReply = true
    await expect(createOrder({ cart, ...params() })).rejects.toThrow()

    const other = await createAccount('Second Till', 'staff')
    await signInAs(other)
    const fresh = await reloaded()
    const theirs = await fresh({ cart, ...params(), uid: other.uid })

    expect(theirs.number).toBe(2)
    expect(await read(`orders/${theirs.id}`)).toMatchObject({ createdBy: other.uid })
    // The first account's unanswered order is still theirs to retry.
    await signInAs(till)
    await expect((await reloaded())({ cart, ...params() })).resolves.toMatchObject({ number: 1 })
    expect(await count('orders')).toBe(2)
  })

  it('7. a confirmed order leaves nothing behind, and the next one is a new sale', async () => {
    const cart = cartOf({ menuItemId: OTHER, basePrice: 500 })

    await createOrder({ cart, ...params() })
    expect(storedKeys()).toEqual([])

    await expect(createOrder({ cart, ...params() })).resolves.toMatchObject({ number: 2 })
    expect(await count('orders')).toBe(2)
  })

  it('7. a retry that gets its answer leaves nothing behind either', async () => {
    const cart = cartOf({ menuItemId: OTHER, basePrice: 500 })
    session.loseNextReply = true
    await expect(createOrder({ cart, ...params() })).rejects.toThrow()
    expect(storedKeys()).toHaveLength(1)

    await (
      await reloaded()
    )({ cart, ...params() })
    expect(storedKeys()).toEqual([])
  })

  it('stores nothing about the order itself', async () => {
    const cart = cartOf({ menuItemId: ITEM, basePrice: PRICE, modifiers: [egg] })
    session.loseNextReply = true
    await expect(createOrder({ cart, ...params() })).rejects.toThrow()

    const stored = [...store.entries()].join(' ')
    for (const word of [ITEM, 'alice', 'Nasi', 'Option egg', 'dine_in', String(PRICE + 150)]) {
      expect(stored).not.toContain(word)
    }
  })
})

describe('17. the counter under pressure', () => {
  it('gives simultaneous sales different numbers, with none skipped', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => place(request())))

    expect(results.map((result) => result.number).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ])
    expect((await read(`counters/${today()}`))?.lastNumber).toBe(10)
  }, 60_000)

  it('continues from a counter the previous client left', async () => {
    await write(`counters/${today()}`, { lastNumber: 41 })
    await expect(place(request())).resolves.toMatchObject({ number: 42 })
  })
})

describe('18. who may place an order', () => {
  it('refuses a caller who is not signed in', async () => {
    await signOutAll()
    expect((await refusal(request())).reason).toBe('not-allowed')
  })

  it('refuses a deactivated account', async () => {
    const gone = await createAccount('Gone', 'staff', false)
    await signInAs(gone)
    expect((await refusal(request())).reason).toBe('not-allowed')
  })

  it('refuses an account with no profile', async () => {
    const orphan = await createAccount('Orphan', 'staff')
    await asServer(async (db: Firestore) => {
      const { deleteDoc } = await import('firebase/firestore')
      await deleteDoc(doc(db, 'users', orphan.uid))
    })
    await signInAs(orphan)
    expect((await refusal(request())).reason).toBe('not-allowed')
  })

  it('lets an admin ring up a sale, as the rules always have', async () => {
    await signInAs(admin)
    await expect(place(request({ operatorId: null }))).resolves.toMatchObject({ number: 1 })
  })

  it('refuses an operator who is deactivated', async () => {
    expect((await refusal(request({ operatorId: 'bob' }))).reason).toBe('invalid-operator')
  })

  it('refuses an operator who does not exist', async () => {
    expect((await refusal(request({ operatorId: 'nobody' }))).reason).toBe('invalid-operator')
  })

  it('refuses malformed requests', async () => {
    expect((await refusal(request({ requestId: 'x' }))).reason).toBe('invalid-request')
    expect((await refusal(request({ lines: [] }))).reason).toBe('invalid-request')
    expect((await refusal(request({ language: 'fr' }))).reason).toBe('invalid-request')
  })

  it('takes an operator’s name from the roster, not from the request', async () => {
    const { id } = await place(request({ operatorId: 'alice', staffName: 'Mallory' }))
    expect(await read(`orders/${id}`)).toMatchObject({ staffId: 'alice', staffName: 'Alice' })
  })

  it('accepts the signed-in account named as its own operator, as the till sends it', async () => {
    const { id } = await place(request({ operatorId: till.uid }))
    expect(await read(`orders/${id}`)).toMatchObject({
      staffId: till.uid,
      staffName: 'Counter Till',
    })
  })

  it('will not take another account as an operator', async () => {
    expect((await refusal(request({ operatorId: admin.uid }))).reason).toBe('invalid-operator')
  })

  it('stops a sale when the account is deactivated, whatever its token still says', async () => {
    await write(`users/${till.uid}`, { ...(await read(`users/${till.uid}`)), active: false })
    expect((await refusal(request())).reason).toBe('not-allowed')
    expect(await count('orders')).toBe(0)
  })
})

describe('what a refusal gives away', () => {
  it.each(['..', '.', '__reserved__', 'x'.repeat(1501)])(
    'refuses an item id Firestore cannot read, rather than failing on it: %s',
    async (menuItemId) => {
      const refused = await refusal(request({ lines: [line({ menuItemId })] }))
      expect(refused).toMatchObject({
        reason: 'invalid-request',
        code: 'functions/invalid-argument',
      })
    },
  )

  it.each(['..', '__reserved__'])(
    'refuses an operator id of %s the same way',
    async (operatorId) => {
      expect((await refusal(request({ operatorId }))).reason).toBe('invalid-request')
    },
  )

  it('sells nothing from a menu item with an unreadable category, and says so plainly', async () => {
    await write(`menuItems/${ITEM}`, item({ categoryId: 'a/b' }))
    expect((await refusal(request())).reason).toBe('item-unavailable')
  })

  it('still offers an item that lists an unreadable group', async () => {
    await write(`menuItems/${ITEM}`, item({ modifierGroupIds: ['a/b'] }))
    await expect(place(request())).resolves.toMatchObject({ number: 1 })
  })

  it('says only the reason: no stack, no document, no path', async () => {
    await write(`menuItems/${ITEM}`, item({ active: false }))
    const caught = await place(request()).catch((error: unknown) => error)

    expect(caught).toBeInstanceOf(FirebaseError)
    const { code, message, details } = caught as FirebaseError & { details?: unknown }
    expect(code).toBe('functions/failed-precondition')
    expect(message).toMatch(/^item-unavailable\b/)
    expect(details).toEqual({ reason: 'item-unavailable', menuItemId: ITEM })
  })

  it('never returns a cost, even on a price it has to send back', async () => {
    await write(`menuItemCosts/${ITEM}`, { cost: 300, updatedAt: now })
    const refused = await refusal(request({ expectedTotal: 1 }))
    expect(JSON.stringify(refused)).not.toContain('300')
    expect(JSON.stringify(refused)).not.toContain('cost')
  })
})

describe('19-21. everything downstream', () => {
  const payment = (orderId: string, over: Record<string, unknown> = {}) => ({
    orderId,
    method: 'cash',
    amount: PRICE,
    cashTendered: 1000,
    changeGiven: 200,
    paidAt: serverTimestamp(),
    paidBy: till.uid,
    paidByName: 'Counter Till',
    paidByStaffId: 'alice',
    paidByStaffName: 'Alice',
    ...over,
  })

  const pay = (orderId: string, over: Record<string, unknown> = {}) =>
    setDoc(doc(asRulesUser(till.uid), 'orderPayments', orderId), payment(orderId, over))

  /** Today's unpaid count, worked out exactly as the navigation badge works it out. */
  async function unpaidToday() {
    return asServer(async (db: Firestore) => {
      const orders = await getDocs(
        query(collection(db, 'orders'), where('businessDate', '==', today())),
      )
      const parsed = orders.docs.flatMap((entry) => {
        const order = parseOrder(entry.id, entry.data())
        return order ? [order] : []
      })
      const payments = new Map<string, OrderPayment>()
      const voids = new Map<string, OrderVoid>()
      for (const entry of (await getDocs(collection(db, 'orderPayments'))).docs) {
        const record = parseOrderPayment(entry.id, entry.data())
        if (record) payments.set(entry.id, record)
      }
      for (const entry of (await getDocs(collection(db, 'orderVoids'))).docs) {
        const record = parseOrderVoid(entry.id, entry.data())
        if (record) voids.set(entry.id, record)
      }
      return countUnpaidOrders(
        buildOrderViews(parsed, { payments, voids, fulfillments: new Map() }),
      )
    })
  }

  async function setPin() {
    await signInAs(admin)
    await call('setAdminPin', { pin: PIN })
    await signInAs(till)
  }

  it('19. Pay now: the payment rule accepts a server-placed order', async () => {
    const { id } = await place(request())
    await assertSucceeds(pay(id))
    expect(await read(`orderPayments/${id}`)).toMatchObject({ amount: PRICE, method: 'cash' })
    expect(await unpaidToday()).toBe(0)
  })

  it('19. Pay later: the order simply stays unpaid', async () => {
    await place(request())
    expect(await unpaidToday()).toBe(1)
  })

  it('20. a payment must still match the server’s total', async () => {
    const { id } = await place(request())
    await assertFails(pay(id, { amount: 1, cashTendered: 1, changeGiven: 0 }))
  })

  it('20. the unpaid count follows payment and void', async () => {
    const first = await place(request())
    const second = await place(request())
    expect(await unpaidToday()).toBe(2)

    await pay(first.id)
    expect(await unpaidToday()).toBe(1)

    await setPin()
    await call('voidOrderWithAdminPin', {
      orderId: second.id,
      reason: 'Wrong item',
      pin: PIN,
      operatorId: 'alice',
    })
    expect(await unpaidToday()).toBe(0)
  })

  it('20. a PIN void reverses the server’s total', async () => {
    const { id } = await place(request())
    await setPin()
    await call('voidOrderWithAdminPin', {
      orderId: id,
      reason: 'Mistake',
      pin: PIN,
      operatorId: 'alice',
    })

    expect(await read(`orderVoids/${id}`)).toMatchObject({ amount: PRICE })
  })

  it('21. the report reads server-placed orders exactly as it read the others', async () => {
    await write('modifierGroups/g', group({ options: [option('egg', 200)] }))
    await write(`menuItems/${ITEM}`, item({ modifierGroupIds: ['g'] }))
    await write(`menuItemCosts/${ITEM}`, { cost: 300, updatedAt: now })

    const paid = await place(
      request({ lines: [line({ quantity: 2, choices: [choice('g', 'egg', 200)] })] }),
    )
    await place(request())
    const voided = await place(request())

    await pay(paid.id, { amount: 2000, cashTendered: 2000, changeGiven: 0 })
    await setPin()
    await call('voidOrderWithAdminPin', {
      orderId: voided.id,
      reason: 'Mistake',
      pin: PIN,
      operatorId: 'alice',
    })

    session.db = asRulesUser(admin.uid)
    const report = buildReport(await fetchReportData({ from: today(), to: today() }))

    expect(report.orderCount).toBe(2)
    expect(report.revenue).toBe(2000 + PRICE)
    expect(report.collectedRevenue).toBe(2000)
    expect(report.outstandingRevenue).toBe(PRICE)
    expect(report.unpaidOrderCount).toBe(1)
    expect(report.voidedAmount).toBe(PRICE)
    expect(report.estimatedCost).toBe(300 * 3)
    expect(report.items?.[0]).toBeDefined()
  })
})

describe('the size of an order', () => {
  async function seedLargeMenu(optionName: string, groupName = 'Choices') {
    await asServer(async (db: Firestore) => {
      await setDoc(
        doc(db, 'modifierGroups', 'wide'),
        group({
          name: groupName,
          options: Array.from({ length: 30 }, (_, index) =>
            option(`option-${index}`, 10, { name: `${optionName} ${index}` }),
          ),
        }),
      )
      for (let index = 0; index < 100; index += 1) {
        await setDoc(doc(db, 'menuItems', `item-${index}`), item({ modifierGroupIds: ['wide'] }))
      }
    })
  }

  const hundredLines = (selectionsPerLine: number, optionName: string, groupName = 'Choices') => ({
    lines: Array.from({ length: 100 }, (_, index) =>
      line({
        menuItemId: `item-${index}`,
        choices: Array.from({ length: selectionsPerLine }, (__, position) =>
          choice('wide', `option-${position}`, 10, `${optionName} ${position}`, groupName),
        ),
      }),
    ),
  })

  it('places the 100 lines an order may hold, each with several options', async () => {
    await seedLargeMenu('Extra')
    const { id } = await place(request(hundredLines(5, 'Extra')))

    const order = await read(`orders/${id}`)
    expect(order?.lines).toHaveLength(100)
    expect(order?.total).toBe(100 * (PRICE + 50))
  }, 60_000)

  it('places 100 lines of 30 short options, the most the cart allows', async () => {
    await seedLargeMenu('Extra')
    const { id } = await place(request(hundredLines(30, 'Extra')))

    const order = await read(`orders/${id}`)
    expect(order?.lines).toHaveLength(100)
    expect(JSON.stringify(order).length).toBeLessThan(1_048_576)
  }, 60_000)

  it('refuses an order too large for one document, by name, and writes nothing', async () => {
    // Names at the 60 characters the rules allow, three bytes each: every option on every line
    // carries about 470 bytes, and 3,000 of them pass Firestore's 1 MiB. Nothing may be left
    // behind, least of all a spent number.
    await seedLargeMenu('訂'.repeat(57), '訂'.repeat(60))

    expect(
      await refusal(request(hundredLines(30, '訂'.repeat(57), '訂'.repeat(60)))),
    ).toMatchObject({
      reason: 'order-too-large',
      code: 'functions/failed-precondition',
    })

    expect(await count('orders')).toBe(0)
    expect(await count('orderRequests')).toBe(0)
    expect(await read(`counters/${today()}`)).toBeNull()
  }, 60_000)

  it('tells the till so in its own words', async () => {
    await seedLargeMenu('訂'.repeat(57), '訂'.repeat(60))
    const modifiers = Array.from({ length: 30 }, (_, index) => ({
      groupId: 'wide',
      groupName: '訂'.repeat(60),
      optionId: `option-${index}`,
      optionName: `${'訂'.repeat(57)} ${index}`,
      priceAdjustment: 10,
    }))
    const cart = Array.from({ length: 100 }).reduce<Cart>(
      (current, _, index) =>
        addToCart(current, {
          menuItemId: `item-${index}`,
          name: 'Nasi Lemak',
          basePrice: PRICE,
          modifiers,
        }),
      EMPTY_CART,
    )

    const caught = await createOrder({
      cart,
      placement: { orderType: 'takeaway', tableNumber: '' },
      staff: { id: 'alice', name: 'Alice' },
      language: 'en',
      uid: till.uid,
    }).catch((error: unknown) => error)

    expect(caught).toBeInstanceOf(MessageError)
    expect((caught as MessageError).detail).toEqual({ key: 'terminal.orderTooLarge' })
  }, 60_000)

  it('still places an order just under the ceiling, so Firestore agrees with the arithmetic', async () => {
    await seedLargeMenu('訂'.repeat(20), '訂'.repeat(60))

    const { id } = await place(request(hundredLines(30, '訂'.repeat(20), '訂'.repeat(60))))

    const weight = storedBytes(await read(`orders/${id}`))
    expect(weight).toBeGreaterThan(MAX_ORDER_BYTES * 0.95)
    expect(weight).toBeLessThanOrEqual(MAX_ORDER_BYTES + 100)
  }, 60_000)
})
