/**
 * `voidOrderWithAdminPin`'s warm-up, against the real Cloud Function in the Functions emulator, with
 * real Auth accounts and a real admin PIN.
 *
 * A warm-up is `{ warmup: true }` and nothing else. It passes exactly the checks a void passes
 * first — signed in, a profile, active — and then stops: no PIN is validated or compared, no attempt
 * is spent, reset or even read, no order is read and no void is written. So it can neither use,
 * reset nor reveal a lockout. Anything else is a void, judged as one: a void carrying
 * `warmup: true` still spends its attempt and checks its PIN.
 *
 * Run with `npm run test:functions`.
 */
import { deleteDoc, doc, type Firestore } from 'firebase/firestore'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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

const ORDER_ID = 'order-7'
const TOTAL = 1700
const PIN = '482915'
const WRONG_PIN = '000000'

let admin: Account
let till: Account

vi.setConfig({ testTimeout: 120_000 })

const warmUp = () => call<unknown>('voidOrderWithAdminPin', { warmup: true })

const voidRequest = (pin: string, extra: Record<string, unknown> = {}) => ({
  orderId: ORDER_ID,
  reason: 'Wrong item rung up',
  pin,
  operatorId: 'alice',
  ...extra,
})

async function setPinAs(account: Account, pin: string): Promise<void> {
  await signInAs(account)
  await call('setAdminPin', { pin })
  await signOutAll()
}

/**
 * Every document a void, a payment or a PIN check could touch, and the size of every collection
 * they live in. A warm-up must leave all of it exactly as it was.
 */
async function securityState(): Promise<Record<string, unknown>> {
  const documents = [
    `orders/${ORDER_ID}`,
    `orderVoids/${ORDER_ID}`,
    `orderPayments/${ORDER_ID}`,
    `orderFulfillment/${ORDER_ID}`,
    `pinAttempts/${till.uid}`,
    `pinAttempts/${admin.uid}`,
    'pinAttempts/_global',
    `pinSetupAttempts/${admin.uid}`,
    `adminPins/${admin.uid}`,
    `users/${till.uid}`,
    `users/${admin.uid}`,
  ]
  const collections = [
    'orders',
    'orderVoids',
    'orderPayments',
    'orderFulfillment',
    'orderRequests',
    'counters',
    'pinAttempts',
    'pinSetupAttempts',
    'adminPins',
    'users',
  ]
  const state: Record<string, unknown> = {}
  for (const path of documents) state[path] = await read(path)
  for (const name of collections) state[`count:${name}`] = await count(name)
  return state
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
  await write('staffMembers/alice', {
    name: 'Alice',
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  await write(`orders/${ORDER_ID}`, {
    number: 7,
    businessDate: '2026-11-17',
    lines: [
      {
        menuItemId: 'm1',
        name: 'Roti Canai',
        basePrice: 850,
        unitPrice: 850,
        modifiers: [],
        quantity: 2,
      },
    ],
    total: TOTAL,
    orderType: 'takeaway',
    createdAt: new Date(),
    createdBy: 'someone',
    createdByName: 'Counter Till',
    staffId: 'alice',
    staffName: 'Alice',
  })
  await setPinAs(admin, PIN)
  await signInAs(till)
})

describe('a warm-up from an active account', () => {
  it('answers { warm: true } and changes nothing — no order, void, payment or PIN record', async () => {
    const before = await securityState()

    await expect(warmUp()).resolves.toEqual({ warm: true })

    expect(await securityState()).toEqual(before)
    expect(await read(`pinAttempts/${till.uid}`)).toBeNull()
  })

  it('is allowed to an admin, exactly as a void call is, and changes nothing', async () => {
    await signInAs(admin)
    const before = await securityState()

    await expect(warmUp()).resolves.toEqual({ warm: true })

    expect(await securityState()).toEqual(before)
  })

  it('changes nothing however often it is sent', async () => {
    const before = await securityState()
    for (let i = 0; i < 10; i += 1) await expect(warmUp()).resolves.toEqual({ warm: true })
    expect(await securityState()).toEqual(before)
  })

  it('gives the same answer whether or not any admin has a PIN — it reveals nothing', async () => {
    const withPin = await warmUp()
    await asServer((db: Firestore) => deleteDoc(doc(db, 'adminPins', admin.uid)))
    const withoutPin = await warmUp()

    expect(withoutPin).toEqual(withPin)
    // A real void, by contrast, does find out.
    expect(await refusal('voidOrderWithAdminPin', voidRequest(PIN))).toBe('no-pin')
  })
})

describe('the PIN lockout', () => {
  it('is neither used, reset nor revealed by a warm-up from a locked account', async () => {
    const lock = { failures: 0, windowStart: null, lockedUntil: Date.now() + 15 * 60_000 }
    await write(`pinAttempts/${till.uid}`, lock)
    const before = await securityState()

    await expect(warmUp()).resolves.toEqual({ warm: true })

    expect(await securityState()).toEqual(before)
    expect(await read(`pinAttempts/${till.uid}`)).toEqual(lock)
    // Still locked: even the right PIN is refused, and nothing is voided.
    expect(await refusal('voidOrderWithAdminPin', voidRequest(PIN))).toBe('locked')
    expect(await read(`orderVoids/${ORDER_ID}`)).toBeNull()
  })

  it('leaves a count of wrong PINs exactly where it was — neither spent nor cleared', async () => {
    for (let i = 0; i < 3; i += 1) {
      expect(await refusal('voidOrderWithAdminPin', voidRequest(WRONG_PIN))).toBe('incorrect-pin')
    }
    const counted = await read(`pinAttempts/${till.uid}`)
    expect(counted).toMatchObject({ failures: 3 })
    const before = await securityState()

    for (let i = 0; i < 5; i += 1) await warmUp()

    expect(await securityState()).toEqual(before)
    expect(await read(`pinAttempts/${till.uid}`)).toEqual(counted)
  })
})

describe('a warm-up is refused exactly as a void call would be', () => {
  it('when nobody is signed in', async () => {
    await signOutAll()
    const before = await securityState()

    expect(await refusal('voidOrderWithAdminPin', { warmup: true })).toBe('not-allowed')
    expect(await refusal('voidOrderWithAdminPin', voidRequest(PIN))).toBe('not-allowed')
    expect(await securityState()).toEqual(before)
  })

  it('for a deactivated account', async () => {
    const gone = await createAccount('Gone', 'staff', false)
    await signInAs(gone)
    const before = await securityState()

    expect(await refusal('voidOrderWithAdminPin', { warmup: true })).toBe('not-allowed')
    expect(await securityState()).toEqual(before)
    expect(await read(`pinAttempts/${gone.uid}`)).toBeNull()
  })

  it('for an account with no profile', async () => {
    const orphan = await createAccount('Orphan', 'staff')
    await asServer((db: Firestore) => deleteDoc(doc(db, 'users', orphan.uid)))
    await signInAs(orphan)
    const before = await securityState()

    expect(await refusal('voidOrderWithAdminPin', { warmup: true })).toBe('not-allowed')
    expect(await securityState()).toEqual(before)
  })

  it('for a token naming an account that does not exist', async () => {
    const before = await securityState()
    const forged = await callWithToken(
      'voidOrderWithAdminPin',
      { warmup: true },
      { uid: 'no-such-account', authTimeSeconds: Math.floor(Date.now() / 1000) },
    )
    expect(forged).toEqual({ ok: false, reason: 'not-allowed' })
    expect(await securityState()).toEqual(before)
  })
})

describe('anything but exactly { warmup: true } is a void', () => {
  it('refuses a warm-up with something added as a malformed void, spending no attempt', async () => {
    const before = await securityState()

    expect(await refusal('voidOrderWithAdminPin', { warmup: true, extra: 1 })).toBe(
      'invalid-request',
    )
    expect(await refusal('voidOrderWithAdminPin', { warmup: 'true' })).toBe('invalid-request')
    expect(await securityState()).toEqual(before)
    expect(await read(`pinAttempts/${till.uid}`)).toBeNull()
  })

  it('still spends an attempt and checks the PIN for a void that carries warmup: true', async () => {
    expect(await refusal('voidOrderWithAdminPin', voidRequest(WRONG_PIN, { warmup: true }))).toBe(
      'incorrect-pin',
    )
    expect(await read(`pinAttempts/${till.uid}`)).toMatchObject({ failures: 1 })
    expect(await read(`orderVoids/${ORDER_ID}`)).toBeNull()
  })

  it('voids normally when that void carries the right PIN', async () => {
    await expect(
      call('voidOrderWithAdminPin', voidRequest(PIN, { warmup: true })),
    ).resolves.toEqual({
      ok: true,
    })
    expect(await read(`orderVoids/${ORDER_ID}`)).toMatchObject({
      orderId: ORDER_ID,
      amount: TOTAL,
      voidedBy: admin.uid,
    })
  })
})

describe('warm-ups alongside a real void', () => {
  it('leave exactly one void, with the attempt count cleared as a correct PIN clears it', async () => {
    const results = await Promise.all([
      warmUp(),
      warmUp(),
      call('voidOrderWithAdminPin', voidRequest(PIN)),
      warmUp(),
      warmUp(),
    ])

    expect(results).toEqual([
      { warm: true },
      { warm: true },
      { ok: true },
      { warm: true },
      { warm: true },
    ])
    expect(await count('orderVoids')).toBe(1)
    expect(await read(`orderVoids/${ORDER_ID}`)).toMatchObject({ amount: TOTAL })
    expect(await read(`pinAttempts/${till.uid}`)).toEqual({
      failures: 0,
      windowStart: null,
      lockedUntil: null,
    })
    expect(await read('pinAttempts/_global')).toBeNull()
  })

  it('do not stop a wrong PIN being counted when they arrive at the same time', async () => {
    const results = await Promise.allSettled([
      warmUp(),
      call('voidOrderWithAdminPin', voidRequest(WRONG_PIN)),
      warmUp(),
    ])

    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
    expect(await read(`pinAttempts/${till.uid}`)).toMatchObject({ failures: 1 })
    expect(await read('pinAttempts/_global')).toMatchObject({ count: 1 })
    expect(await read(`orderVoids/${ORDER_ID}`)).toBeNull()
  })
})
