/**
 * `placeOrder`'s warm-up, against the real Cloud Function in the Functions emulator, with real Auth
 * accounts.
 *
 * A warm-up is `{ warmup: true }` and nothing else. It must pass exactly the checks an order passes
 * before anything else happens — signed in, a profile, active — and then stop: no order, no request
 * record, no counter, nothing written anywhere. Anything else is an order, judged as one, so a
 * real order carrying `warmup: true` is still placed, and an order's numbering and idempotency are
 * exactly as they were.
 *
 * Run with `npm run test:functions`.
 */
import { doc, deleteDoc, type Firestore } from 'firebase/firestore'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { businessDateAt } from '../../functions/src/order'
import {
  asServer,
  call,
  callWithToken,
  count,
  createAccount,
  read,
  refusal,
  resetEmulators,
  signInAs,
  signOutAll,
  startHarness,
  stopHarness,
  write,
  type Account,
} from './harness'

vi.setConfig({ testTimeout: 120_000 })

const ITEM = 'item-nasi'
const PRICE = 800
const now = new Date()
const today = () => businessDateAt(new Date())

let admin: Account
let till: Account
let sequence = 0

const warmUp = () => call<unknown>('placeOrder', { warmup: true })
const place = (data: unknown) => call<{ id: string; number: number }>('placeOrder', data)

function order(over: Record<string, unknown> = {}) {
  return {
    requestId: `request-${Date.now()}-${(sequence += 1)}`,
    lines: [
      {
        menuItemId: ITEM,
        quantity: 1,
        selections: [],
        expected: {
          name: 'Nasi Lemak',
          basePrice: PRICE,
          unitPrice: PRICE,
          adjustments: [],
          groupNames: [],
          optionNames: [],
        },
      },
    ],
    orderType: 'takeaway',
    tableNumber: null,
    operatorId: 'alice',
    language: 'en',
    expectedTotal: PRICE,
    ...over,
  }
}

/** Everything a sale, a payment, a void or a PIN attempt could have left behind. */
const BUSINESS_COLLECTIONS = [
  'orders',
  'orderRequests',
  'counters',
  'orderPayments',
  'orderVoids',
  'orderFulfillment',
  'pinAttempts',
] as const

async function businessDocuments(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const name of BUSINESS_COLLECTIONS) counts[name] = await count(name)
  return counts
}

async function expectNothingWritten() {
  expect(await businessDocuments()).toEqual(
    Object.fromEntries(BUSINESS_COLLECTIONS.map((name) => [name, 0])),
  )
  expect(await read(`counters/${today()}`)).toBeNull()
}

beforeAll(async () => {
  await startHarness()
})

afterAll(async () => {
  await stopHarness()
})

beforeEach(async () => {
  await resetEmulators()
  admin = await createAccount('Ada Admin', 'admin')
  till = await createAccount('Counter Till', 'staff')
  await write('staffMembers/alice', { name: 'Alice', active: true, createdAt: now, updatedAt: now })
  await write('categories/mains', {
    name: 'Mains',
    sortOrder: 0,
    active: true,
    createdAt: now,
    updatedAt: now,
  })
  await write(`menuItems/${ITEM}`, {
    name: 'Nasi Lemak',
    names: {},
    categoryId: 'mains',
    price: PRICE,
    sortOrder: 0,
    active: true,
    modifierGroupIds: [],
    createdAt: now,
    updatedAt: now,
  })
  await signInAs(till)
})

describe('a warm-up from an active account', () => {
  it('answers { warm: true } and writes nothing at all', async () => {
    const profileBefore = await read(`users/${till.uid}`)
    const menuBefore = await read(`menuItems/${ITEM}`)

    await expect(warmUp()).resolves.toEqual({ warm: true })

    await expectNothingWritten()
    expect(await read(`users/${till.uid}`)).toEqual(profileBefore)
    expect(await read(`menuItems/${ITEM}`)).toEqual(menuBefore)
  })

  it('is allowed to an admin, exactly as an order is, and still writes nothing', async () => {
    await signInAs(admin)
    await expect(warmUp()).resolves.toEqual({ warm: true })
    await expectNothingWritten()
  })

  it('writes nothing however often it is sent', async () => {
    for (let i = 0; i < 10; i += 1) await expect(warmUp()).resolves.toEqual({ warm: true })
    await expectNothingWritten()
  })

  it('gives the same answer to everyone it lets through — nothing about the caller', async () => {
    const asTill = await warmUp()
    await signInAs(admin)
    const asAdmin = await warmUp()

    expect(asTill).toEqual(asAdmin)
    expect(JSON.stringify(asTill)).not.toContain(till.uid)
    expect(JSON.stringify(asAdmin)).not.toContain(admin.uid)
  })
})

describe('a warm-up is refused exactly as an order would be', () => {
  it('when nobody is signed in', async () => {
    await signOutAll()
    expect(await refusal('placeOrder', { warmup: true })).toBe('not-allowed')
    expect(await refusal('placeOrder', order())).toBe('not-allowed')
    await expectNothingWritten()
  })

  it('for a deactivated account', async () => {
    const gone = await createAccount('Gone', 'staff', false)
    await signInAs(gone)
    expect(await refusal('placeOrder', { warmup: true })).toBe('not-allowed')
    await expectNothingWritten()
  })

  it('for an account with no profile', async () => {
    const orphan = await createAccount('Orphan', 'staff')
    await asServer((db: Firestore) => deleteDoc(doc(db, 'users', orphan.uid)))
    await signInAs(orphan)
    expect(await refusal('placeOrder', { warmup: true })).toBe('not-allowed')
    await expectNothingWritten()
  })

  it('for a token naming an account that does not exist', async () => {
    const forged = await callWithToken(
      'placeOrder',
      { warmup: true },
      { uid: 'no-such-account', authTimeSeconds: Math.floor(Date.now() / 1000) },
    )
    expect(forged).toEqual({ ok: false, reason: 'not-allowed' })
    await expectNothingWritten()
  })
})

describe('anything but exactly { warmup: true } is an order', () => {
  it('refuses a warm-up with something added, as a malformed order, writing nothing', async () => {
    expect(await refusal('placeOrder', { warmup: true, extra: 1 })).toBe('invalid-request')
    expect(await refusal('placeOrder', { warmup: 'true' })).toBe('invalid-request')
    await expectNothingWritten()
  })

  it('places a real order that also carries warmup: true, through the normal path', async () => {
    const placed = await place(order({ warmup: true }))

    expect(placed).toEqual({ id: expect.any(String), number: 1 })
    expect(await read(`orders/${placed.id}`)).toMatchObject({ number: 1, total: PRICE })
    expect(await count('orderRequests')).toBe(1)
    expect(await read(`counters/${today()}`)).toEqual({ lastNumber: 1 })
  })
})

describe('orders around warm-ups', () => {
  it('number and replay exactly as they would without them', async () => {
    await warmUp()
    const first = order()
    const placed = await place(first)
    await warmUp()

    // The same request again is the same order, not a second one.
    await expect(place(first)).resolves.toEqual(placed)
    await warmUp()
    const second = await place(order())

    expect(placed.number).toBe(1)
    expect(second.number).toBe(2)
    expect(await count('orders')).toBe(2)
    expect(await count('orderRequests')).toBe(2)
    expect(await read(`counters/${today()}`)).toEqual({ lastNumber: 2 })
  })

  it('leave one order, one request record and one number when sent all at once', async () => {
    const results = await Promise.all([
      warmUp(),
      warmUp(),
      place(order()),
      warmUp(),
      warmUp(),
      warmUp(),
    ])

    expect(
      results.filter((result) => result && typeof result === 'object' && 'number' in result),
    ).toHaveLength(1)
    expect(await count('orders')).toBe(1)
    expect(await count('orderRequests')).toBe(1)
    expect(await read(`counters/${today()}`)).toEqual({ lastNumber: 1 })
  })
})
