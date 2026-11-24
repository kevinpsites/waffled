import { describe, it, expect, afterEach, vi } from 'vitest'
import { fetchImage } from '../src/modules/mealie/mealie-reads'

const RID = '11111111-1111-4111-8111-111111111111'
const conn = { baseUrl: 'http://mealie.test' } as never

afterEach(() => vi.unstubAllGlobals())

describe('fetchImage', () => {
  it('maps a body that dies mid-read to 502 MealieUnavailable', async () => {
    const res = { status: 200, ok: true, headers: new Headers(), arrayBuffer: () => Promise.reject(new DOMException('aborted', 'AbortError')) }
    vi.stubGlobal('fetch', vi.fn(async () => res))
    await expect(fetchImage(conn, RID, 'min')).rejects.toMatchObject({ name: 'MealieUnavailable', statusCode: 502 })
  })
})
