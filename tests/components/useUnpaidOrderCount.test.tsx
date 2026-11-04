// @vitest-environment jsdom
/**
 * Today's unpaid-order count, as the navigation badge receives it — and its wiring into both
 * navigations through AppShell.
 *
 * The three live hooks (orders by date, then their payment and void records) are replaced by a
 * store the test drives, so "a snapshot arrives" can be played out step by step; the counting
 * itself is the real `buildOrderViews` + `countUnpaidOrders`, the Unpaid filter's own rule.
 */
import { useSyncExternalStore } from 'react'

import { act, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Order, OrderPayment, OrderVoid } from '@/features/pos/types'

import { renderComponent as render } from './render'

const TODAY = '2026-11-03'

function order(id: string, number: number): Order {
  return {
    id,
    number,
    businessDate: TODAY,
    lines: [
      {
        menuItemId: 'm1',
        name: 'Teh Tarik',
        basePrice: 450,
        unitPrice: 450,
        modifiers: [],
        quantity: 1,
      },
    ],
    total: 450,
    orderType: 'takeaway',
    tableNumber: null,
    paymentMethod: null,
    cashTendered: null,
    changeGiven: null,
    createdAt: null,
    createdBy: 'till',
    createdByName: 'Counter Till',
    staffId: 'alice',
    staffName: 'Alice',
  }
}

const paymentFor = (orderId: string): OrderPayment => ({
  orderId,
  method: 'cash',
  amount: 450,
  cashTendered: 500,
  changeGiven: 50,
  paidAt: null,
  paidBy: 'till',
  paidByName: 'Counter Till',
  paidByStaffId: 'alice',
  paidByStaffName: 'Alice',
})

const voidFor = (orderId: string): OrderVoid => ({
  orderId,
  reason: 'Wrong item',
  amount: 450,
  voidedAt: null,
  voidedBy: 'admin',
  voidedByName: 'Admin',
  initiatedByStaffId: 'alice',
  initiatedByStaffName: 'Alice',
})

// ---- The live data, as the listeners would hold it --------------------------------------------

const store = {
  orders: [] as Order[],
  payments: new Map<string, OrderPayment>(),
  voids: new Map<string, OrderVoid>(),
  ordersLoading: false,
  sidecarsLoading: false,
  error: false,
  paymentsError: false,
  voidsError: false,
}
let version = 0
const listeners = new Set<() => void>()
const askedForDates: string[] = []

function update(change: () => void) {
  act(() => {
    change()
    version += 1
    for (const listener of listeners) listener()
  })
}

function useVersion() {
  return useSyncExternalStore(
    (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => version,
  )
}

/** Stable per snapshot, as the real hooks' results are. */
const cache = new Map<string, { version: number; value: unknown }>()
function stable<T>(key: string, current: number, make: () => T): T {
  const hit = cache.get(key)
  if (hit?.version === current) return hit.value as T
  const value = make()
  cache.set(key, { version: current, value })
  return value
}

vi.mock('@/features/pos/useBusinessToday', () => ({ useBusinessToday: () => TODAY }))

vi.mock('@/features/pos/useOrders', () => ({
  useOrders: (businessDate: string) => {
    askedForDates.push(businessDate)
    const current = useVersion()
    return stable('orders', current, () => ({
      orders: store.ordersLoading ? [] : store.orders,
      loading: store.ordersLoading,
      error: store.error ? { key: 'load.orders' } : null,
    }))
  },
}))

vi.mock('@/features/pos/useOrderPayments', () => ({
  useOrderPayments: () => {
    const current = useVersion()
    return stable('payments', current, () => ({
      payments: store.payments,
      loading: store.sidecarsLoading,
      error: store.paymentsError ? { key: 'load.paymentsDate' } : null,
    }))
  },
}))

vi.mock('@/features/pos/useOrderVoids', () => ({
  useOrderVoids: () => {
    const current = useVersion()
    return stable('voids', current, () => ({
      voids: store.voids,
      loading: store.sidecarsLoading,
      error: store.voidsError ? { key: 'load.voidsDate' } : null,
    }))
  },
}))

// AppShell's other occupants are not under test here.
vi.mock('@/components/layout/Topbar', () => ({ Topbar: () => null }))
vi.mock('@/features/auth/useAuth', () => ({
  useAuth: () => ({ role: 'staff', status: 'authenticated', profile: null }),
}))

import { AppShell } from '@/components/layout/AppShell'
import { useUnpaidOrderCount } from '@/features/pos/useUnpaidOrderCount'

function Probe() {
  const count = useUnpaidOrderCount()
  return <output data-testid="count">{count === null ? 'none' : count}</output>
}

const count = () => screen.getByTestId('count').textContent

beforeEach(() => {
  // #1 and #2 Pay later, #3 paid, #4 voided before payment.
  store.orders = [order('o1', 1), order('o2', 2), order('o3', 3), order('o4', 4)]
  store.payments = new Map([['o3', paymentFor('o3')]])
  store.voids = new Map([['o4', voidFor('o4')]])
  store.ordersLoading = false
  store.sidecarsLoading = false
  store.error = false
  store.paymentsError = false
  store.voidsError = false
  askedForDates.length = 0
  version += 1
  cache.clear()
})

describe('useUnpaidOrderCount', () => {
  it('asks for today’s orders — not any other day', () => {
    render(<Probe />)
    expect(new Set(askedForDates)).toEqual(new Set([TODAY]))
  })

  it('counts Pay later orders, leaving out paid and voided ones', () => {
    render(<Probe />)
    expect(count()).toBe('2')
  })

  it('has no number until the orders and their payment and void records have all arrived', () => {
    store.sidecarsLoading = true
    render(<Probe />)
    expect(count()).toBe('none')
    update(() => (store.sidecarsLoading = false))
    expect(count()).toBe('2')
  })

  it('goes up when a new Pay later order arrives', () => {
    render(<Probe />)
    update(() => (store.orders = [order('o5', 5), ...store.orders]))
    expect(count()).toBe('3')
  })

  it('goes down when an unpaid order is paid', () => {
    render(<Probe />)
    update(() => (store.payments = new Map([...store.payments, ['o1', paymentFor('o1')]])))
    expect(count()).toBe('1')
  })

  it('goes down when an unpaid order is voided', () => {
    render(<Probe />)
    update(() => (store.voids = new Map([...store.voids, ['o2', voidFor('o2')]])))
    expect(count()).toBe('1')
  })

  it('reaches zero when everything is settled', () => {
    render(<Probe />)
    update(() => {
      store.payments = new Map([...store.payments, ['o1', paymentFor('o1')]])
      store.voids = new Map([...store.voids, ['o2', voidFor('o2')]])
    })
    expect(count()).toBe('0')
  })

  it('has no number when the orders cannot be read, rather than a wrong one', () => {
    store.error = true
    render(<Probe />)
    expect(count()).toBe('none')
  })

  it('drops a number it was showing when the payment records stop being readable', () => {
    render(<Probe />)
    expect(count()).toBe('2')
    update(() => (store.paymentsError = true))
    expect(count()).toBe('none')
  })

  it('drops a number it was showing when the void records stop being readable', () => {
    render(<Probe />)
    expect(count()).toBe('2')
    update(() => (store.voidsError = true))
    expect(count()).toBe('none')
  })
})

describe('AppShell: one count, both navigations', () => {
  function renderShell() {
    return render(
      <MemoryRouter initialEntries={['/pos']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/pos" element={<p>page</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )
  }

  const navs = () => screen.getAllByRole('navigation', { name: 'Main' })
  const badgeIn = (nav: HTMLElement) =>
    within(within(nav).getByRole('link', { name: 'Orders' })).queryByTestId('nav-unpaid-badge')

  it('badges Orders in the sidebar and the bottom bar, and follows the count live', () => {
    renderShell()
    // The sidebar and the bottom bar — CSS shows one of them at a time.
    expect(navs()).toHaveLength(2)
    for (const nav of navs()) expect(badgeIn(nav)?.textContent).toBe('2')

    update(() => (store.payments = new Map([...store.payments, ['o1', paymentFor('o1')]])))
    for (const nav of navs()) expect(badgeIn(nav)?.textContent).toBe('1')

    update(() => (store.voids = new Map([...store.voids, ['o2', voidFor('o2')]])))
    for (const nav of navs()) expect(badgeIn(nav)).toBeNull()
  })
})
