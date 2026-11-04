// @vitest-environment jsdom
/**
 * A selling price and a cost are both compulsory, and the two have to make sense together.
 *
 * The rules themselves are proven exhaustively in tests/unit/item-pricing.test.ts. What is proven
 * here is that the form obeys them on both routes: that a refusal stops the write, lands under
 * the field it belongs to, and answers as either field changes.
 *
 * The menu table is here too. An item from before the rule can still have no cost, so it stops
 * being rendered as a dash — which read as "zero" at a glance — in favour of something that says
 * what is wrong and links to where it is fixed.
 */
import { screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MenuItemFormPage } from '@/features/menu/MenuItemFormPage'
import { MenuListPage } from '@/features/menu/MenuListPage'
import { LANGUAGE_STORAGE_KEY } from '@/features/i18n/languages'

import { renderComponent } from './render'

const createMenuItem = vi.hoisted(() => vi.fn())
const updateMenuItem = vi.hoisted(() => vi.fn())

vi.mock('@/features/menu/menu-api', () => ({
  createMenuItem,
  updateMenuItem,
  deleteMenuItem: vi.fn(),
  setMenuItemActive: vi.fn(),
}))

vi.mock('@/features/menu/ModifierGroupsEditor', () => ({ ModifierGroupsEditor: () => null }))

vi.mock('@/features/auth/useAuth', () => ({
  useAuth: () => ({ role: 'admin', profile: { uid: 'u1', role: 'admin' } }),
}))

const CATEGORIES = [
  {
    id: 'cat-coffee',
    name: 'Coffee',
    sortOrder: 0,
    active: true,
    createdAt: null,
    updatedAt: null,
  },
]

const ITEMS = [
  {
    id: 'item-kopi',
    name: 'Kopi O',
    names: { en: 'Kopi O', ms: '', zh: '' },
    description: '',
    categoryId: 'cat-coffee',
    price: 250,
    sortOrder: 0,
    active: true,
    createdAt: null,
    updatedAt: null,
  },
  {
    id: 'item-ckt',
    name: 'Char Kway Teow',
    names: { en: 'Char Kway Teow', ms: '', zh: '' },
    description: '',
    categoryId: 'cat-coffee',
    price: 1000,
    sortOrder: 1,
    active: true,
    createdAt: null,
    updatedAt: null,
  },
]

/** Only Kopi O has one — Char Kway Teow is the item this feature exists for. */
let costs = new Map<string, number>([['item-kopi', 80]])

vi.mock('@/features/menu/useCategories', () => ({
  useCategories: () => ({ categories: CATEGORIES, loading: false, error: null }),
}))
vi.mock('@/features/menu/useMenuItems', () => ({
  useMenuItems: () => ({ items: ITEMS, loading: false, error: null }),
}))
vi.mock('@/features/menu/useItemCosts', () => ({
  useItemCosts: () => ({ costs, loading: false, error: null }),
}))
vi.mock('@/features/menu/useModifierGroups', () => ({
  useModifierGroups: () => ({ groups: [], loading: false, error: null }),
}))

beforeEach(() => {
  createMenuItem.mockReset()
  createMenuItem.mockResolvedValue('new-id')
  updateMenuItem.mockReset()
  updateMenuItem.mockResolvedValue(undefined)
  costs = new Map<string, number>([['item-kopi', 80]])
})

afterEach(() => {
  document.documentElement.removeAttribute('lang')
  window.localStorage.clear()
})

function renderNewItemForm() {
  return renderComponent(
    <MemoryRouter initialEntries={['/menu/new']}>
      <Routes>
        <Route path="/menu/new" element={<MenuItemFormPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

function renderEditForm(itemId: string) {
  return renderComponent(
    <MemoryRouter initialEntries={[`/menu/${itemId}/edit`]}>
      <Routes>
        <Route path="/menu/:itemId/edit" element={<MenuItemFormPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

type User = ReturnType<typeof renderComponent>['user']

const priceField = () => screen.getByTestId('price') as HTMLInputElement
const costField = () => screen.getByTestId('cost') as HTMLInputElement
const submit = () => screen.getByRole('button', { name: 'Create item' })

describe('the selling price is compulsory', () => {
  async function submitPrice(user: User, price: string) {
    await user.type(screen.getByTestId('name'), 'Teh Tarik')
    if (price !== '') await user.type(priceField(), price)
    await user.type(costField(), '1.00')
    await user.click(submit())
  }

  it('marks itself required, for the eye and for assistive technology', () => {
    renderNewItemForm()
    expect(priceField().required).toBe(true)
    expect(document.querySelector('label[for="price"]')?.textContent).toContain('*')
  })

  it('blocks an empty price, says so under the field and puts the cursor there', async () => {
    const { user } = renderNewItemForm()
    await submitPrice(user, '')

    expect(createMenuItem).not.toHaveBeenCalled()
    expect(screen.getByTestId('price-error').textContent).toBe('Enter a price.')
    expect(document.activeElement).toBe(priceField())
    expect(priceField().getAttribute('aria-invalid')).toBe('true')
    expect(priceField().getAttribute('aria-describedby')).toBe('price-error')
  })

  it('does not read a field of spaces as zero, or as anything else', async () => {
    const { user } = renderNewItemForm()
    await submitPrice(user, '   ')

    expect(createMenuItem).not.toHaveBeenCalled()
    expect(screen.getByTestId('price-error').textContent).toBe('Enter a price.')
  })

  it.each(['0', '0.00'])('blocks a price of %s', async (price) => {
    const { user } = renderNewItemForm()
    await submitPrice(user, price)

    expect(createMenuItem).not.toHaveBeenCalled()
    expect(screen.getByTestId('price-error').textContent).toBe(
      'The selling price must be more than RM 0.00.',
    )
  })

  it('blocks a negative price', async () => {
    const { user } = renderNewItemForm()
    await submitPrice(user, '-1')

    expect(createMenuItem).not.toHaveBeenCalled()
    expect(screen.getByTestId('price-error').textContent).toBe('A price cannot be negative.')
  })

  it('blocks a price that is not a number', async () => {
    const { user } = renderNewItemForm()
    await submitPrice(user, 'free')

    expect(createMenuItem).not.toHaveBeenCalled()
    expect(screen.getByTestId('price-error').textContent).toBe('Enter a number, for example 12.50.')
  })

  it('says nothing about either field until there is a reason to', () => {
    renderNewItemForm()
    expect(screen.queryByTestId('price-error')).toBeNull()
    expect(screen.queryByTestId('cost-error')).toBeNull()
    expect(priceField().getAttribute('aria-invalid')).toBe('false')
  })

  it('reports a missing price and a missing cost together, each under its field', async () => {
    const { user } = renderNewItemForm()
    await user.type(screen.getByTestId('name'), 'Teh Tarik')
    await user.click(submit())

    expect(screen.getByTestId('price-error').textContent).toBe('Enter a price.')
    expect(screen.getByTestId('cost-error').textContent).toBe('Cost is required.')
    expect(document.activeElement).toBe(priceField())
    expect(createMenuItem).not.toHaveBeenCalled()
  })
})

describe('the cost is compulsory, and blank is not zero', () => {
  async function submitCost(user: User, price: string, cost: string) {
    await user.type(screen.getByTestId('name'), 'Teh Tarik')
    await user.type(priceField(), price)
    if (cost !== '') await user.type(costField(), cost)
    await user.click(submit())
  }

  it('marks itself required, for the eye and for assistive technology', () => {
    renderNewItemForm()
    expect(costField().required).toBe(true)
    expect(document.querySelector('label[for="cost"]')?.textContent).toContain('*')
  })

  it('suggests a figure rather than telling people to leave it blank', () => {
    renderNewItemForm()
    expect(costField().placeholder).toBe('4.50')
    expect(screen.queryByText(/Leave blank/)).toBeNull()
  })

  it('blocks an empty cost, says so under the field and puts the cursor there', async () => {
    const { user } = renderNewItemForm()
    await submitCost(user, '3.50', '')

    expect(createMenuItem).not.toHaveBeenCalled()
    expect(screen.getByTestId('cost-error').textContent).toBe('Cost is required.')
    expect(document.activeElement).toBe(costField())
    expect(costField().getAttribute('aria-invalid')).toBe('true')
  })

  it('blocks a field of spaces rather than reading it as zero', async () => {
    const { user } = renderNewItemForm()
    await submitCost(user, '3.50', '   ')

    expect(createMenuItem).not.toHaveBeenCalled()
    expect(screen.getByTestId('cost-error').textContent).toBe('Cost is required.')
  })

  it('accepts zero as a real cost, and sends it as 0', async () => {
    const { user } = renderNewItemForm()
    await submitCost(user, '10.00', '0.00')

    expect(createMenuItem).toHaveBeenCalledTimes(1)
    expect(createMenuItem.mock.calls[0]?.[0]).toMatchObject({ price: 1000 })
    expect(createMenuItem.mock.calls[0]?.[1]).toBe(0)
  })

  it('saves a cost below the price, in whole sen', async () => {
    const { user } = renderNewItemForm()
    await submitCost(user, '10.00', '8.00')

    expect(createMenuItem.mock.calls[0]?.[1]).toBe(800)
  })

  it('saves a cost equal to the price', async () => {
    const { user } = renderNewItemForm()
    await submitCost(user, '10.00', '10.00')

    expect(createMenuItem.mock.calls[0]?.[1]).toBe(1000)
  })

  it('blocks a cost above the price, under the field and with the cursor in it', async () => {
    const { user } = renderNewItemForm()
    await submitCost(user, '10.00', '10.50')

    expect(createMenuItem).not.toHaveBeenCalled()
    expect(screen.getByTestId('cost-error').textContent).toBe(
      'Cost cannot be more than the selling price of RM 10.00.',
    )
    expect(document.activeElement).toBe(costField())
    expect(screen.queryByTestId('price-error')).toBeNull()
  })

  it('blocks a negative cost', async () => {
    const { user } = renderNewItemForm()
    await submitCost(user, '3.50', '-1')

    expect(createMenuItem).not.toHaveBeenCalled()
    expect(screen.getByTestId('cost-error').textContent).toBe('A cost cannot be negative.')
  })

  it('blocks a cost that is not a number', async () => {
    const { user } = renderNewItemForm()
    await submitCost(user, '3.50', 'free')

    expect(createMenuItem).not.toHaveBeenCalled()
    expect(screen.getByTestId('cost-error').textContent).toBe('Enter a number, for example 12.50.')
  })

  it('blocks zero for both, on the price and not the cost', async () => {
    const { user } = renderNewItemForm()
    await submitCost(user, '0.00', '0.00')

    expect(createMenuItem).not.toHaveBeenCalled()
    expect(screen.getByTestId('price-error')).not.toBeNull()
    expect(screen.queryByTestId('cost-error')).toBeNull()
  })
})

describe('the two fields answer each other', () => {
  async function tooDear(user: User) {
    await user.type(screen.getByTestId('name'), 'Teh Tarik')
    await user.type(priceField(), '10.00')
    await user.type(costField(), '10.50')
    await user.click(submit())
    expect(screen.getByTestId('cost-error')).not.toBeNull()
  }

  it('clears the complaint as soon as the cost comes within the price', async () => {
    const { user } = renderNewItemForm()
    await tooDear(user)

    await user.clear(costField())
    await user.type(costField(), '9')
    expect(screen.queryByTestId('cost-error')).toBeNull()
  })

  it('clears the complaint under the COST when the PRICE is raised', async () => {
    const { user } = renderNewItemForm()
    await tooDear(user)

    await user.clear(priceField())
    await user.type(priceField(), '11')
    expect(screen.queryByTestId('cost-error')).toBeNull()
  })

  it('states the price as it now stands', async () => {
    const { user } = renderNewItemForm()
    await tooDear(user)

    await user.clear(priceField())
    await user.type(priceField(), '10.25')
    expect(screen.getByTestId('cost-error').textContent).toContain('RM 10.25')
  })

  it('raises the complaint when the price is lowered after the check has run', async () => {
    const { user } = renderNewItemForm()
    await user.type(priceField(), '10.00')
    await user.type(costField(), '8.00')
    await user.tab()
    expect(screen.queryByTestId('cost-error')).toBeNull()

    await user.clear(priceField())
    await user.type(priceField(), '7')
    expect(screen.getByTestId('cost-error')).not.toBeNull()
  })

  it('does not complain while a price is still being typed', async () => {
    const { user } = renderNewItemForm()
    await user.type(priceField(), 'x')
    expect(screen.queryByTestId('price-error')).toBeNull()
  })

  it('checks a filled-in field as soon as it is left', async () => {
    const { user } = renderNewItemForm()
    await user.type(priceField(), 'free')
    expect(screen.queryByTestId('price-error')).toBeNull()

    await user.tab()
    expect(screen.getByTestId('price-error')).not.toBeNull()
  })

  it('does not call the cost required just for arriving at it from the price', async () => {
    const { user } = renderNewItemForm()
    await user.type(priceField(), '10.00')
    await user.tab()

    expect(document.activeElement).toBe(costField())
    expect(screen.queryByTestId('cost-error')).toBeNull()
  })

  it('does not call the price required when only the cost has been filled in', async () => {
    const { user } = renderNewItemForm()
    await user.type(costField(), '4.00')
    await user.tab()
    expect(screen.queryByTestId('price-error')).toBeNull()
  })

  it('follows the cost as it is typed once the price has been checked', async () => {
    const { user } = renderNewItemForm()
    await user.type(priceField(), '10.00')
    await user.tab()
    await user.type(costField(), '9')
    expect(screen.queryByTestId('cost-error')).toBeNull()

    await user.type(costField(), '9')
    expect(screen.getByTestId('cost-error')).not.toBeNull()
  })

  it('does not complain about an empty field merely passed through', async () => {
    const { user } = renderNewItemForm()
    await user.click(priceField())
    await user.tab()
    expect(screen.queryByTestId('price-error')).toBeNull()
  })
})

describe('editing an item', () => {
  const save = () => screen.getByRole('button', { name: 'Save changes' })

  it('saves valid values, stating the cost as both new and previous', async () => {
    const { user } = renderEditForm('item-kopi')
    await user.click(save())

    expect(updateMenuItem).toHaveBeenCalledTimes(1)
    expect(updateMenuItem.mock.calls[0]?.[0]).toBe('item-kopi')
    expect(updateMenuItem.mock.calls[0]?.[1]).toMatchObject({ price: 250 })
    expect(updateMenuItem.mock.calls[0]?.[2]).toEqual({ next: 80, previous: 80 })
  })

  it('blocks a price lowered beneath the cost already recorded', async () => {
    const { user } = renderEditForm('item-kopi')
    await user.clear(priceField())
    await user.type(priceField(), '0.50')
    await user.click(save())

    expect(updateMenuItem).not.toHaveBeenCalled()
    expect(screen.getByTestId('cost-error').textContent).toBe(
      'Cost cannot be more than the selling price of RM 0.50.',
    )
  })

  it('saves a cost changed to something within the price', async () => {
    const { user } = renderEditForm('item-kopi')
    await user.clear(costField())
    await user.type(costField(), '2.50')
    await user.click(save())

    expect(updateMenuItem.mock.calls[0]?.[2]).toEqual({ next: 250, previous: 80 })
  })

  it('saves a recorded cost changed to zero, as a real change', async () => {
    const { user } = renderEditForm('item-kopi')
    await user.clear(costField())
    await user.type(costField(), '0')
    await user.click(save())

    expect(updateMenuItem.mock.calls[0]?.[2]).toEqual({ next: 0, previous: 80 })
  })

  it('blocks a price cleared on an existing item', async () => {
    const { user } = renderEditForm('item-kopi')
    await user.clear(priceField())
    await user.click(save())

    expect(updateMenuItem).not.toHaveBeenCalled()
    expect(screen.getByTestId('price-error').textContent).toBe('Enter a price.')
  })

  it('will not let a recorded cost be removed by leaving it blank', async () => {
    const { user } = renderEditForm('item-kopi')
    await user.clear(costField())
    await user.click(save())

    expect(updateMenuItem).not.toHaveBeenCalled()
    expect(screen.getByTestId('cost-error').textContent).toBe('Cost is required.')
  })

  it('will not save an item with no cost until one is entered, and fills nothing in', async () => {
    const { user } = renderEditForm('item-ckt')
    expect(costField().value).toBe('')

    await user.click(save())
    expect(updateMenuItem).not.toHaveBeenCalled()
    expect(screen.getByTestId('cost-error').textContent).toBe('Cost is required.')

    await user.type(costField(), '4.00')
    await user.click(save())
    expect(updateMenuItem.mock.calls[0]?.[2]).toEqual({ next: 400, previous: null })
  })

  it('accepts RM 0.00 typed into such an item as a real first cost', async () => {
    const { user } = renderEditForm('item-ckt')
    await user.type(costField(), '0.00')
    await user.click(save())

    expect(updateMenuItem.mock.calls[0]?.[2]).toEqual({ next: 0, previous: null })
  })

  it('asks an old item whose cost already exceeds its price to be put right', async () => {
    costs = new Map([['item-kopi', 300]])
    const { user } = renderEditForm('item-kopi')
    await user.click(save())

    expect(updateMenuItem).not.toHaveBeenCalled()
    expect(screen.getByTestId('cost-error')).not.toBeNull()
  })
})

describe('the messages in every language', () => {
  const CASES = [
    [
      'ms',
      'Harga jualan mesti lebih daripada RM 0.00.',
      'Kos tidak boleh melebihi harga jualan',
      'Kos diperlukan.',
      'Kos tidak boleh negatif.',
    ],
    ['zh', '售价必须大于 RM 0.00。', '成本不能高于售价', '必须填写成本。', '成本不能为负数。'],
  ] as const

  it.each(CASES)('reads properly in %s', async (language, zero, tooDear, required, negative) => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language)
    const { user } = renderNewItemForm()

    await user.type(priceField(), '0')
    await user.tab()
    expect(screen.getByTestId('price-error').textContent).toBe(zero)

    await user.clear(priceField())
    await user.type(priceField(), '10.00')
    await user.type(costField(), '10.50')
    await user.tab()
    expect(screen.getByTestId('cost-error').textContent).toContain(tooDear)
    expect(screen.getByTestId('cost-error').textContent).toContain('RM 10.00')

    await user.clear(costField())
    await user.type(costField(), '-1')
    expect(screen.getByTestId('cost-error').textContent).toBe(negative)

    await user.clear(costField())
    await user.click(document.querySelector('button[type="submit"]')!)
    expect(screen.getByTestId('cost-error').textContent).toBe(required)
  })
})

describe('the menu table flags an item with no cost', () => {
  function renderMenu() {
    return renderComponent(
      <MemoryRouter>
        <MenuListPage />
      </MemoryRouter>,
    )
  }

  it('names the problem instead of showing a dash', () => {
    renderMenu()
    const pill = screen.getByTestId('item-missing-cost')
    expect(pill.textContent).toContain('Missing cost')
  })

  it('links straight to the form that fixes it', () => {
    renderMenu()
    expect(screen.getByTestId('item-missing-cost').getAttribute('href')).toBe('/menu/item-ckt/edit')
  })

  it('flags only the item that is actually missing one', () => {
    renderMenu()
    expect(screen.getAllByTestId('item-missing-cost')).toHaveLength(1)
    // The item that has a cost still shows the figure.
    expect(screen.getByText('RM 0.80')).not.toBeNull()
  })

  it('says nothing when every item has a cost', () => {
    costs = new Map<string, number>([
      ['item-kopi', 80],
      ['item-ckt', 520],
    ])
    renderMenu()
    expect(screen.queryByTestId('item-missing-cost')).toBeNull()
  })
})
