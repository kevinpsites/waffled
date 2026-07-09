import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { ReactElement } from 'react'
import { Tasks } from './Tasks'
import { uploadImage } from '../lib/api'

// Photo-proof completion uploads through uploadImage(), which re-encodes via a
// <canvas> jsdom can't run — so stub it to a fixed { key, url, contentType }.
vi.mock('../lib/api/media', () => ({
  uploadImage: vi.fn(async () => ({ key: 'hh/proof.jpg', url: '/media/hh/proof.jpg', contentType: 'image/jpeg' })),
  MAX_UPLOAD_BYTES: 10 * 1024 * 1024,
}))

// Tasks reads the active tab from the URL (useSearchParams), so it needs a Router.
const renderTasks = (ui: ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>)

interface Inst {
  id: string
  choreTitle: string
  emoji: string | null
  personId: string
  personName: string
  status: string
  rewardAmount: number
}

const ok = (body: unknown) => ({ ok: true, json: async () => body })

// A signed-in admin-equivalent caller: all four capabilities, so approval/manage
// surfaces render. /api/household feeds useHousehold (and thus the can() gates).
const ALL_CAPS = ['chore.manage', 'chore.approve', 'reward.manage', 'reward.approve']
const householdPerson = (capabilities = ALL_CAPS) =>
  ok({ provisioned: true, household: { id: 'h', name: 'Home', timezone: 'UTC', weekStart: 'sunday' }, person: { id: 'me', name: 'Me', memberType: 'adult', isAdmin: true, capabilities } })

function mockInstances(initial: Inst[], persons: Array<{ id: string; name: string }> = []) {
  let instances = [...initial]
  globalThis.fetch = vi.fn(async (url: string, opts?: { method?: string }) => {
    const u = String(url)
    const m = opts?.method ?? 'GET'
    if (u.includes('/api/household') && m === 'GET') return householdPerson()
    if (u.includes('/api/persons') && m === 'GET') return ok({ persons })
    if (u.includes('/api/chore-instances/today') && m === 'GET') return ok({ date: 'x', instances })
    if (u.includes('/complete') && m === 'POST') {
      const id = u.split('/').slice(-2)[0]
      instances = instances.map((i) => (i.id === id ? { ...i, status: 'done' } : i))
      return ok({ instance: { id, status: 'done' } })
    }
    if (u.includes('/uncomplete') && m === 'POST') {
      const id = u.split('/').slice(-2)[0]
      instances = instances.map((i) => (i.id === id ? { ...i, status: 'pending' } : i))
      return ok({ instance: { id, status: 'pending' } })
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
}

describe('Tasks screen', () => {
  it('lists chores grouped by person and completes one', async () => {
    mockInstances([
      { id: '1', choreTitle: 'Feed dog', emoji: '🐶', personId: 'p1', personName: 'Wally', status: 'pending', rewardAmount: 2 },
      { id: '2', choreTitle: 'Set table', emoji: '🍽️', personId: 'p2', personName: 'Lottie', status: 'pending', rewardAmount: 2 },
    ])
    renderTasks(<Tasks />)
    expect(await screen.findByText(/Feed dog/)).toBeInTheDocument()
    expect(screen.getByText('Wally')).toBeInTheDocument()
    expect(screen.getByText('Lottie')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Complete Feed dog/ }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Uncomplete Feed dog/ })).toBeInTheDocument()
    )
  })

  it('shows a calm "due …" hint on a future-dated one-off (not "overdue")', async () => {
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10)
    mockInstances([
      { id: '5', choreTitle: 'Return library books', emoji: '📚', personId: 'p1', personName: 'Wally', status: 'pending', rewardAmount: 2, dueOn: future, rrule: null } as unknown as Inst,
    ])
    renderTasks(<Tasks />)
    expect(await screen.findByText(/Return library books/)).toBeInTheDocument()
    // present today with a "due …" badge, and NOT flagged overdue
    expect(screen.getByText(/^due /)).toBeInTheDocument()
    expect(screen.queryByText(/overdue/)).not.toBeInTheDocument()
  })

  it('always shows Up-for-grabs and every person — even with no chores', async () => {
    // Wally has a chore; Lottie and Kevin have none. All three (+ Up for grabs) should appear.
    mockInstances(
      [{ id: '1', choreTitle: 'Feed dog', emoji: '🐶', personId: 'p1', personName: 'Wally', status: 'pending', rewardAmount: 2 }],
      [
        { id: 'p1', name: 'Wally' },
        { id: 'p2', name: 'Lottie' },
        { id: 'p3', name: 'Kevin' },
      ]
    )
    renderTasks(<Tasks />)
    expect(await screen.findByText(/Feed dog/)).toBeInTheDocument()
    expect(screen.getByText(/Up for grabs/)).toBeInTheDocument()
    expect(screen.getByText('Lottie')).toBeInTheDocument() // empty person still shown
    expect(screen.getByText('Kevin')).toBeInTheDocument()
    expect(screen.getByText(/Nothing for Lottie/)).toBeInTheDocument()

    // Stable order: Up for grabs, then persons in list order (Wally, Lottie, Kevin).
    const heads = screen
      .getAllByText(/Up for grabs|Wally|Lottie|Kevin/, { selector: '.chore-head .nm' })
      .map((e) => (e.textContent || '').replace(/[^A-Za-z ]/g, '').trim())
    expect(heads).toEqual(['Up for grabs', 'Wally', 'Lottie', 'Kevin'])
  })

  it('photo-proof: completing prompts for a photo, uploads it, then completes with the key', async () => {
    const completeBodies: Array<Record<string, unknown> | null> = []
    let instances: Array<Record<string, unknown>> = [
      { id: '9', choreTitle: 'Tidy room', emoji: '🧹', personId: 'p1', personName: 'Wally', status: 'pending', rewardAmount: 3, requiresPhoto: true, requiresApproval: false, proofUrl: null },
    ]
    globalThis.fetch = vi.fn(async (url: string, opts?: { method?: string; body?: string }) => {
      const u = String(url)
      const m = opts?.method ?? 'GET'
      if (u.includes('/api/household')) return householdPerson()
      if (u.includes('/api/persons')) return ok({ persons: [{ id: 'p1', name: 'Wally' }] })
      if (u.includes('/api/chore-instances/today')) return ok({ date: 'x', instances })
      if (u.includes('/complete') && m === 'POST') {
        completeBodies.push(opts?.body ? JSON.parse(opts.body) : null)
        const id = u.split('/').slice(-2)[0]
        instances = instances.map((i) => (i.id === id ? { ...i, status: 'done' } : i))
        return ok({ instance: { id, status: 'done' } })
      }
      return { ok: false, status: 404, json: async () => ({}) }
    }) as unknown as typeof fetch

    const { container } = renderTasks(<Tasks />)
    expect(await screen.findByText(/Tidy room/)).toBeInTheDocument()

    // Tapping the tick on a photo-proof chore must NOT complete immediately…
    fireEvent.click(screen.getByRole('button', { name: /Complete Tidy room/ }))
    expect(completeBodies.length).toBe(0)

    // …it opens the (hidden) file picker. Supplying a photo uploads + completes.
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['x'], 'proof.jpg', { type: 'image/jpeg' })
    fireEvent.change(fileInput, { target: { files: [file] } })

    await waitFor(() => expect(completeBodies.length).toBe(1))
    expect(uploadImage).toHaveBeenCalled()
    expect(completeBodies[0]).toMatchObject({ storageKey: 'hh/proof.jpg', contentType: 'image/jpeg' })
  })

  it('photo-proof review: the thumbnail opens a modal with the large photo + Approve', async () => {
    const approved: string[] = []
    let instances: Array<Record<string, unknown>> = [
      { id: '7', choreId: 'c7', choreTitle: 'Wash car', emoji: '🚗', personId: 'p1', personName: 'Wally', status: 'awaiting', rewardAmount: 8, requiresPhoto: true, requiresApproval: true, proofUrl: '/media/h/car.jpg', dueOn: '2026-06-24' },
    ]
    globalThis.fetch = vi.fn(async (url: string, opts?: { method?: string }) => {
      const u = String(url)
      const m = opts?.method ?? 'GET'
      if (u.includes('/api/household')) return householdPerson()
      if (u.includes('/api/persons')) return ok({ persons: [{ id: 'p1', name: 'Wally' }] })
      if (u.includes('/api/chore-instances/awaiting')) return ok({ instances })
      if (u.includes('/api/chore-instances/today')) return ok({ date: 'x', instances })
      if (u.includes('/approve') && m === 'POST') {
        const id = u.split('/').slice(-2)[0]
        approved.push(id)
        instances = instances.map((i) => (i.id === id ? { ...i, status: 'done' } : i))
        return ok({ instance: { id, status: 'done' } })
      }
      return { ok: false, status: 404, json: async () => ({}) }
    }) as unknown as typeof fetch

    renderTasks(<Tasks />)
    // No raw-image link — the thumbnail is a button that opens an in-app review modal.
    const thumb = (await screen.findAllByAltText('Proof for Wash car'))[0].closest('button')!
    fireEvent.click(thumb)

    // The modal shows the large photo (distinct alt) and an Approve action.
    expect(await screen.findByAltText('Photo proof for Wash car')).toBeInTheDocument()
    const modal = document.querySelector('.chore-proof-modal') as HTMLElement
    fireEvent.click(within(modal).getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(approved).toEqual(['7']))
  })
})
