/**
 * Which requests `placeOrder` treats as a warm-up (functions/src/order.ts).
 *
 * Exactly `{ warmup: true }` and nothing else. Anything else — including a real order that happens
 * to carry `warmup: true` — is judged as an order, so a warm-up can never swallow a sale.
 * tests/functions/order-warmup.test.ts proves the same against the deployed function's code.
 */
import { describe, expect, it } from 'vitest'

import { isWarmupRequest, parsePlaceOrderRequest } from '../../functions/src/order'

const order = {
  requestId: 'request-1234567890-abcdef',
  lines: [
    {
      menuItemId: 'item-nasi',
      quantity: 1,
      selections: [],
      expected: {
        name: 'Nasi Lemak',
        basePrice: 800,
        unitPrice: 800,
        adjustments: [],
        groupNames: [],
        optionNames: [],
      },
    },
  ],
  orderType: 'takeaway',
  tableNumber: null,
  operatorId: 'alice',
  language: 'en',
  expectedTotal: 800,
}

describe('a warm-up', () => {
  it('is exactly { warmup: true }', () => {
    expect(isWarmupRequest({ warmup: true })).toBe(true)
  })

  it.each([
    ['warmup false', { warmup: false }],
    ['warmup as a string', { warmup: 'true' }],
    ['warmup as a number', { warmup: 1 }],
    ['an extra key', { warmup: true, extra: 1 }],
    ['a request id alongside', { warmup: true, requestId: 'request-1234567890-abcdef' }],
    ['an empty object', {}],
    ['an array', [true]],
    ['an array holding the shape', [{ warmup: true }]],
    ['null', null],
    ['undefined', undefined],
    ['a string', 'warmup'],
    ['true', true],
  ])('is not %s', (_label, data) => {
    expect(isWarmupRequest(data)).toBe(false)
  })

  it('is not a real order that also carries warmup: true — that is still an order', () => {
    const withFlag = { ...order, warmup: true }

    expect(isWarmupRequest(withFlag)).toBe(false)
    expect(parsePlaceOrderRequest(withFlag)).not.toBeNull()
  })

  it('is never mistaken for an order by the parser either', () => {
    expect(parsePlaceOrderRequest({ warmup: true })).toBeNull()
  })
})
