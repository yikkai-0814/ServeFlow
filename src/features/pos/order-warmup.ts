import { httpsCallable } from 'firebase/functions'

import { auth } from '@/lib/firebase'
import { appFunctions } from '@/lib/functions'
import { perfOutcome, perfStart } from '@/lib/perf'

/**
 * Gets `placeOrder` ready shortly before the till is likely to use it.
 *
 * After a quiet spell the function has no running instance, and the first order paid for starting
 * one and for opening its first Firestore connection — measured at several seconds, against well
 * under one once it is running. `{ warmup: true }` makes the function do exactly the first step of
 * an order, checking the caller's profile, and then stop: it writes nothing and places nothing
 * (see isWarmupRequest in functions/src/order.ts).
 *
 * **Never in an order's way.** Nothing waits for this, nothing it does is shown, and every failure
 * is swallowed: `createOrder` does not know it exists. It is a hint to the platform, and Cloud Run
 * may still serve the order from a different instance.
 *
 * **Sent only when it can help, and rarely.**
 *  - Only for the account Firebase Auth is actually signed in as: if the session has changed or
 *    gone, nothing is sent.
 *  - At most one at a time.
 *  - Not again within five minutes of one that succeeded; a failed one may be retried at the next
 *    trigger.
 *  - Not while the browser says it is offline, or while the page is hidden.
 *
 * Triggered by the till itself, on things a person does (TerminalPage) — never on a timer.
 */

export const ORDER_WARMUP_INTERVAL_MS = 5 * 60_000

/** Well past a cold start (about five seconds measured), so a slow one still counts. */
export const ORDER_WARMUP_TIMEOUT_MS = 10_000

let lastSucceededAt: number | null = null
let inFlight = false

/** Forgets any warm-up, so each test starts from a cold till. */
export function resetOrderWarmup(): void {
  lastSucceededAt = null
  inFlight = false
}

/**
 * Sends a warm-up for the signed-in account `uid`, if one is due. Returns at once and never throws.
 */
export function warmUpOrders(uid: string, now = Date.now()): void {
  try {
    if (inFlight) return
    if (lastSucceededAt !== null && now - lastSucceededAt < ORDER_WARMUP_INTERVAL_MS) return
    if (!uid || auth.currentUser?.uid !== uid) return
    if (globalThis.navigator?.onLine === false) return
    if (globalThis.document?.visibilityState === 'hidden') return

    inFlight = true
    const answered = perfStart('order.warmup')
    const warm = httpsCallable(appFunctions(), 'placeOrder', { timeout: ORDER_WARMUP_TIMEOUT_MS })
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
    // Whatever went wrong, the till carries on exactly as it would have without this.
    inFlight = false
  }
}
