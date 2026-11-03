// @vitest-environment jsdom
/**
 * New Order asks who is making **this** order, every time.
 *
 * Two people share one counter. The person who took the last order is not necessarily
 * taking the next, so carrying the previous name forward would file one person's sale under
 * another's — permanently, orders being immutable, and silently, which is worse. The prompt
 * is therefore deliberate friction rather than a rough edge to smooth off.
 *
 * The staff session is stubbed with a real, stateful stand-in rather than a fixed value:
 * picking a name has to actually change what the page sees, or none of this is tested. The
 * uid-scoping that makes the underlying persistence safe is Phase 13's and is covered in
 * StaffSessionProvider.test.tsx — untouched by this phase.
 */
import { act, useSyncExternalStore } from 'react'

import { screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Operator } from '@/features/staff/staff-session'
import type { OrderView } from '@/features/pos/orders-view'
import type { PaymentState } from '@/features/pos/payments'
import { recordPayment } from '@/features/pos/payment-api'
import { createOrder } from '@/features/pos/pos-api'
import { TerminalPage } from '@/features/pos/TerminalPage'

import { renderComponent } from './render'

const ALICE: Operator = { id: 'alice', name: 'Alice', isSelf: false }
const BOB: Operator = { id: 'bob', name: 'Bob', isSelf: false }
const TILL: Operator = { id: 'till-uid', name: 'Shared Till', isSelf: true }
const ROSTER = [TILL, ALICE, BOB]

/**
 * A single shared operator, the way the real provider shares one through context.
 *
 * Giving each caller its own `useState` would be wrong in a way that hides the bug: the
 * page and the picker inside it both call `useStaffSession`, so a name chosen in the picker
 * has to be visible to the page. An external store is the smallest thing that behaves like
 * the provider without dragging in Firestore or localStorage.
 */
let currentOperator: Operator | null = null
const listeners = new Set<() => void>()

function setCurrentOperator(next: Operator | null) {
  currentOperator = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** What the persisted session already holds when the page mounts. */
let storedOperator: Operator | null = null
let staffLoading = false

vi.mock('@/features/auth/useAuth', () => ({
  useAuth: () => ({
    profile: { uid: 'till-uid', displayName: 'Shared Till', role: 'staff', active: true },
    status: 'authenticated',
    role: 'staff',
  }),
}))

/**
 * A stand-in for the real provider: `select` changes who the page sees, exactly as the
 * uid-scoped one does, without reaching for Firestore or localStorage.
 */
vi.mock('@/features/staff/useStaffSession', () => ({
  useStaffSession: () => ({
    operator: useSyncExternalStore(subscribe, () => currentOperator),
    operators: ROSTER,
    loading: staffLoading,
    select: (id: string) =>
      setCurrentOperator(ROSTER.find((candidate) => candidate.id === id) ?? null),
  }),
}))

vi.mock('@/features/menu/useCategories', () => ({
  useCategories: () => ({
    categories: [{ id: 'coffee', name: 'Coffee', sortOrder: 1, active: true }],
    data: [],
    loading: false,
    error: null,
  }),
}))

vi.mock('@/features/menu/useMenuItems', () => ({
  useMenuItems: () => ({
    items: [
      {
        id: 'flat-white',
        name: 'Flat White',
        categoryId: 'coffee',
        price: 1250,
        sortOrder: 1,
        active: true,
        modifierGroupIds: [],
      },
    ],
    data: [],
    loading: false,
    error: null,
  }),
}))

vi.mock('@/features/pos/pos-api', () => ({
  createOrder: vi.fn(),
}))

vi.mock('@/features/pos/payment-api', () => ({
  recordPayment: vi.fn(),
}))

/**
 * What the database says about the placed order's payment, which the payment question reads
 * only when a payment did not complete on screen. Unpaid unless a test says otherwise.
 *
 * An external store for the same reason as the operator above: the real hook is a live
 * listener, so a payment landing has to re-render the page, not merely change a variable.
 */
let recordedPayment: PaymentState = { status: 'unpaid' }
const paymentListeners = new Set<() => void>()

function setRecordedPayment(next: PaymentState) {
  recordedPayment = next
  for (const listener of paymentListeners) listener()
}

function subscribePayment(listener: () => void) {
  paymentListeners.add(listener)
  return () => paymentListeners.delete(listener)
}

/** The order id the payment question asked about, so a test can check it is the right one. */
let detailOrderId: string | undefined

vi.mock('@/features/pos/useOrderDetail', () => ({
  useOrderDetail: (orderId: string | undefined) => {
    detailOrderId = orderId
    const payment = useSyncExternalStore(subscribePayment, () => recordedPayment)
    return {
      view: orderId ? ({ payment } as unknown as OrderView) : null,
      loading: false,
      error: null,
    }
  },
}))

const createOrderMock = vi.mocked(createOrder)
const recordPaymentMock = vi.mocked(recordPayment)
let orderNumber = 0

beforeEach(() => {
  storedOperator = null
  currentOperator = null
  staffLoading = false
  orderNumber = 0
  recordedPayment = { status: 'unpaid' }
  detailOrderId = undefined
  createOrderMock.mockReset()
  createOrderMock.mockImplementation(async () => {
    orderNumber += 1
    return { id: `order-${orderNumber}`, number: orderNumber }
  })
  recordPaymentMock.mockReset()
  recordPaymentMock.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.clearAllMocks()
})

const asking = () => screen.queryByText('Who is making this order?') !== null
const deciding = () => screen.queryByTestId('payment-decision') !== null
const banner = () => screen.getByTestId('order-confirmation')

type User = ReturnType<typeof renderComponent>['user']

/** Everything between choosing a name and the order being written. */
async function placeOnlyAs(user: User, name: string) {
  await user.click(screen.getByText(name))
  await user.click(screen.getByText('Flat White'))
  await user.type(screen.getByLabelText('Table number'), '5')
  await user.click(screen.getByTestId('place-order'))
}

/**
 * Places an order and leaves it unpaid — "Pay later", which is exactly what every order did
 * before the payment question existed. The tests about operators and carry-over use this, so
 * they keep asserting what they always did.
 */
async function placeAnOrderAs(user: User, name: string) {
  await placeOnlyAs(user, name)
  await user.click(screen.getByTestId('pay-later'))
}

/** A promise the test resolves or rejects by hand, to hold a write in flight. */
function deferred() {
  let resolve!: () => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Who the most recent createOrder call named as the operator. */
const lastOperator = () => createOrderMock.mock.calls.at(-1)?.[0].staff

describe('New Order: every order asks who is making it', () => {
  it('asks before anything can be rung up', () => {
    renderComponent(<TerminalPage />)
    expect(asking()).toBe(true)
    expect(screen.queryByText('Flat White')).toBeNull()
  })

  it('asks even when the session already remembers somebody', () => {
    // The heart of this phase. A stored selection is where the answer is KEPT; it is not an
    // answer to a question that has not been asked for this order.
    storedOperator = ALICE
    setCurrentOperator(storedOperator)
    renderComponent(<TerminalPage />)
    expect(asking()).toBe(true)
  })

  it('opens the order once a name is chosen', async () => {
    const { user } = renderComponent(<TerminalPage />)
    await user.click(screen.getByText('Alice'))

    expect(asking()).toBe(false)
    expect(screen.getByRole('heading', { name: 'New Order' })).not.toBeNull()
    expect(screen.getByText('Flat White')).not.toBeNull()
  })

  it('waits for the roster rather than asking too early', () => {
    staffLoading = true
    renderComponent(<TerminalPage />)
    expect(asking()).toBe(false)
  })
})

describe('New Order: the next order starts from the question again', () => {
  it('asks again as soon as an order is placed', async () => {
    const { user } = renderComponent(<TerminalPage />)
    await placeAnOrderAs(user, 'Alice')

    expect(createOrderMock).toHaveBeenCalledOnce()
    expect(asking()).toBe(true)
  })

  it('reports the order just placed on the screen that asks', async () => {
    const { user } = renderComponent(<TerminalPage />)
    await placeAnOrderAs(user, 'Alice')

    const confirmation = screen.getByTestId('order-confirmation')
    expect(confirmation.textContent).toContain('Order #1 placed')
    expect(confirmation.textContent).toContain('RM 12.50')
  })

  it('clears that confirmation once the next order has an operator', async () => {
    const { user } = renderComponent(<TerminalPage />)
    await placeAnOrderAs(user, 'Alice')
    await user.click(screen.getByText('Bob'))

    expect(screen.queryByTestId('order-confirmation')).toBeNull()
  })

  it('does not pre-select the person who took the last order', async () => {
    const { user } = renderComponent(<TerminalPage />)
    await placeAnOrderAs(user, 'Alice')

    // Alice is still the stored operator, and the page is still asking. Nothing is rung up
    // against her until somebody says so again.
    expect(asking()).toBe(true)
    expect(screen.queryByText('Flat White')).toBeNull()
  })
})

describe('New Order: consecutive orders can be different people', () => {
  it('attributes each order to the person chosen for it', async () => {
    const { user } = renderComponent(<TerminalPage />)

    await placeAnOrderAs(user, 'Alice')
    expect(lastOperator()).toEqual({ id: 'alice', name: 'Alice' })

    await placeAnOrderAs(user, 'Bob')
    expect(lastOperator()).toEqual({ id: 'bob', name: 'Bob' })

    await placeAnOrderAs(user, 'Alice')
    expect(lastOperator()).toEqual({ id: 'alice', name: 'Alice' })

    // Alice, Bob, Alice — the example from the counter, in order.
    expect(createOrderMock.mock.calls.map((call) => call[0].staff.name)).toEqual([
      'Alice',
      'Bob',
      'Alice',
    ])
  })

  it('still sends the signed-in account alongside the operator', async () => {
    // Two identities on one sale, unchanged by this phase: the credential that wrote it and
    // the person who took it. The rules check both.
    const { user } = renderComponent(<TerminalPage />)
    await placeAnOrderAs(user, 'Bob')

    const [params] = createOrderMock.mock.calls[0] ?? []
    expect(params?.user).toEqual({ uid: 'till-uid', displayName: 'Shared Till' })
    expect(params?.staff).toEqual({ id: 'bob', name: 'Bob' })
  })

  it('carries nothing else from one order into the next', async () => {
    const { user } = renderComponent(<TerminalPage />)
    await placeAnOrderAs(user, 'Alice')
    await user.click(screen.getByText('Bob'))

    // The cart and the table number are already cleared on success; this is the check that
    // the second order genuinely starts empty rather than inheriting the first.
    expect(screen.getByTestId('cart-total').textContent).toBe('RM 0.00')
    expect((screen.getByLabelText('Table number') as HTMLInputElement).value).toBe('')
  })
})

describe('New Order: pay now or pay later', () => {
  it('asks how to proceed once the order is saved, before anything else', async () => {
    const { user } = renderComponent(<TerminalPage />)
    await placeOnlyAs(user, 'Alice')

    expect(createOrderMock).toHaveBeenCalledOnce()
    expect(deciding()).toBe(true)
    expect(screen.getByText('How would you like to proceed?')).not.toBeNull()
    const decision = screen.getByTestId('payment-decision')
    expect(decision.textContent).toContain('Order #1 is saved')
    expect(decision.textContent).toContain('RM 12.50')
    expect(decision.textContent).toContain('Dine-in · Table 5')
    // Not yet on to the next order, and nothing paid yet.
    expect(asking()).toBe(false)
    expect(recordPaymentMock).not.toHaveBeenCalled()
    // It looks up the order that was just written, not some other one.
    expect(detailOrderId).toBe('order-1')
  })

  it('opens the existing payment dialog for that order on Pay now', async () => {
    const { user } = renderComponent(<TerminalPage />)
    await placeOnlyAs(user, 'Alice')
    await user.click(screen.getByTestId('pay-now'))

    expect(screen.getByText('Record payment for order #1')).not.toBeNull()
    expect(screen.getByTestId('payment-total').textContent).toBe('RM 12.50')
    expect(screen.getByTestId('payment-cash')).not.toBeNull()
    expect(screen.getByTestId('payment-ewallet')).not.toBeNull()
    // Opened by the question itself — no second "Record Payment" button to press.
    expect(screen.queryByTestId('record-payment')).toBeNull()
  })

  it('takes cash with the existing change calculation, and reports the order paid', async () => {
    const { user } = renderComponent(<TerminalPage />)
    await placeOnlyAs(user, 'Alice')
    await user.click(screen.getByTestId('pay-now'))
    await user.type(screen.getByLabelText(/Cash received/), '20')
    expect(screen.getByTestId('payment-change').textContent).toBe('RM 7.50')
    await user.click(screen.getByTestId('confirm-payment'))

    expect(recordPaymentMock).toHaveBeenCalledOnce()
    expect(recordPaymentMock).toHaveBeenCalledWith('order-1', {
      method: 'cash',
      amount: 1250,
      cashTendered: 2000,
      user: { uid: 'till-uid', displayName: 'Shared Till' },
      staff: { id: 'alice', name: 'Alice' },
    })
    await waitFor(() => expect(asking()).toBe(true))
    expect(banner().getAttribute('data-settlement')).toBe('paid')
    expect(banner().textContent).toContain('Order #1 placed')
    expect(banner().textContent).toContain('paid by Cash')
  })

  it('takes e-wallet with no cash figures, and reports the order paid', async () => {
    const { user } = renderComponent(<TerminalPage />)
    await placeOnlyAs(user, 'Alice')
    await user.click(screen.getByTestId('pay-now'))
    await user.click(screen.getByTestId('payment-ewallet'))
    await user.click(screen.getByTestId('confirm-payment'))

    expect(recordPaymentMock).toHaveBeenCalledWith(
      'order-1',
      expect.objectContaining({ method: 'ewallet', amount: 1250, cashTendered: null }),
    )
    await waitFor(() => expect(asking()).toBe(true))
    expect(banner().getAttribute('data-settlement')).toBe('paid')
    expect(banner().textContent).toContain('paid by E-Wallet')
  })

  it('leaves the order unpaid on Pay later, and says where to collect it', async () => {
    const { user } = renderComponent(<TerminalPage />)
    await placeOnlyAs(user, 'Alice')
    await user.click(screen.getByTestId('pay-later'))

    expect(recordPaymentMock).not.toHaveBeenCalled()
    expect(asking()).toBe(true)
    expect(banner().getAttribute('data-settlement')).toBe('unpaid')
    expect(banner().textContent).toContain('unpaid')
    expect(banner().textContent).toContain('Record payment from the Orders page')
  })
})

describe('New Order: backing out of a payment returns to the question', () => {
  /** Still on the payment question for the saved order — not moved on, not finalised. */
  function expectStillDeciding() {
    expect(deciding()).toBe(true)
    expect(screen.getByTestId('pay-now')).not.toBeNull()
    expect(screen.getByTestId('pay-later')).not.toBeNull()
    expect(screen.getByTestId('payment-decision').textContent).toContain('Order #1 is saved')
    // The payment dialog is closed, and nothing has been settled either way.
    expect(screen.queryByTestId('confirm-payment')).toBeNull()
    expect(asking()).toBe(false)
    expect(screen.queryByTestId('order-confirmation')).toBeNull()
    expect(recordPaymentMock).not.toHaveBeenCalled()
    // The order itself is never undone or written again.
    expect(createOrderMock).toHaveBeenCalledOnce()
  }

  it('stays on the question when the payment dialog is cancelled', async () => {
    const { user } = renderComponent(<TerminalPage />)
    await placeOnlyAs(user, 'Alice')
    await user.click(screen.getByTestId('pay-now'))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expectStillDeciding()
  })

  it('treats Escape the same as Cancel', async () => {
    const { user } = renderComponent(<TerminalPage />)
    await placeOnlyAs(user, 'Alice')
    await user.click(screen.getByTestId('pay-now'))
    await user.keyboard('{Escape}')

    expectStillDeciding()
  })

  it('does not take Cancel as Pay later — only Pay later itself finalises the order unpaid', async () => {
    const { user } = renderComponent(<TerminalPage />)
    await placeOnlyAs(user, 'Alice')
    await user.click(screen.getByTestId('pay-now'))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expectStillDeciding()

    await user.click(screen.getByTestId('pay-later'))
    expect(asking()).toBe(true)
    expect(banner().getAttribute('data-settlement')).toBe('unpaid')
    expect(banner().textContent).toContain('Order #1 placed')
    expect(recordPaymentMock).not.toHaveBeenCalled()
  })

  it('can still take payment with Pay now after a cancel, on a fresh dialog', async () => {
    const { user } = renderComponent(<TerminalPage />)
    await placeOnlyAs(user, 'Alice')
    await user.click(screen.getByTestId('pay-now'))
    await user.type(screen.getByLabelText(/Cash received/), '50')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expectStillDeciding()

    await user.click(screen.getByTestId('pay-now'))
    // Nothing typed before the cancel carries over into the new attempt.
    expect((screen.getByLabelText(/Cash received/) as HTMLInputElement).value).toBe('')
    await user.type(screen.getByLabelText(/Cash received/), '20')
    await user.click(screen.getByTestId('confirm-payment'))

    expect(recordPaymentMock).toHaveBeenCalledOnce()
    expect(recordPaymentMock).toHaveBeenCalledWith(
      'order-1',
      expect.objectContaining({ method: 'cash', amount: 1250, cashTendered: 2000 }),
    )
    await waitFor(() => expect(asking()).toBe(true))
    expect(banner().getAttribute('data-settlement')).toBe('paid')
  })

  it('can be cancelled any number of times without moving on', async () => {
    const { user } = renderComponent(<TerminalPage />)
    await placeOnlyAs(user, 'Alice')
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await user.click(screen.getByTestId('pay-now'))
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
    }

    expectStillDeciding()
  })
})

describe('New Order: a payment that does not go through', () => {
  it('shows why a refused payment failed, and returns to the question once closed', async () => {
    recordPaymentMock.mockRejectedValue({ code: 'permission-denied' })
    const { user } = renderComponent(<TerminalPage />)
    await placeOnlyAs(user, 'Alice')
    await user.click(screen.getByTestId('pay-now'))
    await user.click(screen.getByTestId('payment-ewallet'))
    await user.click(screen.getByTestId('confirm-payment'))

    // The dialog stays, saying why — never closing as though it worked.
    expect(
      await screen.findByText(
        'That payment could not be recorded. The order may already be paid, or it may have been voided.',
      ),
    ).not.toBeNull()
    expect(deciding()).toBe(true)

    // Closing it neither pretends the payment worked nor quietly settles for "pay later":
    // the counter is back at the question for the same, still unpaid, order.
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(deciding()).toBe(true)
    expect(screen.queryByTestId('confirm-payment')).toBeNull()
    expect(asking()).toBe(false)
    expect(screen.queryByTestId('order-confirmation')).toBeNull()

    await user.click(screen.getByTestId('pay-later'))
    expect(banner().getAttribute('data-settlement')).toBe('unpaid')
  })

  it('shows a generic failure for an error with no reason, and can be retried', async () => {
    recordPaymentMock.mockRejectedValueOnce(new Error('network'))
    const { user } = renderComponent(<TerminalPage />)
    await placeOnlyAs(user, 'Alice')
    await user.click(screen.getByTestId('pay-now'))
    await user.click(screen.getByTestId('payment-ewallet'))
    await user.click(screen.getByTestId('confirm-payment'))

    expect(await screen.findByText('The payment could not be recorded.')).not.toBeNull()

    // A second try succeeds, and that is what is reported.
    await user.click(screen.getByTestId('confirm-payment'))
    await waitFor(() => expect(asking()).toBe(true))
    expect(recordPaymentMock).toHaveBeenCalledTimes(2)
    expect(banner().getAttribute('data-settlement')).toBe('paid')
  })

  it('reports the payment the database holds when the failed write actually landed', async () => {
    // The answer was lost but the write was not: the recorded state says paid, so the
    // counter must not be told to collect the money a second time.
    recordPaymentMock.mockRejectedValue({ code: 'permission-denied' })
    const { user } = renderComponent(<TerminalPage />)
    await placeOnlyAs(user, 'Alice')
    await user.click(screen.getByTestId('pay-now'))
    await user.click(screen.getByTestId('payment-ewallet'))
    await user.click(screen.getByTestId('confirm-payment'))
    await screen.findByText(/That payment could not be recorded/)

    act(() =>
      setRecordedPayment({
        status: 'paid',
        method: 'ewallet',
        cashTendered: null,
        changeGiven: null,
        source: 'recorded',
      }),
    )
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(banner().getAttribute('data-settlement')).toBe('paid')
    expect(banner().textContent).toContain('paid by E-Wallet')
  })
})

describe('New Order: nothing is sent twice', () => {
  it('places the order once however often Place order is pressed', async () => {
    const write = deferred()
    createOrderMock.mockImplementationOnce(async () => {
      await write.promise
      return { id: 'order-1', number: 1 }
    })
    const { user } = renderComponent(<TerminalPage />)
    await user.click(screen.getByText('Alice'))
    await user.click(screen.getByText('Flat White'))
    await user.type(screen.getByLabelText('Table number'), '5')
    await user.click(screen.getByTestId('place-order'))
    await user.click(screen.getByTestId('place-order'))

    expect(createOrderMock).toHaveBeenCalledOnce()
    await act(async () => write.resolve())
    expect(deciding()).toBe(true)
  })

  it('records the payment once, and cannot be closed while it is being written', async () => {
    const write = deferred()
    recordPaymentMock.mockImplementationOnce(() => write.promise)
    const { user } = renderComponent(<TerminalPage />)
    await placeOnlyAs(user, 'Alice')
    await user.click(screen.getByTestId('pay-now'))
    await user.click(screen.getByTestId('payment-ewallet'))
    await user.click(screen.getByTestId('confirm-payment'))

    const confirm = screen.getByTestId('confirm-payment') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    expect(confirm.textContent).toBe('Recording…')
    await user.click(confirm)
    // Escape while the write is in flight would otherwise report "not recorded" for a
    // payment that may yet land.
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('confirm-payment')).not.toBeNull()
    expect(screen.queryByTestId('order-confirmation')).toBeNull()

    await act(async () => write.resolve())
    await waitFor(() => expect(asking()).toBe(true))
    expect(recordPaymentMock).toHaveBeenCalledOnce()
    expect(banner().getAttribute('data-settlement')).toBe('paid')
  })
})

describe('New Order: the payment belongs to this order and its operator', () => {
  it('names the operator who made the order as the one taking the money', async () => {
    const { user } = renderComponent(<TerminalPage />)
    await placeOnlyAs(user, 'Bob')
    // Even if the session's operator changes while the question is up, this order's payment
    // stays with the person this order was made by.
    act(() => setCurrentOperator(ALICE))
    await user.click(screen.getByTestId('pay-now'))
    await user.click(screen.getByTestId('payment-ewallet'))
    await user.click(screen.getByTestId('confirm-payment'))

    const [orderId, params] = recordPaymentMock.mock.calls[0] ?? []
    expect(orderId).toBe('order-1')
    expect(params?.staff).toEqual({ id: 'bob', name: 'Bob' })
    expect(params?.user).toEqual({ uid: 'till-uid', displayName: 'Shared Till' })
  })

  it('still asks who is making the next order after paying, and starts it empty', async () => {
    const { user } = renderComponent(<TerminalPage />)
    await placeOnlyAs(user, 'Alice')
    await user.click(screen.getByTestId('pay-now'))
    await user.click(screen.getByTestId('payment-ewallet'))
    await user.click(screen.getByTestId('confirm-payment'))

    await waitFor(() => expect(asking()).toBe(true))
    expect(screen.queryByText('Flat White')).toBeNull()

    await user.click(screen.getByText('Bob'))
    expect(deciding()).toBe(false)
    expect(screen.queryByTestId('order-confirmation')).toBeNull()
    expect(screen.getByTestId('cart-total').textContent).toBe('RM 0.00')
    expect((screen.getByLabelText('Table number') as HTMLInputElement).value).toBe('')
  })

  it('asks the payment question afresh for the next order', async () => {
    const { user } = renderComponent(<TerminalPage />)
    await placeOnlyAs(user, 'Alice')
    await user.click(screen.getByTestId('pay-now'))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.click(screen.getByTestId('pay-later'))

    await placeOnlyAs(user, 'Bob')
    // A fresh question about order #2: no dialog left open from order #1.
    expect(deciding()).toBe(true)
    expect(screen.getByTestId('payment-decision').textContent).toContain('Order #2 is saved')
    expect(screen.queryByTestId('confirm-payment')).toBeNull()
    expect(detailOrderId).toBe('order-2')
  })
})
