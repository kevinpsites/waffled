import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const mocks = vi.hoisted(() => ({
  identity: { scope: 'principal-a' as string | null },
  resolve: vi.fn(),
  warm: vi.fn(),
  lists: vi.fn(),
  createList: vi.fn(),
  addListItem: vi.fn(),
  recipes: vi.fn(),
  planSlot: vi.fn(),
}))

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return {
    ...actual,
    currentIdentityScope: () => mocks.identity.scope,
    usePersons: () => ({ persons: [], loading: false, error: false }),
    useHousehold: () => ({
      household: { id: 'h', name: 'Home', timezone: 'UTC', weekStart: 'sunday' },
      person: { id: 'viewer', name: 'Viewer', memberType: 'adult', isAdmin: true, capabilities: [] },
      memberships: [],
      pendingInvites: [],
    }),
    can: () => true,
    api: {
      ...actual.api,
      resolve: mocks.resolve,
      warm: mocks.warm,
      lists: mocks.lists,
      createList: mocks.createList,
      addListItem: mocks.addListItem,
      recipes: mocks.recipes,
      planSlot: mocks.planSlot,
    },
  }
})

import { CaptureBar } from './CaptureBar'

function openAndType(value: string): void {
  fireEvent.click(document.querySelector('.capture-trigger') as HTMLElement)
  fireEvent.change(screen.getByLabelText('Add anything'), { target: { value } })
}

async function submitSettledKind(kind: 'List' | 'Meal'): Promise<void> {
  // The on-device guess is intentionally available before the debounced server
  // parse. Wait for the mocked authoritative parse so this concurrency test is
  // deterministic across calendar days ("tomorrow" is otherwise re-derived).
  await screen.findByText('via Claude', { exact: true }, { timeout: 3000 })
  await screen.findByText(kind, { exact: true }, { timeout: 3000 })
  fireEvent.click(screen.getByRole('button', { name: 'Add' }))
}

beforeEach(() => {
  mocks.identity.scope = 'principal-a'
  mocks.resolve.mockReset()
  mocks.warm.mockReset().mockResolvedValue(undefined)
  mocks.lists.mockReset().mockResolvedValue({ lists: [] })
  mocks.createList.mockReset().mockResolvedValue({
    id: 'new-list',
    name: 'Errands',
    emoji: null,
    listType: 'custom',
    isAutoBuilt: false,
    sortMode: 'manual',
    itemCount: 0,
  })
  mocks.addListItem.mockReset().mockResolvedValue({ id: 'item-1' })
  mocks.recipes.mockReset().mockResolvedValue({ recipes: [] })
  mocks.planSlot.mockReset().mockResolvedValue({ entry: { id: 'entry-1' } })
})

describe('CaptureBar principal-bound async commits', () => {
  it('keeps a list lookup, list creation, and item creation on the initiating principal', async () => {
    const lookup = deferred<{ lists: never[] }>()
    mocks.lists.mockImplementation((identityScope?: string | null) =>
      identityScope === undefined ? Promise.resolve({ lists: [] }) : lookup.promise
    )
    mocks.resolve.mockResolvedValue({
      intent: { kind: 'list', itemName: 'Batteries', listName: 'Errands', quantity: null },
      via: 'anthropic',
    })

    render(<CaptureBar />)
    openAndType('add batteries to the errands list')
    await submitSettledKind('List')

    await waitFor(() => expect(mocks.lists).toHaveBeenCalledWith('principal-a'))
    mocks.identity.scope = 'principal-b'
    lookup.resolve({ lists: [] })

    await waitFor(() => expect(mocks.addListItem).toHaveBeenCalled())
    expect(mocks.createList).toHaveBeenCalledWith({ name: 'Errands' }, 'principal-a')
    expect(mocks.addListItem).toHaveBeenCalledWith(
      'new-list',
      { name: 'Batteries', quantity: undefined },
      'principal-a',
    )
  })

  it('keeps a recipe lookup and meal-plan write on the initiating principal', async () => {
    const lookup = deferred<{ recipes: Array<{ id: string; title: string }> }>()
    mocks.recipes.mockImplementation(() => lookup.promise)
    mocks.resolve.mockResolvedValue({
      intent: {
        kind: 'meal',
        title: 'Tacos',
        date: '2026-09-04',
        mealType: 'dinner',
        whenLabel: 'Fri, Sep 4 · Dinner',
      },
      via: 'anthropic',
    })

    render(<CaptureBar />)
    openAndType('tacos for dinner tomorrow')
    await submitSettledKind('Meal')

    await waitFor(() => expect(mocks.recipes).toHaveBeenCalledWith('principal-a'))
    mocks.identity.scope = 'principal-b'
    lookup.resolve({ recipes: [{ id: 'recipe-tacos', title: 'Tacos' }] })

    await waitFor(() => expect(mocks.planSlot).toHaveBeenCalled())
    expect(mocks.planSlot).toHaveBeenCalledWith({
      date: '2026-09-04',
      mealType: 'dinner',
      recipeId: 'recipe-tacos',
      title: undefined,
    }, 'principal-a')
  })
})
