// @vitest-environment jsdom
/**
 * Where the browser's opt-in timings are taken (src/lib/perf.ts): restoring a session, the first
 * answer for each menu collection, and orders reaching the Queue.
 *
 * Each is checked both ways. Switched on, it reports what it should and nothing that identifies a
 * person. Switched off — the default everywhere — it reports nothing, and what the app does with
 * the data is the same as it always was.
 */
import { act, renderHook, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

import { renderComponent } from './render'

type Next = (snapshot: unknown) => void
const listeners = new Map<string, { next: Next; fail: () => void }>()
let authChanged: ((user: { uid: string } | null) => void) | null = null
const signInWithEmailAndPassword = vi.hoisted(() => vi.fn())

vi.mock('@/lib/firebase', () => ({ app: {}, auth: {}, db: {} }))

vi.mock('firebase/auth', () => ({
  onAuthStateChanged: (_auth: unknown, callback: (user: { uid: string } | null) => void) => {
    authChanged = callback
    return () => {
      authChanged = null
    }
  },
  signInWithEmailAndPassword,
  signOut: vi.fn(async () => undefined),
}))

vi.mock('firebase/firestore', () => ({
  collection: (_db: unknown, path: string) => ({ path }),
  doc: (_db: unknown, ...segments: string[]) => ({ path: segments.join('/') }),
  onSnapshot: (ref: { path: string }, next: Next, fail: () => void) => {
    listeners.set(ref.path, { next, fail })
    return () => listeners.delete(ref.path)
  },
}))

import { AuthProvider } from '@/features/auth/AuthProvider'
import { useAuth } from '@/features/auth/useAuth'
import { clearCollectionCache, useCollectionDocs } from '@/features/menu/use-collection'
import type { Order } from '@/features/pos/types'
import { useQueuePerf } from '@/features/pos/useQueuePerf'
import { PERF_STORAGE_KEY, resetPerf } from '@/lib/perf'

let info: MockInstance<typeof console.info>

function timing(on: boolean) {
  resetPerf()
  if (on) localStorage.setItem(PERF_STORAGE_KEY, '1')
  else localStorage.removeItem(PERF_STORAGE_KEY)
}

/** Every measurement printed, as [name, fields]. */
const measured = () => info.mock.calls.map((call) => [call[1], call[3]])

beforeEach(() => {
  listeners.clear()
  authChanged = null
  clearCollectionCache()
  signInWithEmailAndPassword.mockReset()
  info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.removeItem(PERF_STORAGE_KEY)
  resetPerf()
})

// ---- Session -----------------------------------------------------------------------------------

function SessionProbe() {
  const { status, signIn } = useAuth()
  const [failure, setFailure] = useState('')
  return (
    <>
      <p data-testid="status">{status}</p>
      <p data-testid="failure">{failure}</p>
      <button
        type="button"
        onClick={() => {
          signIn('alice@example.com', 'hunter22').catch((caught: { code?: string }) =>
            setFailure(caught.code ?? 'failed'),
          )
        }}
      >
        sign in
      </button>
    </>
  )
}

function restoreSession(uid: string) {
  act(() => authChanged?.({ uid }))
  act(() =>
    listeners.get(`users/${uid}`)?.next({
      exists: () => true,
      data: () => ({ role: 'staff', active: true, displayName: 'Alice Tan', email: 'a@x.y' }),
      metadata: { fromCache: false },
    }),
  )
}

describe('restoring a session', () => {
  it('times the saved session and the profile, without naming anyone', () => {
    timing(true)
    renderComponent(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    restoreSession('secret-uid-9')

    expect(screen.getByTestId('status').textContent).toBe('authenticated')
    expect(measured()).toEqual([
      ['session.auth', { signedIn: true }],
      ['session.profile', { fromCache: false }],
    ])
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/secret-uid|Alice|a@x\.y/)
  })

  it('times a sign-in, records only the error code, and still passes the error on', async () => {
    timing(true)
    signInWithEmailAndPassword.mockRejectedValue({ code: 'auth/invalid-credential' })
    const { user } = renderComponent(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )
    act(() => authChanged?.(null))

    await user.click(screen.getByText('sign in'))

    await waitFor(() =>
      expect(screen.getByTestId('failure').textContent).toBe('auth/invalid-credential'),
    )
    expect(measured()).toContainEqual(['login.signIn', { outcome: 'invalid-credential' }])
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/alice@example|hunter22/)
  })

  it('restores the session the same way, and prints nothing, when switched off', () => {
    timing(false)
    renderComponent(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    restoreSession('secret-uid-9')

    expect(screen.getByTestId('status').textContent).toBe('authenticated')
    expect(info).not.toHaveBeenCalled()
  })
})

// ---- Menu --------------------------------------------------------------------------------------

/** Module-level, as useCollectionDocs requires. */
function parseName(id: string, data: Record<string, unknown>) {
  return typeof data.name === 'string' ? { id, name: data.name } : null
}

function deliver(path: string, names: string[], fromCache: boolean) {
  act(() =>
    listeners.get(path)?.next({
      docs: names.map((name, index) => ({ id: `d${index}`, data: () => ({ name }) })),
      metadata: { fromCache },
    }),
  )
}

describe('loading the menu', () => {
  it('times the first answer for a menu collection, once', () => {
    timing(true)
    const { result } = renderHook(() => useCollectionDocs('menuItems', parseName))

    deliver('menuItems', ['Teh Tarik', 'Kopi O'], true)
    deliver('menuItems', ['Teh Tarik', 'Kopi O', 'Milo'], false)

    expect(result.current.data).toHaveLength(3)
    expect(measured()).toEqual([
      ['menu.first', { collection: 'menuItems', fromCache: true, count: 2 }],
    ])
  })

  it('does not time a collection that is not part of the menu', () => {
    timing(true)
    renderHook(() => useCollectionDocs('staffMembers', parseName))

    deliver('staffMembers', ['Alice Tan'], false)

    expect(info).not.toHaveBeenCalled()
  })

  it('records a failed read as an error, and still shows the error as before', () => {
    timing(true)
    const { result } = renderHook(() => useCollectionDocs('categories', parseName))

    act(() => listeners.get('categories')?.fail())

    expect(result.current.error).not.toBeNull()
    expect(measured()).toEqual([['menu.first', { collection: 'categories', outcome: 'error' }]])
  })

  it('loads the same rows and prints nothing when switched off', () => {
    timing(false)
    const { result } = renderHook(() => useCollectionDocs('menuItems', parseName))

    deliver('menuItems', ['Teh Tarik'], false)

    expect(result.current.data).toEqual([{ id: 'd0', name: 'Teh Tarik' }])
    expect(info).not.toHaveBeenCalled()
  })
})

// ---- Queue -------------------------------------------------------------------------------------

function order(id: string, createdAtMs: number | null = null): Order {
  return {
    id,
    createdAt: createdAtMs === null ? null : { toMillis: () => createdAtMs },
  } as unknown as Order
}

function renderQueue(initial: { date: string; orders: Order[]; loading: boolean }) {
  return renderHook((props) => useQueuePerf(props.date, props.orders, props.loading), {
    initialProps: initial,
  })
}

describe('orders reaching the Queue', () => {
  it('times the first complete board, then each new order until the board is whole again', () => {
    timing(true)
    const first = [order('a'), order('b')]
    const { rerender } = renderQueue({ date: '2026-11-13', orders: [], loading: true })

    rerender({ date: '2026-11-13', orders: first, loading: false })
    expect(measured()).toEqual([['queue.first', { count: 2 }]])

    // The new order arrives; its group's listeners reopen, so the board is loading again.
    const placedAt = Date.now() - 1_500
    const withNew = [order('c', placedAt), ...first]
    rerender({ date: '2026-11-13', orders: withNew, loading: true })
    expect(info).toHaveBeenCalledTimes(1)

    rerender({ date: '2026-11-13', orders: withNew, loading: false })
    const [name, fields] = measured()[1]!
    expect(name).toBe('queue.newOrder')
    expect(
      (fields as { approxSinceCreatedMs: number }).approxSinceCreatedMs,
    ).toBeGreaterThanOrEqual(1_500)
  })

  it('starts again for another business date', () => {
    timing(true)
    const { rerender } = renderQueue({ date: '2026-11-13', orders: [order('a')], loading: false })
    rerender({ date: '2026-11-12', orders: [], loading: true })
    rerender({ date: '2026-11-12', orders: [order('x'), order('y')], loading: false })

    expect(measured()).toEqual([
      ['queue.first', { count: 1 }],
      ['queue.first', { count: 2 }],
    ])
  })

  it('prints nothing when switched off', () => {
    timing(false)
    const { rerender } = renderQueue({ date: '2026-11-13', orders: [], loading: false })
    rerender({ date: '2026-11-13', orders: [order('a', Date.now())], loading: false })

    expect(info).not.toHaveBeenCalled()
  })
})
