// @vitest-environment jsdom
/**
 * An administrator setting their own void PIN, from Settings.
 *
 * What is pinned here is the order of operations the server relies on — password confirmed,
 * token refreshed, THEN the PIN sent — and that no secret outlives a failure. Whether the PIN
 * is acceptable (format aside) is the server's call, tested in tests/functions; here the
 * server is a stub that answers yes or no.
 */
import { FirebaseError } from 'firebase/app'
import { message, MessageError } from '@/features/i18n/messages'
import { LANGUAGE_STORAGE_KEY } from '@/features/i18n/languages'
import { screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ThemeProvider } from '@/features/theme/ThemeProvider'

import { renderComponent } from './render'

const calls: string[] = []

const fetchAdminPinStatus = vi.hoisted(() => vi.fn())
const setAdminPin = vi.hoisted(() => vi.fn())
const reauthenticateWithCredential = vi.hoisted(() => vi.fn())
const getIdToken = vi.hoisted(() => vi.fn())

vi.mock('@/features/pos/void-pin-api', () => ({ fetchAdminPinStatus, setAdminPin }))
vi.mock('firebase/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('firebase/auth')>()),
  reauthenticateWithCredential,
  EmailAuthProvider: {
    credential: (email: string, password: string) => ({ email, password }),
  },
}))
vi.mock('@/lib/firebase', () => ({
  auth: { currentUser: { email: 'ada@example.test', getIdToken } },
}))

let role: 'admin' | 'staff' = 'admin'
vi.mock('@/features/auth/useAuth', () => ({
  useAuth: () => ({
    role,
    profile: {
      uid: 'admin-uid',
      displayName: 'Ada Admin',
      email: 'ada@example.test',
      role,
      active: true,
      createdAt: null,
    },
    signOut: async () => {},
  }),
}))

import { AdminPinPanel } from '@/features/settings/AdminPinPanel'
import { SettingsPage } from '@/features/settings/SettingsPage'

beforeEach(() => {
  role = 'admin'
  calls.length = 0
  fetchAdminPinStatus.mockReset()
  fetchAdminPinStatus.mockResolvedValue({
    pinAvailable: false,
    self: { configured: false, updatedAt: null },
  })
  setAdminPin.mockReset()
  setAdminPin.mockImplementation(async () => void calls.push('setAdminPin'))
  reauthenticateWithCredential.mockReset()
  reauthenticateWithCredential.mockImplementation(async () => void calls.push('reauthenticate'))
  getIdToken.mockReset()
  getIdToken.mockImplementation(async (force: boolean) => void calls.push(`getIdToken(${force})`))
  // jsdom has no matchMedia, and the Settings page's theme provider consults it.
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
})

afterEach(() => {
  window.localStorage.clear()
  vi.unstubAllGlobals()
})

type User = ReturnType<typeof renderComponent>['user']

async function fillDialog(user: User, password: string, pin: string, confirm = pin) {
  await user.click(screen.getByTestId('admin-pin-open'))
  if (password) await user.type(screen.getByTestId('admin-pin-password'), password)
  if (pin) await user.type(screen.getByTestId('admin-pin-new'), pin)
  if (confirm) await user.type(screen.getByTestId('admin-pin-confirm'), confirm)
  await user.click(screen.getByTestId('admin-pin-save'))
}

describe('AdminPinPanel: status', () => {
  it('says when no PIN is set, and offers to set one', async () => {
    renderComponent(<AdminPinPanel />)
    expect(await screen.findByText(/You have not set a PIN/)).not.toBeNull()
    expect(screen.getByTestId('admin-pin-open').textContent).toContain('Set PIN')
  })

  it('says when a PIN is set, and offers to change it — never showing it', async () => {
    fetchAdminPinStatus.mockResolvedValue({
      pinAvailable: true,
      self: { configured: true, updatedAt: '2026-11-01T02:00:00.000Z' },
    })
    renderComponent(<AdminPinPanel />)
    expect(await screen.findByText(/Your PIN is set\. Last changed/)).not.toBeNull()
    expect(screen.getByTestId('admin-pin-open').textContent).toContain('Change PIN')
  })

  it('says plainly when the PIN service cannot be reached', async () => {
    fetchAdminPinStatus.mockRejectedValue(new Error('offline'))
    renderComponent(<AdminPinPanel />)
    expect(await screen.findByText(/PIN settings are unavailable right now/)).not.toBeNull()
  })
})

describe('AdminPinPanel: setting a PIN', () => {
  it('confirms the password, refreshes the token, THEN sends the PIN', async () => {
    const { user } = renderComponent(<AdminPinPanel />)
    await screen.findByText(/You have not set a PIN/)
    await fillDialog(user, 'correct horse', '482915')

    await waitFor(() => expect(setAdminPin).toHaveBeenCalledWith('482915'))
    expect(reauthenticateWithCredential).toHaveBeenCalledWith(expect.anything(), {
      email: 'ada@example.test',
      password: 'correct horse',
    })
    // The forced refresh is what puts the new auth_time in front of setAdminPin.
    expect(calls).toEqual(['reauthenticate', 'getIdToken(true)', 'setAdminPin'])
    expect(await screen.findByTestId('admin-pin-saved')).not.toBeNull()
    // The status is fetched again, so the panel reflects what the server now holds.
    expect(fetchAdminPinStatus).toHaveBeenCalledTimes(2)
  })

  it('masks every field and accepts digits only in the PIN fields', async () => {
    const { user } = renderComponent(<AdminPinPanel />)
    await screen.findByText(/You have not set a PIN/)
    await user.click(screen.getByTestId('admin-pin-open'))

    for (const id of ['admin-pin-password', 'admin-pin-new', 'admin-pin-confirm']) {
      expect((screen.getByTestId(id) as HTMLInputElement).type).toBe('password')
    }
    const pin = screen.getByTestId('admin-pin-new') as HTMLInputElement
    expect(pin.inputMode).toBe('numeric')
    await user.type(pin, '4a8-2 9157')
    expect(pin.value).toBe('482915')
  })

  it('asks for the password before anything else, and sends nothing without it', async () => {
    const { user } = renderComponent(<AdminPinPanel />)
    await screen.findByText(/You have not set a PIN/)
    await fillDialog(user, '', '482915')

    expect(screen.getByText('Enter your password to confirm it is you.')).not.toBeNull()
    expect(reauthenticateWithCredential).not.toHaveBeenCalled()
    expect(setAdminPin).not.toHaveBeenCalled()
  })

  it('cannot be saved until both PINs have six digits', async () => {
    const { user } = renderComponent(<AdminPinPanel />)
    await screen.findByText(/You have not set a PIN/)
    await fillDialog(user, 'pw', '1234')
    const save = screen.getByTestId('admin-pin-save') as HTMLButtonElement

    expect(save.disabled).toBe(true)
    expect(screen.getByTestId('admin-pin-new-progress').textContent).toBe('4 / 6 digits entered')
    expect(screen.getByTestId('admin-pin-confirm-progress').textContent).toBe(
      '4 / 6 digits entered',
    )
    // Enter in a PIN field is held to the same check, and explains it.
    await user.type(screen.getByTestId('admin-pin-new'), '{Enter}')
    expect(screen.getByText('The PIN must be exactly 6 digits.')).not.toBeNull()

    expect(reauthenticateWithCredential).not.toHaveBeenCalled()
    expect(setAdminPin).not.toHaveBeenCalled()
  })

  it('refuses two PINs that differ before contacting anything, and marks the confirmation', async () => {
    const { user } = renderComponent(<AdminPinPanel />)
    await screen.findByText(/You have not set a PIN/)
    await fillDialog(user, 'pw', '482915', '482916')

    expect(screen.getByText('The two PINs do not match.')).not.toBeNull()
    expect(screen.getByTestId('admin-pin-confirm').getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByTestId('admin-pin-new').getAttribute('aria-invalid')).toBeNull()
    expect(reauthenticateWithCredential).not.toHaveBeenCalled()
    expect(setAdminPin).not.toHaveBeenCalled()
  })

  it('draws both PINs as six masked boxes that fill as digits go in', async () => {
    const { user } = renderComponent(<AdminPinPanel />)
    await screen.findByText(/You have not set a PIN/)
    await user.click(screen.getByTestId('admin-pin-open'))
    await user.type(screen.getByTestId('admin-pin-new'), '48')
    await user.click(screen.getAllByTestId('admin-pin-confirm-slot')[0]!)
    await user.paste('482-915')

    const newSlots = screen.getAllByTestId('admin-pin-new-slot')
    const confirmSlots = screen.getAllByTestId('admin-pin-confirm-slot')
    expect(newSlots).toHaveLength(6)
    expect(newSlots.filter((slot) => slot.dataset.filled === 'true')).toHaveLength(2)
    expect(confirmSlots.filter((slot) => slot.dataset.filled === 'true')).toHaveLength(6)
    expect(newSlots[0]!.parentElement!.textContent).toBe('')
    expect(confirmSlots[0]!.parentElement!.textContent).toBe('')
  })

  it('stops at a wrong password — the PIN is never sent — and clears every field', async () => {
    reauthenticateWithCredential.mockRejectedValue(
      new FirebaseError('auth/invalid-credential', 'bad'),
    )
    const { user } = renderComponent(<AdminPinPanel />)
    await screen.findByText(/You have not set a PIN/)
    await fillDialog(user, 'wrong', '482915')

    expect(await screen.findByText('That email or password is not correct.')).not.toBeNull()
    expect(setAdminPin).not.toHaveBeenCalled()
    for (const id of ['admin-pin-password', 'admin-pin-new', 'admin-pin-confirm']) {
      expect((screen.getByTestId(id) as HTMLInputElement).value).toBe('')
    }
  })

  it('shows the server’s refusal of a PIN another admin already uses, without saying whose', async () => {
    setAdminPin.mockRejectedValue(new MessageError(message('settings.pinUnavailable')))
    const { user } = renderComponent(<AdminPinPanel />)
    await screen.findByText(/You have not set a PIN/)
    await fillDialog(user, 'correct horse', '111111')

    expect(
      await screen.findByText("This PIN can't be used. Choose a different PIN."),
    ).not.toBeNull()
    expect(screen.queryByTestId('admin-pin-saved')).toBeNull()
  })

  it('shows the server’s setup limit', async () => {
    setAdminPin.mockRejectedValue(new MessageError(message('settings.pinRateLimited')))
    const { user } = renderComponent(<AdminPinPanel />)
    await screen.findByText(/You have not set a PIN/)
    await fillDialog(user, 'correct horse', '482915')

    expect(await screen.findByText(/Too many PIN changes/)).not.toBeNull()
  })
})

describe('Settings: who sees the PIN panel', () => {
  /** As settings.test.tsx renders it: the page reads the theme and links out. */
  const renderSettings = () =>
    renderComponent(
      <MemoryRouter>
        <ThemeProvider>
          <SettingsPage />
        </ThemeProvider>
      </MemoryRouter>,
    )

  it('shows it to an administrator', async () => {
    renderSettings()
    expect(await screen.findByTestId('settings-admin-pin')).not.toBeNull()
  })

  it('never shows it to staff, nor asks the server anything', () => {
    role = 'staff'
    renderSettings()
    expect(screen.queryByTestId('settings-admin-pin')).toBeNull()
    expect(fetchAdminPinStatus).not.toHaveBeenCalled()
  })
})

describe('AdminPinPanel: in every language', () => {
  const CASES = [
    ['ms', 'PIN kebenaran pembatalan', 'Tetapkan PIN', 'Kedua-dua PIN tidak sepadan.'],
    ['zh', '作废授权 PIN', '设置 PIN', '两次输入的 PIN 不一致。'],
  ] as const

  for (const [language, title, setLabel, mismatch] of CASES) {
    it(`reads in ${language}`, async () => {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language)
      const { user } = renderComponent(<AdminPinPanel />)
      expect(await screen.findByText(title)).not.toBeNull()
      await waitFor(() =>
        expect(screen.getByTestId('admin-pin-open').textContent).toContain(setLabel),
      )

      await fillDialog(user, 'pw', '482915', '482916')
      expect(screen.getByText(mismatch)).not.toBeNull()
    })
  }
})
