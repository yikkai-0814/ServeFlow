import { message, MessageError, type Message } from '@/features/i18n/messages'
import { useTranslation } from '@/features/i18n/useTranslation'
import { useRef, useState } from 'react'
import { Clock, Wallet } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { recordPayment } from '@/features/pos/payment-api'
import { RecordPaymentDialog } from '@/features/pos/RecordPaymentDialog'
import type { PaymentMethod } from '@/features/pos/types'
import { useOrderDetail } from '@/features/pos/useOrderDetail'
import { formatMoney } from '@/lib/money'

/**
 * An order the till has just written, held while the counter decides how it is paid.
 *
 * Everything a payment needs is captured here at the moment of sale rather than read back
 * from the page afterwards: by now the cart has been cleared, and the operator question has
 * been reset for the next order, so neither is a safe source for THIS order's figures.
 */
export interface PlacedOrder {
  id: string
  number: number
  total: number
  service: Message
  /** The signed-in account, exactly as the order recorded it. */
  user: { uid: string; displayName: string }
  /** The operator chosen for this order — who the payment is taken by, too. */
  staff: { id: string; name: string }
}

/**
 * How the decision ended: paid here, or deliberately left unpaid with Pay later. There is no
 * third way out — backing out of a payment returns to the question rather than ending it.
 */
export type Settlement = { kind: 'paid'; method: PaymentMethod } | { kind: 'unpaid' }

/**
 * "Pay now or pay later?", asked once the order is already saved.
 *
 * The order exists whatever is chosen here, and nothing on this screen changes or removes it.
 * Pay now opens the very dialog an order's own page uses and writes through the very same
 * `recordPayment`, so there is still exactly one way money is recorded — with the same
 * one-payment-per-order guarantee from the rules.
 *
 * Only an explicit answer moves on. Cancelling the payment dialog, or pressing Escape in it,
 * comes back here with the order still saved and still unpaid, so a slip of the hand can
 * never be read as "pay later".
 */
export function PaymentDecision({
  order,
  onSettled,
}: {
  order: PlacedOrder
  onSettled: (settlement: Settlement) => void
}) {
  const { t } = useTranslation()
  const [paying, setPaying] = useState(false)
  /**
   * The order as the database has it, live. Consulted only when a payment did NOT complete
   * here: a write can reach the server even though its answer never came back, and a retry
   * of it is then refused as a second payment. Reading the recorded state — through the same
   * resolution every other screen uses — is what stops this screen calling a paid order
   * unpaid, or an unpaid one paid.
   */
  const { view } = useOrderDetail(order.id)
  /** One outcome per order, however many taps or close events arrive. */
  const settled = useRef(false)

  function settle(settlement: Settlement) {
    if (settled.current) return
    settled.current = true
    onSettled(settlement)
  }

  /**
   * The payment dialog closed without a payment completing here — Cancel, or Escape. Back to
   * the question, unless the database shows the payment landed after all, in which case the
   * order IS paid and asking again would invite taking the money twice.
   */
  function handleDismiss() {
    if (view?.payment.status === 'paid') {
      settle({ kind: 'paid', method: view.payment.method })
      return
    }
    setPaying(false)
  }

  async function handlePayment(method: PaymentMethod, cashTendered: number | null) {
    try {
      await recordPayment(order.id, {
        method,
        amount: order.total,
        cashTendered,
        user: order.user,
        staff: order.staff,
      })
    } catch (caught) {
      // As on an order's page: a rules refusal says only 'permission-denied', so say what it
      // can actually mean, and let recordPayment's own validation messages through.
      const denied = typeof caught === 'object' && caught !== null && 'code' in caught
      throw denied ? new MessageError(message('payment.recordFailed')) : caught
    }
    settle({ kind: 'paid', method })
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 py-6 sm:py-8" data-testid="payment-decision">
      <div className="space-y-1 text-center">
        <h1 className="font-heading text-xl font-semibold tracking-tight text-balance sm:text-2xl">
          {t('terminal.paymentDecision')}
        </h1>
        <p className="text-sm text-balance text-muted-foreground">
          {t('terminal.paymentDecisionBlurb', {
            number: order.number,
            total: formatMoney(order.total),
            service: t(order.service),
          })}
        </p>
      </div>

      {/* `whitespace-normal`: "Bayar sekarang" is wider than half a 320-360px phone, and without
          it the label ran out of its button. It wraps there and stays on one line elsewhere. */}
      <div className="grid grid-cols-2 gap-3">
        <Button
          type="button"
          size="lg"
          className="h-touch-lg text-lg font-semibold whitespace-normal"
          data-testid="pay-now"
          disabled={paying}
          onClick={() => setPaying(true)}
        >
          <Wallet aria-hidden="true" />
          {t('terminal.payNow')}
        </Button>
        <Button
          type="button"
          size="lg"
          variant="outline"
          className="h-touch-lg text-lg font-semibold whitespace-normal"
          data-testid="pay-later"
          disabled={paying}
          onClick={() => settle({ kind: 'unpaid' })}
        >
          <Clock aria-hidden="true" />
          {t('terminal.payLater')}
        </Button>
      </div>

      <RecordPaymentDialog
        open={paying}
        orderNumber={order.number}
        total={order.total}
        onConfirm={handlePayment}
        onDismiss={handleDismiss}
      />
    </div>
  )
}
