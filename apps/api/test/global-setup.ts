// Vitest globalSetup: boot ONE Postgres container for the whole api suite and hand
// its admin connection string to the workers. Each test file then carves its own
// uniquely-named database out of this shared cluster via `test/helpers/pg.ts`
// (the drop-in `PostgreSqlContainer` shim), so files stay isolated but we pay the
// container-startup cost once instead of ~50 times.
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import type { GlobalSetupContext } from 'vitest/node'

// Make the injected value typed for `inject('pgAdminUri')` in the shim.
declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUri: string
  }
}

let container: StartedPostgreSqlContainer | undefined

export async function setup({ provide }: GlobalSetupContext): Promise<void> {
  container = await new PostgreSqlContainer('postgres:16').start()
  provide('pgAdminUri', container.getConnectionUri())
}

export async function teardown(): Promise<void> {
  await container?.stop()
}
