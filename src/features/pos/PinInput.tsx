import { useTranslation } from '@/features/i18n/useTranslation'
import { useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'

import { ADMIN_PIN_LENGTH, sanitizePinInput } from '@/features/pos/voids'
import { cn } from '@/lib/utils'

const SLOTS = Array.from({ length: ADMIN_PIN_LENGTH }, (_, index) => index)

/**
 * A six-digit PIN, shown as six boxes.
 *
 * **One input, six pictures of it.** The boxes are drawn from a single real `<input>` — its
 * value and where its caret is — rather than being six inputs of their own. That one input is
 * what a screen reader announces (labelled, described, "secure text"), what the keyboard moves
 * through (arrows, Home, End, Backspace all behave natively), and what a password manager or
 * paste sees. Six separate fields would mean six tab stops and six announcements for one
 * secret, and focus juggling to fake what the browser already does.
 *
 * The input is transparent and lies over the boxes, which take the clicks: pressing a box puts
 * the caret there (selecting a filled digit, so the next key replaces it).
 *
 * Masked throughout. A filled box shows a dot, never the digit; the input is a password field,
 * so the value is not on screen in any form. Nothing here logs or reports the value.
 *
 * Digits only: a keystroke that is not one is ignored outright, rather than stripped after the
 * fact — so typing a letter over a selected digit cannot silently delete it. A paste keeps the
 * digits it contains and fills from the start, so "482 915" pastes as 482915.
 *
 * This never submits. The sixth digit just fills the last box; the caller's button (or Enter,
 * via `onEnter`) decides when to send it.
 */
export function PinInput({
  id,
  value,
  onChange,
  onEnter,
  disabled = false,
  invalid = false,
  autoFocus = false,
  describedBy,
  'data-testid': testId,
}: {
  id: string
  value: string
  onChange: (next: string) => void
  onEnter?: () => void
  disabled?: boolean
  invalid?: boolean
  autoFocus?: boolean
  /** The caller's hint, announced along with the progress. */
  describedBy?: string
  'data-testid'?: string
}) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  const [focused, setFocused] = useState(false)
  const [caret, setCaret] = useState(0)
  const progressId = `${id}-progress`

  function syncCaret() {
    const input = inputRef.current
    if (input) setCaret(input.selectionStart ?? input.value.length)
  }

  function handleChange(raw: string) {
    if (!/^\d*$/.test(raw)) return
    onChange(raw.slice(0, ADMIN_PIN_LENGTH))
    syncCaret()
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    event.preventDefault()
    const digits = sanitizePinInput(event.clipboardData.getData('text'))
    if (digits === '') return
    onChange(digits)
    setCaret(digits.length)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault()
      onEnter?.()
    }
  }

  /**
   * Puts the caret at a box. A filled box is selected, so typing replaces that digit; an empty
   * one past the end goes to the next box to fill — a PIN has no gaps.
   */
  function focusSlot(index: number) {
    const input = inputRef.current
    if (!input || disabled) return
    input.focus()
    const position = Math.min(index, value.length)
    input.setSelectionRange(position, position < value.length ? position + 1 : position)
    setCaret(position)
  }

  /** The box the next digit goes into: the caret's, or the last box once all six are in. */
  const activeSlot = focused ? Math.min(caret, ADMIN_PIN_LENGTH - 1) : -1

  return (
    <div className="grid w-full gap-1.5">
      <div className="relative w-full max-w-xs">
        <input
          ref={inputRef}
          id={id}
          type="password"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          maxLength={ADMIN_PIN_LENGTH}
          value={value}
          onChange={(event) => handleChange(event.target.value)}
          onPaste={handlePaste}
          onKeyDown={handleKeyDown}
          onSelect={syncCaret}
          onFocus={() => {
            setFocused(true)
            syncCaret()
          }}
          onBlur={() => setFocused(false)}
          disabled={disabled}
          autoFocus={autoFocus}
          aria-invalid={invalid || undefined}
          aria-describedby={[describedBy, progressId].filter(Boolean).join(' ')}
          data-testid={testId}
          // Present, focusable and labelled — just not painted. The boxes below are its picture.
          className="pointer-events-none absolute inset-0 h-full w-full opacity-0"
        />
        <div className="grid grid-cols-6 gap-1.5 sm:gap-2" aria-hidden="true">
          {SLOTS.map((index) => {
            const filled = index < value.length
            const active = index === activeSlot
            return (
              <div
                key={index}
                data-testid={testId ? `${testId}-slot` : undefined}
                data-filled={filled}
                data-active={active}
                // Keep focus on the input rather than letting the press blur it, then move
                // the caret on click — which, unlike mousedown, also opens a touch keyboard.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => focusSlot(index)}
                className={cn(
                  'flex h-12 min-w-0 items-center justify-center rounded-lg border transition-[border-color,box-shadow,background-color] duration-100 sm:h-14',
                  filled
                    ? 'border-primary/50 bg-primary/[0.06] dark:bg-primary/10'
                    : 'border-input bg-transparent dark:bg-input/30',
                  active && 'border-ring ring-3 ring-ring/50',
                  invalid && 'border-destructive',
                  invalid && active && 'ring-destructive/20',
                  disabled ? 'cursor-not-allowed opacity-50' : 'cursor-text',
                )}
              >
                {filled ? (
                  <span className="size-2.5 rounded-full bg-foreground" />
                ) : active ? (
                  // A caret, so it is obvious where the next digit lands.
                  <span className="h-6 w-px animate-pulse bg-foreground motion-reduce:animate-none" />
                ) : null}
              </div>
            )
          })}
        </div>
      </div>
      <p
        id={progressId}
        aria-live="polite"
        className="text-xs text-muted-foreground tabular-nums"
        data-testid={testId ? `${testId}-progress` : undefined}
      >
        {t('void.pinProgress', { count: value.length, length: ADMIN_PIN_LENGTH })}
      </p>
    </div>
  )
}
