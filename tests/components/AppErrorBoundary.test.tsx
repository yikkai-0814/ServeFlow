// @vitest-environment jsdom
/**
 * What the counter sees when a screen fails to render, instead of a blank page.
 */
import { screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppErrorBoundary } from '@/components/layout/AppErrorBoundary'
import { LANGUAGE_STORAGE_KEY } from '@/features/i18n/languages'

import { renderComponent } from './render'

const SECRET = 'orders/abc123 permission-denied for admin@example.com'

function Broken(): never {
  throw new Error(SECRET)
}

function renderBroken() {
  return renderComponent(
    <AppErrorBoundary>
      <Broken />
    </AppErrorBoundary>,
  )
}

beforeEach(() => {
  // React reports a caught render error to the console, which is the right place for it.
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('AppErrorBoundary', () => {
  it('shows its children when nothing is wrong', () => {
    renderComponent(
      <AppErrorBoundary>
        <p>The till</p>
      </AppErrorBoundary>,
    )
    expect(screen.getByText('The till')).not.toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('replaces a blank page with a message and a way forward', () => {
    renderBroken()
    expect(screen.getByRole('alert')).not.toBeNull()
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Reload' })).not.toBeNull()
  })

  it('never shows the error itself, which can name documents and accounts', () => {
    const { container } = renderBroken()
    expect(container.textContent).not.toContain('abc123')
    expect(container.textContent).not.toContain('admin@example.com')
    expect(container.textContent).not.toContain('permission-denied')
  })

  it('reloads the page when asked', async () => {
    const reload = vi.fn()
    vi.stubGlobal('location', { ...window.location, reload })
    const { user } = renderBroken()

    await user.click(screen.getByTestId('error-reload'))
    expect(reload).toHaveBeenCalledOnce()
  })

  it('offers a full page load back to the start, since the router may be what failed', () => {
    renderBroken()
    expect(screen.getByRole('link', { name: 'Back to start' }).getAttribute('href')).toBe('/')
  })

  it.each([
    ['ms', 'Berlaku masalah', 'Muat semula', 'Kembali ke permulaan'],
    ['zh', '出现问题', '重新加载', '返回首页'],
  ])('speaks %s', (language, title, reload, home) => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language)
    renderBroken()
    expect(screen.getByRole('heading', { name: title })).not.toBeNull()
    expect(screen.getByRole('button', { name: reload })).not.toBeNull()
    expect(screen.getByRole('link', { name: home })).not.toBeNull()
  })
})
