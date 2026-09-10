import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  PROBE_PATH,
  UNREACHABLE_GRACE_MS,
  SERVER_REACHABLE_EVENT,
  configureReachability,
  getServerReachability,
  isUnansweredError,
  markUnanswered,
  probeServerNow,
  reportNetworkFailure,
  reportStatus,
  resetReachability,
} from './reachability'

const answered = (status = 200) => ({ status }) as Response
const gateway = () => ({ status: 502 }) as Response

function setDeviceOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: online })
}

describe('server reachability store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetReachability()
  })
  afterEach(() => {
    setDeviceOnline(true) // a leaked false would disable outage detection everywhere
    resetReachability()
    vi.useRealTimers()
  })

  it('flips to unreachable after two consecutive non-answers', () => {
    reportNetworkFailure()
    expect(getServerReachability()).toBe('reachable')
    reportNetworkFailure()
    expect(getServerReachability()).toBe('unreachable')
  })

  it('stays reachable when a single failure is followed by an answer', () => {
    reportNetworkFailure()
    reportStatus(200)
    reportNetworkFailure()
    expect(getServerReachability()).toBe('reachable')
  })

  it('cancels a pending grace flip as soon as something answers', () => {
    reportNetworkFailure()
    reportStatus(200)
    vi.advanceTimersByTime(UNREACHABLE_GRACE_MS)
    expect(getServerReachability()).toBe('reachable')
  })

  it('blames nothing on the server while the device itself is offline', () => {
    setDeviceOnline(false)
    reportNetworkFailure()
    reportNetworkFailure()
    expect(getServerReachability()).toBe('reachable')

    vi.advanceTimersByTime(UNREACHABLE_GRACE_MS)
    expect(getServerReachability()).toBe('reachable')
  })

  it('flips on a lone non-answer that is still unanswered after the grace window', () => {
    reportNetworkFailure()
    vi.advanceTimersByTime(2999)
    expect(getServerReachability()).toBe('reachable')
    vi.advanceTimersByTime(1)
    expect(getServerReachability()).toBe('unreachable')
  })

  it('counts a gateway status as a non-answer but 401/404/500 as answers', () => {
    expect(reportStatus(502)).toBe('no-answer')
    expect(reportStatus(503)).toBe('no-answer')
    expect(reportStatus(504)).toBe('no-answer')
    expect(getServerReachability()).toBe('unreachable')

    resetReachability()
    expect(reportStatus(401)).toBe('answered')
    expect(reportStatus(404)).toBe('answered')
    expect(reportStatus(500)).toBe('answered')
    expect(getServerReachability()).toBe('reachable')
  })

  it('counts a 502 the api answered in its own JSON as an answer', () => {
    expect(reportStatus(502, 'application/json; charset=utf-8')).toBe('answered')
    expect(reportStatus(503, 'Application/JSON')).toBe('answered')
    expect(getServerReachability()).toBe('reachable')

    expect(reportStatus(502, 'text/plain')).toBe('no-answer')
    expect(reportStatus(504, null)).toBe('no-answer')
    expect(getServerReachability()).toBe('unreachable')
  })

  it('probes every 5s, backs off to 15s after a minute, and stops once answered', async () => {
    const fetchMock = vi.fn(async (_path: string) => gateway())
    configureReachability({ fetch: fetchMock as unknown as typeof fetch })
    reportNetworkFailure()
    reportNetworkFailure()
    expect(getServerReachability()).toBe('unreachable')
    expect(fetchMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(PROBE_PATH)

    // 12 fast probes fill the first minute…
    await vi.advanceTimersByTimeAsync(55_000)
    expect(fetchMock).toHaveBeenCalledTimes(12)

    // …after which the cadence is 15s, so 14s buys nothing and 15s buys one probe.
    await vi.advanceTimersByTimeAsync(14_000)
    expect(fetchMock).toHaveBeenCalledTimes(12)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchMock).toHaveBeenCalledTimes(13)
  })

  // A hung connection: the socket stays open until the probe's own deadline aborts it.
  const hangingFetch = () =>
    vi.fn(
      (_path: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )

  it('gives up on a probe that never answers and schedules the next one', async () => {
    const fetchMock = hangingFetch()
    configureReachability({ fetch: fetchMock as unknown as typeof fetch })
    reportNetworkFailure()
    reportNetworkFailure()

    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Nothing more happens while it hangs…
    await vi.advanceTimersByTimeAsync(3999)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // …the deadline makes it a non-answer, and the usual cadence resumes.
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(getServerReachability()).toBe('unreachable')
  })

  it('lets Retry finish on a probe that never answers', async () => {
    configureReachability({ fetch: hangingFetch() as unknown as typeof fetch })
    reportNetworkFailure()
    reportNetworkFailure()

    const verdict = probeServerNow()
    await vi.advanceTimersByTimeAsync(4000)

    await expect(verdict).resolves.toBe('no-answer')
  })

  it('restores reachable and fires the refetch event when a probe answers', async () => {
    const fetchMock = vi.fn(async () => answered())
    configureReachability({ fetch: fetchMock as unknown as typeof fetch })
    const onReachable = vi.fn()
    window.addEventListener(SERVER_REACHABLE_EVENT, onReachable)

    reportNetworkFailure()
    reportNetworkFailure()
    await vi.advanceTimersByTimeAsync(5000)

    expect(getServerReachability()).toBe('reachable')
    expect(onReachable).toHaveBeenCalledTimes(1)

    // No further probing once the server is back.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    window.removeEventListener(SERVER_REACHABLE_EVENT, onReachable)
  })

  it('ignores a probe that was still in flight when the store was reset', async () => {
    let release: (res: Response) => void = () => {}
    configureReachability({
      fetch: vi.fn(() => new Promise<Response>((resolve) => { release = resolve })) as unknown as typeof fetch,
    })
    const onReachable = vi.fn()
    window.addEventListener(SERVER_REACHABLE_EVENT, onReachable)
    reportNetworkFailure()
    reportNetworkFailure()
    await vi.advanceTimersByTimeAsync(5000)

    resetReachability()
    configureReachability({ fetch: vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch })
    reportNetworkFailure()
    reportNetworkFailure()
    expect(getServerReachability()).toBe('unreachable')

    // The old probe finally answers — for a store that no longer exists.
    release(answered())
    await vi.advanceTimersByTimeAsync(0)

    expect(getServerReachability()).toBe('unreachable')
    expect(onReachable).not.toHaveBeenCalled()
    window.removeEventListener(SERVER_REACHABLE_EVENT, onReachable)
  })

  it('probes immediately on Retry instead of waiting for the next tick', async () => {
    const fetchMock = vi.fn(async () => answered())
    configureReachability({ fetch: fetchMock as unknown as typeof fetch })
    reportNetworkFailure()
    reportNetworkFailure()

    await probeServerNow()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getServerReachability()).toBe('reachable')
  })

  it('marks the error of a call that went unanswered, so the caller can branch on it', () => {
    const err = markUnanswered(new TypeError('Failed to fetch'))
    expect(isUnansweredError(err)).toBe(true)
    expect(isUnansweredError(new Error('/api/auth/status -> 401'))).toBe(false)
    expect(isUnansweredError(null)).toBe(false)
  })
})
