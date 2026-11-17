import { useEffect, useRef } from 'react'

import type { Order } from '@/features/pos/types'
import { perfEnabled, perfMeasure, perfNow } from '@/lib/perf'

/**
 * Times how quickly a day's orders reach the screen, when timing is switched on (src/lib/perf.ts).
 * Does nothing at all otherwise — not even keep the ids it would compare.
 *
 * Two measurements, both on the device showing the board:
 *
 *  - `queue.first`: the day was asked for → its orders and their payment, void and fulfilment
 *    records have all arrived. Once per business date shown.
 *  - `queue.newOrder`: an order appeared in the day's listener → the board is complete again.
 *    The gap is the listeners for its group of orders reopening (see order-sidecars.ts). It
 *    also reports `approxSinceCreatedMs`: this device's clock minus the time the server wrote the
 *    order. That is the whole trip from the till, but only as accurate as the two clocks agree.
 *
 * Reads only what the workspace already has. It changes nothing it is given and opens nothing.
 */
interface Tracking {
  businessDate: string
  startedAt: number
  /** The ids already counted; null until the day's first complete answer. */
  known: Set<string> | null
  /** A new order waiting for the board to be complete again. */
  arriving: { startedAt: number; createdAtMs: number | null } | null
}

function createdAtMs(order: Order): number | null {
  const millis = order.createdAt?.toMillis?.()
  return typeof millis === 'number' && Number.isFinite(millis) ? millis : null
}

export function useQueuePerf(businessDate: string, orders: readonly Order[], loading: boolean) {
  const tracking = useRef<Tracking | null>(null)

  useEffect(() => {
    if (!perfEnabled()) return
    tracking.current = { businessDate, startedAt: perfNow(), known: null, arriving: null }
  }, [businessDate])

  useEffect(() => {
    const current = tracking.current
    if (!current || current.businessDate !== businessDate) return

    if (current.known === null) {
      if (loading) return
      perfMeasure('queue.first', current.startedAt, { count: orders.length })
      current.known = new Set(orders.map((order) => order.id))
      return
    }

    const known = current.known
    const fresh = orders.filter((order) => !known.has(order.id))
    for (const order of fresh) known.add(order.id)
    if (fresh.length > 0 && current.arriving === null) {
      const created = fresh.map(createdAtMs).filter((millis): millis is number => millis !== null)
      current.arriving = {
        startedAt: perfNow(),
        createdAtMs: created.length > 0 ? Math.max(...created) : null,
      }
    }

    if (current.arriving && !loading) {
      const { startedAt, createdAtMs: created } = current.arriving
      current.arriving = null
      perfMeasure(
        'queue.newOrder',
        startedAt,
        created === null ? undefined : { approxSinceCreatedMs: Date.now() - created },
      )
    }
  }, [businessDate, orders, loading])
}
