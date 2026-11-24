import { render, screen, fireEvent, act } from '@testing-library/react'
import { UndoToast } from './UndoToast'

describe('UndoToast', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('calls onDone after ms', () => {
    const onDone = vi.fn()
    render(<UndoToast message="Logged" onUndo={vi.fn()} onDone={onDone} ms={1000} />)
    act(() => { vi.advanceTimersByTime(999) })
    expect(onDone).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1) })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('defaults to 6000ms', () => {
    const onDone = vi.fn()
    render(<UndoToast message="Logged" onUndo={vi.fn()} onDone={onDone} />)
    act(() => { vi.advanceTimersByTime(5999) })
    expect(onDone).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(1) })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('Undo calls onUndo then onDone, once, and the timer cannot fire it again', () => {
    const calls: string[] = []
    render(<UndoToast message="Logged" onUndo={() => calls.push('undo')} onDone={() => calls.push('done')} ms={1000} />)
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    act(() => { vi.advanceTimersByTime(5000) })
    expect(calls).toEqual(['undo', 'done'])
  })

  it('does not fire onDone after unmount', () => {
    const onDone = vi.fn()
    const { unmount } = render(<UndoToast message="Logged" onUndo={vi.fn()} onDone={onDone} ms={1000} />)
    unmount()
    act(() => { vi.advanceTimersByTime(5000) })
    expect(onDone).not.toHaveBeenCalled()
  })
})
