import { describe, expect, it, vi } from 'vitest'
import { reloadOnWorkerTakeover } from './pwa'

// When a new build's worker takes over, it has just deleted the previous build's
// asset cache (cache names carry the build stamp). Any screen the open page then
// navigates to asks for a chunk URL from the *old* build: gone from the cache, and
// Caddy's `try_files` answers with index.html, so the module load fails on MIME type
// and ScreenBoundary renders. On a wall-mounted display there is nobody there to tap
// Reload, so it sits on the error card until someone walks over. Reloading on
// takeover is what closes that.
describe('reloading when a new service worker takes over', () => {
  function harness(controller: unknown) {
    const listeners = new Map<string, () => void>()
    const serviceWorker = {
      controller,
      addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
    } as unknown as ServiceWorkerContainer
    const reload = vi.fn()
    return { listeners, serviceWorker, reload }
  }

  it('reloads the page when a new build claims it', () => {
    const { listeners, serviceWorker, reload } = harness({})
    reloadOnWorkerTakeover(serviceWorker, reload)

    listeners.get('controllerchange')?.()

    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('does not reload on the very first install', () => {
    // The first worker ever registered also fires controllerchange when it claims
    // the page. There is no stale chunk to escape there — the page was loaded from
    // the network moments ago — and reloading would bounce every first-time visitor.
    const { listeners, serviceWorker, reload } = harness(null)
    reloadOnWorkerTakeover(serviceWorker, reload)

    listeners.get('controllerchange')?.()

    expect(reload).not.toHaveBeenCalled()
  })

  it('reloads at most once', () => {
    // A reload loop on a kitchen display is worse than a stale one.
    const { listeners, serviceWorker, reload } = harness({})
    reloadOnWorkerTakeover(serviceWorker, reload)

    listeners.get('controllerchange')?.()
    listeners.get('controllerchange')?.()

    expect(reload).toHaveBeenCalledTimes(1)
  })
})
