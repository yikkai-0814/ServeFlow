/**
 * What an order is worth, decided on the server. Pure, like pin.ts and void.ts.
 *
 * The till sends what was chosen: which items, how many, which options. Everything with a price
 * or a name on it is read from the menu here, so a modified client can describe an order but
 * cannot state what it costs or what it is called. The prices and names the till sends alongside
 * are what its cart shows, and are only ever compared: nothing the order records comes from them.
 *
 * **These are the app's own rules, restated.** functions/ is a separate package and cannot import
 * from src/, so each function below names what it mirrors, and tests/unit/order-parity.test.ts
 * runs the two side by side. A difference is a bug in this file: the till shows a price, and this
 * is where it has to come out the same.
 */

import { createHash } from 'node:crypto'

import { isDocumentId } from './void'

/** Mirrors MAX_CART_LINES in src/features/pos/cart.ts and `d.lines.size() <= 100`. */
export const MAX_ORDER_LINES = 100
/** Mirrors MAX_LINE_QUANTITY in src/features/pos/cart.ts. */
export const MAX_LINE_QUANTITY = 999
/** Mirrors MAX_MODIFIERS_PER_LINE in src/features/menu/modifiers.ts. */
export const MAX_MODIFIERS_PER_LINE = 30
/** Mirrors TABLE_NUMBER_PATTERN in src/features/pos/order-type.ts. */
const TABLE_NUMBER_PATTERN = /^[A-Za-z0-9]{1,8}$/
/** Mirrors LANGUAGES in src/features/i18n/languages.ts. */
const LANGUAGES = ['en', 'ms', 'zh'] as const
/** Long enough that a client cannot collide by accident, and safe to hash and to log. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/

/** The café's calendar. A sale is filed under this zone's date, whatever a till's clock says. */
export const BUSINESS_TIME_ZONE = 'Asia/Kuala_Lumpur'

/**
 * The most an order may weigh by `storedBytes`. Firestore refuses a document over 1 MiB
 * (1,048,576 bytes). This stays below that because the figure here is Firestore's published
 * arithmetic rather than its own measurement, and it leaves out the document's name and
 * `createdAt`. It limits bytes, not lines or options: only long multi-byte names on most of 3,000
 * options reach it.
 */
export const MAX_ORDER_BYTES = 1_000_000

export type Language = (typeof LANGUAGES)[number]

// ---- The request ----------------------------------------------------------------------------

export interface RequestedSelection {
  groupId: string
  optionId: string
}

export interface RequestedLine {
  menuItemId: string
  quantity: number
  selections: RequestedSelection[]
}

/** What the till's cart shows for a line. Compared with the menu, and never stored. */
export interface LineQuote {
  /** The item's name exactly as the cart shows it, in the language it was added in. */
  name: string
  basePrice: number
  unitPrice: number
  /** One per selection, in the same order, as are the two lists of names below. */
  adjustments: number[]
  groupNames: string[]
  optionNames: string[]
}

export interface QuotedLine extends RequestedLine {
  expected: LineQuote
}

export interface PlaceOrderRequest {
  requestId: string
  lines: QuotedLine[]
  orderType: 'dine_in' | 'takeaway'
  /** Null exactly when the order is a takeaway. */
  tableNumber: string | null
  operatorId: string | null
  language: Language
  expectedTotal: number
}

/**
 * An id Firestore will accept in a read. `isDocumentId` only rules out a path, and Firestore also
 * refuses `.`, `..`, `__reserved__` names and anything over 1,500 bytes. Sent one of those, the read
 * fails as an internal error rather than a refusal.
 */
export function isReadableId(value: unknown): value is string {
  return isDocumentId(value) && Buffer.byteLength(value) <= 1500 && !/^\.\.?$|^__.*__$/.test(value)
}

function isSen(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function parseSelection(value: unknown): RequestedSelection | null {
  if (typeof value !== 'object' || value === null) return null
  const { groupId, optionId } = value as Record<string, unknown>
  return isDocumentId(groupId) && isDocumentId(optionId) ? { groupId, optionId } : null
}

function isNameList(value: unknown, length: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((name) => typeof name === 'string')
  )
}

function parseExpected(value: unknown, selections: number): LineQuote | null {
  if (typeof value !== 'object' || value === null) return null
  const { name, basePrice, unitPrice, adjustments, groupNames, optionNames } = value as Record<
    string,
    unknown
  >

  if (typeof name !== 'string') return null
  if (!isSen(basePrice) || !isSen(unitPrice)) return null
  if (!Array.isArray(adjustments) || adjustments.length !== selections) return null
  // An adjustment may be negative, so it is a whole number of sen rather than an amount.
  if (!adjustments.every((adjustment) => Number.isSafeInteger(adjustment))) return null
  if (!isNameList(groupNames, selections) || !isNameList(optionNames, selections)) return null
  return {
    name,
    basePrice,
    unitPrice,
    adjustments: adjustments as number[],
    groupNames,
    optionNames,
  }
}

function parseLine(value: unknown): QuotedLine | null {
  if (typeof value !== 'object' || value === null) return null
  const { menuItemId, quantity, selections, expected } = value as Record<string, unknown>

  if (!isReadableId(menuItemId)) return null
  if (!Number.isInteger(quantity)) return null
  const count = quantity as number
  if (count < 1 || count > MAX_LINE_QUANTITY) return null
  if (!Array.isArray(selections) || selections.length > MAX_MODIFIERS_PER_LINE) return null

  const parsed: RequestedSelection[] = []
  const chosen = new Set<string>()
  for (const selection of selections) {
    const one = parseSelection(selection)
    if (!one) return null
    // The till toggles an option, so it can never send the same one twice.
    const key = `${one.groupId}/${one.optionId}`
    if (chosen.has(key)) return null
    chosen.add(key)
    parsed.push(one)
  }

  const prices = parseExpected(expected, parsed.length)
  return prices ? { menuItemId, quantity: count, selections: parsed, expected: prices } : null
}

/** The line's configuration, as `lineKeyOf` in src/features/menu/modifiers.ts identifies it. */
function configurationOf(line: RequestedLine): string {
  const options = line.selections.map((s) => `${s.groupId}/${s.optionId}`).sort()
  return `${line.menuItemId}|${options.join(',')}`
}

/** Null if this is not something the till could have sent. Nothing in it is yet believed. */
export function parsePlaceOrderRequest(data: unknown): PlaceOrderRequest | null {
  if (typeof data !== 'object' || data === null) return null
  const { requestId, lines, orderType, tableNumber, operatorId, language, expectedTotal } =
    data as Record<string, unknown>

  if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) return null
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > MAX_ORDER_LINES) return null
  if (!LANGUAGES.includes(language as Language)) return null
  if (!isSen(expectedTotal)) return null

  const parsedLines: QuotedLine[] = []
  const configurations = new Set<string>()
  for (const line of lines) {
    const parsed = parseLine(line)
    if (!parsed) return null
    // Identical lines merge in the cart, so two of them did not come from a till.
    const configuration = configurationOf(parsed)
    if (configurations.has(configuration)) return null
    configurations.add(configuration)
    parsedLines.push(parsed)
  }

  // Mirrors validatePlacement in src/features/pos/order-type.ts.
  let table: string | null = null
  if (orderType === 'dine_in') {
    const trimmed = typeof tableNumber === 'string' ? tableNumber.trim() : ''
    if (!TABLE_NUMBER_PATTERN.test(trimmed)) return null
    table = trimmed
  } else if (orderType !== 'takeaway') {
    return null
  }

  const operator = operatorId === undefined || operatorId === null ? null : operatorId
  if (operator !== null && !isReadableId(operator)) return null

  return {
    requestId,
    lines: parsedLines,
    orderType,
    tableNumber: table,
    operatorId: operator,
    language: language as Language,
    expectedTotal,
  }
}

// ---- Idempotency ----------------------------------------------------------------------------

/**
 * The document a request is remembered under. Derived from the caller as well as the id, so one
 * account can never land on another's record: the same id from two accounts is two requests.
 */
export function requestRecordId(uid: string, requestId: string): string {
  return createHash('sha256').update(`${uid}\u0000${requestId}`).digest('hex')
}

/**
 * One line, whichever order its options were chosen in.
 *
 * Mirrors canonicalLine in src/features/pos/pending-order.ts. The till reuses a request id for
 * whatever it treats as the same order, so everything it treats as the same has to match here.
 */
function canonicalLine({ menuItemId, quantity, selections, expected }: QuotedLine): string {
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
 * What was asked for, so a reused id can be told from a retry. Sorted, because an order rebuilt
 * after a reload is the same order whichever items were tapped first.
 */
export function requestFingerprint(request: PlaceOrderRequest): string {
  const { lines, orderType, tableNumber, operatorId, language, expectedTotal } = request
  const canonical = JSON.stringify([
    lines.map(canonicalLine).sort(),
    orderType,
    tableNumber,
    operatorId,
    language,
    expectedTotal,
  ])
  return createHash('sha256').update(canonical).digest('hex')
}

// ---- The calendar ---------------------------------------------------------------------------

/** The date in the café's own zone, as `YYYY-MM-DD`: the same shape businessDateOf produces. */
export function businessDateAt(when: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(when)
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

// ---- The menu, as stored --------------------------------------------------------------------

interface Named {
  name: string
  names: Partial<Record<Language, string>>
}

export interface CatalogueItem extends Named {
  id: string
  categoryId: string
  price: number
  active: boolean
  modifierGroupIds: string[]
}

export interface CatalogueOption extends Named {
  id: string
  priceAdjustment: number
  active: boolean
}

export interface CatalogueGroup {
  id: string
  /** Legacy: the one item this group belongs to. Null on a shared definition. */
  itemId: string | null
  name: string
  selection: 'single' | 'multiple'
  required: boolean
  sortOrder: number
  active: boolean
  options: CatalogueOption[]
}

/** Mirrors parseNames in src/features/menu/localized-names.ts: translations only, trimmed. */
function parseTranslations(raw: unknown): Partial<Record<Language, string>> {
  if (typeof raw !== 'object' || raw === null) return {}
  const names: Partial<Record<Language, string>> = {}
  for (const language of ['ms', 'zh'] as const) {
    const value = (raw as Record<string, unknown>)[language]
    if (typeof value === 'string' && value.trim() !== '') names[language] = value.trim()
  }
  return names
}

/** Mirrors parseMenuItem in src/features/menu/types.ts. Null means it cannot be sold. */
export function parseCatalogueItem(
  id: string,
  data: Record<string, unknown> | undefined,
): CatalogueItem | null {
  if (!data) return null
  const { name, names, categoryId, price, active, modifierGroupIds } = data

  if (typeof name !== 'string' || name.trim() === '') return null
  if (typeof categoryId !== 'string' || categoryId === '') return null
  if (typeof active !== 'boolean') return null
  if (typeof price !== 'number' || !Number.isInteger(price) || price < 0) return null

  return {
    id,
    name,
    names: parseTranslations(names),
    categoryId,
    price,
    active,
    modifierGroupIds: Array.isArray(modifierGroupIds)
      ? modifierGroupIds.filter(
          (value): value is string => typeof value === 'string' && value !== '',
        )
      : [],
  }
}

function parseCatalogueOption(value: unknown): CatalogueOption | null {
  if (typeof value !== 'object' || value === null) return null
  const { id, name, names, priceAdjustment, active } = value as Record<string, unknown>

  if (typeof id !== 'string' || id === '') return null
  if (typeof name !== 'string' || name.trim() === '') return null
  if (typeof priceAdjustment !== 'number' || !Number.isInteger(priceAdjustment)) return null

  return {
    id,
    name,
    names: parseTranslations(names),
    priceAdjustment,
    active: typeof active === 'boolean' ? active : true,
  }
}

/** Mirrors parseModifierGroup in src/features/menu/modifiers.ts. */
export function parseCatalogueGroup(
  id: string,
  data: Record<string, unknown> | undefined,
): CatalogueGroup | null {
  if (!data) return null
  const { itemId, name, selection, required, sortOrder, active, options } = data

  if (typeof name !== 'string' || name.trim() === '') return null
  if (selection !== 'single' && selection !== 'multiple') return null
  if (typeof required !== 'boolean') return null
  if (typeof active !== 'boolean') return null
  if (!Array.isArray(options)) return null

  const parsedOptions: CatalogueOption[] = []
  for (const option of options) {
    const parsed = parseCatalogueOption(option)
    if (!parsed) return null
    parsedOptions.push(parsed)
  }

  return {
    id,
    itemId: typeof itemId === 'string' && itemId !== '' ? itemId : null,
    name,
    selection,
    required,
    sortOrder: typeof sortOrder === 'number' && Number.isFinite(sortOrder) ? sortOrder : 0,
    active,
    options: parsedOptions,
  }
}

/** Mirrors localizedNameOf in src/features/menu/localized-names.ts. */
function localizedName(subject: Named, language: Language): string {
  return subject.names[language] || subject.name.trim()
}

/**
 * The groups the till offers for one item.
 *
 * Mirrors groupsForItem and offeredGroupsFor in src/features/menu/modifiers.ts: attached groups
 * in the item's own order, then legacy groups naming the item by `itemId`, active ones only, each
 * with its active options, and none left empty. A group owned by a different item is not offered
 * however the list reads.
 */
export function offeredGroups(
  groups: readonly CatalogueGroup[],
  item: CatalogueItem,
): CatalogueGroup[] {
  const byId = new Map(groups.map((group) => [group.id, group]))
  const resolved: CatalogueGroup[] = []
  const taken = new Set<string>()

  for (const id of item.modifierGroupIds) {
    const group = byId.get(id)
    if (!group || taken.has(id)) continue
    if (group.itemId !== null && group.itemId !== item.id) continue
    taken.add(id)
    resolved.push(group)
  }

  const legacy = groups
    .filter((group) => group.itemId === item.id && !taken.has(group.id))
    .sort((a, b) =>
      a.sortOrder !== b.sortOrder ? a.sortOrder - b.sortOrder : a.name.localeCompare(b.name),
    )

  return [...resolved, ...legacy]
    .filter((group) => group.active)
    .map((group) => ({ ...group, options: group.options.filter((option) => option.active) }))
    .filter((group) => group.options.length > 0)
}

// ---- Pricing --------------------------------------------------------------------------------

/** One chosen option as an order records it. Mirrors SelectedModifier. */
export interface PricedModifier {
  groupId: string
  groupName: string
  optionId: string
  optionName: string
  priceAdjustment: number
}

/** One order line, in exactly the shape `createOrder` has always written. */
export interface PricedLine {
  menuItemId: string
  name: string
  basePrice: number
  unitPrice: number
  modifiers: PricedModifier[]
  quantity: number
}

export type OrderRefusal =
  | { reason: 'item-unavailable'; menuItemId: string }
  | { reason: 'selection-required'; group: string }
  | { reason: 'single-choice'; group: string }
  | { reason: 'option-withdrawn'; group: string }
  | { reason: 'option-unknown' }
  | { reason: 'invalid-request' }

export type PricedOrder =
  { ok: true; lines: PricedLine[]; total: number } | ({ ok: false } & OrderRefusal)

export interface Catalogue {
  items: ReadonlyMap<string, CatalogueItem>
  /** Ids of the categories on sale. Items in a hidden category never reach the till. */
  activeCategoryIds: ReadonlySet<string>
  groups: readonly CatalogueGroup[]
}

/**
 * Whether every line is priced as the till's cart shows it, part by part.
 *
 * Line by line because a total can hide two changes that cancel out. Part by part for the same
 * reason inside a line, where a dearer item and a cheaper option leave the unit price as it was.
 * The lines correspond by position: priceOrder keeps both them and their options in order.
 */
export function pricesMatch(lines: readonly QuotedLine[], priced: readonly PricedLine[]): boolean {
  return lines.every(({ expected }, index) => {
    const line = priced[index]
    return (
      line !== undefined &&
      expected.basePrice === line.basePrice &&
      expected.unitPrice === line.unitPrice &&
      expected.adjustments.length === line.modifiers.length &&
      expected.adjustments.every(
        (adjustment, position) => adjustment === line.modifiers[position]?.priceAdjustment,
      )
    )
  })
}

/**
 * Whether every name the order would record is the one the till's cart shows.
 *
 * An order records what the counter showed, and the menu may have moved on since the line was
 * added: an item renamed, a translation corrected, an option or group reworded. Recording the
 * menu's word then would put a name on the order that nobody saw, and the till's word cannot be
 * recorded instead, because a client must not choose what an order says. So a difference is
 * refused, like a price, and placing it again takes somebody seeing the current name first.
 *
 * Same correspondence as pricesMatch, whose lengths parseExpected has already settled.
 */
export function namesMatch(lines: readonly QuotedLine[], priced: readonly PricedLine[]): boolean {
  return lines.every(({ expected }, index) => {
    const line = priced[index]
    return (
      line !== undefined &&
      expected.name === line.name &&
      expected.groupNames.every((name, at) => name === line.modifiers[at]?.groupName) &&
      expected.optionNames.every((name, at) => name === line.modifiers[at]?.optionName)
    )
  })
}

/**
 * A value's size by Firestore's published arithmetic: a string is its UTF-8 bytes plus one, a
 * number eight, a boolean or null one, an array the sum of its values, and a map the sum of its
 * keys and values.
 */
export function storedBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value) + 1
  if (typeof value === 'number') return 8
  if (Array.isArray(value)) return value.reduce((sum, entry) => sum + storedBytes(entry), 0)
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).reduce(
      (sum, [key, entry]) => sum + storedBytes(key) + storedBytes(entry),
      0,
    )
  }
  return 1
}

/** Mirrors validateSelections in src/features/menu/modifiers.ts. Null means they are fine. */
function checkSelections(
  groups: readonly CatalogueGroup[],
  selections: readonly RequestedSelection[],
): OrderRefusal | null {
  for (const group of groups) {
    const chosen = selections.filter((selection) => selection.groupId === group.id)

    if (group.selection === 'single' && chosen.length > 1) {
      return { reason: 'single-choice', group: group.name }
    }
    if (group.required && chosen.length === 0) {
      return { reason: 'selection-required', group: group.name }
    }
    for (const selection of chosen) {
      if (!group.options.some((option) => option.id === selection.optionId)) {
        return { reason: 'option-withdrawn', group: group.name }
      }
    }
  }

  for (const selection of selections) {
    if (!groups.some((group) => group.id === selection.groupId)) {
      return { reason: 'option-unknown' }
    }
  }
  return null
}

/**
 * Works out the order from the menu alone.
 *
 * Mirrors unitPriceWith and cartTotal: an item's price plus its adjustments, floored at zero per
 * unit, times the quantity. Whole sen throughout, so every step is exact. Options keep the order
 * they were chosen in, and names are taken in the till's language, because a line records what
 * the counter showed.
 */
export function priceOrder(
  lines: readonly RequestedLine[],
  language: Language,
  catalogue: Catalogue,
): PricedOrder {
  const priced: PricedLine[] = []
  let total = 0

  for (const line of lines) {
    const item = catalogue.items.get(line.menuItemId)
    if (!item || !item.active || !catalogue.activeCategoryIds.has(item.categoryId)) {
      return { ok: false, reason: 'item-unavailable', menuItemId: line.menuItemId }
    }

    const groups = offeredGroups(catalogue.groups, item)
    const refusal = checkSelections(groups, line.selections)
    if (refusal) return { ok: false, ...refusal }

    const modifiers = line.selections.map((selection): PricedModifier => {
      // checkSelections has established that both of these exist.
      const group = groups.find((candidate) => candidate.id === selection.groupId)!
      const option = group.options.find((candidate) => candidate.id === selection.optionId)!
      return {
        groupId: group.id,
        groupName: group.name,
        optionId: option.id,
        optionName: localizedName(option, language),
        priceAdjustment: option.priceAdjustment,
      }
    })

    const adjustments = modifiers.reduce((sum, modifier) => sum + modifier.priceAdjustment, 0)
    const unitPrice = Math.max(0, item.price + adjustments)
    total += unitPrice * line.quantity

    priced.push({
      menuItemId: item.id,
      name: localizedName(item, language),
      basePrice: item.price,
      unitPrice,
      modifiers,
      quantity: line.quantity,
    })
  }

  if (!Number.isSafeInteger(total)) return { ok: false, reason: 'invalid-request' }
  return { ok: true, lines: priced, total }
}
