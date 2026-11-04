// @vitest-environment jsdom
/**
 * One sidecar listener failing while its neighbours keep working.
 *
 * A busy day splits its payments, voids and fulfilment across several listeners, one per chunk of
 * 30 orders (see order-sidecars.ts). The hook used to hold a single error for all of them, so any
 * healthy chunk's next snapshot wiped out a failure elsewhere: the Orders banner disappeared and
 * the unpaid badge came back counting from rows that had stopped updating.
 *
 * Everything real runs here — the hooks, AppShell, Orders and Queue — and only Firestore's
 * `onSnapshot` is replaced, by a stand-in the tests answer by hand. `fail` plays out what the SDK
 * does to a listener that errors: drops it for good, which is why recovery has to mean a new
 * listener and can never mean the old one speaking again.
 */
import { act, renderHook, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { renderComponent } from './render'

interface Listener {
  path: string
  ids: string[] | null
  next: (snapshot: unknown) => void
  fail: (error: Error) => void
  closed: boolean
}

const live = vi.hoisted(() => ({ listeners: [] as Listener[] }))

vi.mock('@/lib/firebase', () => ({ app: {}, auth: {}, db: {} }))

vi.mock('firebase/firestore', async (original) => ({
  ...(await original<typeof import('firebase/firestore')>()),
  collection: (_db: unknown, path: string) => ({ path }),
  query: (base: { path: string }, filter: unknown) => ({ ...base, filter }),
  where: (field: string, _op: string, value: unknown) => ({ field, value }),
  onSnapshot: (
    ref: { path: string; filter: { field: string; value: unknown } },
    next: Listener['next'],
    fail: Listener['fail'],
  ) => {
    const listener: Listener = {
      path: ref.path,
      ids: ref.filter.field === 'orderId' ? (ref.filter.value as string[]) : null,
      next,
      fail,
      closed: false,
    }
    live.listeners.push(listener)
    return () => {
      listener.closed = true
    }
  },
}))

vi.mock('@/components/layout/Topbar', () => ({ Topbar: () => null }))
vi.mock('@/features/pos/BusinessDateBar', () => ({ BusinessDateBar: () => null }))
vi.mock('@/features/auth/useAuth', () => ({
  useAuth: () => ({
    role: 'staff',
    status: 'authenticated',
    profile: { uid: 'till', displayName: 'Counter Till', role: 'staff', active: true },
  }),
}))
vi.mock('@/features/staff/useStaffSession', () => ({
  useStaffSession: () => ({
    operator: { id: 'alice', name: 'Alice', isSelf: false },
    operators: [],
    loading: false,
    select: () => undefined,
  }),
}))

import { AppShell } from '@/components/layout/AppShell'
import { OrdersListPage } from '@/features/pos/OrdersListPage'
import { QueuePage } from '@/features/pos/QueuePage'
import { useOrderPayments } from '@/features/pos/useOrderPayments'

const PAYMENTS_FAILED = 'Could not load payments for this date.'
const VOIDS_FAILED = 'Could not load voided sales for this date.'
const FULFILMENT_FAILED = 'Could not load fulfilment for this date.'
const ORDERS_FAILED = 'Could not load orders. You may not have permission, or you are offline.'

const order = (index: number) => ({
  id: `o${index}`,
  number: index,
  businessDate: '2026-11-04',
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
  createdAt: null,
  createdBy: 'till',
  createdByName: 'Counter Till',
  staffId: 'alice',
  staffName: 'Alice',
})

/** Orders 1..count. Anything above 30 lands in a second chunk. */
const day = (count: number) => Array.from({ length: count }, (_, index) => order(index + 1))

const payment = (orderId: string) => ({
  orderId,
  method: 'ewallet',
  amount: 450,
  cashTendered: null,
  changeGiven: null,
  paidAt: null,
  paidBy: 'till',
  paidByName: 'Counter Till',
  paidByStaffId: 'alice',
  paidByStaffName: 'Alice',
})

type Row = Record<string, unknown> & { id?: string; orderId?: string }

const open = (path: string) => live.listeners.filter((l) => l.path === path && !l.closed)
const openTotal = () => live.listeners.filter((l) => !l.closed).length

/** The open listener covering this order. Exactly one, or the test is wrong. */
function chunkOf(path: string, orderId: string): Listener {
  const found = open(path).filter((l) => l.ids?.includes(orderId))
  expect(found).toHaveLength(1)
  return found[0]!
}

function answer(listener: Listener, rows: Row[] = []) {
  act(() =>
    listener.next({
      docs: rows.map((row) => ({ id: row.id ?? row.orderId, data: () => row })),
    }),
  )
}

function fail(listener: Listener) {
  act(() => {
    listener.closed = true
    listener.fail(new Error('permission-denied'))
  })
}

/** Every sidecar listener that has not been answered since `since`, empty. */
function answerNew(since: number) {
  for (const listener of live.listeners.slice(since)) {
    if (!listener.closed && listener.path !== 'orders') answer(listener)
  }
}

/** A day's orders arrive and every sidecar listener they open answers empty. */
function settle(count: number) {
  const since = live.listeners.length
  answer(open('orders')[0]!, day(count))
  answerNew(since)
}

/** The next sale is rung up: the orders listener reports one more. */
function saleRungUp(count: number) {
  const since = live.listeners.length
  answer(open('orders')[0]!, day(count))
  return since
}

beforeEach(() => {
  live.listeners.length = 0
})

describe('useSidecarDocs: one failed chunk among healthy ones', () => {
  const FIRST = ['o1', 'o2']
  const SECOND = ['o31']

  function renderChunks(initial: string[][] = [FIRST, SECOND]) {
    return renderHook(({ chunks }) => useOrderPayments(chunks), {
      initialProps: { chunks: initial },
    })
  }

  it('keeps reporting the failure while another chunk goes on answering', () => {
    const { result } = renderChunks()
    answer(chunkOf('orderPayments', 'o1'))
    answer(chunkOf('orderPayments', 'o31'))
    expect(result.current.error).toBeNull()

    fail(chunkOf('orderPayments', 'o1'))
    expect(result.current.error).toMatchObject({ key: 'load.paymentsDate' })

    answer(chunkOf('orderPayments', 'o31'), [payment('o31')])
    expect(result.current.error).toMatchObject({ key: 'load.paymentsDate' })
    expect(result.current.payments.has('o31')).toBe(true)
  })

  it('holds a separate failure for each chunk: one recovering does not excuse the other', () => {
    const { result, rerender } = renderChunks()
    answer(chunkOf('orderPayments', 'o1'))
    answer(chunkOf('orderPayments', 'o31'))
    fail(chunkOf('orderPayments', 'o1'))
    fail(chunkOf('orderPayments', 'o31'))
    rerender({ chunks: [FIRST, SECOND, ['o61']] })

    answer(chunkOf('orderPayments', 'o61'))
    answer(chunkOf('orderPayments', 'o31'))
    expect(result.current.error).toMatchObject({ key: 'load.paymentsDate' })

    answer(chunkOf('orderPayments', 'o1'))
    expect(result.current.error).toBeNull()
  })

  it('does not retry on its own: re-rendering opens nothing', () => {
    const chunks = [FIRST, SECOND]
    const { rerender } = renderHook(({ current }) => useOrderPayments(current), {
      initialProps: { current: chunks },
    })
    fail(chunkOf('orderPayments', 'o1'))
    const opened = live.listeners.length

    for (let i = 0; i < 5; i += 1) rerender({ current: chunks })
    expect(live.listeners.length).toBe(opened)
  })

  it('replaces the dead listener at the next reconciliation, and adds no other', () => {
    const { result, rerender } = renderChunks()
    answer(chunkOf('orderPayments', 'o1'))
    answer(chunkOf('orderPayments', 'o31'))
    const healthy = chunkOf('orderPayments', 'o31')
    fail(chunkOf('orderPayments', 'o1'))
    expect(open('orderPayments')).toHaveLength(1)

    // A third chunk appears. The failed one is still wanted, under the very same ids.
    rerender({ chunks: [FIRST, SECOND, ['o61']] })

    expect(open('orderPayments')).toHaveLength(3)
    expect(chunkOf('orderPayments', 'o31')).toBe(healthy)
    expect(chunkOf('orderPayments', 'o1').ids).toEqual(FIRST)
    // Reopened is not recovered: nothing is known until it has answered.
    expect(result.current.error).toMatchObject({ key: 'load.paymentsDate' })
  })

  it('clears the failure only when that chunk’s own new listener answers', () => {
    const { result, rerender } = renderChunks()
    answer(chunkOf('orderPayments', 'o1'))
    answer(chunkOf('orderPayments', 'o31'))
    fail(chunkOf('orderPayments', 'o1'))
    rerender({ chunks: [FIRST, SECOND, ['o61']] })

    answer(chunkOf('orderPayments', 'o61'))
    answer(chunkOf('orderPayments', 'o31'))
    expect(result.current.error).toMatchObject({ key: 'load.paymentsDate' })

    answer(chunkOf('orderPayments', 'o1'), [payment('o2')])
    expect(result.current.error).toBeNull()
    expect(result.current.payments.has('o2')).toBe(true)
  })

  it('reports it again if the replacement fails too', () => {
    const { result, rerender } = renderChunks()
    answer(chunkOf('orderPayments', 'o1'))
    answer(chunkOf('orderPayments', 'o31'))
    fail(chunkOf('orderPayments', 'o1'))
    rerender({ chunks: [FIRST, SECOND, ['o61']] })

    fail(chunkOf('orderPayments', 'o1'))
    answer(chunkOf('orderPayments', 'o31'))
    expect(result.current.error).toMatchObject({ key: 'load.paymentsDate' })
  })

  it('forgets a failure once its chunk is no longer asked for', () => {
    const { result, rerender } = renderChunks([FIRST])
    answer(chunkOf('orderPayments', 'o1'))
    fail(chunkOf('orderPayments', 'o1'))
    expect(result.current.error).not.toBeNull()

    // A day with no orders has nothing left to fail.
    rerender({ chunks: [] })
    expect(result.current.error).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it('leaves no listener open when it unmounts after a failure', () => {
    const { unmount, rerender } = renderChunks()
    fail(chunkOf('orderPayments', 'o1'))
    rerender({ chunks: [FIRST, SECOND, ['o61']] })
    unmount()
    expect(openTotal()).toBe(0)
  })
})

describe('the unpaid badge during a partial failure', () => {
  function renderShell() {
    return renderComponent(
      <MemoryRouter initialEntries={['/pos']}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/pos" element={<p>page</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    )
  }

  const badges = () => screen.queryAllByTestId('nav-unpaid-badge').map((node) => node.textContent)

  for (const [path, failing] of [
    ['orderPayments', 'payments'],
    ['orderVoids', 'voids'],
  ] as const) {
    it(`stays hidden while one ${failing} listener is down, however the others behave`, () => {
      renderShell()
      settle(31)
      expect(badges()).toEqual(['31', '31'])

      fail(chunkOf(path, 'o1'))
      expect(badges()).toEqual([])

      // The healthy chunk and the other collection go on answering. This is what used to bring
      // the badge back, counting from the failed chunk's frozen rows.
      answer(chunkOf(path, 'o31'))
      answer(chunkOf('orderPayments', 'o31'), [])
      answer(open('orders')[0]!, day(31))
      expect(badges()).toEqual([])
    })
  }

  it('returns with the count as it now stands, not as it stood before the failure', () => {
    renderShell()
    settle(31)
    expect(badges()).toEqual(['31', '31'])

    fail(chunkOf('orderPayments', 'o1'))
    answer(chunkOf('orderPayments', 'o31'))
    expect(badges()).toEqual([])

    // A sale reconciles the chunks, which is what replaces the dead listener: o32 joins the
    // second chunk and the first, unchanged, gets its listener back. No extra subscriptions —
    // one for the orders, and one per chunk for payments and voids, exactly as before.
    const since = saleRungUp(32)
    expect(openTotal()).toBe(5)
    expect(badges()).toEqual([])

    // Everything else answers first, and the failed chunk has not yet: still hidden.
    for (const listener of live.listeners.slice(since)) {
      if (!listener.closed && !listener.ids?.includes('o1')) answer(listener)
    }
    answer(chunkOf('orderVoids', 'o1'))
    expect(badges()).toEqual([])

    // o1 and o2 were paid during the outage, so the old rows would have said 32.
    answer(chunkOf('orderPayments', 'o1'), [payment('o1'), payment('o2')])
    expect(badges()).toEqual(['30', '30'])
  })

  it('comes back through a new listener, never the dead one', () => {
    renderShell()
    settle(2)
    const dead = chunkOf('orderPayments', 'o1')
    fail(dead)
    expect(badges()).toEqual([])

    const since = saleRungUp(3)
    answerNew(since)
    expect(badges()).toEqual(['3', '3'])
    expect(open('orderPayments')).not.toContain(dead)
  })
})

describe.each([
  ['Orders', OrdersListPage, 'order-row'],
  ['Queue', QueuePage, 'queue-card'],
] as const)('%s: how a failure is shown', (_name, Page, row) => {
  function renderPage() {
    return renderComponent(
      <MemoryRouter>
        <Page />
      </MemoryRouter>,
    )
  }

  const rows = () => screen.queryAllByTestId(row).length
  const alertText = () => screen.queryByRole('alert')?.textContent ?? null

  it('shows no alert on a healthy day', () => {
    renderPage()
    settle(31)
    expect(rows()).toBe(31)
    expect(alertText()).toBeNull()
  })

  it('keeps its rows and its alert while one chunk is down', () => {
    renderPage()
    settle(31)

    fail(chunkOf('orderPayments', 'o1'))
    expect(alertText()).toBe(PAYMENTS_FAILED)
    expect(rows()).toBe(31)

    answer(chunkOf('orderPayments', 'o31'))
    expect(alertText()).toBe(PAYMENTS_FAILED)
    expect(rows()).toBe(31)
  })

  it('clears the alert once the failed chunk has really answered again', () => {
    renderPage()
    settle(31)
    fail(chunkOf('orderPayments', 'o1'))

    const since = saleRungUp(32)
    for (const listener of live.listeners.slice(since)) {
      if (!listener.closed && !listener.ids?.includes('o1')) answer(listener)
    }
    expect(alertText()).toBe(PAYMENTS_FAILED)

    answer(chunkOf('orderPayments', 'o1'))
    expect(alertText()).toBeNull()
    expect(rows()).toBe(32)
  })

  it('still clears a one-chunk failure when the next sale arrives, as it always did', () => {
    renderPage()
    settle(2)
    fail(chunkOf('orderPayments', 'o1'))
    expect(alertText()).toBe(PAYMENTS_FAILED)

    answerNew(saleRungUp(3))
    expect(alertText()).toBeNull()
    expect(rows()).toBe(3)
  })

  it('names fulfilment in its own words', () => {
    renderPage()
    settle(2)
    fail(chunkOf('orderFulfillment', 'o1'))
    expect(alertText()).toBe(FULFILMENT_FAILED)
  })

  it('names voids in their own words', () => {
    renderPage()
    settle(2)
    fail(chunkOf('orderVoids', 'o1'))
    expect(alertText()).toBe(VOIDS_FAILED)
  })

  it('still puts payments ahead of voids, and voids ahead of fulfilment', () => {
    renderPage()
    settle(2)
    fail(chunkOf('orderFulfillment', 'o1'))
    fail(chunkOf('orderVoids', 'o1'))
    expect(alertText()).toBe(VOIDS_FAILED)
    fail(chunkOf('orderPayments', 'o1'))
    expect(alertText()).toBe(PAYMENTS_FAILED)
  })

  it('still reports the orders themselves failing', () => {
    renderPage()
    fail(open('orders')[0]!)
    expect(alertText()).toBe(ORDERS_FAILED)
  })
})
