import { httpsCallable } from 'firebase/functions'

import { auth } from '@/lib/firebase'
import { appFunctions } from '@/lib/functions'
import { perfOutcome, perfStart } from '@/lib/perf'

/**
 * Gets `voidOrderWithAdminPin` ready before a staff member presses Void Sale.
 *
 * Opening an order already calls `getAdminPinStatus`, but that is a different function with its
 * own instances, so it warms nothing a void uses. After a quiet spell the void itself then paid for
 * starting an instance and opening its first Firestore connection — measured at 4.64 s, against
 * 0.49 s once running. `{ warmup: true }` makes the void function do exactly its first step,
 * checking the caller's profile, and then stop: no PIN is validated or compared, no attempt is
 * spent, reset or read, no order is read and no void is written (see voidOrderWithAdminPin in
 * functions/src/index.ts).
 *
 * The same rules as the order warm-up (order-warmup.ts), with state of its own, because it warms a
 * different function:
 *  - only for the account Firebase Auth is actually signed in as;
 *  - at most one at a time;
 *  - not again within five minutes of one that succeeded; a failed one may be retried at the next
 *    trigger;
 *  - not while the browser says it is offline, or while the page is hidden.
 *
 * **Never in a void's way.** Nothing waits for this, nothing it does is shown, every failure is
 * swallowed, and `voidOrderWithAdminPin` in void-pin-api.ts does not know it exists. It sends no
 * PIN, no reason and no order: only `{ warmup: true }`.
 *
 * Triggered by the order page on things a person does (OrderDetailPage) — never on a timer.
 */

export const VOID_WARMUP_INTERVAL_MS = 5 * 60_000

/** Well past a cold start (about five seconds measured), so a slow one still counts. */
export const VOID_WARMUP_TIMEOUT_MS = 10_000

let lastSucceededAt: number | null = null
let inFlight = false

/** Forgets any warm-up, so each test starts from a cold function. */
export function resetVoidWarmup(): void {
  lastSucceededAt = null
  inFlight = false
}

/**
 * Sends a void warm-up for the signed-in account `uid`, if one is due. Returns at once and never
 * throws.
 */
export function warmUpVoids(uid: string, now = Date.now()): void {
  try {
    if (inFlight) return
    if (lastSucceededAt !== null && now - lastSucceededAt < VOID_WARMUP_INTERVAL_MS) return
    if (!uid || auth.currentUser?.uid !== uid) return
    if (globalThis.navigator?.onLine === false) return
    if (globalThis.document?.visibilityState === 'hidden') return

    inFlight = true
    const answered = perfStart('void.warmup')
    const warm = httpsCallable(appFunctions(), 'voidOrderWithAdminPin', {
      timeout: VOID_WARMUP_TIMEOUT_MS,
    })
    warm({ warmup: true }).then(
      () => {
        lastSucceededAt = now
        inFlight = false
        answered?.({ outcome: 'ok' })
      },
      (caught: unknown) => {
        inFlight = false
        answered?.({ outcome: perfOutcome(caught) })
      },
    )
  } catch {
    // Whatever went wrong, the page carries on exactly as it would have without this.
    inFlight = false
  }
}
