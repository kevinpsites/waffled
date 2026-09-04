// Minimal psql stand-in for the spike: the embedded-postgres bundle ships initdb,
// pg_ctl and postgres only — no psql, no pg_dump. This runs a .sql file (or stdin
// with `-`) against a DATABASE URL using the api's own `pg` dependency, and
// understands just enough psql syntax for infra/compose/postgres/init/00-init.sql:
//   \set ...        ignored (ON_ERROR_STOP is our default: first error → exit 1)
//   <query>\gexec   run the query, then execute each returned value as SQL
// Usage: node sql.mjs <database-url> <file|->   (run from apps/api so `pg` resolves)
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(process.cwd() + '/')
const { Client } = require('pg')

const [url, file] = process.argv.slice(2)
if (!url || !file) {
  console.error('usage: node sql.mjs <database-url> <file|->')
  process.exit(2)
}
const text = readFileSync(file === '-' ? 0 : file, 'utf8')

// Strip comments + \set lines, then split on ';' at end of statement. \gexec is
// kept as a suffix marker on its statement.
const cleaned = text
  .split('\n')
  .filter((l) => !/^\s*--/.test(l) && !/^\s*\\set\b/.test(l))
  .join('\n')
const statements = []
let buf = ''
for (const line of cleaned.split('\n')) {
  buf += line + '\n'
  if (/;\s*$/.test(line) || /\\gexec\s*$/.test(line)) {
    statements.push(buf.trim())
    buf = ''
  }
}
if (buf.trim()) statements.push(buf.trim())

const client = new Client({ connectionString: url })
await client.connect()
try {
  for (const raw of statements) {
    const gexec = /\\gexec\s*$/.test(raw)
    const stmt = raw.replace(/\\gexec\s*$/, '').replace(/;\s*$/, '')
    if (!stmt.trim()) continue
    const res = await client.query(stmt)
    if (gexec) {
      for (const row of res.rows) {
        for (const v of Object.values(row)) if (typeof v === 'string') await client.query(v)
      }
    }
  }
} catch (err) {
  console.error(`sql.mjs: ${err.message}`)
  process.exitCode = 1
} finally {
  await client.end()
}
