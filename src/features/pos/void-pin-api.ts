import { message, MessageError, type Message } from '@/features/i18n/messages'
import type { TranslationKey } from '@/features/i18n/translations/en'
import { FirebaseError } from 'firebase/app'
import { httpsCallable } from 'firebase/functions'

import { ADMIN_PIN_LENGTH } from '@/features/pos/voids'
import { appFunctions } from '@/lib/functions'
import { perfOutcome, perfStart } from '@/lib/perf'

/**
 * The app's side of the Admin PIN — three calls to the Cloud Functions in functions/.
 *
 * Nothing about a PIN is decided here. The PIN travels once, to the server, which hashes or
 * compares it and answers yes or no; no hash ever comes back. What this file does is turn the
 * server's refusal codes (`details.reason`) into sentences the counter can act on, the same
 * job payment-api.ts does for a rules refusal.
 */

export interface AdminPinStatus {
  /** At least one active administrator has set a PIN, so the void dialog can ask for one. */
  pinAvailable: boolean
  /** Only for an admin caller: whether they have set their own PIN, and when. */
  self?: { configured: boolean; updatedAt: string | null }
}

export async function fetchAdminPinStatus(): Promise<AdminPinStatus> {
  const call = httpsCallable<void, AdminPinStatus>(appFunctions(), 'getAdminPinStatus')
  // Timed when src/lib/perf.ts is switched on; the answer and any failure pass through as before.
  const answered = perfStart('void.pinStatus')
  try {
    const { data } = await call()
    answered?.({ outcome: 'ok' })
    return data
  } catch (caught) {
    answered?.({ outcome: perfOutcome(caught) })
    throw caught
  }
}

export interface VoidWithPinParams {
  reason: string
  pin: string
  /**
   * The roster id of the operator at the till, if one is selected. An id only: the server
   * looks the person up, requires them to be active, and records the name it finds. The
   * requesting account itself comes from the signed-in token, never from here.
   */
  operatorId: string | null
}

const VOID_REFUSALS: Record<string, TranslationKey> = {
  'incorrect-pin': 'void.pinIncorrect',
  'no-pin': 'void.pinNotConfigured',
  'pin-conflict': 'void.pinConflict',
  'already-voided': 'void.alreadyVoided',
  'invalid-operator': 'void.operatorUnavailable',
  'not-allowed': 'void.pinNotAllowed',
}

/** Voids an order with an administrator's PIN. Writes nothing itself — the server does. */
export async function voidOrderWithAdminPin(
  orderId: string,
  { reason, pin, operatorId }: VoidWithPinParams,
): Promise<void> {
  const call = httpsCallable(appFunctions(), 'voidOrderWithAdminPin')
  const called = perfStart('void.call')
  try {
    await call({ orderId, reason, pin, operatorId })
    called?.({ outcome: 'ok' })
  } catch (caught) {
    called?.({ outcome: perfOutcome(caught) })
    throw new MessageError(refusalMessage(caught, VOID_REFUSALS, message('order.voidFailed')))
  }
}

const SETUP_REFUSALS: Record<string, TranslationKey> = {
  'stale-sign-in': 'settings.pinStaleSignIn',
  'rate-limited': 'settings.pinRateLimited',
  'pin-unavailable': 'settings.pinUnavailable',
  'not-allowed': 'settings.pinNotAllowed',
}

/** Sets or changes the signed-in admin's own PIN. The caller re-authenticates first. */
export async function setAdminPin(pin: string): Promise<void> {
  const call = httpsCallable(appFunctions(), 'setAdminPin')
  try {
    await call({ pin })
  } catch (caught) {
    throw new MessageError(
      refusalMessage(caught, SETUP_REFUSALS, message('settings.pinSaveFailed')),
    )
  }
}

/** The server's refusal as a sentence; anything it did not explain becomes `fallback`. */
function refusalMessage(
  caught: unknown,
  known: Record<string, TranslationKey>,
  fallback: Message,
): Message {
  if (!(caught instanceof FirebaseError)) return fallback
  const details = (caught as FirebaseError & { details?: unknown }).details
  const reason =
    typeof details === 'object' && details !== null
      ? (details as { reason?: unknown }).reason
      : null

  // Shared by both calls: a lockout says how long, a malformed PIN says what is expected.
  if (reason === 'locked') {
    const minutes = (details as { retryAfterMinutes?: unknown }).retryAfterMinutes
    return message('void.pinLocked', { minutes: typeof minutes === 'number' ? minutes : 15 })
  }
  if (reason === 'invalid-pin') return message('validation.pinFormat', { length: ADMIN_PIN_LENGTH })

  const key = typeof reason === 'string' ? known[reason] : undefined
  return key ? message(key) : fallback
}
