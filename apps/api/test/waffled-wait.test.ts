import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../../..', 'waffled')

describe('waffled startup health wait', () => {
  it('retries transient startup states before reporting status', () => {
    const attempts = execFileSync('bash', ['-c', `
      source "$1" help >/dev/null
      attempts=0
      services_ready() {
        attempts=$((attempts + 1))
        [ "$attempts" -ge 3 ]
      }
      sleep() { :; }
      wait_for_services api >/dev/null
      printf '%s' "$attempts"
    `, '_', cli], { encoding: 'utf8' })

    expect(attempts).toBe('3')
  })

  it('returns after a bounded wait when health checks never settle', () => {
    const result = execFileSync('bash', ['-c', `
      source "$1" help >/dev/null
      services_ready() { return 1; }
      sleep() { :; }
      export WAFFLED_HEALTH_ATTEMPTS=2
      set +e
      wait_for_services api
      printf 'exit=%s' "$?"
    `, '_', cli], { encoding: 'utf8' })

    expect(result).toContain('Services are taking longer than expected')
    expect(result).toContain('exit=1')
  })
})
