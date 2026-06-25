import { describe, it, expect } from 'vitest'
import { runJob, registerJob, jobSnapshots } from '../src/platform/jobs'

const snap = (name: string) => jobSnapshots().find((j) => j.name === name)!

describe('jobs registry', () => {
  it('records timing, result and runCount on success', async () => {
    const out = await runJob('t-success', async () => ({ n: 5 }))
    expect(out).toEqual({ n: 5 })
    const rec = snap('t-success')
    expect(rec.runCount).toBe(1)
    expect(rec.lastError).toBeNull()
    expect(rec.lastResult).toEqual({ n: 5 })
    expect(rec.lastDurationMs).toBeGreaterThanOrEqual(0)
    expect(rec.lastRunAt).toBeTruthy()
    expect(rec.running).toBe(false)
  })

  it('records the error message and re-throws', async () => {
    await expect(runJob('t-fail', async () => {
      throw new Error('x')
    })).rejects.toThrow('x')
    expect(snap('t-fail').lastError).toBe('x')
    expect(snap('t-fail').runCount).toBe(1)
  })

  it('skips an overlapping run (in-flight guard) and returns undefined', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const p1 = runJob('t-lock', async () => {
      await gate
      return 'a'
    })
    const skipped = await runJob('t-lock', async () => 'b')
    expect(skipped).toBeUndefined()
    release()
    expect(await p1).toBe('a')
    expect(snap('t-lock').runCount).toBe(1) // the skipped run didn't count
  })

  it('registerJob makes a job visible before its first run', () => {
    registerJob('t-reg')
    const rec = snap('t-reg')
    expect(rec.runCount).toBe(0)
    expect(rec.lastRunAt).toBeNull()
  })
})
