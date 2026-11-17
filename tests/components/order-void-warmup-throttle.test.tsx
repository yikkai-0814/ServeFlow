// @vitest-environment jsdom
/**
 * The order page's three triggers and the real void warm-up module together: the order opening,
 * the page coming back into view and the void dialog opening all go through one module state, so
 * there is never more than one void warm-up in flight, none again for five minutes after one
 * succeeds, and a failure is retried at the next trigger. Only the network call is replaced.
 */
import { act } from 'react'

import { screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { renderComponent } from './render'

const signedIn = vi.hoisted(() => ({ currentUser: { uid: 'till-uid' } as { uid: string } | null }))
const warmCallable = vi.hoisted(() => vi.fn())
const httpsCallable = vi.hoisted(() => vi.fn((..._args: unknown[]) => warmCallable))

vi.mock('@/lib/firebase', () => ({
  app: {},
  db: {},
  auth: {
    get currentUser() {
      return signedIn.currentUser
    },
  },
}))
vi.mock('@/lib/functions', () => ({ appFunctions: () => ({}) }))
vi.mock('firebase/functions', () => ({ httpsCallable }))

vi.mock('@/features/auth/useAuth', () => ({
  useAuth: () => ({
    status: 'authenticated',
    role: 'staff',
    profile: { uid: 'till-uid', displayName: 'Shared Till', role: 'staff', active: true },
  }),
}))
vi.mock('@/features/staff/useStaffSession', () => ({
  useStaffSession: () => ({ operator: null, operators: [], loading: false, select: () => {} }),
}))
vi.mock('@/features/pos/useOrderDetail', () => ({
  useOrderDetail: () => ({
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
            quantity: 1,
          },
        ],
        total: 450,
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
      voided: null,
      overall: 'payment-outstanding',
      fulfillmentRecord: null,
      paymentRecord: null,
    },
    loading: false,
    error: null,
  }),
}))
vi.mock('@/features/pos/void-pin-api', () => ({
  voidOrderWithAdminPin: vi.fn(),
  fetchAdminPinStatus: vi.fn(async () => ({ pinAvailable: true })),
}))
vi.mock('@/features/pos/void-api', () => ({ voidOrder: vi.fn() }))
vi.mock('@/features/pos/manager-authorization', () => ({ withManagerAuthorization: vi.fn() }))
vi.mock('@/features/pos/payment-api', () => ({ recordPayment: vi.fn() }))
vi.mock('@/features/pos/fulfillment-api', () => ({
  setFulfillment: vi.fn(),
  correctFulfillment: vi.fn(),
}))

import { OrderDetailPage } from '@/features/pos/OrderDetailPage'
import { resetVoidWarmup, VOID_WARMUP_INTERVAL_MS } from '@/features/pos/void-warmup'

let visibility: DocumentVisibilityState = 'visible'
let clock = 1_800_000_000_000

function becomes(state: DocumentVisibilityState) {
  visibility = state
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

function deferred() {
  let resolve!: (value: unknown) => void
  const promise = new Promise((res) => {
    resolve = res
  })
  return { promise, resolve }
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

/** The page coming back into view, then the void dialog opening and closing. */
async function laterTriggers(user: ReturnType<typeof renderComponent>['user']) {
  becomes('hidden')
  becomes('visible')
  await user.click(screen.getByTestId('void-order'))
  await user.click(screen.getByRole('button', { name: 'Cancel' }))
}

beforeEach(() => {
  resetVoidWarmup()
  signedIn.currentUser = { uid: 'till-uid' }
  visibility = 'visible'
  clock = 1_800_000_000_000
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  warmCallable.mockReset()
  httpsCallable.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the order page and the void warm-up together', () => {
  it('send one warm-up while it is in flight, whichever triggers fire', async () => {
    warmCallable.mockReturnValue(deferred().promise)
    const { user } = renderOrder()

    await laterTriggers(user)
    await laterTriggers(user)

    expect(warmCallable).toHaveBeenCalledOnce()
    expect(warmCallable).toHaveBeenCalledWith({ warmup: true })
    expect(httpsCallable.mock.calls.every((call) => call[1] === 'voidOrderWithAdminPin')).toBe(true)
  })

  it('send nothing more for five minutes after one succeeds, then one again', async () => {
    warmCallable.mockResolvedValue({ data: { warm: true } })
    const { user } = renderOrder()
    await waitFor(() => expect(warmCallable).toHaveBeenCalledOnce())
    await act(async () => undefined)

    await laterTriggers(user)
    expect(warmCallable).toHaveBeenCalledOnce()

    clock += VOID_WARMUP_INTERVAL_MS
    await user.click(screen.getByTestId('void-order'))
    expect(warmCallable).toHaveBeenCalledTimes(2)
  })

  it('retry at the next trigger after a failure, still one at a time', async () => {
    warmCallable.mockRejectedValueOnce(new Error('unavailable'))
    warmCallable.mockReturnValueOnce(deferred().promise)
    const { user } = renderOrder()
    await act(async () => undefined)

    await laterTriggers(user)

    expect(warmCallable).toHaveBeenCalledTimes(2)
  })

  it('send nothing once Firebase Auth is no longer signed in as this account', async () => {
    signedIn.currentUser = null
    const { user } = renderOrder()

    await laterTriggers(user)

    expect(warmCallable).not.toHaveBeenCalled()
  })
})
