/**
 * The order this device sent and never heard back about.
 *
 * A failure at the till can mean the order was placed and only the reply was lost. Sending the
 * same request id again is safe, because `placeOrder` answers with the order it already made, so
 * the id has to outlive the page: reload after an uncertain response, ring the same order up
 * again, and it reaches the server under the same id instead of becoming a second sale.
 *
 * **Only enough to recognise the order, never the order.** What is stored is the request id, a
 * hash and the time. Nothing here can rebuild a cart, so the till still starts empty after a
 * reload, and no price, name, table or operator is left on the device.
 *
 * Kept per account, as a staff selection is (see staff-session.ts), because `placeOrder` binds a
 * request id to the caller: an id is meaningless under another account, and one account's
 * unanswered order must not be disturbed by the next person signing in.
 *
 * **Several attempts can be open at once, and each is its own.** Two tabs on one account share
 * this storage, so it holds a list, and confirming an order removes that request and nothing else.
 * Nothing about one tab's attempt can be cleared or replaced by another's.
 *
 * **An identical order is a retry only if nobody is still sending it.** While a call is out its
 * attempt is marked as sending. A second tab ringing up the same thing at that moment is a second
 * sale, so it takes a new id. Once the call ends without an answer, or the page that made it
 * reloads or closes, the attempt is open to whoever rings that order up next, which is the recovery
 * this file exists for. The mark has a time limit, so a page that crashed cannot hold it for good.
 *
 * Storage is the only record unless writing to it fails. If it is blocked, this falls back to
 * memory: a retry on the same page stays safe, and only the reload protection is lost.
 */

/** Per account: the uid follows it. */
export const PENDING_ORDER_STORAGE_KEY = 'ordering-system.pos.pendingOrder'

/**
 * How long an unanswered order is still the same order.
 *
 * Long enough to outlast a reload and a dropped connection. It ends so that a genuinely new sale
 * of the same thing at the same table, later in the day, is not taken for a retry. Counted from
 * the last attempt, so a till that keeps trying through an outage stays covered.
 */
export const PENDING_ORDER_TTL_MS = 30 * 60_000

/**
 * How long a call can be out, and a little more. The Firebase client gives up on a callable after
 * 70 seconds, so past this nobody is waiting for the answer, even if the page never said so.
 */
export const PENDING_ORDER_SEND_LIMIT_MS = 75_000

interface PendingOrder {
  requestId: string
  fingerprint: string
  savedAt: number
  /** Present while a call is out: when to stop believing it is. */
  sendingUntil?: number
}

/** The parts of a request that decide whether two submissions are the same order. */
export interface Submission {
  lines: readonly {
    menuItemId: string
    quantity: number
    selections: readonly { groupId: string; optionId: string }[]
    expected: {
      name: string
      basePrice: number
      unitPrice: number
      adjustments: readonly number[]
      groupNames: readonly string[]
      optionNames: readonly string[]
    }
  }[]
  orderType: string
  tableNumber: string | null
  operatorId: string
  language: string
  expectedTotal: number
}

/** Mirrors canonicalLine in functions/src/order.ts. */
function canonicalLine({
  menuItemId,
  quantity,
  selections,
  expected,
}: Submission['lines'][number]) {
  const choices = selections
    .map(({ groupId, optionId }, index) =>
      JSON.stringify([
        groupId,
        optionId,
        expected.adjustments[index],
        expected.groupNames[index],
        expected.optionNames[index],
      ]),
    )
    .sort()
  return JSON.stringify([
    menuItemId,
    quantity,
    expected.name,
    expected.basePrice,
    expected.unitPrice,
    choices,
  ])
}

/**
 * A hash of the submission, the same whichever order it was tapped in: someone rebuilding an order
 * after a reload will not always add the items in the same sequence. The server's own fingerprint
 * sorts the same way, or it would refuse the rebuilt order as a reused id.
 */
export async function fingerprintOf(submission: Submission): Promise<string> {
  const { lines, orderType, tableNumber, operatorId, language, expectedTotal } = submission
  const canonical = JSON.stringify([
    lines.map(canonicalLine).sort(),
    orderType,
    tableNumber,
    operatorId,
    language,
    expectedTotal,
  ])
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Only ever holds an account whose storage could not be written. */
const inMemory = new Map<string, PendingOrder[]>()

/** The calls this page has out, and whose they are. Lost with the page, as they should be. */
const sendingHere = new Map<string, string>()

const keyFor = (uid: string) => `${PENDING_ORDER_STORAGE_KEY}.${uid}`

function parseEntry(value: unknown): PendingOrder | null {
  if (typeof value !== 'object' || value === null) return null

  const { requestId, fingerprint, savedAt, sendingUntil } = value as Partial<PendingOrder>
  if (typeof requestId !== 'string' || typeof fingerprint !== 'string') return null
  if (typeof savedAt !== 'number') return null
  return typeof sendingUntil === 'number'
    ? { requestId, fingerprint, savedAt, sendingUntil }
    : { requestId, fingerprint, savedAt }
}

function parseEntries(raw: string | null): PendingOrder[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((value) => parseEntry(value) ?? [])
}

function readEntries(uid: string): PendingOrder[] {
  const held = inMemory.get(uid)
  if (held) return held
  try {
    return parseEntries(localStorage.getItem(keyFor(uid)))
  } catch {
    return []
  }
}

function writeEntries(uid: string, entries: PendingOrder[]) {
  try {
    if (entries.length === 0) localStorage.removeItem(keyFor(uid))
    else localStorage.setItem(keyFor(uid), JSON.stringify(entries))
    inMemory.delete(uid)
  } catch {
    // Blocked or full. Memory still covers a retry from this page.
    inMemory.set(uid, entries)
  }
}

let watchingForLeave = false

/** A page going away takes its calls with it, so a reload can pick up what it left. */
function watchForLeave() {
  if (watchingForLeave || typeof window === 'undefined') return
  watchingForLeave = true
  window.addEventListener('pagehide', () => {
    for (const [requestId, uid] of [...sendingHere]) releaseRequest(uid, requestId)
  })
}

/**
 * The id to send this submission under: an open attempt at the same order if there is one,
 * otherwise a new one. Saved before the call goes out, because a reload can come at any moment
 * after it.
 *
 * An attempt another page is still sending does not count, because that page has not lost anything:
 * this is a second sale of the same thing. This page's own does count, as one order stays one
 * order however often the same page sends it.
 */
export function requestIdFor(uid: string, fingerprint: string, now = Date.now()): string {
  watchForLeave()
  const open = readEntries(uid).filter((entry) => now - entry.savedAt < PENDING_ORDER_TTL_MS)
  const attempt = open.find(
    (entry) =>
      entry.fingerprint === fingerprint &&
      (sendingHere.has(entry.requestId) || now >= (entry.sendingUntil ?? 0)),
  )
  const requestId = attempt?.requestId ?? crypto.randomUUID()

  writeEntries(uid, [
    ...open.filter((entry) => entry.requestId !== requestId),
    { requestId, fingerprint, savedAt: now, sendingUntil: now + PENDING_ORDER_SEND_LIMIT_MS },
  ])
  sendingHere.set(requestId, uid)
  return requestId
}

/**
 * The call ended without a confirmation, or the page is going. The order may or may not exist, so
 * the attempt stays open for whoever rings it up next, under the same id.
 *
 * A refusal lands here too. It wrote nothing, so keeping the id through one is harmless: the server
 * judges the same id afresh.
 */
export function releaseRequest(uid: string, requestId: string) {
  sendingHere.delete(requestId)
  const entries = readEntries(uid)
  if (!entries.some((entry) => entry.requestId === requestId)) return
  writeEntries(
    uid,
    entries.map((entry) => {
      if (entry.requestId !== requestId) return entry
      const { sendingUntil: _finished, ...open } = entry
      return open
    }),
  )
}

/**
 * The server has confirmed the order, so the next one is a new sale.
 *
 * Called on success alone, and for this request alone: any other attempt on the account, from this
 * tab or another, is still unanswered and stays exactly as it was.
 */
export function forgetRequest(uid: string, requestId: string) {
  sendingHere.delete(requestId)
  const entries = readEntries(uid)
  const remaining = entries.filter((entry) => entry.requestId !== requestId)
  if (remaining.length !== entries.length) writeEntries(uid, remaining)
}
