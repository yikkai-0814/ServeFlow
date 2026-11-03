/**
 * Admin PIN authorisation for voiding a sale.
 *
 * Three callables, and the only code that can read or write the PIN data:
 *
 *   getAdminPinStatus      — any active user: is PIN authorisation available, and (for an
 *                            admin) have they set one. Never returns a hash.
 *   setAdminPin            — an admin sets or changes their OWN PIN, after proving their
 *                            password moments ago.
 *   voidOrderWithAdminPin  — a staff member (or admin) voids an order with an admin's PIN.
 *
 * The PIN collections (`adminPins`, `pinAttempts`, `pinSetupAttempts`) are refused to every
 * client by firestore.rules; only the Admin SDK here touches them. Everything else the app
 * does is still decided by the rules — this adds one trusted writer for one document,
 * `orderVoids/{orderId}`, and restates every condition the rules put on it (see void.ts).
 */

import { initializeApp } from 'firebase-admin/app'
import { FieldValue, getFirestore, type DocumentSnapshot } from 'firebase-admin/firestore'
import { logger } from 'firebase-functions'
import { setGlobalOptions } from 'firebase-functions/v2'
import {
  HttpsError,
  onCall,
  type CallableRequest,
  type FunctionsErrorCode,
} from 'firebase-functions/v2/https'

import {
  EMPTY_WINDOW,
  hashPin,
  isRecentSignIn,
  isValidPin,
  lockRemainingMs,
  NO_ATTEMPTS,
  parseStoredPin,
  recordGlobalFailure,
  recordSetupAttempt,
  spendAttempt,
  verifyPin,
  type AttemptState,
  type StoredPin,
  type WindowCount,
} from './pin'
import { isDocumentId, orderTotalOf, resolveInitiator, validateReason } from './void'

// Closest region to the café; also where the app calls them (src/lib/env.ts).
setGlobalOptions({ region: 'asia-southeast1', maxInstances: 10 })

initializeApp()
const db = getFirestore()

const GLOBAL_MONITOR = 'pinAttempts/_global'

/**
 * Why a call was refused. Sent as `details.reason` so the app can show its own translated
 * sentence; the English message is for logs only.
 */
type RefusalReason =
  | 'not-allowed'
  | 'invalid-pin'
  | 'invalid-request'
  | 'invalid-reason'
  | 'stale-sign-in'
  | 'rate-limited'
  | 'pin-unavailable'
  | 'no-pin'
  | 'incorrect-pin'
  | 'locked'
  | 'pin-conflict'
  | 'order-not-found'
  | 'already-voided'
  | 'invalid-operator'

function refuse(
  code: FunctionsErrorCode,
  reason: RefusalReason,
  extra: Record<string, unknown> = {},
): never {
  throw new HttpsError(code, reason, { reason, ...extra })
}

// ---- Who is calling --------------------------------------------------------------------------

interface Caller {
  uid: string
  role: 'admin' | 'staff'
  displayName: unknown
}

/**
 * The signed-in account, read from its own profile — never from anything the client sent.
 * Mirrors isActive() in firestore.rules: no profile, or an inactive one, is no one.
 */
async function requireActiveCaller(request: CallableRequest): Promise<Caller> {
  const uid = request.auth?.uid
  if (!uid) refuse('unauthenticated', 'not-allowed')

  const profile = await db.doc(`users/${uid}`).get()
  const role = profile.get('role')
  if (!profile.exists || profile.get('active') !== true || (role !== 'admin' && role !== 'staff')) {
    refuse('permission-denied', 'not-allowed')
  }
  return { uid, role, displayName: profile.get('displayName') }
}

interface PinAdmin {
  uid: string
  pin: StoredPin
}

/**
 * Every admin whose PIN can authorise right now: an active admin profile AND a stored PIN.
 * Deactivating an admin therefore withdraws their PIN at once, with nothing to clean up.
 */
async function activeAdminsWithPins(): Promise<PinAdmin[]> {
  const admins = await db
    .collection('users')
    .where('role', '==', 'admin')
    .where('active', '==', true)
    .get()
  if (admins.empty) return []

  const pins = await db.getAll(...admins.docs.map((admin) => db.doc(`adminPins/${admin.id}`)))
  return pins.flatMap((snapshot) => {
    const pin = parseStoredPin(snapshot.data())
    return pin ? [{ uid: snapshot.id, pin }] : []
  })
}

function readAttempts(snapshot: DocumentSnapshot): AttemptState {
  if (!snapshot.exists) return NO_ATTEMPTS
  const { failures, windowStart, lockedUntil } = snapshot.data() ?? {}
  return {
    failures: typeof failures === 'number' ? failures : 0,
    windowStart: typeof windowStart === 'number' ? windowStart : null,
    lockedUntil: typeof lockedUntil === 'number' ? lockedUntil : null,
  }
}

function readWindow(snapshot: DocumentSnapshot): WindowCount {
  if (!snapshot.exists) return EMPTY_WINDOW
  const { count, windowStart } = snapshot.data() ?? {}
  return {
    count: typeof count === 'number' ? count : 0,
    windowStart: typeof windowStart === 'number' ? windowStart : null,
  }
}

// ---- getAdminPinStatus ----------------------------------------------------------------------

export const getAdminPinStatus = onCall(async (request) => {
  const caller = await requireActiveCaller(request)
  const pinAvailable = (await activeAdminsWithPins()).length > 0

  if (caller.role !== 'admin') return { pinAvailable }

  const own = await db.doc(`adminPins/${caller.uid}`).get()
  const updatedAt = own.get('updatedAt')
  return {
    pinAvailable,
    self: {
      configured: own.exists,
      updatedAt:
        updatedAt && typeof updatedAt.toDate === 'function'
          ? updatedAt.toDate().toISOString()
          : null,
    },
  }
})

// ---- setAdminPin ----------------------------------------------------------------------------

export const setAdminPin = onCall(async (request) => {
  const caller = await requireActiveCaller(request)
  // Staff never set PINs — not their own, not anybody's. An admin sets only their own: the
  // document written is keyed by the verified uid, and nothing in the request names another.
  if (caller.role !== 'admin') refuse('permission-denied', 'not-allowed')

  const pin = (request.data as { pin?: unknown } | null)?.pin
  if (!isValidPin(pin)) refuse('invalid-argument', 'invalid-pin')

  // The app re-enters the password and refreshes the token immediately before this call. An
  // admin session left open on a shared device is therefore not enough to change the PIN.
  if (!isRecentSignIn(request.auth?.token.auth_time, Date.now())) {
    refuse('failed-precondition', 'stale-sign-in')
  }

  const allowed = await db.runTransaction(async (transaction) => {
    const ref = db.doc(`pinSetupAttempts/${caller.uid}`)
    const result = recordSetupAttempt(readWindow(await transaction.get(ref)), Date.now())
    transaction.set(ref, result.state)
    return result.allowed
  })
  if (!allowed) {
    logger.warn('Admin PIN setup rate limit reached', { uid: caller.uid })
    refuse('resource-exhausted', 'rate-limited')
  }

  // No two admins may share a PIN, or a void could not say which of them authorised it. Every
  // other stored PIN is checked — deactivated admins' too, so reactivating one cannot create a
  // clash. The refusal never says whose PIN it matched.
  const others = await db.collection('adminPins').get()
  for (const other of others.docs) {
    if (other.id === caller.uid) continue
    const stored = parseStoredPin(other.data())
    if (stored && (await verifyPin(pin, stored))) refuse('already-exists', 'pin-unavailable')
  }

  await db.doc(`adminPins/${caller.uid}`).set({
    ...(await hashPin(pin)),
    updatedAt: FieldValue.serverTimestamp(),
  })
  logger.info('Admin PIN set', { uid: caller.uid })
  return { ok: true }
})

// ---- voidOrderWithAdminPin ------------------------------------------------------------------

interface VoidRequest {
  orderId?: unknown
  reason?: unknown
  pin?: unknown
  operatorId?: unknown
}

export const voidOrderWithAdminPin = onCall(async (request) => {
  const caller = await requireActiveCaller(request)
  const data = (request.data ?? {}) as VoidRequest

  const { orderId, pin } = data
  if (!isDocumentId(orderId)) refuse('invalid-argument', 'invalid-request')
  const reason = validateReason(data.reason)
  if (reason === null) refuse('invalid-argument', 'invalid-reason')
  // Malformed input is refused before an attempt is spent: a typo of five digits is not a guess.
  if (!isValidPin(pin)) refuse('invalid-argument', 'invalid-pin')
  const operatorId =
    data.operatorId === undefined || data.operatorId === null ? null : data.operatorId
  if (operatorId !== null && !isDocumentId(operatorId))
    refuse('invalid-argument', 'invalid-operator')

  const admins = await activeAdminsWithPins()
  if (admins.length === 0) refuse('failed-precondition', 'no-pin')

  // Spend one attempt atomically BEFORE checking the PIN — see spendAttempt in pin.ts. A locked
  // account is refused here without the PIN being looked at at all.
  const attemptsRef = db.doc(`pinAttempts/${caller.uid}`)
  await db.runTransaction(async (transaction) => {
    const now = Date.now()
    const state = readAttempts(await transaction.get(attemptsRef))
    const remaining = lockRemainingMs(state, now)
    if (remaining > 0) {
      refuse('resource-exhausted', 'locked', { retryAfterMinutes: Math.ceil(remaining / 60_000) })
    }
    transaction.set(attemptsRef, spendAttempt(state, now))
  })

  const matches: PinAdmin[] = []
  for (const admin of admins) {
    if (await verifyPin(pin, admin.pin)) matches.push(admin)
  }

  if (matches.length === 0) {
    await recordFailure(caller.uid)
    const locked = lockRemainingMs(readAttempts(await attemptsRef.get()), Date.now())
    if (locked > 0) {
      logger.warn('Admin PIN attempts locked for account', { uid: caller.uid })
      refuse('resource-exhausted', 'locked', { retryAfterMinutes: Math.ceil(locked / 60_000) })
    }
    refuse('permission-denied', 'incorrect-pin')
  }

  // A correct PIN clears this account's count.
  await attemptsRef.set(NO_ATTEMPTS)

  if (matches.length > 1) {
    // Setup refuses duplicates, so this means a race or a data problem. Refuse rather than
    // guess which admin to record.
    logger.error('Admin PIN matched more than one admin', { admins: matches.map((m) => m.uid) })
    refuse('failed-precondition', 'pin-conflict')
  }
  const adminUid = matches[0]!.uid

  await db.runTransaction(async (transaction) => {
    const orderRef = db.doc(`orders/${orderId}`)
    const voidRef = db.doc(`orderVoids/${orderId}`)
    const adminRef = db.doc(`users/${adminUid}`)
    const callerRef = db.doc(`users/${caller.uid}`)
    const operatorRef = operatorId !== null ? db.doc(`staffMembers/${operatorId}`) : null

    // Everything re-read inside the transaction, so a deactivation that lands while the PIN
    // was being checked still stops the void.
    const [order, existing, admin, callerProfile, operator] = await transaction.getAll(
      orderRef,
      voidRef,
      adminRef,
      callerRef,
      ...(operatorRef ? [operatorRef] : []),
    )

    if (!order?.exists) refuse('not-found', 'order-not-found')
    // validVoid: a void is final and one per order — `allow update: if false`.
    if (existing?.exists) refuse('already-exists', 'already-voided')

    // validVoid: voidedBy must be an ACTIVE ADMIN and voidedByName their current profile name.
    const adminName = admin?.get('displayName')
    if (
      !admin?.exists ||
      admin.get('active') !== true ||
      admin.get('role') !== 'admin' ||
      typeof adminName !== 'string' ||
      adminName.trim() === ''
    ) {
      refuse('permission-denied', 'not-allowed')
    }

    const initiator = resolveInitiator(
      caller.uid,
      {
        exists: callerProfile?.exists ?? false,
        active: callerProfile?.get('active'),
        name: callerProfile?.get('displayName'),
      },
      operatorId,
      operator
        ? { exists: operator.exists, active: operator.get('active'), name: operator.get('name') }
        : null,
    )
    if (!initiator) refuse('failed-precondition', 'invalid-operator')

    // validVoid: `amount == get(orders/$(orderId)).data.total`.
    const amount = orderTotalOf(order.get('total'))
    if (amount === null) refuse('failed-precondition', 'order-not-found')

    // Exactly the fields voidOrder in src/features/pos/void-api.ts writes — the same record
    // whichever way a void was authorised.
    transaction.create(voidRef, {
      orderId,
      reason,
      amount,
      voidedAt: FieldValue.serverTimestamp(),
      voidedBy: adminUid,
      voidedByName: adminName,
      initiatedByStaffId: initiator.staffId,
      initiatedByStaffName: initiator.staffName,
    })
  })

  logger.info('Order voided with admin PIN', { orderId, admin: adminUid, requestedBy: caller.uid })
  return { ok: true }
})

/**
 * A wrong PIN. The account's attempt was already spent; this feeds the business-wide monitor,
 * which warns in the logs when guesses mount up across accounts but never locks anyone.
 */
async function recordFailure(uid: string): Promise<void> {
  const alert = await db.runTransaction(async (transaction) => {
    const ref = db.doc(GLOBAL_MONITOR)
    const result = recordGlobalFailure(readWindow(await transaction.get(ref)), Date.now())
    transaction.set(ref, result.state)
    return result.alert ? result.state : null
  })

  logger.info('Incorrect admin PIN', { uid })
  if (alert) {
    logger.warn('Admin PIN failures across all accounts above threshold', {
      uid,
      failuresInWindow: alert.count,
      windowStartedAt: alert.windowStart,
    })
  }
}
