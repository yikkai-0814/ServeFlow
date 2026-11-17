// @vitest-environment jsdom
/**
 * When the order page asks for a void warm-up, and that a void never depends on one.
 *
 * The warm-up module is replaced, so these watch the page's side alone: it asks when a staff member
 * opens an order that can still be voided, when the page comes back into view and when the void
 * dialog opens — and a PIN void is sent and shown exactly the same whether a warm-up is still
 * running, failed or threw. tests/unit/void-warmup.test.ts covers the module, and
 * order-void-warmup-throttle.test.tsx the two together.
 */
import { act, useSyncExternalStore } from 'react'

import { screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { OrderVoid } from '@/features/pos/types'

import { renderComponent } from './render'

// ---- A session, and an order, the test can change while the page is open -----------------------

interface Session {
  status: 'loading' | 'authenticated' | 'unauthenticated'
  role: 'admin' | 'staff' | null
  uid: string | null
}

interface OrderState {
  loading: boolean
  voided: OrderVoid | null
  /**
   * The order document has arrived but its void, payment and fulfilment records have not, as
   * useOrderDetail reports it: a view, with no void in it yet, and `loading` still true.
   */
  recordsLoading?: boolean
}

let session: Session = { status: 'authenticated', role: 'staff', uid: 'till-uid' }
let orderState: OrderState = { loading: false, voided: null }
const storeListeners = new Set<() => void>()
const notify = () => {
  for (const listener of storeListeners) listener()
}
const subscribe = (listener: () => void) => {
  storeListeners.add(listener)
  return () => storeListeners.delete(listener)
}
function setSession(next: Session) {
  session = next
  notify()
}
function setOrder(next: OrderState) {
  orderState = next
  notify()
}

const VOID_RECORD = {
  orderId: 'order-7',
  reason: 'Wrong item',
  amount: 900,
  voidedAt: null,
  voidedBy: 'admin-uid',
  voidedByName: 'Ada Admin',
  initiatedByStaffId: 'till-uid',
  initiatedByStaffName: 'Shared Till',
} as OrderVoid

vi.mock('@/features/auth/useAuth', () => ({
  useAuth: () => {
    const current = useSyncExternalStore(subscribe, () => session)
    return {
      status: current.status,
      role: current.role,
      profile: current.uid
        ? { uid: current.uid, displayName: 'Shared Till', role: current.role, active: true }
        : null,
    }
  },
}))

vi.mock('@/features/staff/useStaffSession', () => ({
  useStaffSession: () => ({ operator: null, operators: [], loading: false, select: () => {} }),
}))

vi.mock('@/features/pos/useOrderDetail', () => ({
  useOrderDetail: () => {
    const state = useSyncExternalStore(subscribe, () => orderState)
    if (state.loading) return { view: null, loading: true, error: null }
    return {
      view: {
        order: {
          id: 'order-7',
          number: 7,
          businessDate: '2026-11-17',
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
          createdAt: { toDate: () => new Date('2026-11-17T02:00:00.000Z') },
          createdBy: 'till-uid',
          createdByName: 'Shared Till',
          staffId: 'till-uid',
          staffName: 'Shared Till',
        },
        fulfillment: 'pending',
        payment: { status: 'unpaid' },
        // Until its record has answered, a void is not in the view even if one exists.
        voided: state.recordsLoading ? null : state.voided,
        overall: state.voided && !state.recordsLoading ? 'voided' : 'payment-outstanding',
        fulfillmentRecord: null,
        paymentRecord: null,
      },
      loading: state.recordsLoading === true,
      error: null,
    }
  },
}))

const warmUpVoids = vi.hoisted(() => vi.fn())
const voidOrderWithAdminPin = vi.hoisted(() => vi.fn())
const fetchAdminPinStatus = vi.hoisted(() => vi.fn())
const voidOrder = vi.hoisted(() => vi.fn())

vi.mock('@/features/pos/void-warmup', () => ({ warmUpVoids }))
vi.mock('@/features/pos/void-pin-api', () => ({ voidOrderWithAdminPin, fetchAdminPinStatus }))
vi.mock('@/features/pos/void-api', () => ({ voidOrder }))
vi.mock('@/features/pos/manager-authorization', () => ({ withManagerAuthorization: vi.fn() }))
vi.mock('@/features/pos/payment-api', () => ({ recordPayment: vi.fn() }))
vi.mock('@/features/pos/fulfillment-api', () => ({
  setFulfillment: vi.fn(),
  correctFulfillment: vi.fn(),
}))

import { OrderDetailPage } from '@/features/pos/OrderDetailPage'
import { VoidOrderDialog } from '@/features/pos/VoidOrderDialog'

let visibility: DocumentVisibilityState = 'visible'

function becomes(state: DocumentVisibilityState) {
  visibility = state
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

function renderOrder() {
  return renderComponent(
    <MemoryRouter initialEntries={['/orders/order-7']}>
      <Routes>
        <Route path="/orders/:orderId" element={<OrderDetailPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

type User = ReturnType<typeof renderComponent>['user']

/** A staff PIN void, start to finish, with the PIN and reason the warm-up must never see. */
async function pinVoid(user: User) {
  await waitFor(() => expect(fetchAdminPinStatus).toHaveBeenCalled())
  await user.click(screen.getByTestId('void-order'))
  await user.selectOptions(screen.getByTestId('void-reason'), 'wrong-item')
  await user.click(screen.getByTestId('continue-void'))
  await user.type(screen.getByTestId('admin-pin'), '482913')
  await user.click(screen.getByTestId('confirm-void'))
}

beforeEach(() => {
  session = { status: 'authenticated', role: 'staff', uid: 'till-uid' }
  orderState = { loading: false, voided: null }
  visibility = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  warmUpVoids.mockReset()
  voidOrderWithAdminPin.mockReset()
  voidOrderWithAdminPin.mockImplementation(async () =>
    setOrder({ loading: false, voided: VOID_RECORD }),
  )
  fetchAdminPinStatus.mockReset()
  fetchAdminPinStatus.mockResolvedValue({ pinAvailable: true })
  voidOrder.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---- T1: the order opening ---------------------------------------------------------------------

describe('opening an order', () => {
  it('asks for a warm-up when staff open an order that can be voided, with that account', () => {
    renderOrder()
    expect(warmUpVoids.mock.calls).toEqual([['till-uid']])
  })

  it('waits for the order to load, then asks once', () => {
    setOrder({ loading: true, voided: null })
    renderOrder()
    expect(warmUpVoids).not.toHaveBeenCalled()

    act(() => setOrder({ loading: false, voided: null }))
    expect(warmUpVoids.mock.calls).toEqual([['till-uid']])
  })

  it('waits for the void record too, then asks once the order is confirmed not voided', () => {
    // The order document has loaded; whether it was voided has not.
    setOrder({ loading: false, voided: null, recordsLoading: true })
    renderOrder()
    becomes('hidden')
    becomes('visible')
    expect(warmUpVoids).not.toHaveBeenCalled()

    // Everything has answered, and there is no void.
    act(() => setOrder({ loading: false, voided: null }))
    expect(warmUpVoids.mock.calls).toEqual([['till-uid']])
  })

  it('never asks for an order whose void record arrives after the order itself', () => {
    setOrder({ loading: false, voided: VOID_RECORD, recordsLoading: true })
    renderOrder()
    becomes('hidden')
    becomes('visible')

    act(() => setOrder({ loading: false, voided: VOID_RECORD }))
    becomes('hidden')
    becomes('visible')
    expect(warmUpVoids).not.toHaveBeenCalled()
  })

  it.each<[string, () => void]>([
    ['an order that is already voided', () => setOrder({ loading: false, voided: VOID_RECORD })],
    [
      'an admin, who voids without the function',
      () => setSession({ status: 'authenticated', role: 'admin', uid: 'admin-uid' }),
    ],
    [
      'a session still loading',
      () => setSession({ status: 'loading', role: null, uid: 'till-uid' }),
    ],
    ['nobody signed in', () => setSession({ status: 'unauthenticated', role: null, uid: null })],
  ])('does not ask for %s', (_label, arrange) => {
    arrange()
    renderOrder()
    becomes('hidden')
    becomes('visible')
    expect(warmUpVoids).not.toHaveBeenCalled()
  })

  it('does not wait for, or depend on, whether a PIN is available', () => {
    fetchAdminPinStatus.mockReturnValue(new Promise(() => undefined))
    renderOrder()
    expect(warmUpVoids.mock.calls).toEqual([['till-uid']])
  })

  it('never asks on a timer while the page sits open', async () => {
    vi.useFakeTimers()
    try {
      renderOrder()
      warmUpVoids.mockClear()
      await act(async () => {
        vi.advanceTimersByTime(60 * 60_000)
      })
      expect(warmUpVoids).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---- T3: coming back into view -----------------------------------------------------------------

describe('the page coming back into view', () => {
  it('asks again when visible, not when hidden', () => {
    renderOrder()
    warmUpVoids.mockClear()

    becomes('hidden')
    expect(warmUpVoids).not.toHaveBeenCalled()
    becomes('visible')
    expect(warmUpVoids.mock.calls).toEqual([['till-uid']])
  })

  it('stops asking once the order has been voided', () => {
    renderOrder()
    act(() => setOrder({ loading: false, voided: VOID_RECORD }))
    warmUpVoids.mockClear()

    becomes('hidden')
    becomes('visible')
    expect(warmUpVoids).not.toHaveBeenCalled()
  })

  it('stops asking once the session is lost', () => {
    renderOrder()
    act(() => setSession({ status: 'unauthenticated', role: null, uid: null }))
    warmUpVoids.mockClear()

    becomes('hidden')
    becomes('visible')
    expect(warmUpVoids).not.toHaveBeenCalled()
  })

  it('asks only for the account now loaded after a switch — one listener, not two', () => {
    renderOrder()
    act(() => setSession({ status: 'authenticated', role: 'staff', uid: 'second-till' }))
    warmUpVoids.mockClear()

    becomes('hidden')
    becomes('visible')
    expect(warmUpVoids.mock.calls).toEqual([['second-till']])
  })

  it('stops asking once the page has closed', () => {
    const { unmount } = renderOrder()
    unmount()
    warmUpVoids.mockClear()

    becomes('hidden')
    becomes('visible')
    expect(warmUpVoids).not.toHaveBeenCalled()
  })
})

// ---- T2: the void dialog opening ---------------------------------------------------------------

describe('the void dialog opening', () => {
  it('asks when the dialog opens, and not again for its steps or for closing', async () => {
    const { user } = renderOrder()
    await waitFor(() => expect(fetchAdminPinStatus).toHaveBeenCalled())
    warmUpVoids.mockClear()

    await user.click(screen.getByTestId('void-order'))
    expect(warmUpVoids.mock.calls).toEqual([['till-uid']])

    await user.selectOptions(screen.getByTestId('void-reason'), 'wrong-item')
    await user.click(screen.getByTestId('continue-void'))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(warmUpVoids).toHaveBeenCalledOnce()

    // Opening it again is another trigger; void-warmup.ts decides whether it sends anything.
    await user.click(screen.getByTestId('void-order'))
    expect(warmUpVoids).toHaveBeenCalledTimes(2)
  })

  it('does not ask for an admin opening the dialog', async () => {
    setSession({ status: 'authenticated', role: 'admin', uid: 'admin-uid' })
    const { user } = renderOrder()

    await user.click(screen.getByTestId('void-order'))
    expect(warmUpVoids).not.toHaveBeenCalled()
  })
})

describe('the dialog on its own', () => {
  it('works without onOpen, and calls it once per opening when given', async () => {
    const onOpen = vi.fn()
    const { user, rerender } = renderComponent(
      <VoidOrderDialog
        orderNumber={7}
        amount={900}
        requiresAuthorization={false}
        onConfirm={async () => undefined}
      />,
    )
    await user.click(screen.getByTestId('void-order'))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    rerender(
      <VoidOrderDialog
        orderNumber={7}
        amount={900}
        requiresAuthorization={false}
        onConfirm={async () => undefined}
        onOpen={onOpen}
      />,
    )
    await user.click(screen.getByTestId('void-order'))
    expect(onOpen).toHaveBeenCalledOnce()
    expect(onOpen).toHaveBeenCalledWith()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('still opens when onOpen throws', async () => {
    const { user } = renderComponent(
      <VoidOrderDialog
        orderNumber={7}
        amount={900}
        requiresAuthorization={false}
        onConfirm={async () => undefined}
        onOpen={() => {
          throw new Error('listener exploded')
        }}
      />,
    )
    await user.click(screen.getByTestId('void-order'))
    expect(screen.queryByRole('alertdialog')).not.toBeNull()
  })
})

// ---- Independence ------------------------------------------------------------------------------

describe('a PIN void never depends on a warm-up', () => {
  async function expectVoided(user: User) {
    await pinVoid(user)
    await waitFor(() => expect(screen.queryByTestId('voided-banner')).not.toBeNull())
    expect(voidOrderWithAdminPin.mock.calls).toEqual([
      ['order-7', { reason: 'Wrong item', pin: '482913', operatorId: null }],
    ])
    // The warm-up only ever learns which account is signed in: no PIN, reason or order.
    for (const call of warmUpVoids.mock.calls) expect(call).toEqual(['till-uid'])
    expect(JSON.stringify(warmUpVoids.mock.calls)).not.toMatch(/482913|Wrong item|order-7/)
  }

  it('while a warm-up is still running and never finishes', async () => {
    warmUpVoids.mockImplementation(() => {
      void new Promise(() => undefined)
    })
    const { user } = renderOrder()
    await expectVoided(user)
  })

  it('when every warm-up fails', async () => {
    warmUpVoids.mockImplementation(() => {
      void Promise.reject(new Error('unavailable')).catch(() => undefined)
    })
    const { user } = renderOrder()
    await expectVoided(user)
  })

  it('even if the warm-up throws outright — on opening and in the dialog — and nothing shows', async () => {
    warmUpVoids.mockImplementation(() => {
      throw new Error('warm-up exploded')
    })
    const { user } = renderOrder()

    await expectVoided(user)
    expect(screen.queryByText(/warm-up exploded/)).toBeNull()
  })
})
