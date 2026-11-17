// @vitest-environment jsdom
/**
 * The till's triggers and the real warm-up module together: however many things a person does —
 * opening the till, coming back into view, choosing an operator, the first item — there is never
 * more than one warm-up in flight, and none again for five minutes after one succeeds. Only the
 * network call is replaced.
 */
import { act, useSyncExternalStore } from 'react'

import { screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Operator } from '@/features/staff/staff-session'

import { renderComponent } from './render'

const signedIn = vi.hoisted(() => ({ currentUser: { uid: 'till-uid' } as { uid: string } | null }))
const callable = vi.hoisted(() => vi.fn())

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
vi.mock('firebase/functions', () => ({ httpsCallable: () => callable }))

vi.mock('@/features/auth/useAuth', () => ({
  useAuth: () => ({
    status: 'authenticated',
    role: 'staff',
    profile: { uid: 'till-uid', displayName: 'Shared Till', role: 'staff', active: true },
  }),
}))

const ALICE: Operator = { id: 'alice', name: 'Alice', isSelf: false }
let operator: Operator | null = null
const listeners = new Set<() => void>()
vi.mock('@/features/staff/useStaffSession', () => ({
  useStaffSession: () => ({
    operator: useSyncExternalStore(
      (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      () => operator,
    ),
    operators: [ALICE],
    loading: false,
    select: () => {
      operator = ALICE
      for (const listener of listeners) listener()
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
vi.mock('@/features/pos/pos-api', () => ({ createOrder: vi.fn() }))

import { ORDER_WARMUP_INTERVAL_MS, resetOrderWarmup } from '@/features/pos/order-warmup'
import { TerminalPage } from '@/features/pos/TerminalPage'

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
  let reject!: (reason: unknown) => void
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  resetOrderWarmup()
  signedIn.currentUser = { uid: 'till-uid' }
  operator = null
  visibility = 'visible'
  clock = 1_800_000_000_000
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  callable.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** Every trigger the till has, one after another. */
async function everyTrigger(user: ReturnType<typeof renderComponent>['user']) {
  becomes('hidden')
  becomes('visible')
  await user.click(screen.getByText('Alice'))
  await user.click(screen.getByText('Teh Tarik'))
}

describe('the till and the warm-up together', () => {
  it('send one warm-up while it is in flight, whatever else happens', async () => {
    const pending = deferred()
    callable.mockReturnValue(pending.promise)
    const { user } = renderComponent(<TerminalPage />)

    await everyTrigger(user)

    expect(callable).toHaveBeenCalledOnce()
    expect(callable).toHaveBeenCalledWith({ warmup: true })
  })

  it('send nothing more for five minutes after one succeeds, then one again', async () => {
    callable.mockResolvedValue({ data: { warm: true } })
    const { user } = renderComponent(<TerminalPage />)
    await act(async () => undefined)

    await everyTrigger(user)
    expect(callable).toHaveBeenCalledOnce()

    clock += ORDER_WARMUP_INTERVAL_MS
    becomes('hidden')
    becomes('visible')
    expect(callable).toHaveBeenCalledTimes(2)
  })

  it('retry at the next trigger after a failure, still one at a time', async () => {
    callable.mockRejectedValueOnce(new Error('unavailable'))
    const retry = deferred()
    callable.mockReturnValueOnce(retry.promise)
    renderComponent(<TerminalPage />)
    await act(async () => undefined)

    becomes('hidden')
    becomes('visible')
    becomes('hidden')
    becomes('visible')

    expect(callable).toHaveBeenCalledTimes(2)
  })

  it('send nothing once Firebase Auth is no longer signed in as this till', async () => {
    signedIn.currentUser = null
    const { user } = renderComponent(<TerminalPage />)

    await everyTrigger(user)

    expect(callable).not.toHaveBeenCalled()
  })
})
