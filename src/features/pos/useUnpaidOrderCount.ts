import { useMemo } from 'react'

import { chunkOrderIds } from '@/features/pos/order-sidecars'
import { buildOrderViews, countUnpaidOrders } from '@/features/pos/orders-view'
import type { OrderFulfillment } from '@/features/pos/types'
import { useBusinessToday } from '@/features/pos/useBusinessToday'
import { useOrderPayments } from '@/features/pos/useOrderPayments'
import { useOrders } from '@/features/pos/useOrders'
import { useOrderVoids } from '@/features/pos/useOrderVoids'

/** Fulfilment says nothing about money, so the count never subscribes to it. */
const NO_FULFILLMENTS = new Map<string, OrderFulfillment>()

/**
 * How many of TODAY's orders are still waiting to be paid, live — for the Orders badge in
 * the navigation, which is on screen on every page.
 *
 * Today, always: not whichever day the Orders page happens to be showing. The badge is a
 * standing "money still owed at the counter", and it has to mean the same thing from New
 * Order as from Orders.
 *
 * Built from the same hooks the Orders and Queue pages use (`useOrders`, then the payment and
 * void records for exactly those orders) and counted by `countUnpaidOrders` — the rule the
 * Unpaid filter applies — so the badge, the filter and each row's badge cannot disagree. While
 * one of those pages shows today, it asks Firestore the very same queries; the SDK serves
 * identical queries from one listen target, so the badge does not double the reads. Fulfilment
 * records are not subscribed to at all: they have no bearing on whether an order is paid.
 *
 * Null until today's orders and their sidecars have all arrived, or if any of them cannot be
 * read — a badge has to be right or absent, never a guess.
 */
export function useUnpaidOrderCount(): number | null {
  const today = useBusinessToday()
  const { orders, loading: ordersLoading, error: ordersError } = useOrders(today)
  const chunks = useMemo(() => chunkOrderIds(orders), [orders])
  const { payments, loading: paymentsLoading, error: paymentsError } = useOrderPayments(chunks)
  const { voids, loading: voidsLoading, error: voidsError } = useOrderVoids(chunks)

  const settled = !ordersLoading && !paymentsLoading && !voidsLoading
  const failed = ordersError !== null || paymentsError !== null || voidsError !== null

  return useMemo(
    () =>
      settled && !failed
        ? countUnpaidOrders(
            buildOrderViews(orders, { payments, voids, fulfillments: NO_FULFILLMENTS }),
          )
        : null,
    [settled, failed, orders, payments, voids],
  )
}
