// @vitest-environment jsdom
/**
 * An order made by `placeOrder`, on the real Queue.
 *
 * The real board, reading through its real listeners under the real rules, as a signed-in staff
 * account. Nothing between the document and the screen is replaced, because what this proves is
 * that the server writes what that path has always read: the name and modifier snapshots, the
 * number, the placement and the `createdAt` the timer runs from. Moving a card goes through the
 * real `setFulfillment`, so the rules judge the step against the server-written order too.
 *
 * Only who is signed in and which day is shown are stubbed. Neither is what is under test.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore'
import { MemoryRouter } from 'react-router'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { QueuePage } from '@/features/pos/QueuePage'

import { businessDateAt } from '../../functions/src/order'
import { renderComponent } from '../components/render'
import {
  asRulesUser,
  call,
  createAccount,
  read,
  resetEmulators,
  signInAs,
  startHarness,
  stopHarness,
  write,
  type Account,
} from './harness'

const session = vi.hoisted(() => ({
  db: null as unknown,
  profile: null as unknown,
}))

vi.mock('@/lib/firebase', () => ({
  app: {},
  auth: {},
  get db() {
    return session.db
  },
}))

vi.mock('@/features/auth/useAuth', () => ({
  useAuth: () => ({ profile: session.profile, status: 'authenticated', role: 'staff' }),
}))

vi.mock('@/features/staff/useStaffSession', () => ({
  useStaffSession: () => ({
    operator: { id: 'alice', name: 'Alice', isSelf: false },
    operators: [],
    loading: false,
    select: () => undefined,
  }),
}))

vi.mock('@/features/pos/useBusinessToday', () => ({
  useBusinessToday: () => businessDateAt(new Date()),
  useShownBusinessDate: () => ({
    businessDate: businessDateAt(new Date()),
    showDate: () => undefined,
  }),
}))

vi.mock('@/features/pos/BusinessDateBar', () => ({ BusinessDateBar: () => null }))

const PIN = '482915'
const NASI = 'item-nasi'
const TEH = 'item-teh'
const now = new Date()

let till: Account
let admin: Account
let sequence = 0

const egg = { id: 'egg', name: 'Egg', names: { ms: 'Telur' }, priceAdjustment: 150, active: true }
const spicy = { id: 'spicy', name: 'Spicy', names: {}, priceAdjustment: 0, active: true }

/** Nasi Lemak with both options, twice, and a plain Teh, as the till sends them. */
function order(over: Record<string, unknown> = {}) {
  const inMalay = over.language === 'ms'
  return {
    requestId: `queue-request-${Date.now()}-${(sequence += 1)}`,
    lines: [
      {
        menuItemId: NASI,
        quantity: 2,
        selections: [
          { groupId: 'g', optionId: 'egg' },
          { groupId: 'g', optionId: 'spicy' },
        ],
        expected: {
          name: inMalay ? 'Nasi Lemak Biasa' : 'Nasi Lemak',
          basePrice: 800,
          unitPrice: 950,
          adjustments: [150, 0],
          groupNames: ['Add-ons', 'Add-ons'],
          optionNames: [inMalay ? 'Telur' : 'Egg', 'Spicy'],
        },
      },
      {
        menuItemId: TEH,
        quantity: 1,
        selections: [],
        expected: {
          name: 'Teh Tarik',
          basePrice: 300,
          unitPrice: 300,
          adjustments: [],
          groupNames: [],
          optionNames: [],
        },
      },
    ],
    orderType: 'dine_in',
    tableNumber: 'A3',
    operatorId: 'alice',
    language: 'en',
    expectedTotal: 2200,
    ...over,
  }
}

const place = (data: unknown) => call<{ id: string; number: number }>('placeOrder', data)

function showBoard() {
  return renderComponent(
    <MemoryRouter>
      <QueuePage />
    </MemoryRouter>,
  )
}

const card = (number: number) =>
  document.querySelector<HTMLElement>(`[data-testid="queue-card"][data-order-number="${number}"]`)

async function cardFor(number: number) {
  await waitFor(() => expect(card(number)).not.toBeNull(), { timeout: 10_000 })
  return card(number)!
}

/** Which column a card is in, as the board itself says. */
async function waitForColumn(number: number, status: string) {
  await waitFor(() => expect(card(number)?.dataset.fulfillment).toBe(status), { timeout: 10_000 })
}

beforeAll(async () => {
  await startHarness()
})

afterAll(async () => {
  await stopHarness()
})

beforeEach(async () => {
  await resetEmulators()
  admin = await createAccount('Ada Admin', 'admin')
  till = await createAccount('Counter Till', 'staff')
  session.profile = {
    uid: till.uid,
    displayName: 'Counter Till',
    role: 'staff',
    active: true,
  }
  session.db = asRulesUser(till.uid)

  await write('staffMembers/alice', { name: 'Alice', active: true, createdAt: now, updatedAt: now })
  await write('categories/mains', {
    name: 'Mains',
    sortOrder: 0,
    active: true,
    createdAt: now,
    updatedAt: now,
  })
  await write('modifierGroups/g', {
    name: 'Add-ons',
    selection: 'multiple',
    required: false,
    sortOrder: 0,
    active: true,
    options: [egg, spicy],
    createdAt: now,
    updatedAt: now,
  })
  const item = {
    categoryId: 'mains',
    sortOrder: 0,
    active: true,
    createdAt: now,
    updatedAt: now,
  }
  await write(`menuItems/${NASI}`, {
    ...item,
    name: 'Nasi Lemak',
    names: { ms: 'Nasi Lemak Biasa' },
    price: 800,
    modifierGroupIds: ['g'],
  })
  await write(`menuItems/${TEH}`, { ...item, name: 'Teh Tarik', price: 300, modifierGroupIds: [] })
  await signInAs(till)
})

describe('an order from placeOrder on the Queue', () => {
  it('appears in Pending under its number, with its total and placement', async () => {
    const { number } = await place(order())
    showBoard()

    const shown = await cardFor(number)
    expect(number).toBe(1)
    expect(shown.dataset.fulfillment).toBe('pending')
    expect(within(shown).getByRole('link').textContent).toBe('#1')
    expect(within(shown).getByTestId('queue-service').textContent).toBe('Dine-in · Table A3')
    expect(shown.textContent).toContain('RM 22.00')
  })

  it('shows a takeaway as a takeaway, with no table', async () => {
    const { number } = await place(order({ orderType: 'takeaway', tableNumber: null }))
    showBoard()

    const shown = await cardFor(number)
    expect(within(shown).getByTestId('queue-service').textContent).toBe('Takeaway')
  })

  it('lists each item with its quantity, and counts them for the kitchen', async () => {
    const { number } = await place(order())
    showBoard()

    const lines = within(await cardFor(number)).getAllByTestId('queue-line')
    expect(lines.map((line) => line.dataset.itemName)).toEqual(['Nasi Lemak', 'Teh Tarik'])
    expect(lines[0]?.textContent).toContain('2×')
    expect(lines[1]?.textContent).toContain('1×')
    expect(card(number)?.textContent).toContain('3 items')
  })

  it('shows the modifier names the kitchen has to read', async () => {
    const { number } = await place(order())
    showBoard()

    const shown = within(await cardFor(number))
    expect(shown.getAllByTestId('queue-line-modifiers').map((entry) => entry.textContent)).toEqual([
      'Egg · Spicy',
    ])
  })

  it('shows the names in the language the order was placed in', async () => {
    const { number } = await place(order({ language: 'ms' }))
    showBoard()

    const shown = within(await cardFor(number))
    expect(shown.getAllByTestId('queue-line')[0]?.dataset.itemName).toBe('Nasi Lemak Biasa')
    expect(shown.getByTestId('queue-line-modifiers').textContent).toBe('Telur · Spicy')
  })

  it('says who rang it up', async () => {
    const { number } = await place(order())
    showBoard()

    expect(within(await cardFor(number)).getByTestId('queue-operator').textContent).toContain(
      'Alice',
    )
  })

  it('runs its timer from the time the server stamped', async () => {
    const { number, id } = await place(order())
    showBoard()

    const elapsed = within(await cardFor(number)).getByTestId('order-elapsed')
    expect(elapsed.dataset.running).toBe('true')
    expect(within(elapsed).getByTestId('order-elapsed-duration').textContent).toMatch(/^\d/)

    const stored = (await read(`orders/${id}`))?.createdAt as { toMillis(): number }
    expect(Math.abs(Date.now() - stored.toMillis())).toBeLessThan(60_000)
  })

  it('keeps the oldest order first, by the numbers the server gave', async () => {
    await place(order())
    await place(order())
    await place(order())
    showBoard()

    await cardFor(3)
    const shown = screen.getAllByTestId('queue-card').map((entry) => entry.dataset.orderNumber)
    expect(shown).toEqual(['1', '2', '3'])
  })
})

describe('when its status changes', () => {
  it('moves through every step, under the rules, until it leaves the board', async () => {
    const { id, number } = await place(order())
    const { user } = showBoard()
    await cardFor(number)

    await user.click(within(card(number)!).getByTestId('queue-advance'))
    await waitForColumn(number, 'preparing')
    await waitFor(async () =>
      expect(await read(`orderFulfillment/${id}`)).toMatchObject({
        status: 'preparing',
        updatedBy: till.uid,
        updatedByStaffId: 'alice',
      }),
    )

    await user.click(within(card(number)!).getByTestId('queue-advance'))
    await waitForColumn(number, 'ready')
    await waitFor(async () => {
      const stored = await read(`orderFulfillment/${id}`)
      expect(stored?.status).toBe('ready')
      expect(stored?.readyAt).toBeTruthy()
    })

    await user.click(within(card(number)!).getByTestId('queue-advance'))
    await waitFor(() => expect(card(number)).toBeNull(), { timeout: 10_000 })
    await waitFor(async () => {
      const stored = await read(`orderFulfillment/${id}`)
      expect(stored?.status).toBe('delivered')
      expect(stored?.deliveredAt).toBeTruthy()
    })
  }, 60_000)

  it('steps back when the counter corrects a mis-tap', async () => {
    const { id, number } = await place(order())
    const { user } = showBoard()
    await cardFor(number)

    await user.click(within(card(number)!).getByTestId('queue-advance'))
    await waitForColumn(number, 'preparing')
    await waitFor(async () =>
      expect((await read(`orderFulfillment/${id}`))?.status).toBe('preparing'),
    )

    await user.click(within(card(number)!).getByTestId('queue-reverse'))
    await waitForColumn(number, 'pending')
    await waitFor(async () =>
      expect((await read(`orderFulfillment/${id}`))?.status).toBe('pending'),
    )
  }, 30_000)

  it('shows a payment on the card without moving it', async () => {
    const { id, number } = await place(order())
    showBoard()
    await cardFor(number)

    await setDoc(doc(asRulesUser(till.uid), 'orderPayments', id), {
      orderId: id,
      method: 'cash',
      amount: 2200,
      cashTendered: 2200,
      changeGiven: 0,
      paidAt: serverTimestamp(),
      paidBy: till.uid,
      paidByName: 'Counter Till',
      paidByStaffId: 'alice',
      paidByStaffName: 'Alice',
    })

    await waitFor(() => expect(card(number)?.textContent).toContain('Cash'), { timeout: 10_000 })
    expect(card(number)?.dataset.fulfillment).toBe('pending')
  })

  it('drops off the board when it is voided', async () => {
    const { id, number } = await place(order())
    await signInAs(admin)
    await call('setAdminPin', { pin: PIN })
    await signInAs(till)
    showBoard()
    await cardFor(number)

    await call('voidOrderWithAdminPin', {
      orderId: id,
      reason: 'Wrong table',
      pin: PIN,
      operatorId: 'alice',
    })

    await waitFor(() => expect(card(number)).toBeNull(), { timeout: 10_000 })
  })

  it('leaves the order itself exactly as the server wrote it', async () => {
    const { id, number } = await place(order())
    const before = await getDoc(doc(asRulesUser(till.uid), 'orders', id))
    const { user } = showBoard()
    await cardFor(number)

    await user.click(within(card(number)!).getByTestId('queue-advance'))
    await waitForColumn(number, 'preparing')

    const after = await getDoc(doc(asRulesUser(till.uid), 'orders', id))
    expect(after.data()).toEqual(before.data())
  })
})
