/**
 * The two things the app cannot safely decide in a browser: who may void a sale, and what a sale
 * costs. Four callables:
 *
 *   getAdminPinStatus      — any active user: is PIN authorisation available, and (for an
 *                            admin) have they set one. Never returns a hash.
 *   setAdminPin            — an admin sets or changes their OWN PIN, after proving their
 *                            password moments ago.
 *   voidOrderWithAdminPin  — a staff member (or admin) voids an order with an admin's PIN.
 *   placeOrder             — any active user places an order. The till says what was chosen, and
 *                            the prices, names and total come from the menu (see order.ts).
 *
 * The PIN collections (`adminPins`, `pinAttempts`, `pinSetupAttempts`) and `orderRequests` are
 * refused to every client by firestore.rules; only the Admin SDK here touches them. Everything
 * else the app does is still decided by the rules. These are trusted writers for two documents,
 * `orderVoids/{orderId}` and `orders/{orderId}`, and each restates what the rules put on it.
 */

import { initializeApp } from 'firebase-admin/app'
import {
  FieldValue,
  getFirestore,
  type DocumentSnapshot,
  type Transaction,
} from 'firebase-admin/firestore'
import { logger } from 'firebase-functions'
import { setGlobalOptions } from 'firebase-functions/v2'
import {
  HttpsError,
  onCall,
  type CallableRequest,
  type FunctionsErrorCode,
} from 'firebase-functions/v2/https'

import {
  businessDateAt,
  isReadableId,
  MAX_ORDER_BYTES,
  namesMatch,
  parseCatalogueGroup,
  parseCatalogueItem,
  parsePlaceOrderRequest,
  priceOrder,
  pricesMatch,
  requestFingerprint,
  requestRecordId,
  storedBytes,
  type Catalogue,
  type CatalogueGroup,
  type CatalogueItem,
  type RequestedLine,
} from './order'
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
  | 'item-unavailable'
  | 'selection-required'
  | 'single-choice'
  | 'option-withdrawn'
  | 'option-unknown'
  | 'price-changed'
  | 'names-changed'
  | 'request-reused'
  | 'order-too-large'

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

// ---- placeOrder -----------------------------------------------------------------------------

/** Firestore's ceiling on the values in an `in` filter. */
const IN_FILTER_LIMIT = 30

/**
 * Everything on the menu this order touches, read inside its transaction so the prices it is
 * charged at are the prices at the moment it was written.
 */
async function readCatalogue(
  transaction: Transaction,
  lines: readonly RequestedLine[],
): Promise<Catalogue> {
  const itemIds = [...new Set(lines.map((line) => line.menuItemId))]
  const itemDocs = await transaction.getAll(...itemIds.map((id) => db.doc(`menuItems/${id}`)))

  const items = new Map<string, CatalogueItem>()
  for (const document of itemDocs) {
    const item = parseCatalogueItem(document.id, document.data())
    if (item) items.set(item.id, item)
  }

  const activeCategoryIds = new Set<string>()
  // Ids the menu stored are filtered like ids a client sent: one Firestore cannot read would
  // otherwise fail the whole order as an internal error, not as an item that cannot be sold.
  const categoryIds = [...new Set([...items.values()].map((item) => item.categoryId))].filter(
    isReadableId,
  )
  if (categoryIds.length > 0) {
    const categories = await transaction.getAll(
      ...categoryIds.map((id) => db.doc(`categories/${id}`)),
    )
    for (const category of categories) {
      // Mirrors parseCategory: a category only counts if the till could have shown it.
      const name = category.get('name')
      if (category.get('active') === true && typeof name === 'string' && name.trim() !== '') {
        activeCategoryIds.add(category.id)
      }
    }
  }

  // Two sources, as groupsForItem in the app has: what each item lists, and legacy groups that
  // name the item themselves.
  const groups = new Map<string, CatalogueGroup>()
  const keep = (document: DocumentSnapshot) => {
    const group = parseCatalogueGroup(document.id, document.data())
    if (group) groups.set(group.id, group)
  }

  const attached = [
    ...new Set([...items.values()].flatMap((item) => item.modifierGroupIds)),
  ].filter(isReadableId)
  if (attached.length > 0) {
    const documents = await transaction.getAll(
      ...attached.map((id) => db.doc(`modifierGroups/${id}`)),
    )
    documents.forEach(keep)
  }

  const known = [...items.keys()]
  for (let start = 0; start < known.length; start += IN_FILTER_LIMIT) {
    const owned = await transaction.get(
      db
        .collection('modifierGroups')
        .where('itemId', 'in', known.slice(start, start + IN_FILTER_LIMIT)),
    )
    owned.docs.forEach(keep)
  }

  return { items, activeCategoryIds, groups: [...groups.values()] }
}

/**
 * Places an order. The till says what was chosen; everything with a price or a name on it comes
 * from the menu, read here. What the till says it is showing is compared with that, never stored.
 *
 * `requestId` is what makes a retry safe. A till that never heard back sends the same id, and
 * this answers with the order already made rather than ringing it up twice. The record is keyed
 * by the caller as well as the id, so the same id from another account is simply another request
 * and can never return somebody else's order. It is written in the same transaction as the order,
 * so two simultaneous retries contend, and the loser finds the record the winner left.
 *
 * Nothing is remembered about a refusal. A refused order wrote nothing, so the same request may
 * be judged afresh.
 *
 * The order is exactly the document createOrder used to write from the till. Every read comes
 * before the first write, as a Firestore transaction requires.
 */
export const placeOrder = onCall(async (request) => {
  const caller = await requireActiveCaller(request)
  const order = parsePlaceOrderRequest(request.data)
  if (!order) refuse('invalid-argument', 'invalid-request')

  const requestRef = db.doc(`orderRequests/${requestRecordId(caller.uid, order.requestId)}`)
  const fingerprint = requestFingerprint(order)
  const { operatorId } = order

  const placed = await db.runTransaction(
    async (transaction) => {
      const businessDate = businessDateAt(new Date())
      const counterRef = db.doc(`counters/${businessDate}`)
      const callerRef = db.doc(`users/${caller.uid}`)
      const operatorRef = operatorId !== null ? db.doc(`staffMembers/${operatorId}`) : null

      const [existing, counter, callerProfile, operator] = await transaction.getAll(
        requestRef,
        counterRef,
        callerRef,
        ...(operatorRef ? [operatorRef] : []),
      )

      if (existing?.exists) {
        if (existing.get('uid') !== caller.uid || existing.get('fingerprint') !== fingerprint) {
          refuse('already-exists', 'request-reused')
        }
        return { id: existing.get('orderId') as string, number: existing.get('number') as number }
      }

      // Re-read here, so a deactivation that lands during this call still stops the sale.
      const displayName = callerProfile?.get('displayName')
      if (
        callerProfile?.get('active') !== true ||
        typeof displayName !== 'string' ||
        displayName.trim() === ''
      ) {
        refuse('permission-denied', 'not-allowed')
      }

      // Who rang it up, decided the same way a PIN void decides who asked for it.
      const initiator = resolveInitiator(
        caller.uid,
        {
          exists: callerProfile.exists,
          active: callerProfile.get('active'),
          name: displayName,
        },
        operatorId,
        operator
          ? { exists: operator.exists, active: operator.get('active'), name: operator.get('name') }
          : null,
      )
      if (!initiator) refuse('failed-precondition', 'invalid-operator')

      const catalogue = await readCatalogue(transaction, order.lines)
      const priced = priceOrder(order.lines, order.language, catalogue)
      if (!priced.ok) {
        const { ok: _ok, reason, ...details } = priced
        refuse(
          reason === 'invalid-request' ? 'invalid-argument' : 'failed-precondition',
          reason,
          details,
        )
      }

      // The till showed something else. Nothing is written: somebody has to see what is current
      // first, so it goes back for the cart to show. Both price checks, because a total can agree
      // while the lines under it do not. A price outranks a name, since it is the one that costs
      // the customer something, and either way the cart takes on both.
      const current = {
        total: priced.total,
        lines: priced.lines.map((line) => ({
          name: line.name,
          basePrice: line.basePrice,
          unitPrice: line.unitPrice,
          adjustments: line.modifiers.map((modifier) => modifier.priceAdjustment),
          groupNames: line.modifiers.map((modifier) => modifier.groupName),
          optionNames: line.modifiers.map((modifier) => modifier.optionName),
        })),
      }
      if (priced.total !== order.expectedTotal || !pricesMatch(order.lines, priced.lines)) {
        refuse('failed-precondition', 'price-changed', current)
      }
      if (!namesMatch(order.lines, priced.lines)) {
        refuse('failed-precondition', 'names-changed', current)
      }

      const lastNumber: unknown = counter?.get('lastNumber')
      const number = (typeof lastNumber === 'number' ? lastNumber : 0) + 1
      const orderRef = db.collection('orders').doc()
      const record = {
        number,
        businessDate,
        lines: priced.lines,
        total: priced.total,
        orderType: order.orderType,
        // Absent rather than null on a takeaway, which is what every reader and the rules expect.
        ...(order.tableNumber !== null ? { tableNumber: order.tableNumber } : {}),
        createdBy: caller.uid,
        createdByName: displayName,
        staffId: initiator.staffId,
        staffName: initiator.staffName,
      }

      // Firestore would refuse this at commit, and the till could only call that a failure. The
      // same is true of everything above: a refusal here has written nothing and spent no number.
      if (storedBytes(record) > MAX_ORDER_BYTES) refuse('failed-precondition', 'order-too-large')

      transaction.set(counterRef, { lastNumber: number })
      transaction.create(orderRef, { ...record, createdAt: FieldValue.serverTimestamp() })
      transaction.create(requestRef, {
        uid: caller.uid,
        fingerprint,
        orderId: orderRef.id,
        number,
        createdAt: FieldValue.serverTimestamp(),
      })

      return { id: orderRef.id, number }
    },
    // Every sale on a day shares one counter, so simultaneous tills retry against each other.
    { maxAttempts: 10 },
  )

  logger.info('Order placed', { orderId: placed.id, number: placed.number, uid: caller.uid })
  return placed
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
