// @vitest-environment jsdom
/**
 * The void dialog, driven the way a person drives it.
 *
 * This is the interaction with the most hidden state in the app — two steps, a role that
 * decides whether the second one exists, and a password that must never survive a failure —
 * and until this suite existed, none of it was checked by anything but a human clicking.
 *
 * The component holds no Firestore: it takes an `onConfirm` and reports what it collected.
 * So these tests assert on exactly that boundary, which is also the boundary Phase 11's
 * security rests on — a staff member reaches `onConfirm` only WITH credentials attached.
 */
import { message, MessageError } from '@/features/i18n/messages'
import { LANGUAGE_STORAGE_KEY } from '@/features/i18n/languages'
import { act, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { VoidOrderDialog } from '@/features/pos/VoidOrderDialog'
import { VOID_REASON_OTHER, VOID_REASON_PRESETS } from '@/features/pos/voids'

import { renderComponent } from './render'

/** The value of an input, by test id. Stands in for jest-dom's `toHaveValue`. */
function valueOf(testId: string): string {
  return (screen.getByTestId(testId) as HTMLInputElement).value
}

const ORDER_NUMBER = 42
const AMOUNT = 3190

function setup(
  requiresAuthorization: boolean,
  onConfirm = vi.fn<(reason: string, credentials: unknown) => Promise<void>>(async () => {}),
) {
  const rendered = renderComponent(
    <VoidOrderDialog
      orderNumber={ORDER_NUMBER}
      amount={AMOUNT}
      requiresAuthorization={requiresAuthorization}
      onConfirm={onConfirm}
    />,
  )
  return { ...rendered, onConfirm }
}

/** Opens the dialog and picks one of the quick reasons. */
async function openAndSelectReason(
  user: ReturnType<typeof setup>['user'],
  presetId = 'wrong-item',
) {
  await user.click(screen.getByTestId('void-order'))
  await user.selectOptions(screen.getByTestId('void-reason'), presetId)
}

/**
 * Opens the dialog and types a reason of its own under "Other" — the free-text path the
 * dialog has always had, which every test written before the quick reasons existed drives.
 */
async function openAndGiveReason(
  user: ReturnType<typeof setup>['user'],
  reason = 'Wrong item rung up',
) {
  await openAndSelectReason(user, VOID_REASON_OTHER)
  await user.type(screen.getByTestId('void-reason-custom'), reason)
}

describe('VoidOrderDialog: an admin voids in one step', () => {
  it('collects the reason and confirms without asking for anything else', async () => {
    const { user, onConfirm } = setup(false)
    await openAndGiveReason(user)
    await user.click(screen.getByTestId('confirm-void'))

    // Null credentials is the signal that this is the admin's own session doing the write.
    expect(onConfirm).toHaveBeenCalledWith('Wrong item rung up', null)
    expect(screen.queryByTestId('manager-email')).toBeNull()
  })

  it('trims the reason before handing it over', async () => {
    const { user, onConfirm } = setup(false)
    await openAndGiveReason(user, '   Spilled   ')
    await user.click(screen.getByTestId('confirm-void'))

    expect(onConfirm).toHaveBeenCalledWith('Spilled', null)
  })

  it('closes once the void succeeds', async () => {
    const { user } = setup(false)
    await openAndGiveReason(user)
    await user.click(screen.getByTestId('confirm-void'))

    await waitFor(() => expect(screen.queryByTestId('confirm-void')).toBeNull())
  })
})

describe('VoidOrderDialog: staff must produce a manager', () => {
  it('asks for credentials instead of voiding, and only then calls onConfirm', async () => {
    const { user, onConfirm } = setup(true)
    await openAndGiveReason(user)

    await user.click(screen.getByTestId('continue-void'))
    // Nothing has been voided yet — the reason step alone is not an authorisation.
    expect(onConfirm).not.toHaveBeenCalled()

    await user.type(screen.getByTestId('manager-email'), 'ada@example.com')
    await user.type(screen.getByTestId('manager-password'), 'hunter2')
    await user.click(screen.getByTestId('confirm-void'))

    expect(onConfirm).toHaveBeenCalledWith('Wrong item rung up', {
      email: 'ada@example.com',
      password: 'hunter2',
    })
  })

  it('never offers a way past the authorisation step', async () => {
    // The staff-facing dialog must not expose a control that submits without credentials:
    // that would be the whole control implemented as an honour system.
    const { user, onConfirm } = setup(true)
    await openAndGiveReason(user)
    expect(screen.queryByTestId('confirm-void')).toBeNull()

    await user.click(screen.getByTestId('continue-void'))
    await user.click(screen.getByTestId('confirm-void'))

    // Clicked with both fields empty: refused here, nothing attempted.
    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.getByText("Enter the manager's email address.")).not.toBeNull()
  })

  it('refuses an empty password once the email is filled in', async () => {
    const { user, onConfirm } = setup(true)
    await openAndGiveReason(user)
    await user.click(screen.getByTestId('continue-void'))
    await user.type(screen.getByTestId('manager-email'), 'ada@example.com')
    await user.click(screen.getByTestId('confirm-void'))

    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.getByText("Enter the manager's password.")).not.toBeNull()
  })
})

describe('VoidOrderDialog: the reason is required before anything else', () => {
  it('refuses to advance with no reason chosen, for either role', async () => {
    const { user, onConfirm } = setup(true)
    await user.click(screen.getByTestId('void-order'))
    await user.click(screen.getByTestId('continue-void'))

    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.queryByTestId('manager-email')).toBeNull()
    expect(screen.getByText('Select a reason for voiding this sale.')).not.toBeNull()
  })

  it('refuses a reason of nothing but spaces', async () => {
    const { user, onConfirm } = setup(false)
    await openAndGiveReason(user, '    ')
    await user.click(screen.getByTestId('confirm-void'))

    expect(onConfirm).not.toHaveBeenCalled()
  })
})

describe('VoidOrderDialog: a refused authorisation', () => {
  // What withManagerAuthorization actually throws now: a message the dialog translates.
  const REFUSED = 'Those credentials are not allowed to authorise this. Ask an administrator.'

  async function refuseOnce() {
    const onConfirm = vi.fn<(reason: string, credentials: unknown) => Promise<void>>(async () => {
      throw new MessageError(message('void.notAManager'))
    })
    const { user } = setup(true, onConfirm)
    await openAndGiveReason(user)
    await user.click(screen.getByTestId('continue-void'))
    await user.type(screen.getByTestId('manager-email'), 'sam@example.com')
    await user.type(screen.getByTestId('manager-password'), 'wrong')
    await user.click(screen.getByTestId('confirm-void'))
    return { user, onConfirm }
  }

  it('stays open and shows why, rather than closing on a failure', async () => {
    await refuseOnce()
    expect(await screen.findByText(REFUSED)).not.toBeNull()
    expect(screen.getByTestId('confirm-void')).not.toBeNull()
  })

  it('clears the password but keeps the reason, so only the secret is retyped', async () => {
    await refuseOnce()
    await screen.findByText(REFUSED)

    expect(valueOf('manager-password')).toBe('')
    // The email stays too: it is not a secret, and a manager retyping it every attempt at a
    // busy counter is how people start writing passwords on the wall.
    expect(valueOf('manager-email')).toBe('sam@example.com')
  })

  it('lets a second attempt through with the corrected password', async () => {
    const { user, onConfirm } = await refuseOnce()
    await screen.findByText(REFUSED)
    onConfirm.mockImplementation(async () => {})

    await user.type(screen.getByTestId('manager-password'), 'correct-horse')
    await user.click(screen.getByTestId('confirm-void'))

    expect(onConfirm).toHaveBeenLastCalledWith('Wrong item rung up', {
      email: 'sam@example.com',
      password: 'correct-horse',
    })
  })
})

describe('VoidOrderDialog: nothing survives the dialog closing', () => {
  it('forgets the reason and the credentials when cancelled', async () => {
    const { user } = setup(true)
    await openAndGiveReason(user, 'Customer changed their mind')
    await user.click(screen.getByTestId('continue-void'))
    await user.type(screen.getByTestId('manager-email'), 'ada@example.com')
    await user.type(screen.getByTestId('manager-password'), 'hunter2')

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.click(screen.getByTestId('void-order'))

    // Reopened at step one with nothing chosen: a half-finished void on a shared till must
    // not be inherited by whoever picks the screen up next.
    expect((screen.getByTestId('void-reason') as HTMLSelectElement).value).toBe('')
    // And the sentence typed under "Other" is gone with the choice that revealed the field.
    expect(screen.queryByTestId('void-reason-custom')).toBeNull()
    expect(screen.queryByTestId('manager-password')).toBeNull()
  })
})

describe('VoidOrderDialog: the quick reasons', () => {
  it('offers every predefined reason, plus Other, with nothing chosen to begin with', async () => {
    const { user } = setup(false)
    await user.click(screen.getByTestId('void-order'))

    const select = screen.getByTestId('void-reason') as HTMLSelectElement
    expect(select.value).toBe('')
    expect([...select.options].map((option) => option.value)).toEqual([
      '',
      ...VOID_REASON_PRESETS.map((preset) => preset.id),
      VOID_REASON_OTHER,
    ])
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Select a reason',
      'Customer changed mind',
      'Wrong order',
      'Wrong item',
      'Duplicate order',
      'Payment issue',
      'Item unavailable',
      'Staff mistake',
      'Other',
    ])
  })

  it.each(VOID_REASON_PRESETS.map((preset) => preset.id))(
    'lets %s be chosen and voids on that reason alone',
    async (presetId) => {
      const { user, onConfirm } = setup(false)
      await openAndSelectReason(user, presetId)

      // No typing anywhere: the whole point is that the common case is one tap.
      expect(screen.queryByTestId('void-reason-custom')).toBeNull()
      await user.click(screen.getByTestId('confirm-void'))

      const [reason, credentials] = onConfirm.mock.calls[0] as [string, unknown]
      expect(reason.length).toBeGreaterThan(0)
      expect(credentials).toBeNull()
    },
  )

  it('hands over the label the operator read', async () => {
    const { user, onConfirm } = setup(false)
    await openAndSelectReason(user, 'customer-changed-mind')
    await user.click(screen.getByTestId('confirm-void'))

    expect(onConfirm).toHaveBeenCalledWith('Customer changed mind', null)
  })

  it('carries a chosen reason through the manager step unchanged', async () => {
    const { user, onConfirm } = setup(true)
    await openAndSelectReason(user, 'duplicate-order')
    await user.click(screen.getByTestId('continue-void'))
    await user.type(screen.getByTestId('manager-email'), 'ada@example.com')
    await user.type(screen.getByTestId('manager-password'), 'hunter2')
    await user.click(screen.getByTestId('confirm-void'))

    expect(onConfirm).toHaveBeenCalledWith('Duplicate order', {
      email: 'ada@example.com',
      password: 'hunter2',
    })
  })
})

describe('VoidOrderDialog: Other still wants words', () => {
  it('asks for a reason only once Other is chosen', async () => {
    const { user } = setup(false)
    await user.click(screen.getByTestId('void-order'))
    expect(screen.queryByTestId('void-reason-custom')).toBeNull()

    await user.selectOptions(screen.getByTestId('void-reason'), VOID_REASON_OTHER)
    expect(screen.getByTestId('void-reason-custom')).not.toBeNull()
    expect(screen.getByLabelText('Your reason')).not.toBeNull()
  })

  it('refuses to void on Other with nothing typed', async () => {
    const { user, onConfirm } = setup(false)
    await openAndSelectReason(user, VOID_REASON_OTHER)
    await user.click(screen.getByTestId('confirm-void'))

    expect(onConfirm).not.toHaveBeenCalled()
    expect(screen.getByText('Enter a reason for voiding this sale.')).not.toBeNull()
  })

  it('stores what was typed, trimmed, once there is something to store', async () => {
    const { user, onConfirm } = setup(false)
    await openAndGiveReason(user, '  Tray dropped on the way out  ')
    await user.click(screen.getByTestId('confirm-void'))

    expect(onConfirm).toHaveBeenCalledWith('Tray dropped on the way out', null)
  })

  it('writes the preset, not the abandoned sentence, if the choice changes back', async () => {
    const { user, onConfirm } = setup(false)
    await openAndGiveReason(user, 'Half a thought')
    await user.selectOptions(screen.getByTestId('void-reason'), 'staff-mistake')

    expect(screen.queryByTestId('void-reason-custom')).toBeNull()
    await user.click(screen.getByTestId('confirm-void'))
    expect(onConfirm).toHaveBeenCalledWith('Staff mistake', null)
  })
})

// ---- Admin PIN -------------------------------------------------------------------------------

function setupWithPin(
  onConfirm = vi.fn<(reason: string, authorization: unknown) => Promise<void>>(async () => {}),
  requiresAuthorization = true,
) {
  const rendered = renderComponent(
    <VoidOrderDialog
      orderNumber={ORDER_NUMBER}
      amount={AMOUNT}
      requiresAuthorization={requiresAuthorization}
      pinAvailable
      onConfirm={onConfirm}
    />,
  )
  return { ...rendered, onConfirm }
}

/** Opens the dialog, picks a reason and continues to the PIN step. */
async function reachPinStep(user: ReturnType<typeof setupWithPin>['user']) {
  await openAndSelectReason(user)
  await user.click(screen.getByTestId('continue-void'))
}

const pinInput = () => screen.getByTestId('admin-pin') as HTMLInputElement

afterEach(() => {
  window.localStorage.clear()
})

describe('VoidOrderDialog: authorising with an admin PIN', () => {
  it('asks for a PIN instead of a manager sign-in once a PIN is available', async () => {
    const { user } = setupWithPin()
    await reachPinStep(user)

    expect(screen.getByText(`Admin PIN for order #${ORDER_NUMBER}`)).not.toBeNull()
    expect(pinInput()).not.toBeNull()
    expect(screen.queryByTestId('manager-email')).toBeNull()
    expect(screen.queryByTestId('manager-password')).toBeNull()
  })

  it('masks the PIN, asks for the numeric keypad, and never lets the browser remember it', async () => {
    const { user } = setupWithPin()
    await reachPinStep(user)

    expect(pinInput().type).toBe('password')
    expect(pinInput().inputMode).toBe('numeric')
    expect(pinInput().maxLength).toBe(6)
    expect(pinInput().autocomplete).toBe('off')
  })

  it('takes digits only, and no more than six', async () => {
    const { user } = setupWithPin()
    await reachPinStep(user)
    await user.type(pinInput(), '12a3-4 5678')

    expect(pinInput().value).toBe('123456')
  })

  it('cannot be submitted until all six digits are in', async () => {
    const { user, onConfirm } = setupWithPin()
    await reachPinStep(user)
    const confirm = () => screen.getByTestId('confirm-void') as HTMLButtonElement

    expect(confirm().disabled).toBe(true)
    await user.type(pinInput(), '12345')
    expect(confirm().disabled).toBe(true)
    await user.click(confirm())
    expect(onConfirm).not.toHaveBeenCalled()

    await user.type(pinInput(), '6')
    expect(confirm().disabled).toBe(false)
  })

  it('explains an empty or short PIN if Enter is pressed early, and sends nothing', async () => {
    const { user, onConfirm } = setupWithPin()
    await reachPinStep(user)

    await user.type(pinInput(), '{Enter}')
    expect(screen.getByText('Enter the admin PIN.')).not.toBeNull()

    await user.type(pinInput(), '1234{Enter}')
    expect(screen.getByText('The PIN must be exactly 6 digits.')).not.toBeNull()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('hands over the reason and the PIN — nothing else — for the server to check', async () => {
    const { user, onConfirm } = setupWithPin()
    await reachPinStep(user)
    await user.type(pinInput(), '482915')
    await user.click(screen.getByTestId('confirm-void'))

    expect(onConfirm).toHaveBeenCalledOnce()
    expect(onConfirm).toHaveBeenCalledWith('Wrong item', { pin: '482915' })
    await waitFor(() => expect(screen.queryByTestId('admin-pin')).toBeNull())
  })

  it('submits with Enter as well as the button', async () => {
    const { user, onConfirm } = setupWithPin()
    await reachPinStep(user)
    await user.type(pinInput(), '482915{Enter}')

    expect(onConfirm).toHaveBeenCalledWith('Wrong item', { pin: '482915' })
  })

  it('shows a refusal, clears the PIN, and keeps the reason', async () => {
    const onConfirm = vi.fn<(reason: string, authorization: unknown) => Promise<void>>(async () => {
      throw new MessageError(message('void.pinIncorrect'))
    })
    const { user } = setupWithPin(onConfirm)
    await reachPinStep(user)
    await user.type(pinInput(), '000000')
    await user.click(screen.getByTestId('confirm-void'))

    expect(await screen.findByText('That PIN is not correct.')).not.toBeNull()
    expect(pinInput().value).toBe('')
    // A second try needs only the PIN again; the reason is still the one chosen.
    await user.type(pinInput(), '482915')
    await user.click(screen.getByTestId('confirm-void'))
    expect(onConfirm).toHaveBeenLastCalledWith('Wrong item', { pin: '482915' })
  })

  it('shows a lockout plainly', async () => {
    const onConfirm = vi.fn<(reason: string, authorization: unknown) => Promise<void>>(async () => {
      throw new MessageError(message('void.pinLocked', { minutes: 12 }))
    })
    const { user } = setupWithPin(onConfirm)
    await reachPinStep(user)
    await user.type(pinInput(), '000000')
    await user.click(screen.getByTestId('confirm-void'))

    expect(
      await screen.findByText(/Too many incorrect PINs\. Try again in 12 minutes/),
    ).not.toBeNull()
  })

  it('sends a void once however often it is confirmed, and cannot be closed mid-write', async () => {
    let finish!: () => void
    const onConfirm = vi.fn<(reason: string, authorization: unknown) => Promise<void>>(
      () => new Promise<void>((resolve) => (finish = resolve)),
    )
    const { user } = setupWithPin(onConfirm)
    await reachPinStep(user)
    await user.type(pinInput(), '482915')
    await user.click(screen.getByTestId('confirm-void'))

    const confirm = screen.getByTestId('confirm-void') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    expect(confirm.textContent).toBe('Voiding…')
    await user.click(confirm)
    await user.keyboard('{Escape}')
    expect(onConfirm).toHaveBeenCalledOnce()
    expect(screen.queryByTestId('admin-pin')).not.toBeNull()

    await act(async () => finish())
    await waitFor(() => expect(screen.queryByTestId('admin-pin')).toBeNull())
  })

  it('forgets the PIN when the dialog is cancelled', async () => {
    const { user } = setupWithPin()
    await reachPinStep(user)
    await user.type(pinInput(), '482915')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await reachPinStep(user)

    expect(pinInput().value).toBe('')
  })

  it('still asks an admin for nothing — their own void needs no PIN', async () => {
    const { user, onConfirm } = setupWithPin(undefined, false)
    await openAndSelectReason(user)
    await user.click(screen.getByTestId('confirm-void'))

    expect(screen.queryByTestId('admin-pin')).toBeNull()
    expect(onConfirm).toHaveBeenCalledWith('Wrong item', null)
  })
})

describe('VoidOrderDialog: falls back to a manager sign-in until a PIN exists', () => {
  it('asks for email and password when no administrator has set a PIN', async () => {
    const { user, onConfirm } = setup(true)
    await openAndSelectReason(user)
    await user.click(screen.getByTestId('continue-void'))

    expect(screen.queryByTestId('admin-pin')).toBeNull()
    await user.type(screen.getByTestId('manager-email'), 'boss@example.test')
    await user.type(screen.getByTestId('manager-password'), 'secret')
    await user.click(screen.getByTestId('confirm-void'))
    expect(onConfirm).toHaveBeenCalledWith('Wrong item', {
      email: 'boss@example.test',
      password: 'secret',
    })
  })
})

describe('VoidOrderDialog: the PIN step in every language', () => {
  const CASES = [
    [
      'ms',
      `PIN pentadbir untuk pesanan #${ORDER_NUMBER}`,
      'PIN pentadbir',
      'Masukkan PIN pentadbir.',
      '2 / 6 digit dimasukkan',
    ],
    [
      'zh',
      `订单 #${ORDER_NUMBER} 的管理员 PIN`,
      '管理员 PIN',
      '请输入管理员 PIN。',
      '已输入 2 / 6 位',
    ],
  ] as const

  for (const [language, title, label, error, progress] of CASES) {
    it(`reads in ${language}`, async () => {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language)
      const { user, onConfirm } = setupWithPin()
      await user.click(screen.getByTestId('void-order'))
      // Picked by value, which is the same in every language; the label is translated.
      await user.selectOptions(screen.getByTestId('void-reason'), 'wrong-item')
      await user.click(screen.getByTestId('continue-void'))

      expect(screen.getByText(title)).not.toBeNull()
      expect(screen.getByLabelText(label)).not.toBeNull()
      await user.type(pinInput(), '{Enter}')
      expect(screen.getByText(error)).not.toBeNull()
      await user.type(pinInput(), '12')
      expect(screen.getByTestId('admin-pin-progress').textContent).toBe(progress)
      expect(onConfirm).not.toHaveBeenCalled()
    })
  }
})

// ---- The six-box PIN field --------------------------------------------------------------------

describe('VoidOrderDialog: the six PIN boxes', () => {
  const slots = () => screen.getAllByTestId('admin-pin-slot')
  const filled = () => slots().filter((slot) => slot.dataset.filled === 'true').length
  const activeIndex = () => slots().findIndex((slot) => slot.dataset.active === 'true')
  const progress = () => screen.getByTestId('admin-pin-progress').textContent

  it('draws six empty boxes, one input, and says none are entered yet', async () => {
    const { user } = setupWithPin()
    await reachPinStep(user)

    expect(slots()).toHaveLength(6)
    expect(filled()).toBe(0)
    expect(progress()).toBe('0 / 6 digits entered')
    // One logical control, not six: a single labelled input that also announces progress.
    expect(screen.getAllByLabelText('Admin PIN')).toHaveLength(1)
    expect(pinInput().getAttribute('aria-describedby')).toContain('admin-pin-progress')
    expect(screen.getByTestId('admin-pin-progress').getAttribute('aria-live')).toBe('polite')
    // The boxes are pictures of the input, hidden from assistive technology.
    expect(slots()[0]!.parentElement?.getAttribute('aria-hidden')).toBe('true')
  })

  it('fills the next box with each digit, showing a dot and never the digit', async () => {
    const { user } = setupWithPin()
    await reachPinStep(user)
    await user.type(pinInput(), '482')

    expect(filled()).toBe(3)
    expect(activeIndex()).toBe(3)
    expect(progress()).toBe('3 / 6 digits entered')
    const boxes = slots()[0]!.parentElement!
    expect(boxes.textContent).toBe('')
    expect(boxes.querySelectorAll('span.rounded-full')).toHaveLength(3)
  })

  it('backspace clears the last digit and moves back a box', async () => {
    const { user } = setupWithPin()
    await reachPinStep(user)
    await user.type(pinInput(), '4829')
    await user.keyboard('{Backspace}')

    expect(pinInput().value).toBe('482')
    expect(filled()).toBe(3)
    expect(activeIndex()).toBe(3)
    expect(progress()).toBe('3 / 6 digits entered')

    await user.keyboard('{Backspace}{Backspace}{Backspace}{Backspace}')
    expect(pinInput().value).toBe('')
    expect(activeIndex()).toBe(0)
  })

  it('takes a pasted PIN in one go, keeping only its digits', async () => {
    const { user, onConfirm } = setupWithPin()
    await reachPinStep(user)
    await user.click(slots()[0]!)
    await user.paste('482 915')

    expect(pinInput().value).toBe('482915')
    expect(filled()).toBe(6)
    expect(progress()).toBe('6 / 6 digits entered')
    // Filling the last box does not submit — the button still decides.
    expect(onConfirm).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('confirm-void'))
    expect(onConfirm).toHaveBeenCalledWith('Wrong item', { pin: '482915' })
  })

  it('takes no more than six digits from a longer paste', async () => {
    const { user } = setupWithPin()
    await reachPinStep(user)
    await user.click(slots()[0]!)
    await user.paste('12345678')

    expect(pinInput().value).toBe('123456')
  })

  it('ignores a paste with no digits in it', async () => {
    const { user } = setupWithPin()
    await reachPinStep(user)
    await user.type(pinInput(), '12')
    await user.paste('abc')

    expect(pinInput().value).toBe('12')
  })

  it('lets a box be clicked to change just that digit', async () => {
    const { user, onConfirm } = setupWithPin()
    await reachPinStep(user)
    await user.type(pinInput(), '482915')

    await user.click(slots()[2]!)
    expect(activeIndex()).toBe(2)
    await user.keyboard('7')

    expect(pinInput().value).toBe('487915')
    await user.click(screen.getByTestId('confirm-void'))
    expect(onConfirm).toHaveBeenCalledWith('Wrong item', { pin: '487915' })
  })

  it('sends a click on an empty box to the next box to fill — a PIN has no gaps', async () => {
    const { user } = setupWithPin()
    await reachPinStep(user)
    await user.type(pinInput(), '48')
    await user.click(slots()[5]!)

    expect(activeIndex()).toBe(2)
    await user.keyboard('2')
    expect(pinInput().value).toBe('482')
  })

  it('ignores a letter typed over a digit, rather than deleting it', async () => {
    const { user } = setupWithPin()
    await reachPinStep(user)
    await user.type(pinInput(), '482915')
    await user.click(slots()[1]!)
    await user.keyboard('x')

    expect(pinInput().value).toBe('482915')
  })

  it('empties every box after a refused PIN, and marks them as in error', async () => {
    const onConfirm = vi.fn<(reason: string, authorization: unknown) => Promise<void>>(async () => {
      throw new MessageError(message('void.pinIncorrect'))
    })
    const { user } = setupWithPin(onConfirm)
    await reachPinStep(user)
    await user.type(pinInput(), '000000')
    await user.click(screen.getByTestId('confirm-void'))

    expect(await screen.findByText('That PIN is not correct.')).not.toBeNull()
    expect(filled()).toBe(0)
    expect(progress()).toBe('0 / 6 digits entered')
    expect(pinInput().getAttribute('aria-invalid')).toBe('true')
    expect((screen.getByTestId('confirm-void') as HTMLButtonElement).disabled).toBe(true)
  })
})
