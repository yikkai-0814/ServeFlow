/**
 * A menu item's selling price and cost, judged together.
 *
 * Pure — no React, no Firestore — the same split as item-names.ts and money.ts. The form calls
 * `validateItemPricing` on what was typed; the write API calls `checkItemPricing` on the whole
 * sen it was handed, so the two cannot disagree about what a sellable item is.
 *
 * **Why this is not in `parsePriceInput`.** That parser also serves modifier options, where 0 is
 * a real answer: "No vegetables" adds nothing to the bill. "More than zero" and "no more than
 * the price" are facts about a menu item, so they live here and the parser stays as it is.
 *
 * **Blank is not zero.** Both fields are compulsory, and a cost of 0 is a real one: it claims the
 * item is free to make. A blank field claims nothing and is refused, so a missing cost can never
 * become a recorded RM 0.00 on the way through.
 */

import { message, type Message } from '@/features/i18n/messages'
import type { TranslationKey } from '@/features/i18n/translations/en'
import { formatMoney, parsePriceInput } from '@/lib/money'

export interface ItemPricingErrors {
  price: Message | null
  cost: Message | null
}

export type ItemPricing =
  { ok: true; price: number; cost: number } | ({ ok: false } & ItemPricingErrors)

/** The parser speaks of "a price", which reads oddly under the cost field. */
const COST_WORDING: Partial<Record<TranslationKey, TranslationKey>> = {
  'validation.priceRequired': 'validation.costRequired',
  'validation.priceNegative': 'validation.costNegative',
  'validation.priceTooLarge': 'validation.costTooLarge',
}

/** The rules on amounts already in whole sen. */
export function checkItemPricing(price: number, cost: number): ItemPricingErrors {
  if (!Number.isSafeInteger(price) || price <= 0) {
    return {
      price: message('validation.priceMustBePositive', { amount: formatMoney(0) }),
      cost: null,
    }
  }
  return {
    price: null,
    cost:
      cost > price ? message('validation.costExceedsPrice', { price: formatMoney(price) }) : null,
  }
}

/** Both fields as typed, with an error for each that has one. */
export function validateItemPricing(priceText: string, costText: string): ItemPricing {
  const price = parsePriceInput(priceText)
  const cost = parsePriceInput(costText)

  let priceError = price.ok ? null : price.error
  let costError: Message | null = null
  if (!cost.ok) {
    const wording = COST_WORDING[cost.error.key]
    costError = wording ? message(wording) : cost.error
  }

  // A price that parsed still has to be above zero, whatever state the cost is in. Without a
  // usable cost there is nothing to compare, and 0 is the one figure that cannot exceed it.
  if (price.ok) {
    const rules = checkItemPricing(price.sen, cost.ok ? cost.sen : 0)
    priceError = rules.price
    costError ??= rules.cost
  }

  if (price.ok && cost.ok && !priceError && !costError) {
    return { ok: true, price: price.sen, cost: cost.sen }
  }
  return { ok: false, price: priceError, cost: costError }
}
