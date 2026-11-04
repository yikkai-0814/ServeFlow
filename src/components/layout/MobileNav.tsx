import { useTranslation } from '@/features/i18n/useTranslation'
import { useId } from 'react'
import { NavLink } from 'react-router'

import { NavCountBadge } from '@/components/layout/NavCountBadge'
import { navItemsForRole } from '@/components/layout/nav-items'
import { useAuth } from '@/features/auth/useAuth'
import { cn } from '@/lib/utils'

/**
 * Navigation below `md`, where the sidebar is hidden.
 *
 * Until this existed there was none: `Sidebar` is `hidden md:flex`, so a phone-width session
 * could reach a page but never leave it except by the browser's back button. A till or a
 * kitchen tablet held in portrait is not an exotic case for this application.
 *
 * A bottom bar rather than a drawer, because the thumb is already at the bottom of the
 * screen and a POS should not ask for two taps to change screen. It renders from
 * `navItemsForRole` — the same data the sidebar uses — so the roles and their order stay
 * whatever nav-items.ts says, and nothing here can drift from the desktop nav.
 *
 * An admin has six sections, which will not fit across a 390px screen at a readable size;
 * the row scrolls horizontally rather than shrinking the labels to nothing. Staff have four,
 * which fit comfortably, and staff are the ones actually working at this width.
 */
export function MobileNav({
  unpaidOrders = null,
}: {
  /** Today's unpaid orders, badged on the Orders link. Null or zero shows no badge. */
  unpaidOrders?: number | null
} = {}) {
  const { role } = useAuth()
  const { t } = useTranslation()
  const items = navItemsForRole(role)
  const badgeId = useId()

  if (items.length === 0) return null

  return (
    <nav
      aria-label={t('nav.main')}
      className={cn(
        'sticky bottom-0 z-30 flex min-h-mobile-nav shrink-0 gap-1 overflow-x-auto border-t bg-sidebar px-2 pt-1 md:hidden',
        // Clears the home indicator on phones that have one, so the last row of links is not
        // sitting underneath it.
        'pb-[max(0.375rem,env(safe-area-inset-bottom))]',
      )}
    >
      {items.map(({ to, labelKey, icon: Icon }) => {
        const label = t(labelKey)
        const count = to === '/orders' ? unpaidOrders : null
        const badged = count !== null && count > 0
        return (
          <NavLink
            key={to}
            to={to}
            aria-describedby={badged ? badgeId : undefined}
            className={({ isActive }) =>
              cn(
                // px-1, not px-2: at 320px a quarter of the bar is ~73px, and the extra 8px
                // was what cut "New Order" to "New Ord…". py-0.5, and pt-1 on the bar, so that
                // a two-line label still fits `min-h-mobile-nav`: the till's sticky bars offset
                // by that token, and a bar any taller would sit on top of them.
                'flex min-w-18 flex-1 shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-0.5',
                'text-xs font-medium transition-colors',
                'focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                isActive
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )
            }
          >
            {({ isActive }) => (
              <>
                {/* The badge rides on the icon's corner, so the label below keeps its width. */}
                <span className="relative">
                  <Icon className="size-5 shrink-0" aria-hidden="true" />
                  <NavCountBadge
                    count={count}
                    describedById={badgeId}
                    description={t(count === 1 ? 'nav.unpaidOrdersOne' : 'nav.unpaidOrdersOther', {
                      count: count ?? 0,
                    })}
                    className="absolute -top-2 left-3"
                  />
                </span>
                {/* The label is always present, never icon-only: an icon alone is a guess, and
                  this is the only navigation available at this width. It wraps to a second line
                  rather than being cut off — "Pesanan Baharu" cannot fit one line on a phone. */}
                <span className="line-clamp-2 max-w-full text-center leading-tight wrap-break-word">
                  {label}
                </span>
                {isActive && <span className="sr-only">(current page)</span>}
              </>
            )}
          </NavLink>
        )
      })}
    </nav>
  )
}
