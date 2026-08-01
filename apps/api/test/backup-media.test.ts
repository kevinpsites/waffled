import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const backupScript = resolve(root, 'infra/compose/backup/backup.sh')
const cli = resolve(root, 'waffled')
const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'waffled-backup-test-'))
  tempDirs.push(dir)
  return dir
}

function executable(path: string, source: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\n${source}\n`)
  chmodSync(path, 0o755)
}

function runBackup(
  awsSource = 'exit 0',
  tarSource = 'touch "$2"',
  createMediaDir = true,
): ReturnType<typeof spawnSync> {
  const dir = tempDir()
  const bin = join(dir, 'bin')
  const backupDir = join(dir, 'backups')
  const mediaDir = join(dir, 'media')
  mkdirSync(bin)
  if (createMediaDir) mkdirSync(mediaDir)

  executable(join(bin, 'date'), `
    case "$*" in
      "+%s%N") echo 1000000000 ;;
      "-u +%Y%m%d-%H%M%S") echo 20260801-000000 ;;
      *) echo 2026-08-01T00:00:00Z ;;
    esac
  `)
  executable(join(bin, 'psql'), 'echo 00000000-0000-0000-0000-000000000001')
  executable(join(bin, 'pg_dump'), "printf '%s\\n' 'select 1;'")
  executable(join(bin, 'stat'), 'echo 10')
  executable(join(bin, 'tar'), tarSource)
  executable(join(bin, 'aws'), awsSource)

  return spawnSync('bash', [backupScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      DATABASE_URL: 'postgres://test',
      BACKUP_DIR: backupDir,
      MEDIA_DIR: mediaDir,
      BACKUP_INCLUDE_MEDIA: 'true',
      BACKUP_S3_BUCKET: 's3://test-bucket/waffled',
    },
  })
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('uploaded-media backup safety', () => {
  it('fails the run when the enabled media mount is missing', () => {
    const result = runBackup('exit 0', 'exit 0', false)

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('is not mounted')
    expect(result.stdout).not.toContain('OK —')
  })

  it('fails the run when the media archive cannot be created', () => {
    const result = runBackup('exit 0', 'exit 1')

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('FAILED — media archive failed')
    expect(result.stdout).not.toContain('OK —')
  })

  it('fails the run when the offsite media upload fails', () => {
    const result = runBackup(`
      case "$3" in
        *waffled-media-*) exit 1 ;;
        *) exit 0 ;;
      esac
    `)

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('FAILED — media S3 upload failed')
    expect(result.stdout).not.toContain('OK —')
  })

  it('uses the documented media-inclusive default in CLI warnings', () => {
    const dir = tempDir()
    const envFile = join(dir, '.env')
    writeFileSync(envFile, 'BACKUP_HOST_PATH=/safe/backups\n')

    const result = spawnSync('bash', ['-c', `
      test_env="$2"
      source "$1" help >/dev/null
      ENV_FILE="$test_env"
      backup_safety_warnings
    `, '_', cli, envFile], { encoding: 'utf8' })

    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain('uploaded media is not included')
  })
})
