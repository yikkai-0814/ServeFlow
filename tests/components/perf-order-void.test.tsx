// @vitest-environment jsdom
/**
 * The two timings that span screens: Place order → the payment question, and a confirmed void →
 * the void showing on the order's page (src/lib/perf.ts).
 *
 * Both start on a click and end when the next thing is on screen, so they are checked through the
 * real pages. A failure must abandon the measurement rather than let the next success inherit it,
 * and with timing off — the default — the pages behave and print exactly as before.
 */
import { useSyncExternalStore } from 'react'

import { screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import { MessageError, message } from '@/features/i18n/messages'
import type { OrderVoid } from '@/features/pos/types'
import type { Operator } from '@/features/staff/staff-session'
import { PERF_STORAGE_KEY, resetPerf } from '@/lib/perf'

import { renderComponent } from './render'

let role: 'admin' | 'staff' = 'staff'

vi.mock('@/features/auth/useAuth', () => ({
  useAuth: () => ({
    role,
    status: 'authenticated',
    profile: {
      uid: role === 'admin' ? 'admin-uid' : 'till-uid',
      displayName: role === 'admin' ? 'Ada Admin' : 'Shared Till',
      role,
      active: true,
    },
  }),
}))

const ALICE: Operator = { id: 'alice', name: 'Alice', isSelf: false }
let operator: Operator | null = null
const operatorListeners = new Set<() => void>()
function subscribeOperator(listener: () => void) {
  operatorListeners.add(listener)
  return () => operatorListeners.delete(listener)
}

vi.mock('@/features/staff/useStaffSession', () => ({
  useStaffSession: () => ({
    operator: useSyncExternalStore(subscribeOperator, () => operator),
    operators: [ALICE],
    loading: false,
    select: () => {
      operator = ALICE
      for (const listener of operatorListeners) listener()
    },
  }),
}))

vi.mock('@/features/menu/useCategories', () => ({
  useCategories: () => ({
    categories: [{ id: 'drinks', name: 'Drinks', sortOrder: 1, active: true }],
    loading: false,
    error: null,
  }),
}))

vi.mock('@/features/menu/useMenuItems', () => ({
  useMenuItems: () => ({
    items: [
      {
        id: 'teh',
        name: 'Teh Tarik',
        categoryId: 'drinks',
        price: 450,
        sortOrder: 1,
        active: true,
        modifierGroupIds: [],
      },
    ],
    loading: false,
    error: null,
  }),
}))

vi.mock('@/features/menu/useModifierGroups', () => ({
  useModifierGroups: () => ({ groups: [], data: [], loading: false, error: null }),
}))

const createOrder = vi.hoisted(() => vi.fn())
const voidOrder = vi.hoisted(() => vi.fn())
const voidOrderWithAdminPin = vi.hoisted(() => vi.fn())
const fetchAdminPinStatus = vi.hoisted(() => vi.fn())

vi.mock('@/features/pos/pos-api', () => ({ createOrder }))
vi.mock('@/features/pos/payment-api', () => ({ recordPayment: vi.fn() }))
vi.mock('@/features/pos/void-api', () => ({ voidOrder }))
vi.mock('@/features/pos/void-pin-api', () => ({ voidOrderWithAdminPin, fetchAdminPinStatus }))
vi.mock('@/features/pos/manager-authorization', () => ({ withManagerAuthorization: vi.fn() }))
vi.mock('@/features/pos/fulfillment-api', () => ({
  setFulfillment: vi.fn(),
  correctFulfillment: vi.fn(),
}))

/** The void record as the listener would deliver it, once the server has written it. */
let voidRecord: OrderVoid | null = null
const voidListeners = new Set<() => void>()
function subscribeVoid(listener: () => void) {
  voidListeners.add(listener)
  return () => voidListeners.delete(listener)
}
function voidArrives() {
  voidRecord = {
    orderId: 'order-7',
    reason: 'Wrong item',
    amount: 900,
    voidedAt: null,
    voidedBy: 'admin-uid',
    voidedByName: 'Ada Admin',
    initiatedByStaffId: 'alice',
    initiatedByStaffName: 'Alice',
  } as OrderVoid
  for (const listener of voidListeners) listener()
}

vi.mock('@/features/pos/useOrderDetail', () => ({
  useOrderDetail: (orderId: string | undefined) => {
    const voided = useSyncExternalStore(subscribeVoid, () => voidRecord)
    if (orderId !== 'order-7') {
      // The order the till just placed, as PaymentDecision reads it.
      return { view: { payment: { status: 'unpaid' } }, loading: false, error: null }
    }
    return {
      view: {
        order: {
          id: 'order-7',
          number: 7,
          businessDate: '2026-11-13',
          lines: [
            {
              menuItemId: 'teh',
              name: 'Teh Tarik',
              basePrice: 450,
              unitPrice: 450,
              modifiers: [],
              quantity: 2,
            },
          ],
          total: 900,
          orderType: 'takeaway',
          tableNumber: null,
          createdAt: { toDate: () => new Date('2026-11-13T02:00:00.000Z') },
          createdBy: 'till-uid',
          createdByName: 'Shared Till',
          staffId: 'alice',
          staffName: 'Alice',
        },
        fulfillment: 'pending',
        payment: { status: 'unpaid' },
        voided,
        overall: voided ? 'voided' : 'payment-outstanding',
        fulfillmentRecord: null,
        paymentRecord: null,
      },
      loading: false,
      error: null,
    }
  },
}))

import { OrderDetailPage } from '@/features/pos/OrderDetailPage'
import { TerminalPage } from '@/features/pos/TerminalPage'

let info: MockInstance<typeof console.info>

function timing(on: boolean) {
  resetPerf()
  if (on) localStorage.setItem(PERF_STORAGE_KEY, '1')
  else localStorage.removeItem(PERF_STORAGE_KEY)
}

const named = (name: string) => info.mock.calls.filter((call) => call[1] === name)

beforeEach(() => {
  role = 'staff'
  operator = null
  voidRecord = null
  createOrder.mockReset()
  voidOrder.mockReset()
  voidOrderWithAdminPin.mockReset()
  fetchAdminPinStatus.mockReset()
  fetchAdminPinStatus.mockResolvedValue({ pinAvailable: true })
  info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.removeItem(PERF_STORAGE_KEY)
  resetPerf()
})

// ---- Place order → payment question ------------------------------------------------------------

type User = ReturnType<typeof renderComponent>['user']

/** As TerminalPage.test.tsx does it: dine-in, the default, at table 5. */
async function ringUpAnOrder(user: User) {
  await user.click(screen.getByText('Alice'))
  await user.click(screen.getByText('Teh Tarik'))
  await user.type(screen.getByLabelText('Table number'), '5')
  await user.click(screen.getByTestId('place-order'))
}

describe('Place order → the payment question', () => {
  it('is timed once the payment question is on screen', async () => {
    timing(true)
    createOrder.mockResolvedValue({ id: 'order-1', number: 1 })
    const { user } = renderComponent(<TerminalPage />)

    await ringUpAnOrder(user)

    await waitFor(() => expect(screen.queryByTestId('payment-decision')).not.toBeNull())
    expect(named('order.toPaymentStep')).toHaveLength(1)
  })

  it('is abandoned when the order is refused, so a later success is not charged for it', async () => {
    timing(true)
    createOrder.mockRejectedValueOnce(new MessageError(message('terminal.placeFailed')))
    const { user } = renderComponent(<TerminalPage />)

    await ringUpAnOrder(user)
    await waitFor(() => expect(screen.getByText('The order could not be placed.')).not.toBeNull())
    expect(named('order.toPaymentStep')).toHaveLength(0)

    // The cart is still there; placing it again succeeds, and is measured once, on its own.
    createOrder.mockResolvedValue({ id: 'order-1', number: 1 })
    await user.click(screen.getByTestId('place-order'))
    await waitFor(() => expect(screen.queryByTestId('payment-decision')).not.toBeNull())
    expect(named('order.toPaymentStep')).toHaveLength(1)
  })

  it('places the order the same way and prints nothing when switched off', async () => {
    timing(false)
    createOrder.mockResolvedValue({ id: 'order-1', number: 1 })
    const { user } = renderComponent(<TerminalPage />)

    await ringUpAnOrder(user)

    await waitFor(() => expect(screen.queryByTestId('payment-decision')).not.toBeNull())
    expect(createOrder).toHaveBeenCalledOnce()
    expect(info).not.toHaveBeenCalled()
  })
})

// ---- Confirmed void → shown on the page --------------------------------------------------------

function renderOrder() {
  return renderComponent(
    <MemoryRouter initialEntries={['/orders/order-7']}>
      <Routes>
        <Route path="/orders/:orderId" element={<OrderDetailPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

async function confirmVoid(user: User) {
  await user.click(screen.getByTestId('void-order'))
  await user.selectOptions(screen.getByTestId('void-reason'), 'wrong-item')
}

describe('a confirmed void → shown on the order', () => {
  it('is timed for an admin when the void record arrives, with the route only', async () => {
    timing(true)
    role = 'admin'
    voidOrder.mockImplementation(async () => voidArrives())
    const { user } = renderOrder()

    await confirmVoid(user)
    await user.click(screen.getByTestId('confirm-void'))

    await waitFor(() => expect(screen.queryByTestId('voided-banner')).not.toBeNull())
    expect(named('void.toBanner').map((call) => call[3])).toEqual([{ route: 'admin' }])
  })

  it('is timed for staff with an admin PIN, and never prints the PIN or the reason', async () => {
    timing(true)
    voidOrderWithAdminPin.mockImplementation(async () => voidArrives())
    const { user } = renderOrder()

    await confirmVoid(user)
    await user.click(screen.getByTestId('continue-void'))
    await user.type(screen.getByTestId('admin-pin'), '482913')
    await user.click(screen.getByTestId('confirm-void'))

    await waitFor(() => expect(screen.queryByTestId('voided-banner')).not.toBeNull())
    expect(named('void.toBanner').map((call) => call[3])).toEqual([{ route: 'pin' }])
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/482913|Wrong item|order-7/)
  })

  it('is abandoned when the void is refused', async () => {
    timing(true)
    voidOrderWithAdminPin.mockRejectedValue(new MessageError(message('void.pinIncorrect')))
    const { user } = renderOrder()

    await confirmVoid(user)
    await user.click(screen.getByTestId('continue-void'))
    await user.type(screen.getByTestId('admin-pin'), '000000')
    await user.click(screen.getByTestId('confirm-void'))

    await waitFor(() => expect(voidOrderWithAdminPin).toHaveBeenCalledOnce())
    expect(named('void.toBanner')).toHaveLength(0)
  })

  it('measures nothing for an order that was already voided when it was opened', () => {
    timing(true)
    voidArrives()
    renderOrder()

    expect(screen.queryByTestId('voided-banner')).not.toBeNull()
    expect(named('void.toBanner')).toHaveLength(0)
  })

  it('voids the same way and prints nothing when switched off', async () => {
    timing(false)
    role = 'admin'
    voidOrder.mockImplementation(async () => voidArrives())
    const { user } = renderOrder()

    await confirmVoid(user)
    await user.click(screen.getByTestId('confirm-void'))

    await waitFor(() => expect(screen.queryByTestId('voided-banner')).not.toBeNull())
    expect(voidOrder).toHaveBeenCalledOnce()
    expect(info).not.toHaveBeenCalled()
  })
})
