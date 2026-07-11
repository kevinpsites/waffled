import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rulesPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../infra/compose/powersync/sync-config.yaml'
)

describe('PowerSync privacy rules', () => {
  it('sources household and viewer bucket parameters only from trusted JWT claims', async () => {
    const rules = await readFile(rulesPath, 'utf8')
    expect(rules).toContain("request.jwt() ->> 'household_id' as household_id")
    expect(rules).toContain("request.jwt() ->> 'person_id' as person_id")

    const dataQueries = rules.split('\n').filter((line) => line.trimStart().startsWith('- SELECT'))
    expect(dataQueries).toHaveLength(8)
    for (const query of dataQueries) {
      expect(query).toContain('bucket.household_id')
    }
  })

  it('replicates personal event rows only to their owner', async () => {
    const rules = await readFile(rulesPath, 'utf8')
    for (const table of ['events', 'event_participants', 'event_occurrences']) {
      const queries = rules.split('\n').filter((line) => line.includes(`FROM ${table} `))
      expect(queries).toHaveLength(2)
      expect(queries[0]).toContain("visibility = 'family'")
      expect(queries[0]).not.toContain('owner_person_id')
      expect(queries[1]).toContain("visibility = 'personal'")
      expect(queries[1]).toContain('owner_person_id = bucket.person_id')
    }
  })
})
