import { cn } from '@/lib/utils'

/**
 * A small brick-red count on a navigation item — today, the Orders link's unpaid orders.
 *
 * Nothing at all at zero (or while the count is unknown): a badge that is always there stops
 * being read. Above 99 it says "99+", so it never grows wider than the icon it sits on.
 *
 * Decorative for assistive technology. The number is announced through the link instead (its
 * `aria-describedby` points at `describedById`), so a screen reader hears "Orders, 7 unpaid
 * orders today" rather than a bare "7" glued onto the link's name.
 */
export function NavCountBadge({
  count,
  description,
  describedById,
  className,
}: {
  count: number | null | undefined
  /** The full sentence the number stands for, for screen readers. */
  description: string
  describedById: string
  className?: string
}) {
  if (!count || count <= 0) return null
  const capped = count > 99

  return (
    <>
      <span
        aria-hidden="true"
        data-testid="nav-unpaid-badge"
        className={cn(
          'pointer-events-none inline-flex h-5 shrink-0 items-center justify-center rounded-full',
          // A fixed 20px circle with no side padding for 1–99, so a two-digit count stays a
          // circle instead of stretching into a pill; only "99+" needs the room to widen.
          capped ? 'min-w-5 px-1' : 'w-5',
          // The line box is the circle's full height, so there is no half-pixel left over to
          // round the digits up or down. Proportional digits, not tabular: tabular figures pad
          // a "1" to the width of a "0", which sat a two-digit count visibly off-centre.
          // The theme's notification pair: a muted brick red, deep enough to carry a white
          // number in both themes (see --notification in index.css).
          'bg-notification text-[0.6875rem] leading-5 font-semibold text-notification-foreground',
          // A thin ring in the bar's own colour, so the badge stays a clean circle over an
          // icon or on the filled active item rather than bleeding into it.
          'ring-2 ring-sidebar',
          className,
        )}
      >
        {capped ? '99+' : count}
      </span>
      {/* `hidden`, not sr-only: a description is read through aria-describedby even when
          hidden, and hiding it keeps it out of the link's NAME — a link named by its content
          (the bottom bar's) would otherwise be called "7 unpaid orders today Orders". */}
      <span id={describedById} hidden>
        {description}
      </span>
    </>
  )
}
