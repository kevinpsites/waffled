import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { assertProductionSecrets } from '../src/platform/config'

function validEnvironment(): NodeJS.ProcessEnv {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  return {
    NODE_ENV: 'production',
    LOCAL_JWT_SECRET: randomBytes(48).toString('base64'),
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    POWERSYNC_JWT_PRIVATE_KEY: Buffer.from(pem).toString('base64'),
  }
}

describe('production secret validation', () => {
  it('accepts generated session, encryption, and PowerSync keys', () => {
    expect(() => assertProductionSecrets(validEnvironment())).not.toThrow()
  })

  it.each([
    'LOCAL_JWT_SECRET',
    'TOKEN_ENCRYPTION_KEY',
    'POWERSYNC_JWT_PRIVATE_KEY',
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
    expect(() => assertProductionSecrets({
      ...validEnvironment(),
      POWERSYNC_JWT_PRIVATE_KEY: Buffer.from('not a private key').toString('base64'),
    })).toThrow('POWERSYNC_JWT_PRIVATE_KEY')
  })
})
