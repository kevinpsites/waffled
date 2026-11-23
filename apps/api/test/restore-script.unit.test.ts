import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Drives infra/backup/restore.sh with pg_isready/psql/pg_restore stubbed on PATH, so we can
// assert the database is never touched when the dump cannot be read.
const RESTORE = resolve(__dirname, '../../../infra/backup/restore.sh')
let dir: string
let bin: string
let log: string

function stub(name: string, body: string) {
  const path = join(bin, name)
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(path, 0o755)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'waffled-restore-'))
  bin = join(dir, 'bin')
  mkdirSync(bin)
  log = join(dir, 'psql.log')
  stub('pg_isready', 'exit 0')
  // The session-count query answers 0; any other call is the restore itself: record its
  // args and the contents of every -f file (restore.sh deletes them on exit).
  stub('psql', `
case "$*" in *pg_stat_activity*) echo 0; exit 0 ;; esac
{ echo "ARGS: $*"; prev=""; for a in "$@"; do [ "$prev" = "-f" ] && { echo "FILE:"; cat "$a"; }; prev="$a"; done; } >> "${log}"
`)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function restore(file: string) {
  return spawnSync('bash', [RESTORE, file], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DATABASE_URL: 'postgres://x@127.0.0.1:1/none', TMPDIR: dir },
    encoding: 'utf8',
  })
}

describe('restore.sh', () => {
  it('never runs psql when pg_restore fails', () => {
    stub('pg_restore', 'echo "pg_restore: error: corrupt" >&2; exit 1')
    const file = join(dir, 'bad.dump')
    writeFileSync(file, 'junk')
    const run = restore(file)
    expect(run.status).not.toBe(0)
    expect(existsSync(log)).toBe(false)
  })

  it('never runs psql when a .sql.gz is truncated', () => {
    const file = join(dir, 'bad.sql.gz')
    writeFileSync(file, gzipSync('CREATE TABLE t (id int);\n'.repeat(500)).subarray(0, 40))
    const run = restore(file)
    expect(run.status).not.toBe(0)
    expect(existsSync(log)).toBe(false)
  })

  it('never runs psql when the dump renders to nothing', () => {
    stub('pg_restore', 'out=""; prev=""; for a in "$@"; do [ "$prev" = "-f" ] && out="$a"; prev="$a"; done; : > "$out"')
    const file = join(dir, 'empty.dump')
    writeFileSync(file, 'x')
    const run = restore(file)
    expect(run.status).not.toBe(0)
    expect(existsSync(log)).toBe(false)
  })

  it('resets the schema and loads the dump in one single-transaction psql run', () => {
    const file = join(dir, 'good.sql.gz')
    writeFileSync(file, gzipSync('CREATE TABLE restored_marker (id int);\n'))
    const run = restore(file)
    expect(run.status, run.stderr).toBe(0)
    const calls = readFileSync(log, 'utf8')
    expect(calls.match(/^ARGS:/gm)).toHaveLength(1)
    expect(calls).toMatch(/--single-transaction/)
    expect(calls).toMatch(/ON_ERROR_STOP=1/)
    const drop = calls.indexOf('DROP SCHEMA public CASCADE')
    const create = calls.indexOf('CREATE SCHEMA public')
    const marker = calls.indexOf('restored_marker')
    expect(drop).toBeGreaterThan(-1)
    expect(create).toBeGreaterThan(drop)
    expect(marker).toBeGreaterThan(create)
  })
})
