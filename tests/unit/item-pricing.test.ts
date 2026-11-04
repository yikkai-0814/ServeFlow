import { describe, expect, it } from 'vitest'

import { en } from '@/features/i18n/translations/en'
import { ms } from '@/features/i18n/translations/ms'
import { zh } from '@/features/i18n/translations/zh'
import { checkItemPricing, validateItemPricing } from '@/features/menu/item-pricing'
import { parsePriceInput } from '@/lib/money'

/** The keys of whatever went wrong, so a test states the rule rather than the wording. */
function errorsOf(price: string, cost: string) {
  const result = validateItemPricing(price, cost)
  if (result.ok) throw new Error(`expected ${price} / ${cost} to be refused`)
  return { price: result.price?.key ?? null, cost: result.cost?.key ?? null }
}

describe('the examples the rule was stated with', () => {
  it.each([
    ['10.00', '0.00', 1000, 0],
    ['10.00', '8.00', 1000, 800],
    ['10.00', '10.00', 1000, 1000],
  ])('accepts %s with a cost of %s', (price, cost, priceSen, costSen) => {
    expect(validateItemPricing(price, cost)).toEqual({ ok: true, price: priceSen, cost: costSen })
  })

  it('refuses RM 10.00 with a cost of RM 10.50', () => {
    expect(errorsOf('10.00', '10.50')).toEqual({
      price: null,
      cost: 'validation.costExceedsPrice',
    })
  })

  it('refuses RM 10.00 with a blank cost', () => {
    expect(errorsOf('10.00', '')).toEqual({ price: null, cost: 'validation.costRequired' })
  })

  it('refuses a blank price with a cost of RM 5.00', () => {
    expect(errorsOf('', '5.00')).toEqual({ price: 'validation.priceRequired', cost: null })
  })

  it('refuses RM 0.00 with a cost of RM 0.00, on the price alone', () => {
    expect(errorsOf('0.00', '0.00')).toEqual({
      price: 'validation.priceMustBePositive',
      cost: null,
    })
  })
})

describe('the selling price', () => {
  it.each(['', '   '])('refuses a missing price: %j', (price) => {
    expect(errorsOf(price, '1.00').price).toBe('validation.priceRequired')
  })

  it.each(['0', '0.00', '0.0', 'RM 0.00'])('refuses zero, however it is written: %s', (price) => {
    expect(errorsOf(price, '0').price).toBe('validation.priceMustBePositive')
  })

  it.each(['-1', '-0.01', '-0'])('refuses a negative price: %s', (price) => {
    expect(errorsOf(price, '1.00').price).toBe('validation.priceNegative')
  })

  it.each(['abc', '1e3', '12.5.0', '1 2 a', 'NaN', 'Infinity'])('refuses %s', (price) => {
    expect(errorsOf(price, '1.00').price).toBe('validation.priceNotANumber')
  })

  it('refuses more than two decimal places', () => {
    expect(errorsOf('1.234', '1.00').price).toBe('validation.priceDecimals')
  })

  it('accepts the smallest real price', () => {
    expect(validateItemPricing('0.01', '0.01')).toEqual({ ok: true, price: 1, cost: 1 })
  })

  it('names the lowest amount in the app’s own currency format', () => {
    const result = validateItemPricing('0', '0')
    expect(!result.ok && result.price?.params).toEqual({ amount: 'RM 0.00' })
  })
})

describe('the cost', () => {
  it.each(['', '   ', '\t'])('refuses blank, and never reads it as zero: %j', (cost) => {
    expect(errorsOf('10.00', cost).cost).toBe('validation.costRequired')
  })

  it.each(['0', '0.00', 'RM 0.00'])('accepts zero as a real cost: %s', (cost) => {
    expect(validateItemPricing('10.00', cost)).toEqual({ ok: true, price: 1000, cost: 0 })
  })

  it('returns zero as the number 0, not as anything falsy standing in for it', () => {
    const result = validateItemPricing('10.00', '0')
    expect(result.ok && result.cost).toBe(0)
  })

  it('names the price it was compared with', () => {
    const result = validateItemPricing('10.00', '10.50')
    expect(!result.ok && result.cost?.params).toEqual({ price: 'RM 10.00' })
  })

  it('compares in whole sen, so a one-sen excess is caught', () => {
    expect(errorsOf('10.00', '10.01').cost).toBe('validation.costExceedsPrice')
    expect(validateItemPricing('0.30', '0.30').ok).toBe(true)
  })

  it.each(['-1', '-0.01'])('refuses a negative cost in words about cost: %s', (cost) => {
    expect(errorsOf('10.00', cost).cost).toBe('validation.costNegative')
  })

  it('refuses a cost that is not a number', () => {
    expect(errorsOf('10.00', 'free').cost).toBe('validation.priceNotANumber')
  })

  it('reads a lone currency prefix as no cost, and does not ask for a price', () => {
    expect(errorsOf('10.00', 'RM').cost).toBe('validation.costRequired')
  })

  it('words an enormous cost as a cost', () => {
    expect(errorsOf('10.00', '99999999999999999').cost).toBe('validation.costTooLarge')
  })

  it('refuses more than two decimal places', () => {
    expect(errorsOf('10.00', '1.234').cost).toBe('validation.priceDecimals')
  })
})

describe('both fields wrong at once', () => {
  it('reports each, so neither has to be discovered after fixing the other', () => {
    expect(errorsOf('', '')).toEqual({
      price: 'validation.priceRequired',
      cost: 'validation.costRequired',
    })
    expect(errorsOf('', '-1')).toEqual({
      price: 'validation.priceRequired',
      cost: 'validation.costNegative',
    })
  })

  it('still reports a price of zero when the cost is unusable', () => {
    expect(errorsOf('0', '')).toEqual({
      price: 'validation.priceMustBePositive',
      cost: 'validation.costRequired',
    })
  })

  it('makes no comparison against a price that is not a number', () => {
    expect(errorsOf('abc', '5.00')).toEqual({ price: 'validation.priceNotANumber', cost: null })
  })

  it('makes no comparison against a price of zero', () => {
    expect(errorsOf('0', '5.00')).toEqual({ price: 'validation.priceMustBePositive', cost: null })
  })
})

describe('checkItemPricing, for what is already in whole sen', () => {
  it('accepts a cost from zero up to the price', () => {
    expect(checkItemPricing(1000, 0)).toEqual({ price: null, cost: null })
    expect(checkItemPricing(1000, 800)).toEqual({ price: null, cost: null })
    expect(checkItemPricing(1000, 1000)).toEqual({ price: null, cost: null })
  })

  it.each([0, -1, 12.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses a price of %s', (price) => {
    expect(checkItemPricing(price, 0).price?.key).toBe('validation.priceMustBePositive')
  })

  it('refuses a cost above the price', () => {
    expect(checkItemPricing(1000, 1001).cost?.key).toBe('validation.costExceedsPrice')
  })
})

describe('the shared parser is left as it was', () => {
  it('still accepts 0, which a modifier option’s price and cost both rely on', () => {
    expect(parsePriceInput('0')).toEqual({ ok: true, sen: 0 })
    expect(parsePriceInput('0.00')).toEqual({ ok: true, sen: 0 })
  })

  it('still says what it always said about blank and negative', () => {
    expect(parsePriceInput('')).toMatchObject({
      ok: false,
      error: { key: 'validation.priceRequired' },
    })
    expect(parsePriceInput('-1')).toMatchObject({
      ok: false,
      error: { key: 'validation.priceNegative' },
    })
  })
})

describe('every message these rules can show, in all three languages', () => {
  const NEW_KEYS = [
    'validation.priceMustBePositive',
    'validation.costNegative',
    'validation.costTooLarge',
    'validation.costExceedsPrice',
  ] as const

  const ALL_KEYS = [
    ...NEW_KEYS,
    'validation.costRequired',
    'validation.priceRequired',
    'validation.priceNegative',
    'validation.priceNotANumber',
    'validation.priceDecimals',
    'validation.priceTooLarge',
  ] as const

  const placeholders = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1])

  it.each(ALL_KEYS)('%s is really translated, and keeps its placeholders', (key) => {
    expect(en[key].trim()).not.toBe('')
    expect(ms[key].trim()).not.toBe('')
    expect(zh[key].trim()).not.toBe('')
    expect(ms[key]).not.toBe(en[key])
    expect(zh[key]).not.toBe(en[key])
    expect(placeholders(ms[key])).toEqual(placeholders(en[key]))
    expect(placeholders(zh[key])).toEqual(placeholders(en[key]))
  })
})
