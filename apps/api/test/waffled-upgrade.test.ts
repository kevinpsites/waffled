import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const cli = resolve(dirname(fileURLToPath(import.meta.url)), '../../..', 'waffled')
const cliSource = readFileSync(cli, 'utf8')

function runShell(script: string): string {
  return execFileSync('bash', ['-c', `
    source "$1" help >/dev/null
    ${script}
  `, '_', cli], { encoding: 'utf8' })
}

describe('waffled upgrade safety', () => {
  it('rejects unknown flags before running preflight work', () => {
    const result = spawnSync('bash', [cli, 'upgrade', '--unknown'], { encoding: 'utf8' })

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('usage: ./waffled upgrade [--skip-backup]')
    expect(result.stdout).not.toContain("Docker isn't installed")
  })

  it('backs up before changing the version pin', () => {
    const upgradeCase = cliSource.slice(cliSource.indexOf('  upgrade)'), cliSource.indexOf('  down)'))

    expect(upgradeCase.indexOf('run_pre_upgrade_backup')).toBeGreaterThan(-1)
    expect(upgradeCase.indexOf('run_pre_upgrade_backup')).toBeLessThan(upgradeCase.indexOf('set_env_var WAFFLED_VERSION'))
  })

  it('aborts when the repository cannot fast-forward', () => {
    const result = runShell(`
      git() {
        case "$*" in
          *"rev-parse --git-dir"*) return 0 ;;
          *"symbolic-ref --short -q HEAD"*) printf 'main'; return 0 ;;
          *"pull --ff-only"*) return 1 ;;
        esac
      }
      set +e
      output="$(update_repo_for_upgrade 2>&1)"
      code=$?
      printf 'exit=%s\n%s' "$code" "$output"
    `)

    expect(result).toContain('exit=1')
    expect(result).toContain("Couldn't fast-forward the repo")
    expect(result).toContain('No images were changed')
  })

  it('allows a checked-out release tag without pulling', () => {
    const result = runShell(`
      git() {
        case "$*" in
          *"rev-parse --git-dir"*) return 0 ;;
          *"symbolic-ref --short -q HEAD"*) return 1 ;;
          *"pull --ff-only"*) return 99 ;;
        esac
      }
      update_repo_for_upgrade
      printf 'exit=%s' "$?"
    `)

    expect(result).toContain('Detached HEAD')
    expect(result).toContain('exit=0')
  })

  it('aborts when the backup service is unavailable', () => {
    const result = runShell(`
      docker() { return 0; }
      grep() { return 1; }
      set +e
      output="$(run_pre_upgrade_backup 0 2>&1)"
      code=$?
      printf 'exit=%s\n%s' "$code" "$output"
    `)

    expect(result).toContain('exit=1')
    expect(result).toContain('backup service is not running')
    expect(result).toContain('--skip-backup')
  })

  it('aborts when the pre-upgrade backup command fails', () => {
    const result = runShell(`
      docker() {
        case "$1" in
          ps) printf 'waffled-backup\n'; return 0 ;;
          exec) return 1 ;;
        esac
      }
      set +e
      output="$(run_pre_upgrade_backup 0 2>&1)"
      code=$?
      printf 'exit=%s\n%s' "$code" "$output"
    `)

    expect(result).toContain('exit=1')
    expect(result).toContain('backup failed')
    expect(result).toContain('upgrade has been stopped')
  })

  it('skips backup work only when explicitly requested', () => {
    const result = runShell(`
      docker() { return 99; }
      run_pre_upgrade_backup 1
      printf 'exit=%s' "$?"
    `)

    expect(result).toContain('--skip-backup was supplied')
    expect(result).toContain('exit=0')
  })
})
