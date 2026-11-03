// @vitest-environment jsdom
/**
 * Taking money from an order's own page — the pay-later route — after New Order gained its
 * own way into the same dialog.
 *
 * The dialog is shared: New Order opens it directly, this page opens it from its Record
 * Payment button. This pins that the button route still writes exactly what it always did,
 * through the same `recordPayment`, so adding the second route changed nothing here.
 */
import { screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { renderComponent } from './render'

const recordPayment = vi.hoisted(() => vi.fn())

vi.mock('@/features/pos/payment-api', () => ({ recordPayment }))
vi.mock('@/features/pos/fulfillment-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/pos/fulfillment-api')>()
  return { ...actual, setFulfillment: vi.fn(), correctFulfillment: vi.fn() }
})
vi.mock('@/features/pos/void-api', () => ({ voidOrder: vi.fn() }))
vi.mock('@/features/pos/void-pin-api', () => ({
  voidOrderWithAdminPin: vi.fn(),
  fetchAdminPinStatus: vi.fn(async () => ({ pinAvailable: false })),
}))

vi.mock('@/features/auth/useAuth', () => ({
  useAuth: () => ({
    role: 'staff',
    status: 'authenticated',
    profile: { uid: 'u1', displayName: 'Ana', email: 'a@b.c', role: 'staff', active: true },
  }),
}))
vi.mock('@/features/staff/useStaffSession', () => ({
  useStaffSession: () => ({
    operator: { id: 's1', name: 'Alice', isSelf: false },
    operators: [],
    loading: false,
    select: () => {},
  }),
}))

const ORDER_ID = 'order-1'

vi.mock('@/features/pos/useOrderDetail', () => ({
  useOrderDetail: () => ({
    view: {
      order: {
        id: ORDER_ID,
        number: 7,
        businessDate: '2026-09-15',
        lines: [
          {
            menuItemId: 'm1',
            name: 'Flat White',
            basePrice: 1250,
            unitPrice: 1250,
            modifiers: [],
            quantity: 1,
          },
        ],
        total: 1250,
        orderType: 'takeaway',
        tableNumber: null,
        paymentMethod: null,
        cashTendered: null,
        changeGiven: null,
        createdAt: { toDate: () => new Date('2026-09-15T02:00:00.000Z') },
        createdBy: 'u1',
        createdByName: 'Ana',
        staffId: 's1',
        staffName: 'Alice',
      },
      fulfillment: 'delivered',
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

import { OrderDetailPage } from '@/features/pos/OrderDetailPage'

function renderDetail() {
  return renderComponent(
    <MemoryRouter initialEntries={[`/orders/${ORDER_ID}`]}>
      <Routes>
        <Route path="/orders/:orderId" element={<OrderDetailPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  recordPayment.mockReset()
  recordPayment.mockResolvedValue(undefined)
})

describe('paying an unpaid order from its own page', () => {
  it('records cash, with the change, against this order and the selected operator', async () => {
    const { user } = renderDetail()
    await user.click(screen.getByTestId('record-payment'))
    await user.type(screen.getByLabelText(/Cash received/), '20')
    expect(screen.getByTestId('payment-change').textContent).toBe('RM 7.50')
    await user.click(screen.getByTestId('confirm-payment'))

    expect(recordPayment).toHaveBeenCalledOnce()
    expect(recordPayment).toHaveBeenCalledWith(ORDER_ID, {
      method: 'cash',
      amount: 1250,
      cashTendered: 2000,
      user: { uid: 'u1', displayName: 'Ana' },
      staff: { id: 's1', name: 'Alice' },
    })
    await waitFor(() => expect(screen.queryByTestId('confirm-payment')).toBeNull())
  })

  it('records e-wallet with no cash figures', async () => {
    const { user } = renderDetail()
    await user.click(screen.getByTestId('record-payment'))
    await user.click(screen.getByTestId('payment-ewallet'))
    await user.click(screen.getByTestId('confirm-payment'))

    expect(recordPayment).toHaveBeenCalledWith(
      ORDER_ID,
      expect.objectContaining({ method: 'ewallet', amount: 1250, cashTendered: null }),
    )
  })

  it('writes nothing when cancelled, and can be opened again', async () => {
    const { user } = renderDetail()
    await user.click(screen.getByTestId('record-payment'))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(recordPayment).not.toHaveBeenCalled()
    expect(screen.queryByTestId('confirm-payment')).toBeNull()
    await user.click(screen.getByTestId('record-payment'))
    expect(screen.getByTestId('confirm-payment')).not.toBeNull()
  })

  it('explains a refusal from the rules instead of closing', async () => {
    recordPayment.mockRejectedValue({ code: 'permission-denied' })
    const { user } = renderDetail()
    await user.click(screen.getByTestId('record-payment'))
    await user.click(screen.getByTestId('payment-ewallet'))
    await user.click(screen.getByTestId('confirm-payment'))

    expect(await screen.findByText(/That payment could not be recorded/)).not.toBeNull()
    expect(screen.getByTestId('confirm-payment')).not.toBeNull()
  })
})
