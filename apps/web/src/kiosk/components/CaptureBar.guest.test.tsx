import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>()
  return {
    ...actual,
    usePersons: () => ({ persons: [], loading: false, error: false }),
    useHousehold: () => ({
      household: { id: 'h', name: 'Home', timezone: 'UTC', weekStart: 'sunday' },
      person: { id: 'guest', name: 'Visitor', memberType: 'guest', isAdmin: false, capabilities: [] },
      memberships: [],
      pendingInvites: [],
    }),
  }
})

import { CaptureBar } from './CaptureBar'

describe('CaptureBar guest state', () => {
  it('does not render a write affordance for a read-only guest', () => {
    const { container } = render(<CaptureBar />)
    expect(container).toBeEmptyDOMElement()
    expect(document.querySelector('.capture-trigger')).toBeNull()
  })
})
