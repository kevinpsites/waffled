import { getSavedView, saveView } from './persist'

describe('goal data-view persistence (per goal, localStorage)', () => {
  beforeEach(() => localStorage.clear())

  it('returns null when nothing is saved for a goal', () => {
    expect(getSavedView('g1')).toBeNull()
  })

  it('round-trips a saved view for a goal', () => {
    saveView('g1', 'month')
    expect(getSavedView('g1')).toBe('month')
  })

  it('keeps different goals independent', () => {
    saveView('g1', 'month')
    saveView('g2', 'pace')
    expect(getSavedView('g1')).toBe('month')
    expect(getSavedView('g2')).toBe('pace')
  })
})
