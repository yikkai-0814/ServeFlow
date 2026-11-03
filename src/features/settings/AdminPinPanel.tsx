import { isMessageError, message, type Message } from '@/features/i18n/messages'
import { useTranslation } from '@/features/i18n/useTranslation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { EmailAuthProvider, reauthenticateWithCredential } from 'firebase/auth'
import { AlertCircle, Check, KeyRound } from 'lucide-react'

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
import { Panel } from '@/components/data/Panel'
import { fetchAdminPinStatus, setAdminPin, type AdminPinStatus } from '@/features/pos/void-pin-api'
import { PinInput } from '@/features/pos/PinInput'
import { ADMIN_PIN_LENGTH, validateAdminPin } from '@/features/pos/voids'
import { authErrorMessage } from '@/lib/auth-errors'
import { auth } from '@/lib/firebase'

/**
 * Proves the signed-in admin is at the keyboard, then hands the server a token that says so.
 *
 * Re-authentication checks the password with Firebase Auth and changes nothing about it. The
 * token is then refreshed so the call that follows carries the new `auth_time` — setAdminPin
 * refuses a sign-in older than a few minutes, so an admin session left open on a shared
 * device is not enough to change the PIN.
 */
async function confirmPassword(password: string): Promise<void> {
  const user = auth.currentUser
  if (!user?.email) throw new Error('No signed-in user')
  try {
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password))
  } catch (caught) {
    throw new PasswordError(authErrorMessage(caught))
  }
  await user.getIdToken(true)
}

/** A refused password, kept apart from a refused PIN so each gets its own sentence. */
class PasswordError extends Error {
  readonly detail: Message

  constructor(detail: Message) {
    super(detail.key)
    this.detail = detail
  }
}

/**
 * An administrator's own PIN for authorising voids at the till.
 *
 * Rendered for admins only (see SettingsPage). It shows whether a PIN is set and lets the
 * admin set or change it; it never shows, and the server never returns, the PIN or its hash.
 * Staff have no way here, or anywhere, to set or read one — the server refuses them.
 */
export function AdminPinPanel() {
  const { t } = useTranslation()
  const [status, setStatus] = useState<AdminPinStatus | null>(null)
  const [statusFailed, setStatusFailed] = useState(false)
  const [saved, setSaved] = useState(false)

  /** Asks the server; `isCurrent` lets an unmounted panel ignore a late answer. */
  const loadStatus = useCallback((isCurrent: () => boolean = () => true) => {
    fetchAdminPinStatus()
      .then((next) => {
        if (!isCurrent()) return
        setStatus(next)
        setStatusFailed(false)
      })
      .catch(() => {
        if (isCurrent()) setStatusFailed(true)
      })
  }, [])

  useEffect(() => {
    let current = true
    loadStatus(() => current)
    return () => {
      current = false
    }
  }, [loadStatus])

  const configured = status?.self?.configured ?? false
  const updatedAt = status?.self?.updatedAt ? new Date(status.self.updatedAt) : null

  return (
    <Panel
      tone="raised"
      title={t('settings.pinTitle')}
      description={t('settings.pinBlurb')}
      data-testid="settings-admin-pin"
    >
      {statusFailed ? (
        <Alert variant="destructive">
          <AlertCircle aria-hidden="true" />
          <AlertDescription>{t('settings.pinStatusFailed')}</AlertDescription>
        </Alert>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="admin-pin-status">
          {status === null
            ? t('common.loading')
            : configured
              ? updatedAt
                ? t('settings.pinStatusSetOn', { when: updatedAt.toLocaleString() })
                : t('settings.pinStatusSet')
              : t('settings.pinStatusNotSet')}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <SetPinDialog
          configured={configured}
          disabled={status === null && !statusFailed}
          onSaved={() => {
            setSaved(true)
            loadStatus()
          }}
          onOpen={() => setSaved(false)}
        />
        {saved && (
          <span
            className="inline-flex items-center gap-1.5 text-sm font-medium text-success"
            role="status"
            data-testid="admin-pin-saved"
          >
            <Check className="size-4" aria-hidden="true" />
            {t('settings.pinSaved')}
          </span>
        )}
      </div>
    </Panel>
  )
}

function SetPinDialog({
  configured,
  disabled,
  onSaved,
  onOpen,
}: {
  configured: boolean
  disabled: boolean
  onSaved: () => void
  onOpen: () => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [pin, setPin] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<Message | null>(null)
  const [pending, setPending] = useState(false)
  const submitting = useRef(false)

  function reset(nextOpen: boolean) {
    if (!nextOpen && submitting.current) return
    setOpen(nextOpen)
    if (nextOpen) onOpen()
    // Every secret is cleared on close, whether or not it was saved.
    if (!nextOpen) {
      setPassword('')
      setPin('')
      setConfirm('')
      setError(null)
    }
  }

  async function handleSave() {
    if (submitting.current) return
    if (password === '') {
      setError(message('settings.pinPasswordRequired'))
      return
    }
    const validated = validateAdminPin(pin)
    if (!validated.ok) {
      setError(validated.error)
      return
    }
    if (confirm !== pin) {
      setError(message('settings.pinMismatch'))
      return
    }

    submitting.current = true
    setError(null)
    setPending(true)
    try {
      await confirmPassword(password)
      await setAdminPin(validated.pin)
      submitting.current = false
      reset(false)
      onSaved()
    } catch (caught) {
      setError(
        caught instanceof PasswordError
          ? caught.detail
          : isMessageError(caught)
            ? caught.detail
            : message('settings.pinSaveFailed'),
      )
      setPassword('')
      setPin('')
      setConfirm('')
    } finally {
      submitting.current = false
      setPending(false)
    }
  }

  /** Both PINs complete — until then there is nothing worth sending. */
  const complete = pin.length === ADMIN_PIN_LENGTH && confirm.length === ADMIN_PIN_LENGTH

  const pinField = (
    id: string,
    label: string,
    value: string,
    onChange: (next: string) => void,
    invalid = false,
  ) => (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <PinInput
        id={id}
        data-testid={id}
        describedBy="admin-pin-setup-hint"
        value={value}
        onChange={onChange}
        onEnter={() => void handleSave()}
        invalid={invalid}
        disabled={pending}
      />
    </div>
  )

  return (
    <AlertDialog open={open} onOpenChange={reset}>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          size="lg"
          className="h-touch text-base"
          disabled={disabled}
          data-testid="admin-pin-open"
        >
          <KeyRound aria-hidden="true" />
          {t(configured ? 'settings.pinChange' : 'settings.pinSet')}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t(configured ? 'settings.pinChangeTitle' : 'settings.pinSetTitle')}
          </AlertDialogTitle>
          <AlertDialogDescription>{t('settings.pinDialogBlurb')}</AlertDialogDescription>
        </AlertDialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="admin-pin-password">{t('settings.pinCurrentPassword')}</Label>
            <Input
              id="admin-pin-password"
              type="password"
              autoComplete="current-password"
              className="h-touch text-base"
              data-testid="admin-pin-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={pending}
              autoFocus
            />
          </div>
          {pinField('admin-pin-new', t('settings.pinNew'), pin, setPin)}
          {pinField(
            'admin-pin-confirm',
            t('settings.pinConfirm'),
            confirm,
            setConfirm,
            error?.key === 'settings.pinMismatch',
          )}
          <p id="admin-pin-setup-hint" className="text-xs text-muted-foreground">
            {t('void.pinHint', { length: ADMIN_PIN_LENGTH })}
          </p>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertCircle aria-hidden="true" />
            <AlertDescription>{t(error)}</AlertDescription>
          </Alert>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t('common.cancel')}</AlertDialogCancel>
          <Button
            disabled={pending || !complete}
            data-testid="admin-pin-save"
            onClick={() => void handleSave()}
          >
            {t(pending ? 'common.saving' : 'settings.pinSave')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
