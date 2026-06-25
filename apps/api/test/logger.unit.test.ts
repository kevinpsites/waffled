import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createLogger, log } from '../src/platform/logger'

describe('logger', () => {
  let out: string[]
  let err: string[]
  beforeEach(() => {
    out = []
    err = []
    vi.spyOn(console, 'log').mockImplementation((l) => void out.push(String(l)))
    vi.spyOn(console, 'error').mockImplementation((l) => void err.push(String(l)))
    process.env.LOG_FORMAT = 'json'
    process.env.LOG_LEVEL = 'info'
  })
  afterEach(() => vi.restoreAllMocks())

  it('emits a JSON line with msg + fields on stdout for info', () => {
    log.info('hello', { a: 1 })
    expect(out).toHaveLength(1)
    const o = JSON.parse(out[0])
    expect(o).toMatchObject({ level: 'info', msg: 'hello', a: 1 })
    expect(o.ts).toBeTruthy()
  })

  it('routes warn/error to stderr', () => {
    log.warn('w')
    log.error('e')
    expect(out).toHaveLength(0)
    expect(err).toHaveLength(2)
  })

  it('filters levels below the threshold', () => {
    process.env.LOG_LEVEL = 'warn'
    log.info('skip')
    log.warn('keep')
    expect(out).toHaveLength(0)
    expect(err).toHaveLength(1)
  })

  it('child() merges bindings into every line', () => {
    createLogger({ svc: 'x' }).child({ requestId: 'r' }).info('m')
    expect(JSON.parse(out[0])).toMatchObject({ svc: 'x', requestId: 'r', msg: 'm' })
  })

  it('normalizes Error fields to {message, stack}', () => {
    log.error('boom', { err: new Error('nope') })
    expect(JSON.parse(err[0]).err).toMatchObject({ message: 'nope' })
  })
})
