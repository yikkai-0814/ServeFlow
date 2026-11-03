/**
 * The Admin PIN collections are server-only.
 *
 * Hashed PINs, and the counters that stop them being guessed, are read and written by the
 * Cloud Functions alone (Admin SDK). A PIN hash readable by a client could be brute-forced
 * offline in moments — six digits is a million values — so no client role may read one, and
 * no client may forge a counter to lift its own lockout. An admin included: they manage their
 * own PIN through setAdminPin, which never hands a hash back.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  assertFails,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc } from 'firebase/firestore'
import { afterAll, beforeAll, describe, it } from 'vitest'

const ADMIN_UID = 'admin-uid'
const STAFF_UID = 'staff-uid'

let testEnv: RulesTestEnvironment

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'ordering-system-admin-pins-rules-test',
    firestore: { rules: readFileSync(resolve(process.cwd(), 'firestore.rules'), 'utf8') },
  })
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore()
    for (const [uid, role] of [
      [ADMIN_UID, 'admin'],
      [STAFF_UID, 'staff'],
    ] as const) {
      await setDoc(doc(db, 'users', uid), {
        uid,
        email: `${uid}@example.test`,
        displayName: uid,
        role,
        active: true,
        createdAt: new Date(),
      })
    }
    // What the functions store: a hash, never the PIN.
    await setDoc(doc(db, 'adminPins', ADMIN_UID), {
      algorithm: 'scrypt',
      hash: 'aGFzaA==',
      salt: 'c2FsdA==',
      params: { N: 32768, r: 8, p: 1, keyLength: 32 },
    })
    await setDoc(doc(db, 'pinAttempts', STAFF_UID), {
      failures: 0,
      windowStart: null,
      lockedUntil: Date.now() + 15 * 60_000,
    })
    await setDoc(doc(db, 'pinAttempts', '_global'), { count: 3, windowStart: Date.now() })
    await setDoc(doc(db, 'pinSetupAttempts', ADMIN_UID), { count: 1, windowStart: Date.now() })
  })
})

afterAll(async () => {
  await testEnv.cleanup()
})

const PATHS = [
  ['adminPins', ADMIN_UID],
  ['pinAttempts', STAFF_UID],
  ['pinAttempts', '_global'],
  ['pinSetupAttempts', ADMIN_UID],
] as const

const asStaff = () => testEnv.authenticatedContext(STAFF_UID).firestore()
const asAdmin = () => testEnv.authenticatedContext(ADMIN_UID).firestore()
const asAnyone = () => testEnv.unauthenticatedContext().firestore()

describe('admin PIN data cannot be read by any client', () => {
  for (const [who, client] of [
    ['staff', asStaff],
    ['an admin', asAdmin],
    ['a signed-out visitor', asAnyone],
  ] as const) {
    it(`refuses ${who} reading any PIN document or listing the collections`, async () => {
      const db = client()
      for (const [path, id] of PATHS) {
        await assertFails(getDoc(doc(db, path, id)))
        await assertFails(getDocs(collection(db, path)))
      }
    })
  }

  it('refuses an admin reading even their OWN stored PIN', async () => {
    await assertFails(getDoc(doc(asAdmin(), 'adminPins', ADMIN_UID)))
  })
})

describe('admin PIN data cannot be written by any client', () => {
  it('refuses staff setting a PIN — theirs or an admin’s', async () => {
    const db = asStaff()
    await assertFails(setDoc(doc(db, 'adminPins', STAFF_UID), { hash: 'x' }))
    await assertFails(setDoc(doc(db, 'adminPins', ADMIN_UID), { hash: 'x' }))
  })

  it('refuses an admin writing their PIN directly, around setAdminPin', async () => {
    await assertFails(setDoc(doc(asAdmin(), 'adminPins', ADMIN_UID), { hash: 'x' }))
  })

  it('refuses staff clearing their own lockout or resetting the counters', async () => {
    const db = asStaff()
    await assertFails(
      setDoc(doc(db, 'pinAttempts', STAFF_UID), {
        failures: 0,
        windowStart: null,
        lockedUntil: null,
      }),
    )
    await assertFails(deleteDoc(doc(db, 'pinAttempts', STAFF_UID)))
    await assertFails(setDoc(doc(db, 'pinAttempts', '_global'), { count: 0, windowStart: null }))
  })

  it('refuses deleting any PIN document, for every role', async () => {
    for (const client of [asStaff, asAdmin, asAnyone]) {
      for (const [path, id] of PATHS) await assertFails(deleteDoc(doc(client(), path, id)))
    }
  })
})
