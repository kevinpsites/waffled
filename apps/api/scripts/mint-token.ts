// Mints a local HS256 JWT so the API can be exercised without Auth0.
// Only works while the API is in local auth mode (AUTH0_DOMAIN unset), and the
// secret here must match the API's LOCAL_JWT_SECRET (compose passes both the same).
//
// Usage:
//   tsx scripts/mint-token.ts [--household <uuid>] [--sub <id>] [--ttl <seconds>]
//   (in the container: node dist/mint-token.js ...)
// Prints just the token, so:  export TOKEN=$(npm run -s token)
import jwt from 'jsonwebtoken'
import { config } from '../src/config'

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

if (config.auth.mode !== 'local') {
  console.error('Refusing to mint: API is in auth0 mode (AUTH0_DOMAIN is set).')
  process.exit(1)
}

const householdId = arg('--household', '00000000-0000-0000-0000-000000000001')
const sub = arg('--sub', 'dev|kevin')
const ttl = parseInt(arg('--ttl', '604800'), 10) // default 7 days

const { secret, issuer, audience } = config.auth.local
const token = jwt.sign({ [config.auth.householdClaim]: householdId }, secret, {
  algorithm: 'HS256',
  subject: sub,
  issuer,
  audience,
  expiresIn: ttl,
})

process.stdout.write(token + '\n')
