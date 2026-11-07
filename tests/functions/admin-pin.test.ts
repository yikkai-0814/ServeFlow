/**
 * Admin PIN authorisation, against the real Cloud Functions in the Functions emulator, with
 * real Auth accounts and the real firestore.rules loaded.
 *
 * Numbered to match the brief: (1) correct PIN, (2) incorrect PIN, (3) staff and PINs,
 * (4) no PIN configured, (5) setup and change authorisation, (6) lockout and monitoring,
 * (7) no reusable verification, (8) no void without a PIN, (9) the void record and its
 * parity with validVoid. (10), the languages, is covered in tests/unit/i18n.test.ts and the
 * component suites.
 *
 * Run with `npm run test:functions`.
 */
import { assertSucceeds } from '@firebase/rules-unit-testing'
import { deleteDoc, doc, serverTimestamp, setDoc } from 'firebase/firestore'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  asRulesUser,
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
const OTHER_PIN = '730164'
const WRONG_PIN = '000000'

let admin: Account
let till: Account

// Under heavy load the Functions emulator can take over a minute to serve simultaneous calls,
// and the Firebase client has its own limit of about 70 seconds on each call.
vi.setConfig({ testTimeout: 120_000 })

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
  await write('staffMembers/bob', {
    name: 'Bob',
    active: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  await write(`orders/${ORDER_ID}`, {
    number: 7,
    businessDate: '2026-11-03',
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
    createdBy: till.uid,
    createdByName: 'Counter Till',
    staffId: 'alice',
    staffName: 'Alice',
  })
})

/** Signs in as `account` (a fresh sign-in, so a recent auth_time) and sets their PIN. */
async function setPinAs(account: Account, pin: string): Promise<void> {
  await signInAs(account)
  await call('setAdminPin', { pin })
  await signOutAll()
}

const voidRequest = (pin: string, extra: Record<string, unknown> = {}) => ({
  orderId: ORDER_ID,
  reason: '  Wrong item rung up  ',
  pin,
  operatorId: 'alice',
  ...extra,
})

describe('getAdminPinStatus', () => {
  it('reports no PIN available before any admin has set one', async () => {
    await signInAs(till)
    expect(await call('getAdminPinStatus')).toEqual({ pinAvailable: false })
    await signInAs(admin)
    expect(await call('getAdminPinStatus')).toEqual({
      pinAvailable: false,
      self: { configured: false, updatedAt: null },
    })
  })

  it('reports availability to staff, and only an admin learns about their own PIN', async () => {
    await setPinAs(admin, PIN)
    await signInAs(till)
    expect(await call('getAdminPinStatus')).toEqual({ pinAvailable: true })

    await signInAs(admin)
    const own = await call<{
      pinAvailable: boolean
      self: { configured: boolean; updatedAt: string }
    }>('getAdminPinStatus')
    expect(own.pinAvailable).toBe(true)
    expect(own.self.configured).toBe(true)
    expect(Number.isNaN(Date.parse(own.self.updatedAt))).toBe(false)
    // Never a hash, a salt, or anything else from the PIN document.
    expect(JSON.stringify(own)).not.toMatch(/hash|salt|scrypt/)
  })

  it('refuses a signed-out caller and a deactivated account', async () => {
    await signOutAll()
    expect(await refusal('getAdminPinStatus')).toBe('not-allowed')
    const gone = await createAccount('Gone', 'staff', false)
    await signInAs(gone)
    expect(await refusal('getAdminPinStatus')).toBe('not-allowed')
  })
})

describe('(5) setting and changing a PIN', () => {
  it('lets an admin set their own PIN, storing only a salted scrypt hash', async () => {
    await setPinAs(admin, PIN)
    const stored = await read(`adminPins/${admin.uid}`)
    expect(stored).not.toBeNull()
    expect(stored?.algorithm).toBe('scrypt')
    expect(typeof stored?.hash).toBe('string')
    expect(typeof stored?.salt).toBe('string')
    expect(JSON.stringify(stored)).not.toContain(PIN)
  })

  it('(3) refuses staff setting a PIN, and stores nothing', async () => {
    await signInAs(till)
    expect(await refusal('setAdminPin', { pin: PIN })).toBe('not-allowed')
    expect(await count('adminPins')).toBe(0)
  })

  it('refuses anything but six digits', async () => {
    await signInAs(admin)
    for (const pin of ['12345', '1234567', '12a456', '', 123456]) {
      expect(await refusal('setAdminPin', { pin })).toBe('invalid-pin')
    }
  })

  it('requires a recent sign-in, judged by the token’s auth_time', async () => {
    const now = Math.floor(Date.now() / 1000)
    const stale = await callWithToken(
      'setAdminPin',
      { pin: PIN },
      { uid: admin.uid, authTimeSeconds: now - 3600 },
    )
    expect(stale).toEqual({ ok: false, reason: 'stale-sign-in' })
    expect(await read(`adminPins/${admin.uid}`)).toBeNull()

    const fresh = await callWithToken(
      'setAdminPin',
      { pin: PIN },
      { uid: admin.uid, authTimeSeconds: now - 30 },
    )
    expect(fresh.ok).toBe(true)
    expect(await read(`adminPins/${admin.uid}`)).not.toBeNull()
  })

  it('changes only the caller’s own PIN, whatever the request names', async () => {
    const other = await createAccount('Ben Admin', 'admin')
    await setPinAs(admin, PIN)
    const before = await read(`adminPins/${admin.uid}`)

    await signInAs(other)
    await call('setAdminPin', { pin: OTHER_PIN, uid: admin.uid, adminUid: admin.uid })
    expect(await read(`adminPins/${admin.uid}`)).toEqual(before)
    expect(await read(`adminPins/${other.uid}`)).not.toBeNull()
  })

  it('lets an admin change their PIN, and the old one stops working', async () => {
    await setPinAs(admin, PIN)
    await setPinAs(admin, OTHER_PIN)

    await signInAs(till)
    expect(await refusal('voidOrderWithAdminPin', voidRequest(PIN))).toBe('incorrect-pin')
    await call('voidOrderWithAdminPin', voidRequest(OTHER_PIN))
    expect(await read(`orderVoids/${ORDER_ID}`)).not.toBeNull()
  })

  it('refuses a PIN another admin already uses, without saying whose', async () => {
    const other = await createAccount('Ben Admin', 'admin')
    await setPinAs(admin, PIN)

    await signInAs(other)
    expect(await refusal('setAdminPin', { pin: PIN })).toBe('pin-unavailable')
    expect(await read(`adminPins/${other.uid}`)).toBeNull()
    await call('setAdminPin', { pin: OTHER_PIN })
    expect(await read(`adminPins/${other.uid}`)).not.toBeNull()
  })

  it('refuses a deactivated admin’s PIN too, so reactivating them cannot create a clash', async () => {
    const other = await createAccount('Ben Admin', 'admin')
    await setPinAs(admin, PIN)
    await write(`users/${admin.uid}`, {
      uid: admin.uid,
      email: admin.email,
      displayName: admin.displayName,
      role: 'admin',
      active: false,
      createdAt: new Date(),
    })

    await signInAs(other)
    expect(await refusal('setAdminPin', { pin: PIN })).toBe('pin-unavailable')
  })

  it('limits setup attempts, so the duplicate check cannot be used to search for a PIN', async () => {
    await signInAs(admin)
    for (let i = 0; i < 5; i += 1) await call('setAdminPin', { pin: `10000${i}` })
    expect(await refusal('setAdminPin', { pin: '100009' })).toBe('rate-limited')
  })
})

describe('(1) a correct PIN voids the order', () => {
  beforeEach(async () => {
    await setPinAs(admin, PIN)
    await signInAs(till)
  })

  it('writes exactly today’s void record: requester, authorising admin, reason, amount, time', async () => {
    await call('voidOrderWithAdminPin', voidRequest(PIN))

    const record = await read(`orderVoids/${ORDER_ID}`)
    expect(Object.keys(record ?? {}).sort()).toEqual(
      [
        'amount',
        'initiatedByStaffId',
        'initiatedByStaffName',
        'orderId',
        'reason',
        'voidedAt',
        'voidedBy',
        'voidedByName',
      ].sort(),
    )
    expect(record).toMatchObject({
      orderId: ORDER_ID,
      reason: 'Wrong item rung up',
      amount: TOTAL,
      voidedBy: admin.uid,
      voidedByName: 'Ada Admin',
      initiatedByStaffId: 'alice',
      initiatedByStaffName: 'Alice',
    })
    expect(typeof (record?.voidedAt as { toDate?: unknown })?.toDate).toBe('function')
    // The order itself is untouched.
    expect((await read(`orders/${ORDER_ID}`))?.total).toBe(TOTAL)
  })

  it('records the signed-in account when no operator is selected', async () => {
    await call('voidOrderWithAdminPin', voidRequest(PIN, { operatorId: null }))
    expect(await read(`orderVoids/${ORDER_ID}`)).toMatchObject({
      initiatedByStaffId: till.uid,
      initiatedByStaffName: 'Counter Till',
    })
  })

  it('takes every name from the server — nothing the till sends becomes part of the record', async () => {
    await call(
      'voidOrderWithAdminPin',
      voidRequest(PIN, {
        initiatedBy: { staffId: 'mallory', staffName: 'Mallory' },
        initiatedByStaffName: 'Mallory',
        voidedByName: 'Somebody Else',
        amount: 1,
      }),
    )
    expect(await read(`orderVoids/${ORDER_ID}`)).toMatchObject({
      amount: TOTAL,
      voidedByName: 'Ada Admin',
      initiatedByStaffId: 'alice',
      initiatedByStaffName: 'Alice',
    })
  })

  it('(9) writes a record the void rule itself accepts from that admin', async () => {
    await call('voidOrderWithAdminPin', voidRequest(PIN))
    const record = await read(`orderVoids/${ORDER_ID}`)
    await asServer((db) => deleteDoc(doc(db, 'orderVoids', ORDER_ID)))

    // The same fields, written by the authorising admin through the real rules.
    await assertSucceeds(
      setDoc(doc(asRulesUser(admin.uid), 'orderVoids', ORDER_ID), {
        ...record,
        voidedAt: serverTimestamp(),
      }),
    )
  })

  it('a correct PIN clears earlier wrong attempts', async () => {
    for (let i = 0; i < 4; i += 1) await refusal('voidOrderWithAdminPin', voidRequest(WRONG_PIN))
    await call('voidOrderWithAdminPin', voidRequest(PIN))
    expect(await read(`pinAttempts/${till.uid}`)).toMatchObject({ failures: 0, lockedUntil: null })
  })
})

describe('(2) an incorrect PIN voids nothing', () => {
  beforeEach(async () => {
    await setPinAs(admin, PIN)
    await signInAs(till)
  })

  it('is refused, writes no void, and counts against the account and the global monitor', async () => {
    expect(await refusal('voidOrderWithAdminPin', voidRequest(WRONG_PIN))).toBe('incorrect-pin')
    expect(await read(`orderVoids/${ORDER_ID}`)).toBeNull()
    expect(await read(`pinAttempts/${till.uid}`)).toMatchObject({ failures: 1 })
    expect(await read('pinAttempts/_global')).toMatchObject({ count: 1 })
  })

  it('does not spend an attempt on a malformed PIN or reason', async () => {
    expect(await refusal('voidOrderWithAdminPin', voidRequest('1234'))).toBe('invalid-pin')
    expect(await refusal('voidOrderWithAdminPin', voidRequest(PIN, { reason: '   ' }))).toBe(
      'invalid-reason',
    )
    expect(await read(`pinAttempts/${till.uid}`)).toBeNull()
  })

  it('refuses a deactivated admin’s PIN', async () => {
    const other = await createAccount('Ben Admin', 'admin')
    await setPinAs(other, OTHER_PIN)
    await write(`users/${admin.uid}`, {
      uid: admin.uid,
      email: admin.email,
      displayName: admin.displayName,
      role: 'admin',
      active: false,
      createdAt: new Date(),
    })

    await signInAs(till)
    expect(await refusal('voidOrderWithAdminPin', voidRequest(PIN))).toBe('incorrect-pin')
    expect(await read(`orderVoids/${ORDER_ID}`)).toBeNull()
  })
})

describe('(3) who may ask', () => {
  beforeEach(async () => {
    await setPinAs(admin, PIN)
  })

  it('refuses an operator who is unknown or deactivated — even with the right PIN', async () => {
    await signInAs(till)
    expect(await refusal('voidOrderWithAdminPin', voidRequest(PIN, { operatorId: 'ghost' }))).toBe(
      'invalid-operator',
    )
    expect(await refusal('voidOrderWithAdminPin', voidRequest(PIN, { operatorId: 'bob' }))).toBe(
      'invalid-operator',
    )
    expect(await read(`orderVoids/${ORDER_ID}`)).toBeNull()
  })

  it('refuses a deactivated staff account, and a signed-out caller', async () => {
    const gone = await createAccount('Gone', 'staff', false)
    await signInAs(gone)
    expect(await refusal('voidOrderWithAdminPin', voidRequest(PIN))).toBe('not-allowed')
    await signOutAll()
    expect(await refusal('voidOrderWithAdminPin', voidRequest(PIN))).toBe('not-allowed')
    expect(await read(`orderVoids/${ORDER_ID}`)).toBeNull()
  })
})

describe('(4) no PIN configured', () => {
  it('refuses with no-pin, spending no attempt', async () => {
    await signInAs(till)
    expect(await refusal('voidOrderWithAdminPin', voidRequest(PIN))).toBe('no-pin')
    expect(await read(`pinAttempts/${till.uid}`)).toBeNull()
  })
})

describe('(6) brute-force protection', () => {
  beforeEach(async () => {
    await setPinAs(admin, PIN)
  })

  it('locks an account on its fifth wrong PIN, and refuses even the right PIN while locked', async () => {
    await signInAs(till)
    const reasons: string[] = []
    for (let i = 0; i < 5; i += 1)
      reasons.push(await refusal('voidOrderWithAdminPin', voidRequest(WRONG_PIN)))
    expect(reasons).toEqual([
      'incorrect-pin',
      'incorrect-pin',
      'incorrect-pin',
      'incorrect-pin',
      'locked',
    ])

    expect(await refusal('voidOrderWithAdminPin', voidRequest(PIN))).toBe('locked')
    expect(await read(`orderVoids/${ORDER_ID}`)).toBeNull()
  })

  it('lifts the lock once it has expired', async () => {
    await write(`pinAttempts/${till.uid}`, {
      failures: 0,
      windowStart: null,
      lockedUntil: Date.now() - 1000,
    })
    await signInAs(till)
    await call('voidOrderWithAdminPin', voidRequest(PIN))
    expect(await read(`orderVoids/${ORDER_ID}`)).not.toBeNull()
  })

  it('cannot be outrun by sending many guesses at once', async () => {
    await signInAs(till)
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => call('voidOrderWithAdminPin', voidRequest(WRONG_PIN))),
    )
    expect(results.every((result) => result.status === 'rejected')).toBe(true)
    // Attempts are spent before the PIN is checked, so a burst still ends locked.
    expect(await refusal('voidOrderWithAdminPin', voidRequest(PIN))).toBe('locked')
  })

  it('locks only the guessing account; failures elsewhere are counted, never enforced globally', async () => {
    const second = await createAccount('Second Till', 'staff')
    const third = await createAccount('Third Till', 'staff')
    for (const account of [till, second]) {
      await signInAs(account)
      for (let i = 0; i < 5; i += 1) await refusal('voidOrderWithAdminPin', voidRequest(WRONG_PIN))
    }
    expect((await read('pinAttempts/_global'))?.count).toBe(10)

    // Another account is unaffected by everyone else's failures.
    await signInAs(third)
    await call('voidOrderWithAdminPin', voidRequest(PIN))
    expect(await read(`orderVoids/${ORDER_ID}`)).not.toBeNull()
  })
})

describe('(7) no reusable verification', () => {
  beforeEach(async () => {
    await setPinAs(admin, PIN)
    await signInAs(till)
  })

  it('requires the PIN on every void, and refuses voiding the same order twice', async () => {
    await call('voidOrderWithAdminPin', voidRequest(PIN))
    expect(await refusal('voidOrderWithAdminPin', voidRequest(PIN))).toBe('already-voided')

    await write('orders/order-8', { ...(await read(`orders/${ORDER_ID}`)), number: 8 })
    // A second order straight after: no PIN, no void — nothing carried over from the first.
    expect(
      await refusal('voidOrderWithAdminPin', {
        orderId: 'order-8',
        reason: 'Again',
        operatorId: 'alice',
      }),
    ).toBe('invalid-pin')
    expect(await read('orderVoids/order-8')).toBeNull()
  })

  it('refuses an order that does not exist', async () => {
    expect(await refusal('voidOrderWithAdminPin', voidRequest(PIN, { orderId: 'nope' }))).toBe(
      'order-not-found',
    )
  })
})

describe('(8) one PIN, one administrator', () => {
  it('fails closed when a PIN matches more than one admin, rather than guessing', async () => {
    const other = await createAccount('Ben Admin', 'admin')
    await setPinAs(admin, PIN)
    // Only reachable by bypassing setAdminPin, which refuses duplicates.
    await write(`adminPins/${other.uid}`, (await read(`adminPins/${admin.uid}`))!)

    await signInAs(till)
    expect(await refusal('voidOrderWithAdminPin', voidRequest(PIN))).toBe('pin-conflict')
    expect(await read(`orderVoids/${ORDER_ID}`)).toBeNull()
  })
})
