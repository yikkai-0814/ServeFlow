// @vitest-environment jsdom
/**
 * When the till asks for an order warm-up, and that it never depends on one.
 *
 * The warm-up module is replaced, so these watch the till's side alone: it asks on opening, on
 * coming back into view, when an operator is chosen and on the first item — only for a loaded
 * staff session — and an order is placed exactly the same whether a warm-up is still running,
 * failed, or threw. tests/unit/order-warmup.test.ts covers the module itself, and
 * terminal-warmup-throttle.test.tsx the two together.
 */
import { act, useSyncExternalStore } from 'react'

import { screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Operator } from '@/features/staff/staff-session'

import { renderComponent } from './render'

interface Session {
  status: 'loading' | 'authenticated' | 'unauthenticated'
  role: 'admin' | 'staff' | null
  uid: string | null
}

let session: Session = { status: 'authenticated', role: 'staff', uid: 'till-uid' }
const sessionListeners = new Set<() => void>()
function setSession(next: Session) {
  session = next
  for (const listener of sessionListeners) listener()
}
function subscribeSession(listener: () => void) {
  sessionListeners.add(listener)
  return () => sessionListeners.delete(listener)
}

vi.mock('@/features/auth/useAuth', () => ({
  useAuth: () => {
    const current = useSyncExternalStore(subscribeSession, () => session)
    return {
      status: current.status,
      role: current.role,
      profile: current.uid
        ? { uid: current.uid, displayName: 'Shared Till', role: current.role, active: true }
        : null,
    }
  },
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
      {
        id: 'kopi',
        name: 'Kopi O',
        categoryId: 'drinks',
        price: 350,
        sortOrder: 2,
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

const warmUpOrders = vi.hoisted(() => vi.fn())
const createOrder = vi.hoisted(() => vi.fn())

vi.mock('@/features/pos/order-warmup', () => ({ warmUpOrders }))
vi.mock('@/features/pos/pos-api', () => ({ createOrder }))
vi.mock('@/features/pos/payment-api', () => ({ recordPayment: vi.fn() }))
vi.mock('@/features/pos/useOrderDetail', () => ({
  useOrderDetail: () => ({ view: { payment: { status: 'unpaid' } }, loading: false, error: null }),
}))

import { TerminalPage } from '@/features/pos/TerminalPage'

let visibility: DocumentVisibilityState = 'visible'

function becomes(state: DocumentVisibilityState) {
  visibility = state
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

beforeEach(() => {
  setSession({ status: 'authenticated', role: 'staff', uid: 'till-uid' })
  operator = null
  visibility = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  warmUpOrders.mockReset()
  createOrder.mockReset()
  createOrder.mockResolvedValue({ id: 'order-1', number: 1 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

type User = ReturnType<typeof renderComponent>['user']

/** A menu tile, by its canonical name — the cart lists the same name once it holds the item. */
function tile(name: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(
    `[data-testid="pos-item"][data-item-name="${name}"]`,
  )
  if (!found) throw new Error(`no menu tile for ${name}`)
  return found
}

async function ringUp(user: User) {
  await user.click(screen.getByText('Alice'))
  await user.click(screen.getByText('Teh Tarik'))
  await user.type(screen.getByLabelText('Table number'), '5')
  await user.click(screen.getByTestId('place-order'))
}

// ---- When it asks -------------------------------------------------------------------------------

describe('the till asks for a warm-up', () => {
  it('when it opens for a staff session, with that account', () => {
    renderComponent(<TerminalPage />)
    expect(warmUpOrders).toHaveBeenCalledOnce()
    expect(warmUpOrders).toHaveBeenCalledWith('till-uid')
  })

  it('when it comes back into view, and not when it is hidden', () => {
    renderComponent(<TerminalPage />)
    warmUpOrders.mockClear()

    becomes('hidden')
    expect(warmUpOrders).not.toHaveBeenCalled()

    becomes('visible')
    expect(warmUpOrders).toHaveBeenCalledOnce()
    expect(warmUpOrders).toHaveBeenCalledWith('till-uid')
  })

  it('when an operator is chosen, and on the first item only', async () => {
    const { user } = renderComponent(<TerminalPage />)
    warmUpOrders.mockClear()

    await user.click(screen.getByText('Alice'))
    expect(warmUpOrders).toHaveBeenCalledOnce()

    await user.click(tile('Teh Tarik'))
    expect(warmUpOrders).toHaveBeenCalledTimes(2)

    // Once the cart has something in it, adding more is not a new order starting.
    await user.click(tile('Kopi O'))
    await user.click(tile('Teh Tarik'))
    expect(warmUpOrders).toHaveBeenCalledTimes(2)
  })

  it('never on a timer while the till sits still', async () => {
    vi.useFakeTimers()
    try {
      renderComponent(<TerminalPage />)
      warmUpOrders.mockClear()
      await act(async () => {
        vi.advanceTimersByTime(60 * 60_000)
      })
      expect(warmUpOrders).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the till does not ask', () => {
  it.each<[string, Session]>([
    ['while the session is loading', { status: 'loading', role: null, uid: 'till-uid' }],
    ['when signed out', { status: 'unauthenticated', role: null, uid: null }],
    ['for an admin', { status: 'authenticated', role: 'admin', uid: 'admin-uid' }],
  ])('%s', (_label, state) => {
    setSession(state)
    renderComponent(<TerminalPage />)
    becomes('hidden')
    becomes('visible')
    expect(warmUpOrders).not.toHaveBeenCalled()
  })

  it('after the session is lost, even when the till comes back into view', () => {
    renderComponent(<TerminalPage />)
    warmUpOrders.mockClear()

    act(() => setSession({ status: 'unauthenticated', role: null, uid: null }))
    becomes('hidden')
    becomes('visible')

    expect(warmUpOrders).not.toHaveBeenCalled()
  })

  it('for the previous account after a switch — only ever for the one now loaded', () => {
    renderComponent(<TerminalPage />)
    act(() => setSession({ status: 'authenticated', role: 'staff', uid: 'second-till' }))
    warmUpOrders.mockClear()

    becomes('hidden')
    becomes('visible')

    // One listener, for the new account: the old one was removed with its session.
    expect(warmUpOrders.mock.calls).toEqual([['second-till']])
  })

  it('once the till has closed', () => {
    const { unmount } = renderComponent(<TerminalPage />)
    unmount()
    warmUpOrders.mockClear()

    becomes('hidden')
    becomes('visible')

    expect(warmUpOrders).not.toHaveBeenCalled()
  })
})

// ---- Independence -------------------------------------------------------------------------------

describe('placing an order never depends on a warm-up', () => {
  async function expectOrderPlaced(user: User) {
    await ringUp(user)
    await waitFor(() => expect(screen.queryByTestId('payment-decision')).not.toBeNull())
    expect(createOrder).toHaveBeenCalledOnce()
    // The order sent is the till's own: nothing about a warm-up reaches it.
    expect(JSON.stringify(createOrder.mock.calls[0])).not.toContain('warmup')
  }

  it('while a warm-up is still running and never finishes', async () => {
    warmUpOrders.mockImplementation(() => {
      void new Promise(() => undefined)
    })
    const { user } = renderComponent(<TerminalPage />)
    await expectOrderPlaced(user)
  })

  it('when every warm-up fails', async () => {
    warmUpOrders.mockImplementation(() => {
      void Promise.reject(new Error('unavailable')).catch(() => undefined)
    })
    const { user } = renderComponent(<TerminalPage />)
    await expectOrderPlaced(user)
  })

  it('even if the warm-up throws outright, and nothing is shown for it', async () => {
    warmUpOrders.mockImplementation(() => {
      throw new Error('warm-up exploded')
    })
    const { user } = renderComponent(<TerminalPage />)

    await expectOrderPlaced(user)
    expect(screen.queryByText(/warm-up exploded/)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
