/**
 * The till and the server have to arrive at the same order.
 *
 * functions/ is a separate package, so the pricing and customisation rules exist twice: once in
 * the app, deciding what the counter shows, and once in functions/src/order.ts, deciding what is
 * charged. A difference would refuse an honest sale as `price-changed` or `names-changed`, or
 * charge a figure nobody was shown. Each case here runs the same menu through both and compares
 * the result.
 */
import { describe, expect, it } from 'vitest'

import { getLocalizedMenuItemName } from '@/features/menu/item-names'
import {
  offeredGroupsFor,
  parseModifierGroup,
  selectionOf,
  validateSelections,
  type ModifierGroup,
} from '@/features/menu/modifiers'
import { parseMenuItem, type MenuItem } from '@/features/menu/types'
import type { Language } from '@/features/i18n/languages'
import { addToCart, cartTotal, EMPTY_CART, type Cart } from '@/features/pos/cart'

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
  type PlaceOrderRequest,
  type QuotedLine,
  type RequestedLine,
} from '../../functions/src/order'

type Doc = Record<string, unknown>

interface Menu {
  items: Record<string, Doc>
  groups: Record<string, Doc>
}

const option = (id: string, priceAdjustment: number, over: Doc = {}) => ({
  id,
  name: `Option ${id}`,
  names: {},
  priceAdjustment,
  active: true,
  ...over,
})

const group = (over: Doc = {}) => ({
  name: 'Group',
  selection: 'multiple',
  required: false,
  sortOrder: 0,
  active: true,
  options: [option('o1', 100)],
  ...over,
})

const item = (over: Doc = {}) => ({
  name: 'Nasi Lemak',
  categoryId: 'mains',
  price: 800,
  sortOrder: 0,
  active: true,
  ...over,
})

function serverCatalogue(menu: Menu): Catalogue {
  const items = new Map<string, CatalogueItem>()
  for (const [id, data] of Object.entries(menu.items)) {
    const parsed = parseCatalogueItem(id, data)
    if (parsed) items.set(id, parsed)
  }
  const groups: CatalogueGroup[] = []
  for (const [id, data] of Object.entries(menu.groups)) {
    const parsed = parseCatalogueGroup(id, data)
    if (parsed) groups.push(parsed)
  }
  return { items, activeCategoryIds: new Set(['mains']), groups }
}

function clientGroups(menu: Menu): ModifierGroup[] {
  return Object.entries(menu.groups).flatMap(([id, data]) => {
    const parsed = parseModifierGroup(id, data)
    return parsed ? [parsed] : []
  })
}

/** Builds the cart exactly as the till does, or says why it would not. */
function clientCart(menu: Menu, lines: RequestedLine[], language: Language) {
  const groups = clientGroups(menu)
  let cart: Cart = EMPTY_CART

  for (const line of lines) {
    const menuItem = parseMenuItem(line.menuItemId, menu.items[line.menuItemId] ?? {}) as MenuItem
    const offered = offeredGroupsFor(groups, menuItem)

    // Chosen in the order given; one that is not on offer is carried unpriced, as a stale till
    // holding a withdrawn option would.
    const chosen = line.selections.map((selection) => {
      const owner = offered.find((candidate) => candidate.id === selection.groupId)
      const picked = owner?.options.find((candidate) => candidate.id === selection.optionId)
      return owner && picked
        ? selectionOf(owner, picked, language)
        : {
            groupId: selection.groupId,
            groupName: owner?.name ?? '',
            optionId: selection.optionId,
            optionName: '',
            priceAdjustment: 0,
          }
    })

    const validation = validateSelections(offered, chosen)
    if (!validation.ok) return { ok: false as const, error: validation.error.key }

    for (let count = 0; count < line.quantity; count += 1) {
      cart = addToCart(cart, {
        menuItemId: menuItem.id,
        name: getLocalizedMenuItemName(menuItem, language),
        basePrice: menuItem.price,
        modifiers: chosen,
      })
    }
  }
  return { ok: true as const, cart }
}

/** Both sides on one order: they must both accept it identically, or both refuse it alike. */
function expectParity(menu: Menu, lines: RequestedLine[], language: Language = 'en') {
  const client = clientCart(menu, lines, language)
  const server = priceOrder(lines, language, serverCatalogue(menu))

  if (!client.ok) {
    expect(server.ok).toBe(false)
    const expected: Record<string, string> = {
      'validation.chooseGroup': 'selection-required',
      'validation.chooseOnlyOne': 'single-choice',
      'validation.optionWithdrawn': 'option-withdrawn',
      'validation.optionUnknown': 'option-unknown',
    }
    expect(!server.ok && server.reason).toBe(expected[client.error])
    return server
  }

  expect(server.ok).toBe(true)
  if (!server.ok) return server
  expect(server.total).toBe(cartTotal(client.cart))
  // An honest till is never refused: what its cart quotes is what the menu says, part by part.
  const quoted = client.cart.map((entry, index) => ({
    ...lines[index]!,
    expected: {
      name: entry.name,
      basePrice: entry.basePrice,
      unitPrice: entry.unitPrice,
      adjustments: entry.modifiers.map((modifier) => modifier.priceAdjustment),
      groupNames: entry.modifiers.map((modifier) => modifier.groupName),
      optionNames: entry.modifiers.map((modifier) => modifier.optionName),
    },
  }))
  expect(pricesMatch(quoted, server.lines)).toBe(true)
  expect(namesMatch(quoted, server.lines)).toBe(true)
  expect(server.lines).toEqual(
    client.cart.map(({ lineId: _lineId, ...line }) => ({
      ...line,
      modifiers: line.modifiers.map((modifier) => ({ ...modifier })),
    })),
  )
  return server
}

const pick = (groupId: string, optionId: string) => ({ groupId, optionId })
const line = (
  menuItemId: string,
  selections: RequestedLine['selections'] = [],
  quantity = 1,
): RequestedLine => ({ menuItemId, quantity, selections })

describe('the same price on both sides', () => {
  it('prices a plain item', () => {
    const server = expectParity({ items: { a: item() }, groups: {} }, [line('a', [], 3)])
    expect(server.ok && server.total).toBe(2400)
  })

  it('adds an option', () => {
    const menu = {
      items: { a: item({ modifierGroupIds: ['g'] }) },
      groups: { g: group({ options: [option('o1', 150)] }) },
    }
    const server = expectParity(menu, [line('a', [pick('g', 'o1')], 2)])
    expect(server.ok && server.total).toBe(1900)
  })

  it('keeps an option that costs nothing, RM0.00 being a real answer', () => {
    const menu = {
      items: { a: item({ modifierGroupIds: ['g'] }) },
      groups: { g: group({ options: [option('free', 0)] }) },
    }
    const server = expectParity(menu, [line('a', [pick('g', 'free')])])
    expect(server.ok && server.lines[0]?.modifiers[0]?.priceAdjustment).toBe(0)
  })

  it('takes off a negative adjustment', () => {
    const menu = {
      items: { a: item({ modifierGroupIds: ['g'] }) },
      groups: { g: group({ options: [option('less', -200)] }) },
    }
    const server = expectParity(menu, [line('a', [pick('g', 'less')])])
    expect(server.ok && server.total).toBe(600)
  })

  it('floors a line at zero, per unit, rather than owing the customer', () => {
    const menu = {
      items: { a: item({ price: 100, modifierGroupIds: ['g'] }) },
      groups: { g: group({ options: [option('less', -500)] }) },
    }
    const server = expectParity(menu, [line('a', [pick('g', 'less')], 4)])
    expect(server.ok && server.total).toBe(0)
  })

  it('sells an old item still priced at RM0, as the till does', () => {
    expectParity({ items: { a: item({ price: 0 }) }, groups: {} }, [line('a')])
  })

  it('keeps options in the order they were chosen', () => {
    const menu = {
      items: { a: item({ modifierGroupIds: ['g'] }) },
      groups: { g: group({ options: [option('o1', 1), option('o2', 2), option('o3', 3)] }) },
    }
    const server = expectParity(menu, [line('a', [pick('g', 'o3'), pick('g', 'o1')])])
    expect(server.ok && server.lines[0]?.modifiers.map((m) => m.optionId)).toEqual(['o3', 'o1'])
  })
})

describe('the same names on both sides', () => {
  const menu = {
    items: {
      a: item({ name: '  Nasi Lemak ', names: { ms: ' Nasi Lemak Biasa ', zh: '椰浆饭' } }),
      b: item({ name: 'Teh', names: { ms: '   ', zh: 7 } }),
    },
    groups: {
      g: group({
        itemId: 'a',
        options: [option('o1', 0, { name: 'Egg', names: { ms: 'Telur', zh: '鸡蛋' } })],
      }),
    },
  }

  it.each(['en', 'ms', 'zh'] as const)('in %s, trimmed and falling back to English', (language) => {
    expectParity(menu, [line('a', [pick('g', 'o1')]), line('b')], language)
  })
})

describe('the same refusals on both sides', () => {
  it('a required group left unanswered', () => {
    const menu = {
      items: { a: item({ modifierGroupIds: ['g'] }) },
      groups: { g: group({ required: true }) },
    }
    expectParity(menu, [line('a')])
  })

  it('two answers to a one-choice group', () => {
    const menu = {
      items: { a: item({ modifierGroupIds: ['g'] }) },
      groups: { g: group({ selection: 'single', options: [option('o1', 0), option('o2', 0)] }) },
    }
    expectParity(menu, [line('a', [pick('g', 'o1'), pick('g', 'o2')])])
  })

  it('an option withdrawn since it was chosen', () => {
    const menu = {
      items: { a: item({ modifierGroupIds: ['g'] }) },
      groups: { g: group({ options: [option('o1', 0), option('o2', 0, { active: false })] }) },
    }
    expectParity(menu, [line('a', [pick('g', 'o2')])])
  })

  it('a group that has been deactivated', () => {
    const menu = {
      items: { a: item({ modifierGroupIds: ['g'] }) },
      groups: { g: group({ active: false }) },
    }
    expectParity(menu, [line('a', [pick('g', 'o1')])])
  })

  it('a group with every option deactivated, which is simply no longer asked', () => {
    const menu = {
      items: { a: item({ modifierGroupIds: ['g'] }) },
      groups: { g: group({ required: true, options: [option('o1', 0, { active: false })] }) },
    }
    expectParity(menu, [line('a')])
  })

  it('a group belonging to another item, even if this one lists it', () => {
    const menu = {
      items: { a: item({ modifierGroupIds: ['g'] }), b: item() },
      groups: { g: group({ itemId: 'b' }) },
    }
    expectParity(menu, [line('a', [pick('g', 'o1')])])
  })
})

describe('legacy groups, which name their item instead of being listed', () => {
  it('are offered and priced', () => {
    const menu = {
      items: { a: item() },
      groups: { g: group({ itemId: 'a', options: [option('o1', 250)] }) },
    }
    const server = expectParity(menu, [line('a', [pick('g', 'o1')])])
    expect(server.ok && server.total).toBe(1050)
  })

  it('still insist on an answer', () => {
    const menu = { items: { a: item() }, groups: { g: group({ itemId: 'a', required: true }) } }
    expectParity(menu, [line('a')])
  })

  it('sit beside attached groups', () => {
    const menu = {
      items: { a: item({ modifierGroupIds: ['shared'] }) },
      groups: {
        shared: group({ options: [option('s', 10)] }),
        own: group({ itemId: 'a', options: [option('l', 20)] }),
      },
    }
    expectParity(menu, [line('a', [pick('shared', 's'), pick('own', 'l')])])
  })
})

describe('on any menu', () => {
  /** Small and seeded, so a failure repeats exactly. */
  function random(seed: number) {
    let state = seed
    return (limit: number) => {
      state = (state * 1103515245 + 12345) % 2147483648
      return state % limit
    }
  }

  it('agree across 300 generated menus and orders', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const next = random(seed)
      const groups: Record<string, Doc> = {}
      const groupIds: string[] = []

      for (let index = 0; index < 1 + next(4); index += 1) {
        const id = `g${index}`
        const legacy = next(4) === 0
        groupIds.push(id)
        groups[id] = group({
          ...(legacy ? { itemId: 'a' } : {}),
          selection: next(2) === 0 ? 'single' : 'multiple',
          required: next(3) === 0,
          active: next(8) !== 0,
          sortOrder: next(5),
          options: Array.from({ length: 1 + next(4) }, (_, position) =>
            option(`o${position}`, next(900) - 300, { active: next(6) !== 0 }),
          ),
        })
      }

      const attached = groupIds.filter((id) => !(groups[id] as Doc).itemId)
      const menu = {
        items: { a: item({ price: next(2000), modifierGroupIds: attached }) },
        groups,
      }
      const selections = groupIds.flatMap((id) => {
        const options = (groups[id] as { options: { id: string }[] }).options
        return options.filter(() => next(3) === 0).map((choice) => pick(id, choice.id))
      })

      expectParity(menu, [line('a', selections, 1 + next(5))])
    }
  })
})

describe('what only the server decides', () => {
  const catalogue = serverCatalogue({ items: { a: item() }, groups: {} })

  it.each([
    ['an item that does not exist', 'missing'],
    ['an item that cannot be parsed', 'broken'],
  ])('refuses %s', (_label, id) => {
    const withBroken = {
      ...catalogue,
      items: new Map([...catalogue.items, ['broken', null as unknown as CatalogueItem]]),
    }
    const result = priceOrder([line(id)], 'en', withBroken)
    expect(result).toMatchObject({ ok: false, reason: 'item-unavailable', menuItemId: id })
  })

  it('refuses an archived item', () => {
    const archived = serverCatalogue({ items: { a: item({ active: false }) }, groups: {} })
    expect(priceOrder([line('a')], 'en', archived).ok).toBe(false)
  })

  it('refuses an item in a hidden category, which the till never shows', () => {
    const hidden = { ...catalogue, activeCategoryIds: new Set<string>() }
    expect(priceOrder([line('a')], 'en', hidden)).toMatchObject({ reason: 'item-unavailable' })
  })

  it('refuses a price stored as a float or below zero', () => {
    expect(parseCatalogueItem('a', item({ price: 12.5 }))).toBeNull()
    expect(parseCatalogueItem('a', item({ price: -1 }))).toBeNull()
    expect(parseCatalogueItem('a', undefined)).toBeNull()
  })
})

/** What a line with no options quotes, at the price these menus use. */
const plain = {
  name: 'Nasi Lemak',
  basePrice: 800,
  unitPrice: 800,
  adjustments: [] as number[],
  groupNames: [] as string[],
  optionNames: [] as string[],
}

describe('reading a request', () => {
  const valid = {
    requestId: 'request-0000000001',
    lines: [{ menuItemId: 'a', quantity: 1, selections: [], expected: plain }],
    orderType: 'takeaway',
    tableNumber: null,
    operatorId: 'alice',
    language: 'en',
    expectedTotal: 800,
  }
  const lineWith = (over: Doc) => ({ ...valid, lines: [{ ...valid.lines[0], ...over }] })
  const quoted = (selections: RequestedLine['selections']) => ({
    selections,
    expected: {
      ...plain,
      adjustments: selections.map(() => 0),
      groupNames: selections.map(() => 'Group'),
      optionNames: selections.map(({ optionId }) => optionId),
    },
  })

  it('accepts what the till sends', () => {
    expect(parsePlaceOrderRequest(valid)).not.toBeNull()
  })

  it('drops anything else it was sent, prices and names included', () => {
    const parsed = parsePlaceOrderRequest({
      ...valid,
      total: 1,
      lines: [{ ...valid.lines[0], unitPrice: 1, name: 'Free', basePrice: 1 }],
    })
    expect(parsed?.lines).toEqual([
      { menuItemId: 'a', quantity: 1, selections: [], expected: plain },
    ])
    expect(parsed).not.toHaveProperty('total')
  })

  it.each([0, -1, 1.5, 1000, '2', null, Number.NaN])('refuses a quantity of %s', (quantity) => {
    expect(parsePlaceOrderRequest(lineWith({ quantity }))).toBeNull()
  })

  it('accepts the limit on a line', () => {
    expect(parsePlaceOrderRequest(lineWith({ quantity: 999 }))).not.toBeNull()
  })

  it.each([
    ['no request', null],
    ['no lines', { ...valid, lines: [] }],
    [
      '101 lines',
      {
        ...valid,
        lines: Array.from({ length: 101 }, (_, i) => ({
          menuItemId: `i${i}`,
          quantity: 1,
          selections: [],
          expected: plain,
        })),
      },
    ],
    ['a path as an item id', lineWith({ menuItemId: 'a/b' })],
    ['a short request id', { ...valid, requestId: 'short' }],
    ['a request id that is a path', { ...valid, requestId: 'aaaaaaaaaaaaaaaaaaaa/b' }],
    ['an unknown language', { ...valid, language: 'fr' }],
    ['a negative expected total', { ...valid, expectedTotal: -1 }],
    ['a fractional expected total', { ...valid, expectedTotal: 1.5 }],
    ['an unknown order type', { ...valid, orderType: 'delivery' }],
    ['a dine-in order with no table', { ...valid, orderType: 'dine_in' }],
    ['a table with punctuation', { ...valid, orderType: 'dine_in', tableNumber: 'A-1' }],
    ['a table too long', { ...valid, orderType: 'dine_in', tableNumber: '123456789' }],
    ['the same option twice', lineWith(quoted([pick('g', 'o'), pick('g', 'o')]))],
    [
      '31 options on a line',
      lineWith(quoted(Array.from({ length: 31 }, (_, i) => pick('g', `o${i}`)))),
    ],
    ['two identical lines', { ...valid, lines: [valid.lines[0], valid.lines[0]] }],
    ['a line with no quote', lineWith({ expected: undefined })],
    ['a negative base price', lineWith({ expected: { ...plain, basePrice: -1 } })],
    ['a fractional unit price', lineWith({ expected: { ...plain, unitPrice: 1.5 } })],
    ['a unit price as text', lineWith({ expected: { ...plain, unitPrice: '800' } })],
    [
      'an adjustment nothing was chosen for',
      lineWith({ expected: { ...plain, adjustments: [0] } }),
    ],
    ['too few adjustments', lineWith({ selections: [pick('g', 'o')] })],
    [
      'a fractional adjustment',
      lineWith({
        ...quoted([pick('g', 'o')]),
        expected: { ...quoted([pick('g', 'o')]).expected, adjustments: [0.5] },
      }),
    ],
    ['a quote with no name', lineWith({ expected: { ...plain, name: undefined } })],
    ['a name that is not text', lineWith({ expected: { ...plain, name: 7 } })],
    ['no group names', lineWith({ expected: { ...plain, groupNames: undefined } })],
    ['no option names', lineWith({ expected: { ...plain, optionNames: undefined } })],
    [
      'too few group names',
      lineWith({
        ...quoted([pick('g', 'o')]),
        expected: { ...quoted([pick('g', 'o')]).expected, groupNames: [] },
      }),
    ],
    [
      'too many option names',
      lineWith({
        ...quoted([pick('g', 'o')]),
        expected: { ...quoted([pick('g', 'o')]).expected, optionNames: ['a', 'b'] },
      }),
    ],
    [
      'an option name that is not text',
      lineWith({
        ...quoted([pick('g', 'o')]),
        expected: { ...quoted([pick('g', 'o')]).expected, optionNames: [7] },
      }),
    ],
    ['the parent directory as an item', lineWith({ menuItemId: '..' })],
    ['this directory as an item', lineWith({ menuItemId: '.' })],
    ['a reserved item id', lineWith({ menuItemId: '__name__' })],
    ['an item id over 1,500 bytes', lineWith({ menuItemId: '訂'.repeat(501) })],
    ['a reserved operator id', { ...valid, operatorId: '__name__' }],
  ])('refuses %s', (_label, request) => {
    expect(parsePlaceOrderRequest(request)).toBeNull()
  })

  it('keeps two lines of one item made differently', () => {
    const lines = [
      { menuItemId: 'a', quantity: 1, ...quoted([pick('g', 'o1')]) },
      { menuItemId: 'a', quantity: 1, ...quoted([pick('g', 'o2')]) },
    ]
    expect(parsePlaceOrderRequest({ ...valid, lines })?.lines).toHaveLength(2)
  })

  it('trims a table number and ignores one left on a takeaway', () => {
    const dineIn = parsePlaceOrderRequest({ ...valid, orderType: 'dine_in', tableNumber: ' A3 ' })
    expect(dineIn?.tableNumber).toBe('A3')
    expect(parsePlaceOrderRequest({ ...valid, tableNumber: '5' })?.tableNumber).toBeNull()
  })
})

describe('telling requests apart', () => {
  const request = parsePlaceOrderRequest({
    requestId: 'request-0000000001',
    lines: [
      {
        menuItemId: 'a',
        quantity: 1,
        selections: [pick('g', 'o')],
        expected: {
          name: 'Item',
          basePrice: 700,
          unitPrice: 800,
          adjustments: [100],
          groupNames: ['Group'],
          optionNames: ['Option'],
        },
      },
    ],
    orderType: 'takeaway',
    operatorId: 'alice',
    language: 'en',
    expectedTotal: 800,
  })!

  it('gives the same request the same fingerprint, whatever its id', () => {
    expect(requestFingerprint(request)).toBe(
      requestFingerprint({ ...request, requestId: 'another-request-id-1' }),
    )
  })

  it.each([
    ['quantity', { lines: [{ ...request.lines[0]!, quantity: 2 }] }],
    ['operator', { operatorId: 'bob' }],
    ['language', { language: 'ms' as const }],
    ['expected total', { expectedTotal: 900 }],
    ['table', { orderType: 'dine_in' as const, tableNumber: '5' }],
    ['options', { lines: [{ ...request.lines[0]!, selections: [pick('g', 'other')] }] }],
    [
      'quoted base price',
      { lines: [{ ...request.lines[0]!, expected: { ...line0().expected, basePrice: 701 } }] },
    ],
    [
      'quoted unit price',
      { lines: [{ ...request.lines[0]!, expected: { ...line0().expected, unitPrice: 801 } }] },
    ],
    [
      'quoted adjustment',
      { lines: [{ ...request.lines[0]!, expected: { ...line0().expected, adjustments: [101] } }] },
    ],
    [
      'quoted item name',
      { lines: [{ ...request.lines[0]!, expected: { ...line0().expected, name: 'Other' } }] },
    ],
    [
      'quoted group name',
      {
        lines: [{ ...request.lines[0]!, expected: { ...line0().expected, groupNames: ['Other'] } }],
      },
    ],
    [
      'quoted option name',
      {
        lines: [
          { ...request.lines[0]!, expected: { ...line0().expected, optionNames: ['Other'] } },
        ],
      },
    ],
  ])('notices a different %s', (_label, change) => {
    expect(requestFingerprint({ ...request, ...change })).not.toBe(requestFingerprint(request))
  })

  it('takes an order rebuilt in another sequence for the same order', () => {
    const one: QuotedLine = {
      menuItemId: 'a',
      quantity: 1,
      selections: [pick('g', 'x'), pick('g', 'y')],
      expected: {
        ...plain,
        basePrice: 700,
        unitPrice: 1000,
        adjustments: [100, 200],
        groupNames: ['G', 'G'],
        optionNames: ['X', 'Y'],
      },
    }
    const two: QuotedLine = { menuItemId: 'b', quantity: 2, selections: [], expected: plain }
    const reversed: QuotedLine = {
      ...one,
      selections: [pick('g', 'y'), pick('g', 'x')],
      expected: { ...one.expected, adjustments: [200, 100], optionNames: ['Y', 'X'] },
    }
    const order = (lines: QuotedLine[]): PlaceOrderRequest => ({ ...request, lines })

    expect(requestFingerprint(order([one, two]))).toBe(requestFingerprint(order([two, reversed])))
  })

  it('does not let the same prices on swapped options pass for the same order', () => {
    const one: QuotedLine = {
      menuItemId: 'a',
      quantity: 1,
      selections: [pick('g', 'x'), pick('g', 'y')],
      expected: {
        ...plain,
        basePrice: 700,
        unitPrice: 1000,
        adjustments: [100, 200],
        groupNames: ['G', 'G'],
        optionNames: ['X', 'Y'],
      },
    }
    const swapped = { ...one, expected: { ...one.expected, adjustments: [200, 100] } }

    expect(requestFingerprint({ ...request, lines: [one] })).not.toBe(
      requestFingerprint({ ...request, lines: [swapped] }),
    )
  })

  function line0() {
    return request.lines[0]!
  }

  it('files the same request id under a different record for each account', () => {
    expect(requestRecordId('alice', 'id')).not.toBe(requestRecordId('bob', 'id'))
  })

  it('cannot be confused by moving characters between the account and the id', () => {
    expect(requestRecordId('ab', 'c')).not.toBe(requestRecordId('a', 'bc'))
  })
})

describe('comparing a quote with the menu', () => {
  const menu = {
    items: {
      a: item({ price: 800, modifierGroupIds: ['g'] }),
      b: item({ name: 'Teh', price: 500 }),
    },
    groups: { g: group({ options: [option('o1', 150), option('o2', -50)] }) },
  }
  const requested = [line('a', [pick('g', 'o1'), pick('g', 'o2')]), line('b')]
  const priced = () => {
    const result = priceOrder(requested, 'en', serverCatalogue(menu))
    if (!result.ok) throw new Error('The menu above should price.')
    return result.lines
  }
  const honest = (): QuotedLine[] => [
    {
      ...requested[0]!,
      expected: {
        name: 'Nasi Lemak',
        basePrice: 800,
        unitPrice: 900,
        adjustments: [150, -50],
        groupNames: ['Group', 'Group'],
        optionNames: ['Option o1', 'Option o2'],
      },
    },
    {
      ...requested[1]!,
      expected: {
        name: 'Teh',
        basePrice: 500,
        unitPrice: 500,
        adjustments: [],
        groupNames: [],
        optionNames: [],
      },
    },
  ]
  const withFirst = (expected: Partial<QuotedLine['expected']>) => {
    const [first, second] = honest()
    return [{ ...first!, expected: { ...first!.expected, ...expected } }, second!]
  }

  it('accepts a quote that matches, part by part', () => {
    expect(pricesMatch(honest(), priced())).toBe(true)
  })

  it.each([
    ['a base price', { basePrice: 801 }],
    ['a unit price', { unitPrice: 901 }],
    ['an adjustment', { adjustments: [151, -50] }],
    ['adjustments swapped between options', { adjustments: [-50, 150] }],
    ['an adjustment missing', { adjustments: [150] }],
    ['an adjustment too many', { adjustments: [150, -50, 0] }],
  ])('refuses %s that differs', (_label, expected) => {
    expect(pricesMatch(withFirst(expected), priced())).toBe(false)
  })

  it('refuses two lines that differ and cancel out', () => {
    const [first, second] = honest()
    const offsetting = [
      { ...first!, expected: { ...first!.expected, basePrice: 700, unitPrice: 800 } },
      { ...second!, expected: { ...second!.expected, basePrice: 600, unitPrice: 600 } },
    ]
    expect(pricesMatch(offsetting, priced())).toBe(false)
  })

  it('refuses a quote longer than the order', () => {
    expect(pricesMatch(honest(), priced().slice(0, 1))).toBe(false)
  })

  it('accepts names that match, part by part', () => {
    expect(namesMatch(honest(), priced())).toBe(true)
  })

  it.each([
    ['an item name', { name: 'Nasi Lemak Special' }],
    ['an item name by a space', { name: 'Nasi Lemak ' }],
    ['an item name by case', { name: 'nasi lemak' }],
    ['a group name', { groupNames: ['Group', 'Other'] }],
    ['an option name', { optionNames: ['Option o1', 'Other'] }],
    ['option names swapped between options', { optionNames: ['Option o2', 'Option o1'] }],
  ])('refuses %s that differs', (_label, expected) => {
    expect(namesMatch(withFirst(expected), priced())).toBe(false)
    expect(pricesMatch(withFirst(expected), priced())).toBe(true)
  })

  it('refuses a difference on a later line', () => {
    const [first, second] = honest()
    const later = [first!, { ...second!, expected: { ...second!.expected, name: 'Kopi' } }]
    expect(namesMatch(later, priced())).toBe(false)
  })

  it('refuses names for a quote longer than the order', () => {
    expect(namesMatch(honest(), priced().slice(0, 1))).toBe(false)
  })
})

describe('the weight of a document', () => {
  it.each([
    ['an empty string', '', 1],
    ['a string', 'abc', 4],
    ['a multi-byte string, by its UTF-8 bytes', '訂', 4],
    ['a number', 800, 8],
    ['a boolean', true, 1],
    ['null', null, 1],
    ['an array', ['a', 1], 2 + 8],
    ['a map, keys included', { ab: 1 }, 3 + 8],
    ['nesting', [{ a: ['b'] }], 2 + 2],
  ])('counts %s', (_label, value, bytes) => {
    expect(storedBytes(value)).toBe(bytes)
  })

  it('stays below what Firestore allows', () => {
    expect(MAX_ORDER_BYTES).toBeLessThan(1_048_576)
  })
})

describe('ids Firestore can read', () => {
  it.each(['a', 'item-1', 'a.b', '_x_', '__x', 'x__', '訂', 'x'.repeat(1500)])(
    'allows %s',
    (id) => {
      expect(isReadableId(id)).toBe(true)
    },
  )

  it.each(['', '.', '..', '__x__', '____', 'a/b', 'x'.repeat(1501), 1, null])(
    'refuses %s',
    (id) => {
      expect(isReadableId(id)).toBe(false)
    },
  )
})

describe('the business date', () => {
  it.each([
    ['just before Kuala Lumpur midnight', '2026-11-05T15:59:59.000Z', '2026-11-05'],
    ['at Kuala Lumpur midnight', '2026-11-05T16:00:00.000Z', '2026-11-06'],
    ['across a month end', '2026-11-30T16:00:00.000Z', '2026-12-01'],
    ['across a year end', '2026-12-31T16:30:00.000Z', '2027-01-01'],
  ])('%s', (_label, instant, expected) => {
    expect(businessDateAt(new Date(instant))).toBe(expected)
  })

  it('has the shape everything queries by', () => {
    expect(businessDateAt(new Date())).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
