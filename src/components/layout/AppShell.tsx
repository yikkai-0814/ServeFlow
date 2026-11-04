import { Outlet } from 'react-router'

import { MobileNav } from '@/components/layout/MobileNav'
import { Sidebar } from '@/components/layout/Sidebar'
import { Topbar } from '@/components/layout/Topbar'
import { useUnpaidOrderCount } from '@/features/pos/useUnpaidOrderCount'

/**
 * Admin and staff share one shell. The difference between them in Phase 1 is which nav
 * items and routes exist, not a separate layout.
 *
 * Today's unpaid-order count is subscribed to here, once, and handed to both navigations —
 * only one of which is ever visible — rather than each opening its own listeners.
 */
export function AppShell() {
  const unpaidOrders = useUnpaidOrderCount()

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <Topbar />
      <div className="flex flex-1">
        <Sidebar unpaidOrders={unpaidOrders} />
        {/* min-w-0 is load-bearing: without it a wide table or a long order reference makes
            this flex child refuse to shrink, and the whole PAGE scrolls sideways instead of
            the table scrolling inside its own container. */}
        <main className="min-w-0 flex-1 p-4 pb-6 md:p-6">
          <Outlet />
        </main>
      </div>
      {/* Below md the sidebar is hidden, so this is the only way off a page. */}
      <MobileNav unpaidOrders={unpaidOrders} />
    </div>
  )
}
