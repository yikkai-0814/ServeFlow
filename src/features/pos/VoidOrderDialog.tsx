import { isMessageError, message, type Message } from '@/features/i18n/messages'
import { useTranslation } from '@/features/i18n/useTranslation'
import { useRef, useState } from 'react'
import { AlertCircle, Ban, ShieldCheck } from 'lucide-react'

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { PinInput } from '@/features/pos/PinInput'
import {
  ADMIN_PIN_LENGTH,
  findVoidReasonPreset,
  resolveVoidReason,
  validateAdminPin,
  validateManagerCredentials,
  VOID_REASON_MAX,
  VOID_REASON_OTHER,
  VOID_REASON_PRESETS,
  type VoidAuthorization,
} from '@/features/pos/voids'
import { formatMoney } from '@/lib/money'

export interface ManagerCredentials {
  email: string
  password: string
}

/**
 * Voiding is irreversible and reverses money, so it asks for a reason and says plainly that
 * it cannot be undone.
 *
 * The reason is picked from the handful that actually come up at a counter, with "Other" for
 * everything else — the same free-text field as before, now shown only when it is needed.
 * Whichever route is taken, a reason is still required and still trimmed and length-checked
 * before it is written, and what reaches `onConfirm` is the same single string it always was.
 *
 * Two shapes, one dialog. An admin voids their own sale in a single step, exactly as before.
 * Anyone else gets a second step asking an administrator to authorise it — `requiresAuthorization`
 * is the only difference, and it is decided by the caller from the signed-in role.
 *
 * That second step asks for an administrator's six-digit PIN once one has been set
 * (`pinAvailable`), and otherwise for a manager's email and password, as before — the fallback
 * until PIN setup exists. Either way the secret is held in component state only for the
 * moment it takes to use it, passed to `onConfirm`, and cleared whenever the dialog closes or
 * a submission fails. Nothing here decides whether it is valid: a PIN is checked by the server
 * (functions/), a password by Firebase Auth and then firestore.rules.
 *
 * Uses a plain confirm button rather than `AlertDialogAction`, because the dialog must stay
 * open when validation fails — `AlertDialogAction` closes on click, which would swallow the
 * error message before anyone read it.
 */
export function VoidOrderDialog({
  orderNumber,
  amount,
  requiresAuthorization,
  pinAvailable = false,
  onConfirm,
  onOpen,
}: {
  orderNumber: number
  amount: number
  requiresAuthorization: boolean
  /** An administrator has set a PIN, so the second step asks for one instead of a sign-in. */
  pinAvailable?: boolean
  onConfirm: (reason: string, authorization: VoidAuthorization | null) => Promise<void>
  /**
   * Told when the dialog opens, and nothing else: it changes nothing here and receives nothing.
   * The order page uses it to get the void function ready (void-warmup.ts).
   */
  onOpen?: () => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<'reason' | 'authorize'>('reason')
  const [presetId, setPresetId] = useState('')
  const [customReason, setCustomReason] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [pin, setPin] = useState('')
  const [error, setError] = useState<Message | null>(null)
  const [pending, setPending] = useState(false)
  /**
   * Set synchronously, unlike `pending`, so a second tap or Enter that lands before the button
   * re-renders as disabled cannot send the void — and spend a PIN attempt — twice.
   */
  const submitting = useRef(false)

  function reset(nextOpen: boolean) {
    setOpen(nextOpen)
    if (!nextOpen) {
      setStep('reason')
      setPresetId('')
      setCustomReason('')
      setEmail('')
      setPassword('')
      setPin('')
      setError(null)
    }
  }

  /** Not while a void is being written: it may still land, and closing would hide that. */
  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen && submitting.current) return
    reset(nextOpen)
    if (nextOpen && !open) {
      // A notice only: whatever it does or throws, the dialog has already opened as before.
      try {
        onOpen?.()
      } catch {
        // Nothing the listener does can reach the dialog.
      }
    }
  }

  const preset = findVoidReasonPreset(presetId)
  /** Empty for "Other" and for no choice at all, which `resolveVoidReason` reads as such. */
  const presetLabel = preset ? t(preset.labelKey) : ''

  /** Step one. For an admin this is the whole thing; for staff it opens the second step. */
  async function handleReasonStep() {
    const validated = resolveVoidReason(presetId, presetLabel, customReason)
    if (!validated.ok) {
      setError(validated.error)
      return
    }

    setError(null)

    if (requiresAuthorization) {
      setStep('authorize')
      return
    }

    await submit(validated.reason, null)
  }

  async function handleAuthorizeStep() {
    const validatedReason = resolveVoidReason(presetId, presetLabel, customReason)
    if (!validatedReason.ok) {
      // Cannot normally happen — step one checked it — but the reason is what gets written,
      // so it is re-validated rather than trusted because it passed a moment ago.
      setStep('reason')
      setError(validatedReason.error)
      return
    }

    if (pinAvailable) {
      const validatedPin = validateAdminPin(pin)
      if (!validatedPin.ok) {
        setError(validatedPin.error)
        return
      }
      await submit(validatedReason.reason, { pin: validatedPin.pin })
      return
    }

    const credentials = validateManagerCredentials(email, password)
    if (!credentials.ok) {
      setError(credentials.error)
      return
    }

    await submit(validatedReason.reason, {
      email: credentials.email,
      password: credentials.password,
    })
  }

  async function submit(validReason: string, authorization: VoidAuthorization | null) {
    if (submitting.current) return
    submitting.current = true
    setError(null)
    setPending(true)
    try {
      await onConfirm(validReason, authorization)
      reset(false)
    } catch (caught) {
      setError(isMessageError(caught) ? caught.detail : message('order.voidFailed'))
      // Keep the reason so nothing has to be retyped, but never keep the password or PIN.
      setPassword('')
      setPin('')
    } finally {
      submitting.current = false
      setPending(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogTrigger asChild>
        <Button
          variant="destructive"
          size="lg"
          className="h-touch text-base"
          data-testid="void-order"
        >
          <Ban aria-hidden="true" />
          {t('void.action')}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t(
              step === 'reason'
                ? 'void.confirmTitle'
                : pinAvailable
                  ? 'void.pinTitle'
                  : 'void.managerTitle',
              { number: orderNumber },
            )}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {step === 'reason'
              ? t('void.blurb', { amount: formatMoney(amount) })
              : t(pinAvailable ? 'void.pinBlurb' : 'void.managerBlurb')}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {step === 'reason' ? (
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="void-reason">{t('void.reason')}</Label>
              <NativeSelect
                id="void-reason"
                data-testid="void-reason"
                value={presetId}
                onChange={(event) => setPresetId(event.target.value)}
                disabled={pending}
                autoFocus
              >
                {/* No reason is preselected: a void must be a decision somebody made, not
                    whatever happened to be at the top of the list. */}
                <option value="">{t('void.reasonSelect')}</option>
                {VOID_REASON_PRESETS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {t(option.labelKey)}
                  </option>
                ))}
                <option value={VOID_REASON_OTHER}>{t('void.reasonOther')}</option>
              </NativeSelect>
            </div>

            {presetId === VOID_REASON_OTHER && (
              <div className="grid gap-2">
                <Label htmlFor="void-reason-custom">{t('void.reasonCustom')}</Label>
                <Input
                  id="void-reason-custom"
                  data-testid="void-reason-custom"
                  className="h-touch text-base"
                  placeholder={t('void.reasonPlaceholder')}
                  maxLength={VOID_REASON_MAX}
                  value={customReason}
                  onChange={(event) => setCustomReason(event.target.value)}
                  disabled={pending}
                  autoFocus
                />
              </div>
            )}
          </div>
        ) : pinAvailable ? (
          <div className="grid gap-2">
            <Label htmlFor="admin-pin">{t('void.pinLabel')}</Label>
            {/* Masked, digits only, numeric keypad on a tablet. Never autofilled or remembered
                by the browser: it is somebody else's secret, typed on a shared till. */}
            <PinInput
              id="admin-pin"
              data-testid="admin-pin"
              describedBy="admin-pin-hint"
              value={pin}
              onChange={setPin}
              onEnter={() => void handleAuthorizeStep()}
              invalid={error !== null}
              disabled={pending}
              autoFocus
            />
            <p id="admin-pin-hint" className="text-xs text-muted-foreground">
              {t('void.pinHint', { length: ADMIN_PIN_LENGTH })}
            </p>
          </div>
        ) : (
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="manager-email">{t('void.managerEmail')}</Label>
              <Input
                id="manager-email"
                type="email"
                autoComplete="off"
                className="h-touch text-base"
                data-testid="manager-email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={pending}
                autoFocus
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="manager-password">{t('void.managerPassword')}</Label>
              <Input
                id="manager-password"
                type="password"
                autoComplete="off"
                className="h-touch text-base"
                data-testid="manager-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={pending}
              />
            </div>
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertCircle aria-hidden="true" />
            <AlertDescription>{t(error)}</AlertDescription>
          </Alert>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t('common.cancel')}</AlertDialogCancel>
          {step === 'reason' ? (
            <Button
              variant="destructive"
              disabled={pending}
              data-testid={requiresAuthorization ? 'continue-void' : 'confirm-void'}
              onClick={() => void handleReasonStep()}
            >
              {requiresAuthorization ? (
                <>
                  <ShieldCheck aria-hidden="true" />
                  {t('common.continue')}
                </>
              ) : pending ? (
                t('void.submitting')
              ) : (
                t('void.action')
              )}
            </Button>
          ) : (
            <Button
              variant="destructive"
              // With a PIN, nothing to send until all six digits are in.
              disabled={pending || (pinAvailable && pin.length < ADMIN_PIN_LENGTH)}
              data-testid="confirm-void"
              onClick={() => void handleAuthorizeStep()}
            >
              {t(pending ? 'void.submitting' : 'void.authoriseAndVoid')}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
