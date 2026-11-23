import { loadOrCreateSecrets } from './secrets'

/**
 * Entry-point wrapper for every bundled binary. config.ts asserts production secrets at
 * import time, so the secrets must be in process.env before `load` pulls the rest in —
 * which is why callers pass a dynamic import rather than importing statically.
 */
export function withSecrets(name: string, load: () => Promise<unknown>): void {
  Promise.resolve()
    .then(() => loadOrCreateSecrets(process.env.DATA_DIR ?? '/data', process.env))
    .then(load)
    .catch((err) => {
      console.error(`${name}: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    })
}
