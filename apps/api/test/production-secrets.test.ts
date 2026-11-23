import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { assertProductionSecrets } from '../src/platform/config'

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    LOCAL_JWT_SECRET: randomBytes(48).toString('base64'),
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  }
}

describe('production secret validation', () => {
  it('accepts generated session and encryption keys without a PowerSync key', () => {
    expect(() => assertProductionSecrets(validEnvironment())).not.toThrow()
  })

  it.each([
    'LOCAL_JWT_SECRET',
    'TOKEN_ENCRYPTION_KEY',
  ])('rejects a missing %s', (name) => {
    const environment = validEnvironment()
    delete environment[name]
    expect(() => assertProductionSecrets(environment)).toThrow(name)
  })

  it('rejects known or malformed values', () => {
    expect(() => assertProductionSecrets({
      ...validEnvironment(),
      LOCAL_JWT_SECRET: 'waffled-local-dev-secret-change-me',
    })).toThrow('LOCAL_JWT_SECRET')
    expect(() => assertProductionSecrets({
      ...validEnvironment(),
      TOKEN_ENCRYPTION_KEY: 'not-a-32-byte-base64-key',
    })).toThrow('TOKEN_ENCRYPTION_KEY')
  })
})
