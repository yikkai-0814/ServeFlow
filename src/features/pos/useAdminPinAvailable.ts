import { useEffect, useState } from 'react'

import { fetchAdminPinStatus } from '@/features/pos/void-pin-api'

/**
 * Whether a staff member's void can be authorised with an admin PIN yet.
 *
 * Asked of the server once, when a page that can void opens. Until it answers — and if it
 * cannot be reached, or no administrator has set a PIN — the answer is no, and the void dialog
 * falls back to the manager sign-in it has always had. So a missing PIN, or the functions
 * being unavailable, never leaves the counter unable to void at all.
 */
export function useAdminPinAvailable(enabled: boolean): boolean {
  const [available, setAvailable] = useState(false)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    fetchAdminPinStatus()
      .then((status) => {
        if (!cancelled) setAvailable(status.pinAvailable)
      })
      .catch(() => {
        if (!cancelled) setAvailable(false)
      })
    return () => {
      cancelled = true
    }
  }, [enabled])

  return enabled && available
}
