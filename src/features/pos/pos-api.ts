import type { Language } from '@/features/i18n/languages'
import { message, MessageError, type Message } from '@/features/i18n/messages'
import { FirebaseError } from 'firebase/app'
import { httpsCallable } from 'firebase/functions'

import {
  cartTotal,
  StaleCartError,
  validateCart,
  type Cart,
  type CurrentLine,
} from '@/features/pos/cart'
import { validatePlacement, type OrderType } from '@/features/pos/order-type'
import {
  fingerprintOf,
  forgetRequest,
  releaseRequest,
  requestIdFor,
} from '@/features/pos/pending-order'
import { appFunctions } from '@/lib/functions'
import { formatMoney } from '@/lib/money'
import { perfOutcome, perfStart } from '@/lib/perf'

export interface CreateOrderParams {
  cart: Cart
  /**
   * How the order is served, raw as the till holds it. Validated here rather than trusted,
   * so `createOrder` stays the single place an order's shape is decided.
   *
   * `tableNumber` is the text typed into the field; it is ignored entirely for a takeaway.
   */
  placement: { orderType: OrderType; tableNumber: string }
  /**
   * The staff identity operating the till. Separate from the signed-in account on purpose: one
   * shared login serves the whole shift, so the account cannot say who rang the sale up. Only
   * the id is sent; the server looks the person up.
   */
  staff: { id: string; name: string }
  /** The till's language, which is the language an order records its names in. */
  language: Language
  /**
   * The signed-in account, which an unanswered attempt is remembered under on this device. Never
   * sent: the server takes the caller from the verified token.
   */
  uid: string
}

export interface CreatedOrder {
  id: string
  number: number
}

/**
 * Records a sale. **Creates it unpaid**, and taking the money is a separate step: see
 * payment-api.ts.
 *
 * This says what was chosen, and `placeOrder` in functions/ reads the prices and names from the
 * menu, works out the total and writes the order and its number in one transaction. The cart's
 * prices, names and total go with it only so a stale cart can be refused rather than recorded with
 * a figure or a word nobody was shown: nothing the order records comes from them.
 *
 * A failure may mean the order was placed and the reply was lost, so trying the same order again
 * reuses its request id, and the server answers with the order it already made rather than
 * ringing it up twice. See pending-order.ts, which is what carries that across a reload.
 *
 * Throughput note: every sale on a given day touches a single counter document, which
 * Firestore sustains at roughly one write per second. That is far above a café counter's
 * rate, but it is the ceiling of this design.
 */
export async function createOrder({
  cart,
  placement,
  staff,
  language,
  uid,
}: CreateOrderParams): Promise<CreatedOrder> {
  // Timed when src/lib/perf.ts is switched on: the till's own work, then the call.
  const prepared = perfStart('order.prepare')
  const validation = validateCart(cart)
  if (!validation.ok) throw new MessageError(validation.error)

  // A dine-in order without a usable table number never leaves the till. The server checks it
  // again, independently — this is the message the counter sees, not the enforcement.
  const service = validatePlacement(placement.orderType, placement.tableNumber)
  if (!service.ok) throw new MessageError(service.error)

  const request = {
    lines: cart.map((line) => ({
      menuItemId: line.menuItemId,
      quantity: line.quantity,
      selections: line.modifiers.map(({ groupId, optionId }) => ({ groupId, optionId })),
      expected: {
        name: line.name,
        basePrice: line.basePrice,
        unitPrice: line.unitPrice,
        adjustments: line.modifiers.map((modifier) => modifier.priceAdjustment),
        groupNames: line.modifiers.map((modifier) => modifier.groupName),
        optionNames: line.modifiers.map((modifier) => modifier.optionName),
      },
    })),
    orderType: service.orderType,
    tableNumber: service.tableNumber,
    operatorId: staff.id,
    language,
    expectedTotal: cartTotal(cart),
  }

  const requestId = requestIdFor(uid, await fingerprintOf(request))
  prepared?.()

  const placeOrder = httpsCallable<unknown, CreatedOrder>(appFunctions(), 'placeOrder')
  const called = perfStart('order.call')
  try {
    const { data } = await placeOrder({ ...request, requestId })
    called?.({ outcome: 'ok' })
    forgetRequest(uid, requestId)
    return { id: data.id, number: data.number }
  } catch (caught) {
    called?.({ outcome: perfOutcome(caught) })
    releaseRequest(uid, requestId)
    throw refusalOf(caught, cart)
  }
}

/** The server's refusal as something the till can say; anything else stays a plain failure. */
function refusalOf(caught: unknown, cart: Cart): unknown {
  if (!(caught instanceof FirebaseError)) return caught
  const details = (caught as FirebaseError & { details?: unknown }).details
  if (typeof details !== 'object' || details === null) return caught
  const { reason, group, menuItemId, total, lines } = details as Record<string, unknown>

  if ((reason === 'price-changed' || reason === 'names-changed') && typeof total === 'number') {
    return new StaleCartError(
      reason === 'price-changed'
        ? message('terminal.pricesChanged', { total: formatMoney(total) })
        : message('terminal.namesChanged'),
      Array.isArray(lines) ? (lines as CurrentLine[]) : [],
    )
  }

  const said = sentenceFor(reason, group, menuItemId, cart)
  return said ? new MessageError(said) : caught
}

function sentenceFor(
  reason: unknown,
  group: unknown,
  menuItemId: unknown,
  cart: Cart,
): Message | null {
  const groupName = typeof group === 'string' ? group : ''
  switch (reason) {
    case 'item-unavailable': {
      const line = cart.find((candidate) => candidate.menuItemId === menuItemId)
      return message('terminal.itemUnavailable', { name: line?.name ?? '' })
    }
    case 'selection-required':
      return message('validation.chooseGroup', { group: groupName })
    case 'single-choice':
      return message('validation.chooseOnlyOne', { group: groupName })
    case 'option-withdrawn':
      return message('validation.optionWithdrawn', { group: groupName })
    case 'option-unknown':
      return message('validation.optionUnknown')
    case 'order-too-large':
      return message('terminal.orderTooLarge')
    default:
      return null
  }
}
