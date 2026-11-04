// @vitest-environment jsdom
/**
 * The red unpaid-orders badge on the Orders navigation item — desktop sidebar (expanded and
 * collapsed) and the bottom bar below `md`.
 *
 * The count itself comes from useUnpaidOrderCount (tested separately); here it is a prop, so
 * these tests pin what is drawn and announced for each value, including a live change.
 */
import { screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MobileNav } from '@/components/layout/MobileNav'
import { serializeCollapsed, SIDEBAR_STORAGE_KEY } from '@/components/layout/sidebar-state'
import { Sidebar } from '@/components/layout/Sidebar'
import type { Role } from '@/features/auth/types'
import { LANGUAGE_STORAGE_KEY } from '@/features/i18n/languages'

import { renderComponent } from './render'

let currentRole: Role = 'staff'

vi.mock('@/features/auth/useAuth', () => ({
  useAuth: () => ({ role: currentRole, status: 'authenticated', profile: null }),
}))

beforeEach(() => {
  currentRole = 'staff'
  window.localStorage.clear()
})

afterEach(() => {
  window.localStorage.clear()
})

function inRouter(ui: React.ReactElement) {
  return (
    <MemoryRouter initialEntries={['/pos']}>
      <Routes>
        <Route path="*" element={ui} />
      </Routes>
    </MemoryRouter>
  )
}

const ordersLink = (name = 'Orders') => screen.getByRole('link', { name })
const badges = () => screen.queryAllByTestId('nav-unpaid-badge')
/** What a screen reader hears after the link's name. */
const descriptionOf = (link: HTMLElement) => {
  const id = link.getAttribute('aria-describedby')
  return id ? document.getElementById(id)?.textContent : null
}

describe('Sidebar: the unpaid badge on Orders', () => {
  it('shows nothing at zero, and nothing while the count is unknown', () => {
    const { rerender } = renderComponent(inRouter(<Sidebar unpaidOrders={0} />))
    expect(badges()).toHaveLength(0)
    expect(ordersLink().getAttribute('aria-describedby')).toBeNull()

    rerender(inRouter(<Sidebar unpaidOrders={null} />))
    expect(badges()).toHaveLength(0)
  })

  it('shows the count on the Orders item only, in the theme’s notification colours', () => {
    renderComponent(inRouter(<Sidebar unpaidOrders={7} />))
    const badge = within(ordersLink()).getByTestId('nav-unpaid-badge')
    expect(badge.textContent).toBe('7')
    expect(badges()).toHaveLength(1)
    expect(badge.className).toContain('bg-notification')
    expect(badge.className).toContain('text-notification-foreground')
    // Its own token pair, not --destructive: that one cannot carry a white number in dark mode.
    expect(badge.className).not.toContain('destructive')
    expect(badge.className).toContain('rounded-full')
  })

  it('keeps the link named "Orders" and describes the count for screen readers', () => {
    renderComponent(inRouter(<Sidebar unpaidOrders={7} />))
    expect(descriptionOf(ordersLink())).toBe('7 unpaid orders today')
    // The visible number is decorative; the description carries it.
    expect(within(ordersLink()).getByTestId('nav-unpaid-badge').getAttribute('aria-hidden')).toBe(
      'true',
    )
  })

  it('uses the singular for one order', () => {
    renderComponent(inRouter(<Sidebar unpaidOrders={1} />))
    expect(descriptionOf(ordersLink())).toBe('1 unpaid order today')
  })

  it('is a fixed 20px circle with the number centred, for one digit and for two', () => {
    for (const value of [7, 42, 99]) {
      const { unmount } = renderComponent(inRouter(<Sidebar unpaidOrders={value} />))
      const badge = within(ordersLink()).getByTestId('nav-unpaid-badge')
      const classes = badge.className.split(/\s+/)
      expect(classes).toEqual(
        expect.arrayContaining(['inline-flex', 'items-center', 'justify-center', 'h-5', 'w-5']),
      )
      // No side padding to push a two-digit count into a pill, a line box as tall as the
      // circle, and proportional digits — the three things that had it off-centre.
      expect(classes.some((name) => /^px-/.test(name))).toBe(false)
      expect(classes).toContain('leading-5')
      expect(classes).not.toContain('tabular-nums')
      unmount()
    }
  })

  it('lets only "99+" widen past the circle', () => {
    renderComponent(inRouter(<Sidebar unpaidOrders={150} />))
    const classes = within(ordersLink()).getByTestId('nav-unpaid-badge').className.split(/\s+/)
    expect(classes).toEqual(expect.arrayContaining(['h-5', 'min-w-5', 'px-1']))
    expect(classes).not.toContain('w-5')
  })

  it('caps the number at 99+ so the badge never outgrows the icon', () => {
    renderComponent(inRouter(<Sidebar unpaidOrders={150} />))
    expect(within(ordersLink()).getByTestId('nav-unpaid-badge').textContent).toBe('99+')
    expect(descriptionOf(ordersLink())).toBe('150 unpaid orders today')
  })

  it('follows the count live, and disappears when it reaches zero', () => {
    const { rerender } = renderComponent(inRouter(<Sidebar unpaidOrders={7} />))
    rerender(inRouter(<Sidebar unpaidOrders={6} />))
    expect(within(ordersLink()).getByTestId('nav-unpaid-badge').textContent).toBe('6')

    rerender(inRouter(<Sidebar unpaidOrders={0} />))
    expect(badges()).toHaveLength(0)
    expect(ordersLink().getAttribute('aria-describedby')).toBeNull()
  })

  it('sits on the icon in the rail, and at the right end of the item when expanded', () => {
    const { unmount } = renderComponent(inRouter(<Sidebar unpaidOrders={7} />))
    const expanded = within(ordersLink()).getByTestId('nav-unpaid-badge').className
    // Below xl the expanded sidebar is the rail too, so both placements are present.
    expect(expanded).toContain('absolute')
    expect(expanded).toContain('xl:static')
    expect(expanded).toContain('xl:ml-auto')
    unmount()

    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, serializeCollapsed(true))
    renderComponent(inRouter(<Sidebar unpaidOrders={7} />))
    const collapsed = within(ordersLink()).getByTestId('nav-unpaid-badge').className
    expect(collapsed).toContain('absolute')
    expect(collapsed).not.toContain('xl:static')
    expect(descriptionOf(ordersLink())).toBe('7 unpaid orders today')
  })

  it('appears for an admin too, whose Orders item is in a different place', () => {
    currentRole = 'admin'
    renderComponent(inRouter(<Sidebar unpaidOrders={3} />))
    expect(within(ordersLink()).getByTestId('nav-unpaid-badge').textContent).toBe('3')
    expect(badges()).toHaveLength(1)
  })
})

describe('MobileNav: the unpaid badge on Orders', () => {
  it('shows nothing at zero', () => {
    renderComponent(inRouter(<MobileNav unpaidOrders={0} />))
    expect(badges()).toHaveLength(0)
  })

  it('rides on the Orders icon, keeps the link name, and describes the count', () => {
    renderComponent(inRouter(<MobileNav unpaidOrders={7} />))
    const link = ordersLink()
    const badge = within(link).getByTestId('nav-unpaid-badge')
    expect(badge.textContent).toBe('7')
    expect(badge.className).toContain('absolute')
    // Positioned against the icon's own wrapper, not the whole tab.
    expect(badge.parentElement?.className).toContain('relative')
    expect(badge.parentElement?.querySelector('svg')).not.toBeNull()
    expect(descriptionOf(link)).toBe('7 unpaid orders today')
    expect(badges()).toHaveLength(1)
  })

  it('follows the count live', () => {
    const { rerender } = renderComponent(inRouter(<MobileNav unpaidOrders={2} />))
    rerender(inRouter(<MobileNav unpaidOrders={3} />))
    expect(within(ordersLink()).getByTestId('nav-unpaid-badge').textContent).toBe('3')
  })
})

describe('the unpaid badge in every language', () => {
  for (const [language, name, many, one] of [
    ['ms', 'Pesanan', '7 pesanan belum dibayar hari ini', '1 pesanan belum dibayar hari ini'],
    ['zh', '订单', '今日有 7 张未付款订单', '今日有 1 张未付款订单'],
  ] as const) {
    it(`describes the count in ${language}`, () => {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language)
      const { rerender } = renderComponent(inRouter(<Sidebar unpaidOrders={7} />))
      expect(descriptionOf(ordersLink(name))).toBe(many)
      rerender(inRouter(<Sidebar unpaidOrders={1} />))
      expect(descriptionOf(ordersLink(name))).toBe(one)
    })
  }
})
